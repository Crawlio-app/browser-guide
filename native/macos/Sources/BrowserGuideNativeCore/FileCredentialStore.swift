import Foundation

/// Errors from the file-backed credential store.
public enum CredentialStoreError: Error, Equatable, Sendable {
    case ioFailure(String)
    case malformedStore
    case importSourceMissing(String)
    case importSourceInvalid(String)
}

public enum CredentialProvider: String, Sendable {
    case codex = "codex"
    case claudeCode = "claude-code"
}

/// Who a stored or importable sign-in belongs to. Display only: it never
/// carries a token, and every field but the provider is optional because the
/// harnesses record different things. Codex signs an id_token that names an
/// email; Claude Code stores a subscription tier and an expiry and no address.
public struct CredentialAccount: Equatable, Sendable {
    public let provider: CredentialProvider
    public let label: String?
    public let plan: String?
    public let expiresAt: Double?

    public init(provider: CredentialProvider, label: String? = nil, plan: String? = nil, expiresAt: Double? = nil) {
        self.provider = provider
        self.label = label
        self.plan = plan
        self.expiresAt = expiresAt
    }

    public var json: [String: Any] {
        var object: [String: Any] = ["provider": provider.rawValue]
        if let label { object["label"] = label }
        if let plan { object["plan"] = plan }
        if let expiresAt { object["expiresAt"] = expiresAt }
        return object
    }
}

/// One place a sign-in could come from, and whether it is actually there.
public struct CredentialSource: Equatable, Sendable {
    public let provider: CredentialProvider
    public let available: Bool
    public let account: CredentialAccount?
    /// Why it is unusable, when available is false.
    public let detail: String?

    public init(provider: CredentialProvider, available: Bool, account: CredentialAccount? = nil, detail: String? = nil) {
        self.provider = provider
        self.available = available
        self.account = account
        self.detail = detail
    }

    public var json: [String: Any] {
        var object: [String: Any] = ["provider": provider.rawValue, "available": available]
        if let label = account?.label { object["label"] = label }
        if let plan = account?.plan { object["plan"] = plan }
        if let expiresAt = account?.expiresAt { object["expiresAt"] = expiresAt }
        if let detail { object["detail"] = detail }
        return object
    }
}

public struct CredentialImportOutcome: Equatable, Sendable {
    public let provider: CredentialProvider
    /// "api_key" when the import yielded a platform key usable by Realtime,
    /// "oauth" when it stored tokens for later use.
    public let method: String
    /// Whether an OpenAI credential is configured after the import.
    public let configured: Bool
    /// Who the imported sign-in belongs to, when the source says.
    public let account: CredentialAccount?

    public init(provider: CredentialProvider, method: String, configured: Bool, account: CredentialAccount? = nil) {
        self.provider = provider
        self.method = method
        self.configured = configured
        self.account = account
    }
}

public protocol CredentialImporting: Sendable {
    func importCredentials(from provider: CredentialProvider) throws -> CredentialImportOutcome
    /// Which harness sign-ins this computer actually has, so the setup screen
    /// can lead with the one that is there instead of offering a menu of
    /// everything it supports. Runs on demand rather than inside health:
    /// finding a Claude Code sign-in means reading the login Keychain.
    func availableSources() -> [CredentialSource]
    /// Who the stored credentials belong to, for the "connected as" line.
    func storedAccount() -> CredentialAccount?
    /// Re-reads the harness source that produced the stored OpenAI credential
    /// (currently Codex). Returns true when a different key was found.
    func resyncOpenAICredentialFromSource() -> Bool
    /// The stored Claude access token, re-synced from its source when near
    /// expiry. Nil when no Claude sign-in was ever imported.
    func freshAnthropicAccessToken(now: Date) throws -> String?
    /// Whether an Anthropic credential slot exists in the store at all,
    /// without any network or freshness work. Powers the health flag that
    /// selects the Claude engine.
    func hasAnthropicCredential() -> Bool
}

