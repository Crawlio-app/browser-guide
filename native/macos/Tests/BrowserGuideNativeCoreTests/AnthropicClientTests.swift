import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class AnthropicClientTests: XCTestCase {
    func testSendsOAuthHeadersAndParsesTheTextContent() async throws {
        let transport = CapturingAnthropicTransport(
            statusCode: 200,
            body: [
                "content": [
                    ["type": "text", "text": "This page is a billing dashboard."],
                ],
            ]
        )
        let client = AnthropicClient(transport: transport)
        let text = try await client.complete(prompt: "What is this page?", accessToken: "sk-ant-oat-token")

        XCTAssertEqual(text, "This page is a billing dashboard.")
        let request = await transport.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, AnthropicClientConstants.endpoint)
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer sk-ant-oat-token")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-beta"), AnthropicClientConstants.oauthBeta)
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-version"), AnthropicClientConstants.apiVersion)
        let body = try XCTUnwrap(request?.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["model"] as? String, AnthropicClientConstants.model)
        XCTAssertNotNil(object["system"] as? String)
    }

    func testMapsAuthenticationAndRateLimitFailures() async {
        for (status, expected) in [(401, RealtimeClientError.unauthorized), (403, .unauthorized), (429, .rateLimited)] {
            let client = AnthropicClient(transport: CapturingAnthropicTransport(statusCode: status, body: [:]))
            do {
                _ = try await client.complete(prompt: "q", accessToken: "t")
                XCTFail("expected status \(status) to throw")
            } catch let error as RealtimeClientError {
                XCTAssertEqual(error, expected)
            } catch {
                XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testRejectsResponsesWithoutTextContent() async {
        let client = AnthropicClient(
            transport: CapturingAnthropicTransport(statusCode: 200, body: ["content": []])
        )
        do {
            _ = try await client.complete(prompt: "q", accessToken: "t")
            XCTFail("expected an invalid-response error")
        } catch let error as RealtimeClientError {
            XCTAssertEqual(error, .invalidResponse)
        } catch {
            XCTFail("unexpected error: \(error)")
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
