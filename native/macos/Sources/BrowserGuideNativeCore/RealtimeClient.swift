import Foundation

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest, maximumResponseBytes: Int) async throws -> (Data, HTTPURLResponse)
}

public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession

    public init(timeoutSeconds: TimeInterval = 20) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeoutSeconds
        configuration.timeoutIntervalForResource = timeoutSeconds
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    public func data(for request: URLRequest, maximumResponseBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RealtimeClientError.invalidResponse
        }
        guard httpResponse.expectedContentLength < 0
                || httpResponse.expectedContentLength <= Int64(maximumResponseBytes) else {
            throw RealtimeClientError.invalidResponse
        }
        var data = Data()
        if httpResponse.expectedContentLength > 0 {
            data.reserveCapacity(Int(httpResponse.expectedContentLength))
        }
        for try await byte in bytes {
            guard data.count < maximumResponseBytes else {
                throw RealtimeClientError.invalidResponse
            }
            data.append(byte)
        }
        return (data, httpResponse)
    }
}

public enum RealtimeClientError: Error, Equatable, Sendable {
    case timedOut
    case networkFailure
    case unauthorized
    case rateLimited
    case upstreamFailure(retryable: Bool)
    case invalidResponse
}

public struct RealtimeSessionResult: Equatable, Sendable {
    public let answerSDP: String
    public let upstreamRequestID: String?

    public init(answerSDP: String, upstreamRequestID: String?) {
        self.answerSDP = answerSDP
        self.upstreamRequestID = upstreamRequestID
    }
}

public struct RealtimeClient: Sendable {
    public static let endpoint = URL(string: "https://api.openai.com/v1/realtime/calls")!

    private let transport: any HTTPTransport
    private let timeoutSeconds: TimeInterval

    public init(
        transport: any HTTPTransport = URLSessionTransport(),
        timeoutSeconds: TimeInterval = 20
    ) {
        self.transport = transport
        self.timeoutSeconds = timeoutSeconds
    }

    public func createSession(sdp: String, mode: RealtimeMode, apiKey: String) async throws -> RealtimeSessionResult {
        guard HostProtocolCodec.isValidSDP(sdp) else { throw RealtimeClientError.invalidResponse }
        let sessionData: Data
        do {
            sessionData = try Self.sessionConfiguration(mode: mode)
        } catch {
            throw RealtimeClientError.invalidResponse
        }

        let boundary = "BrowserGuide-" + UUID().uuidString
        let body = Self.multipartBody(boundary: boundary, sdp: sdp, sessionData: sessionData)
        guard body.count <= NativeMessageFrameDecoder.defaultMaximumMessageBytes else {
            throw RealtimeClientError.invalidResponse
        }

        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeoutSeconds
        request.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = body

        let responseData: Data
        let response: HTTPURLResponse
        do {
            (responseData, response) = try await transport.data(
                for: request,
                maximumResponseBytes: BrowserGuideHostConstants.maximumSDPBytes
            )
        } catch let error as URLError where error.code == .timedOut {
            throw RealtimeClientError.timedOut
        } catch let error as RealtimeClientError {
            throw error
        } catch {
            throw RealtimeClientError.networkFailure
        }

        switch response.statusCode {
        case 200..<300:
            break
        case 401, 403:
            throw RealtimeClientError.unauthorized
        case 429:
            throw RealtimeClientError.rateLimited
        case 500..<600:
            throw RealtimeClientError.upstreamFailure(retryable: true)
        default:
            throw RealtimeClientError.upstreamFailure(retryable: false)
        }

        guard responseData.count <= BrowserGuideHostConstants.maximumSDPBytes,
              let answer = String(data: responseData, encoding: .utf8),
              HostProtocolCodec.isValidSDP(answer) else {
            throw RealtimeClientError.invalidResponse
        }
        let upstreamRequestID = response.value(forHTTPHeaderField: "x-request-id").flatMap(Self.sanitizedRequestID)
        return RealtimeSessionResult(answerSDP: answer, upstreamRequestID: upstreamRequestID)
    }

    private static func sessionConfiguration(mode: RealtimeMode) throws -> Data {
        var session: [String: Any] = [
            "type": "realtime",
            "model": BrowserGuideHostConstants.realtimeModel,
            "instructions": GuideModelContract.readOnlyInstructions,
            "output_modalities": mode == .voice ? ["audio"] : ["text"],
            "tools": GuideModelContract.realtimeTools,
            "tool_choice": "auto",
        ]
        if mode == .voice {
            session["audio"] = [
                "input": [
                    "transcription": ["model": "gpt-4o-mini-transcribe"],
                    "turn_detection": [
                        "type": "semantic_vad",
                        "create_response": true,
                        "interrupt_response": false,
                    ],
                ],
                "output": ["voice": "marin"],
            ]
        }
        return try JSONSerialization.data(withJSONObject: session, options: [.sortedKeys])
    }

    private static func multipartBody(boundary: String, sdp: String, sessionData: Data) -> Data {
        var body = Data()
        func append(_ value: String) {
            body.append(value.data(using: .utf8) ?? Data())
        }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"sdp\"\r\n")
        append("Content-Type: application/sdp\r\n\r\n")
        append(sdp)
        append("\r\n--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"session\"\r\n")
        append("Content-Type: application/json\r\n\r\n")
        body.append(sessionData)
        append("\r\n--\(boundary)--\r\n")
        return body
    }

    private static func sanitizedRequestID(_ value: String) -> String? {
        guard !value.isEmpty, value.utf8.count <= 128 else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
        return value.unicodeScalars.allSatisfy(allowed.contains) ? value : nil
    }

}