/// Harness-style credential storage: one JSON file with 0600 permissions,
/// the same pattern Claude Code (`~/.claude/.credentials.json`), Codex
/// (`~/.codex/auth.json`), gh, and gcloud use. Replaces the macOS Keychain,
/// whose access-control list re-prompts on every ad-hoc rebuild of the helper
/// and pins the product to macOS.
public struct FileCredentialStore: APIKeyStoring, CredentialImporting, Sendable {
    public static let storeVersion = 1

    private let storeURL: URL
    private let homeDirectory: URL
    private let legacyKeychain: KeychainStore?
    private let claudeCodeKeychainData: @Sendable () -> Data?

    public init() {
        self.init(
            storeURL: Self.defaultStoreURL(),
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            legacyKeychain: KeychainStore(),
            claudeCodeKeychainData: { Self.readClaudeCodeKeychainItem() }
        )
    }

    init(
        storeURL: URL,
        homeDirectory: URL,
        legacyKeychain: KeychainStore?,
        claudeCodeKeychainData: @escaping @Sendable () -> Data? = { nil }
    ) {
        self.storeURL = storeURL
        self.homeDirectory = homeDirectory
        self.legacyKeychain = legacyKeychain
        self.claudeCodeKeychainData = claudeCodeKeychainData
    }

    /// On macOS, Claude Code keeps its OAuth credentials in the login Keychain
    /// (`~/.claude/.credentials.json` is its Linux path) under services named
    /// "Claude Code-credentials" plus per-profile suffixed variants. Items may
    /// also hold only MCP-server tokens, so every candidate is parsed and the
    /// sign-in with the latest expiry wins.
    ///
    /// Reads go through /usr/bin/security rather than SecItemCopyMatching: the
    /// Keychain evaluates item access against the calling binary, and this
    /// ad-hoc-signed helper gets a fresh identity on every rebuild, which
    /// would re-trigger the consent dialog each time. The Apple-signed
    /// security tool keeps one stable identity.
    static func readClaudeCodeKeychainItem() -> Data? {
        guard let dump = runSecurityTool(["dump-keychain"], timeoutSeconds: 10) else { return nil }
        // Service names repeat across items (an old mcpOAuth-only item shares
        // the base name with the real sign-in), so enumerate (service, account)
        // pairs per item block; the account disambiguates duplicate services.
        var candidates: Set<[String]> = []
        for block in dump.components(separatedBy: "keychain: ") {
            guard block.contains("Claude Code-credentials") else { continue }
            guard let service = firstMatch(in: block, pattern: #""svce"<blob>="(Claude Code-credentials[^"]*)""#),
                  let account = firstMatch(in: block, pattern: #""acct"<blob>="([^"]*)""#) else { continue }
            candidates.insert([service, account])
        }

        var freshest: (expires: Double, payload: Data)?
        for pair in candidates {
            guard let secret = runSecurityTool(
                ["find-generic-password", "-s", pair[0], "-a", pair[1], "-w"],
                timeoutSeconds: 10
            ) else { continue }
            let payload = Data(secret.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
            guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
                  let oauth = object["claudeAiOauth"] as? [String: Any],
                  oauth["accessToken"] is String else { continue }
            let expires = (oauth["expiresAt"] as? NSNumber)?.doubleValue ?? 0
            if freshest == nil || expires > freshest!.expires {
                freshest = (expires, payload)
            }
        }
        return freshest?.payload
    }

    private static func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    private static func runSecurityTool(_ arguments: [String], timeoutSeconds: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        // Read concurrently with the wait: dump-keychain output can exceed the
        // pipe buffer, and a full pipe would deadlock a plain waitUntilExit.
        let collected = UnsafeBox()
        let reader = Thread {
            collected.data = output.fileHandleForReading.readDataToEndOfFile()
        }
        reader.start()
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            return nil
        }
        while reader.isExecuting && Date() < deadline.addingTimeInterval(1) {
            Thread.sleep(forTimeInterval: 0.02)
        }
        guard process.terminationStatus == 0 else { return nil }
        return String(data: collected.data, encoding: .utf8)
    }

    public static func defaultStoreURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["BROWSER_GUIDE_CREDENTIALS_PATH"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("browser-guide", isDirectory: true)
            .appendingPathComponent("credentials.json", isDirectory: false)
    }

    // MARK: - APIKeyStoring

    public func readAPIKey() throws -> String? {
        if let store = try loadStore() {
            guard let openai = store["openai"] as? [String: Any] else { return nil }
            return openai["key"] as? String
        }
        return try migrateFromKeychainIfPresent()
    }

    public func saveAPIKey(_ apiKey: String) throws {
        try upsert(provider: "openai", credential: [
            "type": "api_key",
            "key": apiKey,
            "source": "manual",
        ])
    }

    public func deleteAPIKey() throws {
        var store = (try loadStore()) ?? [:]
        store.removeValue(forKey: "openai")
        try persist(store)
    }

    // MARK: - Harness imports

    public func importCredentials(from provider: CredentialProvider) throws -> CredentialImportOutcome {
        switch provider {
        case .codex:
            return try importCodex()
        case .claudeCode:
            return try importClaudeCode()
        }
    }

    /// Codex CLI stores `~/.codex/auth.json` containing an `OPENAI_API_KEY`
    /// minted during `codex login` alongside its ChatGPT OAuth tokens.
    private func importCodex() throws -> CredentialImportOutcome {
        let authURL = homeDirectory
            .appendingPathComponent(".codex", isDirectory: true)
            .appendingPathComponent("auth.json", isDirectory: false)
        guard FileManager.default.fileExists(atPath: authURL.path) else {
            throw CredentialStoreError.importSourceMissing(
                "No Codex sign-in was found (~/.codex/auth.json). Run `codex login` first."
            )
        }
        guard let data = try? Data(contentsOf: authURL),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CredentialStoreError.importSourceInvalid(
                "The Codex sign-in file could not be read. Run `codex login` again."
            )
        }
        guard let apiKey = object["OPENAI_API_KEY"] as? String,
              !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw CredentialStoreError.importSourceInvalid(
                "Your Codex sign-in has no API key. Run `codex login` and choose the API-key option, or paste a key manually."
            )
        }
        let account = Self.codexAccount(from: object)
        var credential: [String: Any] = [
            "type": "api_key",
            "key": apiKey,
            "source": "codex-cli",
        ]
        if let label = account?.label { credential["label"] = label }
        if let plan = account?.plan { credential["plan"] = plan }
        try upsert(provider: "openai", credential: credential)
        return CredentialImportOutcome(provider: .codex, method: "api_key", configured: true, account: account)
    }

