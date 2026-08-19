import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class FileCredentialStoreTests: XCTestCase {
    private var temporaryRoot: URL!

    override func setUpWithError() throws {
        temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-guide-credential-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryRoot)
    }

    private func makeStore(home: URL? = nil) -> FileCredentialStore {
        FileCredentialStore(
            storeURL: temporaryRoot.appendingPathComponent("credentials.json"),
            homeDirectory: home ?? temporaryRoot,
            legacyKeychain: nil
        )
    }

    func testRoundTripsAndDeletesTheOpenAIKey() throws {
        let store = makeStore()
        XCTAssertNil(try store.readAPIKey())
        try store.saveAPIKey("sk-" + String(repeating: "a", count: 24))
        XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "a", count: 24))
        try store.saveAPIKey("sk-" + String(repeating: "b", count: 24))
        XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "b", count: 24))
        try store.deleteAPIKey()
        XCTAssertNil(try store.readAPIKey())
    }

    func testStoreFileIsPrivateToTheUser() throws {
        let store = makeStore()
        try store.saveAPIKey("sk-" + String(repeating: "c", count: 24))
        let storePath = temporaryRoot.appendingPathComponent("credentials.json").path
        let attributes = try FileManager.default.attributesOfItem(atPath: storePath)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.int16Value
        XCTAssertEqual(permissions, 0o600)
    }

    func testImportsTheCodexPlatformKey() throws {
        let codexDirectory = temporaryRoot.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDirectory, withIntermediateDirectories: true)
        let auth: [String: Any] = [
            "OPENAI_API_KEY": "sk-" + String(repeating: "d", count: 24),
            "tokens": ["access_token": "opaque", "refresh_token": "opaque", "account_id": "acct"],
        ]
        try JSONSerialization.data(withJSONObject: auth)
            .write(to: codexDirectory.appendingPathComponent("auth.json"))

        let store = makeStore()
        let outcome = try store.importCredentials(from: .codex)
        XCTAssertEqual(outcome.method, "api_key")
        XCTAssertTrue(outcome.configured)
        XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "d", count: 24))
    }

    func testNamesTheCodexAccountFromItsSignedIdentityToken() throws {
        let codexDirectory = temporaryRoot.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDirectory, withIntermediateDirectories: true)
        let claims: [String: Any] = [
            "email": "person@example.test",
            "https://api.openai.com/auth": ["chatgpt_plan_type": "plus"],
        ]
        let auth: [String: Any] = [
            "OPENAI_API_KEY": "sk-" + String(repeating: "d", count: 24),
            "tokens": ["id_token": Self.unsignedJWT(claims: claims), "access_token": "opaque"],
        ]
        try JSONSerialization.data(withJSONObject: auth)
            .write(to: codexDirectory.appendingPathComponent("auth.json"))

        let store = makeStore()
        let outcome = try store.importCredentials(from: .codex)
        XCTAssertEqual(outcome.account?.label, "person@example.test")
        XCTAssertEqual(outcome.account?.plan, "plus")

        // Health reads the identity back from our own store, so it never has
        // to reopen the harness source.
        let stored = store.storedAccount()
        XCTAssertEqual(stored?.provider, .codex)
        XCTAssertEqual(stored?.label, "person@example.test")

        // The token itself is never carried into the identity.
        XCTAssertFalse(outcome.account?.json.description.contains("sk-") ?? true)
    }

    func testClaudeAccountReportsThePlanAndTheDateReAuthIsActuallyNeeded() throws {
        let claudeDirectory = temporaryRoot.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDirectory, withIntermediateDirectories: true)
        let hourFromNow = Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000
        let yearFromNow = Date().addingTimeInterval(365 * 86_400).timeIntervalSince1970 * 1_000
        let payload: [String: Any] = ["claudeAiOauth": [
            "accessToken": "sk-ant-oat-token",
            "refreshToken": "sk-ant-ort-token",
            "subscriptionType": "max",
            // The access token turns over hourly and Claude Code refreshes it,
            // so the identity must quote the refresh expiry, not this one.
            "expiresAt": hourFromNow,
            "refreshTokenExpiresAt": yearFromNow,
        ]]
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: claudeDirectory.appendingPathComponent(".credentials.json"))

        let store = makeStore()
        let outcome = try store.importCredentials(from: .claudeCode)
        XCTAssertEqual(outcome.account?.plan, "max")
        XCTAssertEqual(outcome.account?.expiresAt, yearFromNow)
        XCTAssertEqual(store.storedAccount()?.expiresAt, yearFromNow)
    }

    func testALapsedSignInIsNotReportedAsUsable() throws {
        // Our copy of a sign-in outlives the sign-in. Answering "connected" on
        // a dead one puts the panel in a ready state that fails on the first
        // question, and shows an account chip for someone who is signed out.
        let claudeDirectory = temporaryRoot.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDirectory, withIntermediateDirectories: true)
        let longAgo = Date(timeIntervalSince1970: 1_600_000_000).timeIntervalSince1970 * 1_000
        let farFuture = Date().addingTimeInterval(365 * 86_400).timeIntervalSince1970 * 1_000
        let credentialsURL = claudeDirectory.appendingPathComponent(".credentials.json")

        try JSONSerialization.data(withJSONObject: ["claudeAiOauth": [
            "accessToken": "sk-ant-oat-token",
            "refreshToken": "sk-ant-ort-token",
            "subscriptionType": "max",
            "refreshTokenExpiresAt": longAgo,
        ]]).write(to: credentialsURL)
        let store = makeStore()
        _ = try store.importCredentials(from: .claudeCode)
        XCTAssertFalse(store.hasAnthropicCredential(now: Date()))

        // A live refresh window is usable even though the access token itself
        // turns over hourly and may well be stale right now.
        try JSONSerialization.data(withJSONObject: ["claudeAiOauth": [
            "accessToken": "sk-ant-oat-token",
            "refreshToken": "sk-ant-ort-token",
            "subscriptionType": "max",
            "expiresAt": longAgo,
            "refreshTokenExpiresAt": farFuture,
        ]]).write(to: credentialsURL)
        _ = try store.importCredentials(from: .claudeCode)
        XCTAssertTrue(store.hasAnthropicCredential(now: Date()))
    }

    func testAvailableSourcesReportWhatThisComputerActuallyHas() throws {
        let store = makeStore()
        let empty = store.availableSources()
        XCTAssertEqual(empty.count, 2)
        XCTAssertTrue(empty.allSatisfy { !$0.available })
        XCTAssertNotNil(empty.first { $0.provider == .codex }?.detail)

        let codexDirectory = temporaryRoot.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDirectory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["OPENAI_API_KEY": "sk-" + String(repeating: "e", count: 24)])
            .write(to: codexDirectory.appendingPathComponent("auth.json"))

        let found = store.availableSources()
        XCTAssertEqual(found.first { $0.provider == .codex }?.available, true)
        XCTAssertEqual(found.first { $0.provider == .claudeCode }?.available, false)

        // A sign-in that exists but carries no usable key is reported as
        // present-and-unusable, with the reason, rather than silently absent.
        try JSONSerialization.data(withJSONObject: ["tokens": ["access_token": "only"]])
            .write(to: codexDirectory.appendingPathComponent("auth.json"))
        let unusable = store.availableSources().first { $0.provider == .codex }
        XCTAssertEqual(unusable?.available, false)
        XCTAssertEqual(unusable?.detail, "This Codex sign-in carries no API key.")
    }

    private static func unsignedJWT(claims: [String: Any]) -> String {
        let payload = try! JSONSerialization.data(withJSONObject: claims)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "header.\(payload).signature"
    }

    func testCodexImportWithoutKeyExplainsTheFix() throws {
        let codexDirectory = temporaryRoot.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDirectory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["tokens": ["access_token": "only"]])
            .write(to: codexDirectory.appendingPathComponent("auth.json"))

        XCTAssertThrowsError(try makeStore().importCredentials(from: .codex)) { error in
            guard case .importSourceInvalid(let message)? = error as? CredentialStoreError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertTrue(message.contains("codex login"))
        }
    }

    func testMissingCodexSignInIsReportedPlainly() {
        XCTAssertThrowsError(try makeStore().importCredentials(from: .codex)) { error in
            guard case .importSourceMissing? = error as? CredentialStoreError else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testFreshAnthropicTokenReSyncsFromTheSourceWhenNearExpiry() throws {
        let claudeDirectory = temporaryRoot.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDirectory, withIntermediateDirectories: true)
        let now = Date()
        let freshExpiry = (now.timeIntervalSince1970 + 3_600) * 1_000

        // Store holds a token that is about to expire; the source has a fresh one.
        func writeSource(access: String, expires: Double) throws {
            let credentials: [String: Any] = [
                "claudeAiOauth": ["accessToken": access, "refreshToken": "r", "expiresAt": expires],
            ]
            try JSONSerialization.data(withJSONObject: credentials)
                .write(to: claudeDirectory.appendingPathComponent(".credentials.json"))
        }
        let store = makeStore()
        try writeSource(access: "stale-token", expires: (now.timeIntervalSince1970 + 60) * 1_000)
        _ = try store.importCredentials(from: .claudeCode)
        try writeSource(access: "fresh-token", expires: freshExpiry)

        XCTAssertEqual(try store.freshAnthropicAccessToken(now: now), "fresh-token")
    }

    func testFreshAnthropicTokenExplainsWhenTheSourceIsAlsoExpired() throws {
        let claudeDirectory = temporaryRoot.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDirectory, withIntermediateDirectories: true)
        let now = Date()
        let expired = (now.timeIntervalSince1970 - 60) * 1_000
        let credentials: [String: Any] = [
            "claudeAiOauth": ["accessToken": "old", "refreshToken": "r", "expiresAt": expired],
        ]
        try JSONSerialization.data(withJSONObject: credentials)
            .write(to: claudeDirectory.appendingPathComponent(".credentials.json"))
        let store = makeStore()
        _ = try store.importCredentials(from: .claudeCode)

        XCTAssertThrowsError(try store.freshAnthropicAccessToken(now: now)) { error in
            guard case .importSourceInvalid(let message)? = error as? CredentialStoreError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertTrue(message.contains("Open Claude Code"))
        }
    }

    func testResyncOpenAIRefreshesOnlyCodexSourcedKeys() throws {
        let codexDirectory = temporaryRoot.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexDirectory, withIntermediateDirectories: true)
        func writeAuth(_ key: String) throws {
            try JSONSerialization.data(withJSONObject: ["OPENAI_API_KEY": key])
                .write(to: codexDirectory.appendingPathComponent("auth.json"))
        }
        let store = makeStore()

        // A manually pasted key must never be silently replaced.
        try store.saveAPIKey("sk-" + String(repeating: "m", count: 24))
        try writeAuth("sk-" + String(repeating: "n", count: 24))
        XCTAssertFalse(store.resyncOpenAICredentialFromSource())
        XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "m", count: 24))

        // A codex-sourced key re-syncs when the source rotated.
        _ = try store.importCredentials(from: .codex)
        try writeAuth("sk-" + String(repeating: "p", count: 24))
        XCTAssertTrue(store.resyncOpenAICredentialFromSource())
        XCTAssertEqual(try store.readAPIKey(), "sk-" + String(repeating: "p", count: 24))
        // No rotation -> no change reported.
        XCTAssertFalse(store.resyncOpenAICredentialFromSource())
    }

    func testImportsClaudeCodeFromTheKeychainWhenTheFileIsAbsent() throws {
        let keychainPayload: [String: Any] = [
            "claudeAiOauth": [
                "accessToken": "sk-ant-oat-keychain",
                "refreshToken": "sk-ant-ort-keychain",
                "expiresAt": 1_900_000_000_000,
            ],
        ]
        let payloadData = try JSONSerialization.data(withJSONObject: keychainPayload)
        let store = FileCredentialStore(
            storeURL: temporaryRoot.appendingPathComponent("credentials.json"),
            homeDirectory: temporaryRoot,
            legacyKeychain: nil,
            claudeCodeKeychainData: { payloadData }
        )

        let outcome = try store.importCredentials(from: .claudeCode)
        XCTAssertEqual(outcome.method, "oauth")

        let raw = try Data(contentsOf: temporaryRoot.appendingPathComponent("credentials.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        let anthropic = try XCTUnwrap(object["anthropic"] as? [String: Any])
        XCTAssertEqual(anthropic["access"] as? String, "sk-ant-oat-keychain")
        XCTAssertEqual(anthropic["source"] as? String, "claude-code")
    }

    func testImportsClaudeCodeOAuthTokensWithoutTouchingOpenAI() throws {
        let claudeDirectory = temporaryRoot.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claudeDirectory, withIntermediateDirectories: true)
        let credentials: [String: Any] = [
            "claudeAiOauth": [
                "accessToken": "sk-ant-oat-token",
                "refreshToken": "sk-ant-ort-token",
                "expiresAt": 1_900_000_000_000,
                "scopes": ["user:inference"],
            ],
        ]
        try JSONSerialization.data(withJSONObject: credentials)
            .write(to: claudeDirectory.appendingPathComponent(".credentials.json"))

        let store = makeStore()
        let outcome = try store.importCredentials(from: .claudeCode)
        XCTAssertEqual(outcome.method, "oauth")
        XCTAssertFalse(outcome.configured)
        XCTAssertNil(try store.readAPIKey())

        let raw = try Data(contentsOf: temporaryRoot.appendingPathComponent("credentials.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        let anthropic = try XCTUnwrap(object["anthropic"] as? [String: Any])
        XCTAssertEqual(anthropic["type"] as? String, "oauth")
        XCTAssertEqual(anthropic["source"] as? String, "claude-code")
        XCTAssertEqual(anthropic["access"] as? String, "sk-ant-oat-token")
        XCTAssertEqual(anthropic["refresh"] as? String, "sk-ant-ort-token")
    }
}

final class SiteMemoryStoreTests: XCTestCase {
    private var temporaryRoot: URL!

    override func setUpWithError() throws {
        temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-guide-memory-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryRoot)
    }

    private func makeStore() -> SiteMemoryStore {
        SiteMemoryStore(storeURL: temporaryRoot.appendingPathComponent("memory.json"))
    }

    func testAppendsRecallsAndTrimsNotesPerOrigin() throws {
        let store = makeStore()
        XCTAssertEqual(try store.notes(for: "https://example.test").count, 0)
        for index in 1...12 {
            try store.append(origin: "https://example.test", question: "q\(index)", answer: "a\(index)")
        }
        let notes = try store.notes(for: "https://example.test")
        XCTAssertEqual(notes.count, SiteMemoryStore.maxNotesPerOrigin)
        XCTAssertEqual(notes.first?["q"] as? String, "q3")
        XCTAssertEqual(notes.last?["a"] as? String, "a12")
    }

    func testTruncatesOversizedEntriesAndKeepsFilePrivate() throws {
        let store = makeStore()
        try store.append(
            origin: "https://example.test",
            question: String(repeating: "q", count: 5_000),
            answer: String(repeating: "a", count: 5_000)
        )
        let note = try XCTUnwrap(store.notes(for: "https://example.test").first)
        XCTAssertEqual((note["q"] as? String)?.count, SiteMemoryStore.maxQuestionLength)
        XCTAssertEqual((note["a"] as? String)?.count, SiteMemoryStore.maxAnswerLength)
        let attributes = try FileManager.default.attributesOfItem(
            atPath: temporaryRoot.appendingPathComponent("memory.json").path
        )
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.int16Value, 0o600)
    }

    func testClearsOneOriginOrEverything() throws {
        let store = makeStore()
        try store.append(origin: "https://one.test", question: "q", answer: "a")
        try store.append(origin: "https://two.test", question: "q", answer: "a")
        try store.clear(origin: "https://one.test")
        XCTAssertEqual(try store.notes(for: "https://one.test").count, 0)
        XCTAssertEqual(try store.notes(for: "https://two.test").count, 1)
        try store.clear(origin: nil)
        XCTAssertEqual(try store.notes(for: "https://two.test").count, 0)
    }

    func testEvictsLeastRecentlyUsedOriginsBeyondTheCap() throws {
        let store = makeStore()
        for index in 0...SiteMemoryStore.maxOrigins {
            try store.append(
                origin: "https://site\(index).test",
                question: "q",
                answer: "a",
                now: Date(timeIntervalSince1970: Double(index))
            )
        }
        XCTAssertEqual(try store.notes(for: "https://site0.test").count, 0)
        XCTAssertEqual(try store.notes(for: "https://site\(SiteMemoryStore.maxOrigins).test").count, 1)
    }
}

final class SharedEvidenceStoreTests: XCTestCase {
    private var temporaryRoot: URL!

    override func setUpWithError() throws {
        temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-guide-evidence-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryRoot)
    }

    func testPublishesABoundedPrivateSnapshotAndClearsToAbsence() throws {
        let storeURL = temporaryRoot.appendingPathComponent("eyes.json")
        let store = SharedEvidenceStore(storeURL: storeURL)
        let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)
        try store.publish(
            origin: "https://example.test",
            title: String(repeating: "t", count: 1_000),
            evidence: "{\"elements\":[]}",
            now: capturedAt
        )

        let raw = try Data(contentsOf: storeURL)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertEqual(object["origin"] as? String, "https://example.test")
        XCTAssertEqual((object["title"] as? String)?.count, SharedEvidenceStore.maxTitleLength)
        XCTAssertEqual(object["evidence"] as? String, "{\"elements\":[]}")
        XCTAssertEqual(object["captured_at"] as? Double, 1_700_000_000)
        let attributes = try FileManager.default.attributesOfItem(atPath: storeURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.int16Value, 0o600)

        store.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: storeURL.path))
        store.clear() // Clearing an already-absent snapshot stays silent.
    }
}
