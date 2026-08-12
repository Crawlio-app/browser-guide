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

    public init() {
        self.init(
            storeURL: Self.defaultStoreURL(),
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            legacyKeychain: KeychainStore()
        )
    }

    init(storeURL: URL, homeDirectory: URL, legacyKeychain: KeychainStore?) {
        self.storeURL = storeURL
        self.homeDirectory = homeDirectory
        self.legacyKeychain = legacyKeychain
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
        guard FileManager.default.fileExists(atPath: credentialsURL.path) else {
            throw CredentialStoreError.importSourceMissing(
                "No Claude Code sign-in was found (~/.claude/.credentials.json). Run `claude` and sign in first."
            )
        }
        guard let data = try? Data(contentsOf: credentialsURL),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
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