    /// Codex writes the ChatGPT id_token beside the API key. Its payload names
    /// the signed-in account, which is the only way we can confirm *which*
    /// account was connected. The signature is not verified and never trusted
    /// for authorization: this is a label on a file the user already owns, and
    /// it is used for display only.
    static func codexAccount(from authObject: [String: Any]) -> CredentialAccount? {
        guard let tokens = authObject["tokens"] as? [String: Any],
              let idToken = tokens["id_token"] as? String,
              let claims = decodeJWTClaims(idToken) else {
            return CredentialAccount(provider: .codex)
        }
        let email = (claims["email"] as? String) ?? (claims["preferred_username"] as? String)
        let auth = claims["https://api.openai.com/auth"] as? [String: Any]
        let plan = auth?["chatgpt_plan_type"] as? String
        return CredentialAccount(
            provider: .codex,
            label: sanitizeIdentityText(email),
            plan: sanitizeIdentityText(plan)
        )
    }

    static func claudeAccount(from oauth: [String: Any]) -> CredentialAccount {
        // The access token expires hourly and Claude Code refreshes it in the
        // background, so surfacing that would cry wolf. The refresh token's
        // expiry is the moment a person genuinely has to sign in again.
        let expiry = (oauth["refreshTokenExpiresAt"] as? NSNumber)?.doubleValue
        return CredentialAccount(
            provider: .claudeCode,
            plan: sanitizeIdentityText(oauth["subscriptionType"] as? String),
            expiresAt: expiry.flatMap { $0 > 0 ? $0 : nil }
        )
    }

    private static func decodeJWTClaims(_ token: String) -> [String: Any]? {
        let segments = token.split(separator: ".")
        guard segments.count >= 2 else { return nil }
        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return object
    }

    /// The panel renders these as text, so anything that gets there has to be
    /// bounded and free of control characters first.
    private static func sanitizeIdentityText(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 320,
              trimmed.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return trimmed
    }

