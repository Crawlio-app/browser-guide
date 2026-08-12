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
