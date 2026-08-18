import Foundation

/// The Claude engine's completion relay: the panel owns the conversation and
/// sends bounded Anthropic-style messages; this client injects the model, the
/// read-only contract (system + tools), and the user's own imported OAuth
/// token, then returns sanitized content blocks for the panel's tool loop.
public enum AnthropicClientConstants {
    public static let endpoint = "https://api.anthropic.com/v1/messages"
    public static let model = "claude-sonnet-5"
    public static let apiVersion = "2023-06-01"
    public static let oauthBeta = "oauth-2025-04-20"
    public static let maxResponseTokens = 1_024
    public static let maximumResponseBytes = 1_024 * 1_024
}

public struct AnthropicCompletionResult: Sendable {
    /// Sanitized content blocks: only `text` and `tool_use` shapes survive.
    public let contentJSON: Data
    public let stopReason: String
}

public struct AnthropicClient: Sendable {
    private let transport: any HTTPTransport
    private let timeoutSeconds: TimeInterval

    public init(transport: any HTTPTransport = URLSessionTransport(timeoutSeconds: 60), timeoutSeconds: TimeInterval = 60) {
        self.transport = transport
        self.timeoutSeconds = timeoutSeconds
    }

    public func complete(messagesData: Data, accessToken: String) async throws -> AnthropicCompletionResult {
        guard let url = URL(string: AnthropicClientConstants.endpoint),
              let messages = (try? JSONSerialization.jsonObject(with: messagesData)) as? [[String: Any]] else {
            throw RealtimeClientError.invalidResponse
        }
        var request = URLRequest(url: url, timeoutInterval: timeoutSeconds)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(AnthropicClientConstants.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue(AnthropicClientConstants.oauthBeta, forHTTPHeaderField: "anthropic-beta")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": AnthropicClientConstants.model,
            "max_tokens": AnthropicClientConstants.maxResponseTokens,
            "system": GuideModelContract.readOnlyInstructions,
            "tools": GuideModelContract.anthropicTools,
            "messages": messages,
        ])

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.data(
                for: request,
                maximumResponseBytes: AnthropicClientConstants.maximumResponseBytes
            )
        } catch let error as RealtimeClientError {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            throw RealtimeClientError.timedOut
        } catch {
            throw RealtimeClientError.networkFailure
        }

        switch response.statusCode {
        case 200:
            break
        case 401, 403:
            throw RealtimeClientError.unauthorized
        case 429:
            throw RealtimeClientError.rateLimited
        case 500...599:
            throw RealtimeClientError.upstreamFailure(retryable: true)
        default:
            throw RealtimeClientError.upstreamFailure(retryable: false)
        }

        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let content = object["content"] as? [[String: Any]] else {
            throw RealtimeClientError.invalidResponse
        }
        // Sanitize: pass through only the shapes the panel's tool loop expects.
        var sanitized: [[String: Any]] = []
        for block in content {
            switch block["type"] as? String {
            case "text":
                guard let text = block["text"] as? String else { continue }
                sanitized.append(["type": "text", "text": String(text.prefix(30_000))])
            case "tool_use":
                guard let id = block["id"] as? String, id.count <= 200,
                      let name = block["name"] as? String, name.count <= 64,
                      let input = block["input"] as? [String: Any],
                      JSONSerialization.isValidJSONObject(input) else { continue }
                sanitized.append(["type": "tool_use", "id": id, "name": name, "input": input])
            default:
                continue
            }
        }
        guard !sanitized.isEmpty else { throw RealtimeClientError.invalidResponse }
        let stopReason = (object["stop_reason"] as? String).flatMap { $0.count <= 40 ? $0 : nil } ?? "end_turn"
        return AnthropicCompletionResult(
            contentJSON: try JSONSerialization.data(withJSONObject: sanitized, options: [.sortedKeys]),
            stopReason: stopReason
        )
    }
}
