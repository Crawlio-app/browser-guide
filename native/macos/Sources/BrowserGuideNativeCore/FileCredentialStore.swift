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

public struct CredentialImportOutcome: Equatable, Sendable {
    public let provider: CredentialProvider
    /// "api_key" when the import yielded a platform key usable by Realtime,
    /// "oauth" when it stored tokens for later use.
    public let method: String
    /// Whether an OpenAI credential is configured after the import.
    public let configured: Bool
}

public protocol CredentialImporting: Sendable {
    func importCredentials(from provider: CredentialProvider) throws -> CredentialImportOutcome
    /// Re-reads the harness source that produced the stored OpenAI credential
    /// (currently Codex). Returns true when a different key was found.
    func resyncOpenAICredentialFromSource() -> Bool
    /// The stored Claude access token, re-synced from its source when near
    /// expiry. Nil when no Claude sign-in was ever imported.
    func freshAnthropicAccessToken(now: Date) throws -> String?
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
        try upsert(provider: "openai", credential: [
            "type": "api_key",
            "key": apiKey,
            "source": "codex-cli",
        ])
        return CredentialImportOutcome(provider: .codex, method: "api_key", configured: true)
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
        var credential: [String: Any] = [
            "type": "oauth",
            "access": accessToken,
            "source": "claude-code",
        ]
        if let refreshToken = oauth["refreshToken"] as? String { credential["refresh"] = refreshToken }
        if let expiresAt = oauth["expiresAt"] as? NSNumber { credential["expires"] = expiresAt }
        try upsert(provider: "anthropic", credential: credential)
        let configured = (try? readAPIKey()) != nil
        return CredentialImportOutcome(provider: .claudeCode, method: "oauth", configured: configured)
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
