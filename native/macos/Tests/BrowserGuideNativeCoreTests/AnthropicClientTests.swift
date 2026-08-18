import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class AnthropicClientTests: XCTestCase {
    private func messagesData(_ messages: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: messages)
    }

    func testSendsOAuthHeadersWithContractSystemAndTools() async throws {
        let transport = CapturingAnthropicTransport(statusCode: 200, body: [
            "content": [["type": "text", "text": "This page is a billing dashboard."]],
            "stop_reason": "end_turn",
        ])
        let client = AnthropicClient(transport: transport)
        let result = try await client.complete(
            messagesData: try messagesData([["role": "user", "content": [["type": "text", "text": "What is this page?"]]]]),
            accessToken: "sk-ant-oat-token"
        )

        let content = try XCTUnwrap(JSONSerialization.jsonObject(with: result.contentJSON) as? [[String: Any]])
        XCTAssertEqual(content.first?["text"] as? String, "This page is a billing dashboard.")
        XCTAssertEqual(result.stopReason, "end_turn")

        let request = await transport.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, AnthropicClientConstants.endpoint)
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer sk-ant-oat-token")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-beta"), AnthropicClientConstants.oauthBeta)
        let body = try XCTUnwrap(request?.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["model"] as? String, AnthropicClientConstants.model)
        XCTAssertEqual(object["system"] as? String, GuideModelContract.readOnlyInstructions)
        let tools = try XCTUnwrap(object["tools"] as? [[String: Any]])
        XCTAssertEqual(tools.compactMap { $0["name"] as? String }, ["show_guidance", "clear_guidance"])
        XCTAssertNotNil(tools.first?["input_schema"])
    }

    func testSanitizesToolUseBlocksAndDropsUnknownShapes() async throws {
        let transport = CapturingAnthropicTransport(statusCode: 200, body: [
            "content": [
                ["type": "tool_use", "id": "toolu_1", "name": "show_guidance", "input": ["refs": ["e2"], "title": "Here", "body": "Look.", "presentation": "point", "waitFor": "none"]],
                ["type": "thinking", "thinking": "must be dropped"],
                ["type": "tool_use", "id": "toolu_bad", "name": "show_guidance"],
                ["type": "text", "text": "Pointed."],
            ],
            "stop_reason": "tool_use",
        ])
        let result = try await AnthropicClient(transport: transport).complete(
            messagesData: try messagesData([["role": "user", "content": [["type": "text", "text": "q"]]]]),
            accessToken: "t"
        )
        let content = try XCTUnwrap(JSONSerialization.jsonObject(with: result.contentJSON) as? [[String: Any]])
        XCTAssertEqual(content.count, 2)
        XCTAssertEqual(content[0]["type"] as? String, "tool_use")
        XCTAssertEqual((content[0]["input"] as? [String: Any])?["title"] as? String, "Here")
        XCTAssertEqual(content[1]["type"] as? String, "text")
        XCTAssertEqual(result.stopReason, "tool_use")
    }

    func testMapsAuthenticationAndRateLimitFailures() async throws {
        for (status, expected) in [(401, RealtimeClientError.unauthorized), (403, .unauthorized), (429, .rateLimited)] {
            let client = AnthropicClient(transport: CapturingAnthropicTransport(statusCode: status, body: [:]))
            do {
                _ = try await client.complete(
                    messagesData: try messagesData([["role": "user", "content": [["type": "text", "text": "q"]]]]),
                    accessToken: "t"
                )
                XCTFail("expected status \(status) to throw")
            } catch let error as RealtimeClientError {
                XCTAssertEqual(error, expected)
            }
        }
    }

    func testRejectsResponsesWithoutUsableContent() async throws {
        let client = AnthropicClient(transport: CapturingAnthropicTransport(statusCode: 200, body: ["content": []]))
        do {
            _ = try await client.complete(
                messagesData: try messagesData([["role": "user", "content": [["type": "text", "text": "q"]]]]),
                accessToken: "t"
            )
            XCTFail("expected an invalid-response error")
        } catch let error as RealtimeClientError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }
}

private actor CapturingAnthropicTransport: HTTPTransport {
    private let statusCode: Int
    private let body: [String: Any]
    private(set) var lastRequest: URLRequest?

    init(statusCode: Int, body: [String: Any]) {
        self.statusCode = statusCode
        self.body = body
    }

    func data(for request: URLRequest, maximumResponseBytes: Int) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: [:]) else {
            throw RealtimeClientError.invalidResponse
        }
        return (try JSONSerialization.data(withJSONObject: body), response)
    }
}
