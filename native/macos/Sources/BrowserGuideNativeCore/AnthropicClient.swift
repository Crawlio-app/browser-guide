import Foundation

/// Spike 3a: text completion against the Anthropic Messages API using the
/// user's own imported Claude Code OAuth token (their token, their
/// `user:inference` scope). This is the fallback brain for users who have a
/// Claude sign-in but no OpenAI credential.
public enum AnthropicClientConstants {
    public static let endpoint = "https://api.anthropic.com/v1/messages"
    public static let model = "claude-sonnet-5"
    public static let apiVersion = "2023-06-01"
    public static let oauthBeta = "oauth-2025-04-20"
    public static let maxResponseTokens = 512
    public static let maximumResponseBytes = 1_024 * 1_024
    public static let systemPrompt = "You are Browser Guide, a read-only browser assistant. "
        + "Explain what the user asks about their current page in plain English, in at most three short sentences. "
        + "You cannot click, type, or act — only explain and point."
}

public struct AnthropicClient: Sendable {
    private let transport: any HTTPTransport
    private let timeoutSeconds: TimeInterval

    public init(transport: any HTTPTransport = URLSessionTransport(), timeoutSeconds: TimeInterval = 30) {
        self.transport = transport
        self.timeoutSeconds = timeoutSeconds
    }

    public func complete(prompt: String, accessToken: String) async throws -> String {
        guard let url = URL(string: AnthropicClientConstants.endpoint) else {
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
            "system": AnthropicClientConstants.systemPrompt,
            "messages": [["role": "user", "content": prompt]],
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
        let text = content
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw RealtimeClientError.invalidResponse }
        return text
    }
}
