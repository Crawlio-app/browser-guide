import Foundation
import XCTest
@testable import BrowserGuideNativeCore

private final class MemoryKeyStore: APIKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func readAPIKey() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func saveAPIKey(_ apiKey: String) throws {
        lock.lock()
        defer { lock.unlock() }
        value = apiKey
    }

    func deleteAPIKey() throws {
        lock.lock()
        defer { lock.unlock() }
        value = nil
    }
}

final class HostServiceTests: XCTestCase {
    private let requestID = "550e8400-e29b-41d4-a716-446655440000"

    func testHealthConfigureAndForgetStayCorrelated() async throws {
        let store = MemoryKeyStore()
        let service = BrowserGuideHostService(keyStore: store)

        let initial = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .health,
            payload: .none
        )))
        XCTAssertEqual(initial["requestId"] as? String, requestID)
        XCTAssertEqual((initial["data"] as? [String: Any])?["configured"] as? Bool, false)

        let fakeKey = "sk-" + String(repeating: "a", count: 24)
        let configured = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .configureKey,
            payload: .configureKey(fakeKey)
        )))
        XCTAssertEqual((configured["data"] as? [String: Any])?["configured"] as? Bool, true)
        XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: configured), as: UTF8.self).contains(fakeKey))

        let forgotten = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .forgetKey,
            payload: .none
        )))
        XCTAssertEqual((forgotten["data"] as? [String: Any])?["configured"] as? Bool, false)
    }

    func testCreateSessionWithoutKeyReturnsStructuredNotConfiguredError() async throws {
        let service = BrowserGuideHostService(keyStore: MemoryKeyStore())
        let response = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .createSession,
            payload: .createSession(sdp: "v=0\r\ns=offer\r\n", mode: .text)
        )))
        let error = try XCTUnwrap(response["error"] as? [String: Any])
        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(error["code"] as? String, "NOT_CONFIGURED")
        XCTAssertEqual(error["retryable"] as? Bool, false)
    }

    func testOpenAIAuthenticationFailureReturnsInvalidAPIKeyRecoveryCode() async throws {
        let store = MemoryKeyStore()
        try store.saveAPIKey("sk-" + String(repeating: "a", count: 24))
        let service = BrowserGuideHostService(
            keyStore: store,
            realtimeClient: RealtimeClient(transport: UnauthorizedTransport())
        )
        let response = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .createSession,
            payload: .createSession(sdp: "v=0\r\ns=offer\r\n", mode: .text)
        )))
        let error = try XCTUnwrap(response["error"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(error["code"] as? String, "INVALID_API_KEY")
        XCTAssertEqual(error["retryable"] as? Bool, false)
    }

    func testTimedOutDeleteUsesExistingStorageCodeWithTruthfulUnknownOutcome() async throws {
        let service = BrowserGuideHostService(keyStore: DeleteOutcomeUnknownKeyStore())
        let response = try responseObject(await service.handle(HostRequest(
            requestID: requestID,
            type: .forgetKey,
            payload: .none
        )))
        let error = try XCTUnwrap(response["error"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(error["code"] as? String, "SECURE_STORAGE_ERROR")
        XCTAssertEqual(error["retryable"] as? Bool, true)
        XCTAssertTrue((error["message"] as? String)?.contains("outcome is not yet known") == true)
    }

    func testTimedOutSaveResponseDoesNotEchoKeyMaterial() async throws {
        let fakeKey = "sk-" + String(repeating: "s", count: 24)
        let service = BrowserGuideHostService(keyStore: TimedOutSaveKeyStore())
        let responseData = await service.handle(HostRequest(
            requestID: requestID,
            type: .configureKey,
            payload: .configureKey(fakeKey)
        ))
        let response = try responseObject(responseData)
        let error = try XCTUnwrap(response["error"] as? [String: Any])

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(error["code"] as? String, "SECURE_STORAGE_ERROR")
        XCTAssertFalse(String(decoding: responseData, as: UTF8.self).contains(fakeKey))
    }

    private func responseObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private struct DeleteOutcomeUnknownKeyStore: APIKeyStoring {
    func readAPIKey() throws -> String? { nil }
    func saveAPIKey(_ apiKey: String) throws {}
    func deleteAPIKey() throws { throw KeychainStoreError.deleteOutcomeUnknown }
}

private struct TimedOutSaveKeyStore: APIKeyStoring {
    func readAPIKey() throws -> String? { nil }
    func saveAPIKey(_ apiKey: String) throws { throw KeychainStoreError.timedOut }
    func deleteAPIKey() throws {}
}

private struct UnauthorizedTransport: HTTPTransport {
    func data(for request: URLRequest, maximumResponseBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(
            url: RealtimeClient.endpoint,
            statusCode: 401,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (Data("rejected".utf8), response)
    }
}