    /// Claude Code stores `~/.claude/.credentials.json` with a `claudeAiOauth`
    /// object. The tokens are stored for upcoming Anthropic-backed features;
    /// they do not power OpenAI Realtime voice.
    private func importClaudeCode() throws -> CredentialImportOutcome {
        let credentialsURL = homeDirectory
            .appendingPathComponent(".claude", isDirectory: true)
            .appendingPathComponent(".credentials.json", isDirectory: false)
        let data: Data
        if FileManager.default.fileExists(atPath: credentialsURL.path),
           let fileData = try? Data(contentsOf: credentialsURL) {
            data = fileData
        } else if let keychainData = claudeCodeKeychainData() {
            data = keychainData
        } else {
            throw CredentialStoreError.importSourceMissing(
                "No Claude Code sign-in was found (checked the login Keychain and ~/.claude/.credentials.json). Run `claude` and sign in first."
            )
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let oauth = object["claudeAiOauth"] as? [String: Any],
              let accessToken = oauth["accessToken"] as? String,
              !accessToken.isEmpty else {
            throw CredentialStoreError.importSourceInvalid(
                "The Claude Code sign-in could not be read. Sign in to Claude Code again."
            )
        }
        let account = Self.claudeAccount(from: oauth)
        var credential: [String: Any] = [
            "type": "oauth",
            "access": accessToken,
            "source": "claude-code",
        ]
        if let refreshToken = oauth["refreshToken"] as? String { credential["refresh"] = refreshToken }
        if let expiresAt = oauth["expiresAt"] as? NSNumber { credential["expires"] = expiresAt }
        if let plan = account.plan { credential["plan"] = plan }
        if let signInExpiry = account.expiresAt { credential["signInExpires"] = signInExpiry }
        try upsert(provider: "anthropic", credential: credential)
        let configured = (try? readAPIKey()) != nil
        return CredentialImportOutcome(
            provider: .claudeCode,
            method: "oauth",
            configured: configured,
            account: account
        )
    }

    // MARK: - Who is connected, and where a sign-in could come from

    public func storedAccount() -> CredentialAccount? {
        guard let store = try? loadStore() else { return nil }
        if let openai = store["openai"] as? [String: Any], openai["key"] is String {
            guard openai["source"] as? String == "codex-cli" else {
                return CredentialAccount(provider: .codex, label: nil, plan: nil)
            }
            return CredentialAccount(
                provider: .codex,
                label: openai["label"] as? String,
                plan: openai["plan"] as? String
            )
        }
        guard let anthropic = store["anthropic"] as? [String: Any], anthropic["access"] is String else { return nil }
        return CredentialAccount(
            provider: .claudeCode,
            plan: anthropic["plan"] as? String,
            expiresAt: (anthropic["signInExpires"] as? NSNumber)?.doubleValue
        )
    }

    public func availableSources() -> [CredentialSource] {
        [codexSource(), claudeCodeSource()]
    }

    private func codexSource() -> CredentialSource {
        let authURL = homeDirectory
            .appendingPathComponent(".codex", isDirectory: true)
            .appendingPathComponent("auth.json", isDirectory: false)
        guard FileManager.default.fileExists(atPath: authURL.path) else {
            return CredentialSource(provider: .codex, available: false, detail: "Run `codex login` to create one.")
        }
        guard let data = try? Data(contentsOf: authURL),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return CredentialSource(provider: .codex, available: false, detail: "The Codex sign-in file could not be read.")
        }
        guard let apiKey = object["OPENAI_API_KEY"] as? String,
              !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            return CredentialSource(
                provider: .codex,
                available: false,
                account: Self.codexAccount(from: object),
                detail: "This Codex sign-in carries no API key."
            )
        }
        return CredentialSource(provider: .codex, available: true, account: Self.codexAccount(from: object))
    }

    private func claudeCodeSource() -> CredentialSource {
        let credentialsURL = homeDirectory
            .appendingPathComponent(".claude", isDirectory: true)
            .appendingPathComponent(".credentials.json", isDirectory: false)
        var data: Data?
        if FileManager.default.fileExists(atPath: credentialsURL.path) {
            data = try? Data(contentsOf: credentialsURL)
        }
        if data == nil { data = claudeCodeKeychainData() }
        guard let payload = data else {
            return CredentialSource(provider: .claudeCode, available: false, detail: "Sign in to Claude Code to create one.")
        }
        guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
              let oauth = object["claudeAiOauth"] as? [String: Any],
              let accessToken = oauth["accessToken"] as? String, !accessToken.isEmpty else {
            return CredentialSource(provider: .claudeCode, available: false, detail: "The Claude Code sign-in could not be read.")
        }
        return CredentialSource(provider: .claudeCode, available: true, account: Self.claudeAccount(from: oauth))
    }

    // MARK: - Source re-sync (freshness without our own OAuth refresh)

    /// Five minutes, matching the early-expiry buffer Superset uses.
    public static let tokenExpiryBufferMs: Double = 5 * 60 * 1_000

    /// Returns a non-expired Anthropic access token. When the stored copy is
    /// near expiry, the harness source file is re-read first — Claude Code
    /// refreshes its own credentials, so re-syncing beats refreshing ourselves
    /// (and never borrows someone else's OAuth client).
    public func freshAnthropicAccessToken(now: Date = Date()) throws -> String? {
        guard var anthropic = try loadStore()?["anthropic"] as? [String: Any] else { return nil }
        if isExpired(anthropic, now: now) {
            if (try? importClaudeCode()) != nil,
               let refreshed = try loadStore()?["anthropic"] as? [String: Any] {
                anthropic = refreshed
            }
            if isExpired(anthropic, now: now) {
                throw CredentialStoreError.importSourceInvalid(
                    "Your Claude sign-in expired. Open Claude Code once to refresh it, then try again."
                )
            }
        }
        return anthropic["access"] as? String
    }

    public func hasAnthropicCredential() -> Bool {
        ((try? loadStore())?["anthropic"] as? [String: Any])?["access"] is String
    }

    public func resyncOpenAICredentialFromSource() -> Bool {
        guard let openai = (try? loadStore())?["openai"] as? [String: Any],
              openai["source"] as? String == "codex-cli",
              let previousKey = openai["key"] as? String else { return false }
        guard (try? importCodex()) != nil,
              let refreshed = (try? loadStore())?["openai"] as? [String: Any],
              let refreshedKey = refreshed["key"] as? String else { return false }
        return refreshedKey != previousKey
    }

    private func isExpired(_ credential: [String: Any], now: Date) -> Bool {
        guard let expires = (credential["expires"] as? NSNumber)?.doubleValue else { return false }
        return now.timeIntervalSince1970 * 1_000 >= expires - Self.tokenExpiryBufferMs
    }

    // MARK: - Keychain migration

    private func migrateFromKeychainIfPresent() throws -> String? {
        guard let legacy = legacyKeychain, legacy.itemExists() else { return nil }
        // This read may show one final macOS consent prompt; after it the key
        // lives in the credentials file and the Keychain item is removed.
        guard let key = try? legacy.readAPIKey(), !key.isEmpty else { return nil }
        try saveAPIKey(key)
        try? legacy.deleteAPIKey()
        return key
    }

    // MARK: - Persistence

    private func loadStore() throws -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: storeURL.path) else { return nil }
        guard let data = try? Data(contentsOf: storeURL) else {
            throw CredentialStoreError.ioFailure("The credential store could not be read.")
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CredentialStoreError.malformedStore
        }
        return object
    }

    private func upsert(provider: String, credential: [String: Any]) throws {
        var store = (try loadStore()) ?? [:]
        store["version"] = Self.storeVersion
        store[provider] = credential
        try persist(store)
    }

    private func persist(_ store: [String: Any]) throws {
        let directory = storeURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
            )
            var payload = store
            payload["version"] = Self.storeVersion
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: storeURL, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: storeURL.path
            )
        } catch {
            throw CredentialStoreError.ioFailure("The credential store could not be written.")
        }
    }
}

/// Mutable capture for the pipe-reader thread; access is sequenced by the
/// thread lifecycle (started, then joined before the read).
private final class UnsafeBox: @unchecked Sendable {
    var data = Data()
}
