import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class HostProtocolTests: XCTestCase {
    private let requestID = "550e8400-e29b-41d4-a716-446655440000"

    func testDecodesEverySupportedRequestWithExactPayloads() throws {
        XCTAssertEqual(
            try decode(["version": 1, "requestId": requestID, "type": "HOST_HEALTH"]),
            HostRequest(requestID: requestID, type: .health, payload: .none)
        )
        XCTAssertEqual(
            try decode([
                "version": 1,
                "requestId": requestID,
                "type": "HOST_CONFIGURE_KEY",
                "payload": ["key": "sk-" + String(repeating: "a", count: 20)],
            ]),
            HostRequest(
                requestID: requestID,
                type: .configureKey,
                payload: .configureKey("sk-" + String(repeating: "a", count: 20))
            )
        )
        let sdp = "v=0\r\no=browser 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
        XCTAssertEqual(
            try decode([
                "version": 1,
                "requestId": requestID,
                "type": "HOST_CREATE_SESSION",
                "payload": ["sdp": sdp, "mode": "voice"],
            ]),
            HostRequest(requestID: requestID, type: .createSession, payload: .createSession(sdp: sdp, mode: .voice))
        )
        XCTAssertEqual(
            try decode(["version": 1, "requestId": requestID, "type": "HOST_FORGET_KEY"]),
            HostRequest(requestID: requestID, type: .forgetKey, payload: .none)
        )
    }

    func testRejectsWrongVersionInvalidRequestIDAndExtraFields() throws {
        XCTAssertHostFailure(
            tryDecode(["version": 2, "requestId": requestID, "type": "HOST_HEALTH"]),
            code: .unsupportedVersion,
            requestID: requestID
        )
        XCTAssertHostFailure(
            tryDecode(["version": 1, "requestId": "not-a-uuid", "type": "HOST_HEALTH"]),
            code: .invalidRequest,
            requestID: BrowserGuideHostConstants.unknownRequestID
        )
        XCTAssertHostFailure(
            tryDecode([
                "version": 1,
                "requestId": requestID,
                "type": "HOST_CONFIGURE_KEY",
                "payload": ["key": "sk-" + String(repeating: "a", count: 20), "extra": true],
            ]),
            code: .invalidRequest,
            requestID: requestID
        )
    }

    func testEncodesCorrelatedStructuredResponses() throws {
        let success = try HostProtocolCodec.success(
            requestID: requestID,
            data: ["ready": true, "configured": false, "model": "gpt-realtime"]
        )
        let successObject = try XCTUnwrap(JSONSerialization.jsonObject(with: success) as? [String: Any])
        XCTAssertEqual(successObject["requestId"] as? String, requestID)
        XCTAssertEqual(successObject["version"] as? Int, 1)
        XCTAssertEqual(successObject["ok"] as? Bool, true)

        let failure = try HostProtocolCodec.failure(HostFailure(
            code: .notConfigured,
            message: "Add a key.",
            retryable: false,
            requestID: requestID
        ))
        let failureObject = try XCTUnwrap(JSONSerialization.jsonObject(with: failure) as? [String: Any])
        let errorObject = try XCTUnwrap(failureObject["error"] as? [String: Any])
        XCTAssertEqual(errorObject["code"] as? String, "NOT_CONFIGURED")
        XCTAssertEqual(errorObject["retryable"] as? Bool, false)
    }

    private func decode(_ object: [String: Any]) throws -> HostRequest {
        try HostProtocolCodec.decodeRequest(JSONSerialization.data(withJSONObject: object))
    }

    private func tryDecode(_ object: [String: Any]) -> Result<HostRequest, Error> {
        Result { try decode(object) }
    }

    private func XCTAssertHostFailure(
        _ result: Result<HostRequest, Error>,
        code: HostFailure.Code,
        requestID: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case .failure(let error) = result, let failure = error as? HostFailure else {
            XCTFail("Expected HostFailure", file: file, line: line)
            return
        }
        XCTAssertEqual(failure.code, code, file: file, line: line)
        XCTAssertEqual(failure.requestID, requestID, file: file, line: line)
    }

    func testDecodesAndRejectsClaudeEnginePayloads() throws {
        let wav = Data("RIFF".utf8) + Data(repeating: 0, count: 60)
        let decoded = try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_TRANSCRIBE",
            "payload": ["audio": wav.base64EncodedString(), "format": "wav"],
        ])
        XCTAssertEqual(decoded, HostRequest(requestID: requestID, type: .transcribe, payload: .transcribe(wavData: wav, locale: nil)))

        // A helper that predates the locale field still accepts the request
        // without one, and a helper that has it accepts a language tag.
        let localized = try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_TRANSCRIBE",
            "payload": ["audio": wav.base64EncodedString(), "format": "wav", "locale": "es-MX"],
        ])
        XCTAssertEqual(localized, HostRequest(requestID: requestID, type: .transcribe, payload: .transcribe(wavData: wav, locale: "es-MX")))

        // Anything that is not a language tag is still rejected outright.
        XCTAssertThrowsError(try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_TRANSCRIBE",
            "payload": ["audio": wav.base64EncodedString(), "format": "wav", "locale": "../../etc/passwd"],
        ]))

        XCTAssertThrowsError(try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_TRANSCRIBE",
            "payload": ["audio": Data("not-riff-data-here-at-all-really-long".utf8).base64EncodedString(), "format": "wav"],
        ]))
        XCTAssertThrowsError(try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_TRANSCRIBE",
            "payload": ["audio": "@@not-base64@@", "format": "wav"],
        ]))

        let messages: [[String: Any]] = [
            ["role": "user", "content": [["type": "text", "text": "What is this page?"]]],
            ["role": "assistant", "content": [
                ["type": "tool_use", "id": "toolu_1", "name": "show_guidance", "input": ["refs": ["e2"]]],
            ]],
            ["role": "user", "content": [
                ["type": "tool_result", "tool_use_id": "toolu_1", "content": "{\"ok\":true}"],
            ]],
        ]
        let completeRequest = try decode([
            "version": 1,
            "requestId": requestID,
            "type": "HOST_COMPLETE",
            "payload": ["messages": messages],
        ])
        guard case .complete(let messagesData) = completeRequest.payload else {
            return XCTFail("expected a complete payload")
        }
        let roundTripped = try XCTUnwrap(JSONSerialization.jsonObject(with: messagesData) as? [[String: Any]])
        XCTAssertEqual(roundTripped.count, 3)

        // Unknown block types, foreign tool names, and extra keys are rejected.
        for badMessages in [
            [["role": "system", "content": [["type": "text", "text": "x"]]]],
            [["role": "user", "content": [["type": "image", "source": "x"]]]],
            [["role": "user", "content": [["type": "text", "text": "x", "extra": true]]]],
            [["role": "user", "content": [["type": "tool_use", "id": "1", "name": "execute", "input": [:] as [String: Any]]]]],
            [["role": "user", "content": [] as [[String: Any]]]],
        ] as [[[String: Any]]] {
            XCTAssertThrowsError(try decode([
                "version": 1,
                "requestId": requestID,
                "type": "HOST_COMPLETE",
                "payload": ["messages": badMessages],
            ]), "should reject \(badMessages)")
        }
    }
}
