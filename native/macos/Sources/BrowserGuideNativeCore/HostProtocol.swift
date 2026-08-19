import CoreFoundation
import Foundation

public enum BrowserGuideHostConstants {
    public static let hostName = "com.crawlio.browser_guide"
    public static let protocolVersion = 1
    public static let hostVersion = "1.0.0"
    public static let realtimeModel = "gpt-realtime"
    public static let maximumSDPBytes = 512 * 1_024
    public static let maximumAPIKeyBytes = 503
    public static let maximumNativeResponseBytes = 1_024 * 1_024
    // Sized against the 768 KiB framed-envelope ceiling AFTER base64 inflation:
    // ~557 KiB of raw 16 kHz mono 16-bit WAV, roughly 17 seconds of speech.
    public static let maximumTranscribeAudioBase64Chars = 760_000
    public static let maximumCompletionMessages = 24
    public static let maximumCompletionBlocks = 8
    public static let maximumCompletionTextChars = 30_000
    public static let maximumToolResultChars = 4_000
    public static let unknownRequestID = "00000000-0000-4000-8000-000000000000"
}

public enum HostRequestType: String, Sendable {
    case health = "HOST_HEALTH"
    case configureKey = "HOST_CONFIGURE_KEY"
    case forgetKey = "HOST_FORGET_KEY"
    case createSession = "HOST_CREATE_SESSION"
    case importCredentials = "HOST_IMPORT_CREDENTIALS"
    case credentialSources = "HOST_CREDENTIAL_SOURCES"
    case memoryGet = "HOST_MEMORY_GET"
    case memoryAppend = "HOST_MEMORY_APPEND"
    case memoryClear = "HOST_MEMORY_CLEAR"
    case publishEvidence = "HOST_PUBLISH_EVIDENCE"
    case clearEvidence = "HOST_CLEAR_EVIDENCE"
    case transcribe = "HOST_TRANSCRIBE"
    case complete = "HOST_COMPLETE"
}

public enum RealtimeMode: String, Sendable {
    case text
    case voice
}

public enum HostRequestPayload: Sendable, Equatable {
    case none
    case configureKey(String)
    case createSession(sdp: String, mode: RealtimeMode)
    case importCredentials(CredentialProvider)
    case memoryGet(origin: String)
    case memoryAppend(origin: String, question: String, answer: String)
    case memoryClear(origin: String?)
    case publishEvidence(origin: String, title: String, evidence: String)
    case transcribe(wavData: Data, locale: String?)
    case complete(messagesData: Data)
}

public struct HostRequest: Sendable, Equatable {
    public let requestID: String
    public let type: HostRequestType
    public let payload: HostRequestPayload

    public init(requestID: String, type: HostRequestType, payload: HostRequestPayload) {
        self.requestID = requestID
        self.type = type
        self.payload = payload
    }
}

public struct HostFailure: Error, Equatable, Sendable {
    public enum Code: String, Sendable {
        case invalidRequest = "INVALID_REQUEST"
        case unsupportedVersion = "UNSUPPORTED_VERSION"
        case payloadTooLarge = "PAYLOAD_TOO_LARGE"
        case notConfigured = "NOT_CONFIGURED"
        case invalidAPIKey = "INVALID_API_KEY"
        case rateLimited = "RATE_LIMITED"
        case secureStorageError = "SECURE_STORAGE_ERROR"
        case upstreamError = "UPSTREAM_ERROR"
        case internalError = "INTERNAL_ERROR"
    }

    public let code: Code
    public let message: String
    public let retryable: Bool
    public let requestID: String

    public init(code: Code, message: String, retryable: Bool, requestID: String) {
        self.code = code
        self.message = String(message.prefix(1_000))
        self.retryable = retryable
        self.requestID = requestID
    }
}

public enum HostProtocolCodec {
    public static func decodeRequest(_ data: Data) throws -> HostRequest {
        guard data.count <= NativeMessageFrameDecoder.defaultMaximumMessageBytes else {
            throw HostFailure(
                code: .payloadTooLarge,
                message: "The native message exceeds the allowed size.",
                retryable: false,
                requestID: BrowserGuideHostConstants.unknownRequestID
            )
        }

        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw invalid("The native message is not valid JSON.")
        }
        guard let object = raw as? [String: Any] else {
            throw invalid("The native message must be a JSON object.")
        }

        let candidateRequestID = validRequestID(object["requestId"])
            ? object["requestId"] as? String ?? BrowserGuideHostConstants.unknownRequestID
            : BrowserGuideHostConstants.unknownRequestID
        let rootKeys = Set(object.keys)
        guard rootKeys.isSubset(of: ["version", "requestId", "type", "payload"]),
              rootKeys.isSuperset(of: ["version", "requestId", "type"]) else {
            throw invalid("The native request contains missing or unsupported fields.", requestID: candidateRequestID)
        }
        guard isInteger(object["version"], equalTo: BrowserGuideHostConstants.protocolVersion) else {
            throw HostFailure(
                code: .unsupportedVersion,
                message: "Unsupported native messaging protocol version.",
                retryable: false,
                requestID: candidateRequestID
            )
        }
        guard let requestID = object["requestId"] as? String, validRequestID(requestID) else {
            throw invalid("requestId must be a canonical UUID.")
        }
        guard let typeName = object["type"] as? String, let type = HostRequestType(rawValue: typeName) else {
            throw invalid("The native request type is unsupported.", requestID: requestID)
        }

        switch type {
        case .health, .forgetKey, .clearEvidence, .credentialSources:
            guard object["payload"] == nil else {
                throw invalid("This native request must omit payload.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .none)

        case .publishEvidence:
            let payload = try exactPayload(object["payload"], keys: ["origin", "title", "evidence"], requestID: requestID)
            guard let origin = payload["origin"] as? String, isWebOrigin(origin),
                  let title = payload["title"] as? String, title.count <= SharedEvidenceStore.maxTitleLength,
                  let evidence = payload["evidence"] as? String, !evidence.isEmpty,
                  evidence.count <= SharedEvidenceStore.maxEvidenceLength else {
                throw invalid("The evidence payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .publishEvidence(origin: origin, title: title, evidence: evidence))

        case .configureKey:
            let payload = try exactPayload(object["payload"], keys: ["key"], requestID: requestID)
            guard let key = payload["key"] as? String else {
                throw invalid("The key payload is invalid.", requestID: requestID)
            }
            let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed == key,
                  trimmed.lengthOfBytes(using: .utf8) <= BrowserGuideHostConstants.maximumAPIKeyBytes,
                  trimmed.range(of: #"^sk-[A-Za-z0-9_-]{20,500}$"#, options: .regularExpression) != nil else {
                throw invalid("Enter a valid OpenAI API key.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .configureKey(trimmed))

        case .importCredentials:
            let payload = try exactPayload(object["payload"], keys: ["provider"], requestID: requestID)
            guard let providerName = payload["provider"] as? String,
                  let provider = CredentialProvider(rawValue: providerName) else {
                throw invalid("The import payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .importCredentials(provider))

        case .memoryGet:
            let payload = try exactPayload(object["payload"], keys: ["origin"], requestID: requestID)
            guard let origin = payload["origin"] as? String, isWebOrigin(origin) else {
                throw invalid("The memory payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .memoryGet(origin: origin))

        case .memoryAppend:
            let payload = try exactPayload(object["payload"], keys: ["origin", "question", "answer"], requestID: requestID)
            guard let origin = payload["origin"] as? String, isWebOrigin(origin),
                  let question = payload["question"] as? String, !question.isEmpty, question.count <= 2_000,
                  let answer = payload["answer"] as? String, !answer.isEmpty, answer.count <= 4_000 else {
                throw invalid("The memory payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .memoryAppend(origin: origin, question: question, answer: answer))

        case .memoryClear:
            if object["payload"] == nil {
                return HostRequest(requestID: requestID, type: type, payload: .memoryClear(origin: nil))
            }
            let payload = try exactPayload(object["payload"], keys: ["origin"], requestID: requestID)
            guard let origin = payload["origin"] as? String, isWebOrigin(origin) else {
                throw invalid("The memory payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .memoryClear(origin: origin))

        case .transcribe:
            let payload = try exactPayload(
                object["payload"],
                keys: ["audio", "format"],
                optionalKeys: ["locale"],
                requestID: requestID
            )
            guard payload["format"] as? String == "wav",
                  let encoded = payload["audio"] as? String,
                  encoded.count <= BrowserGuideHostConstants.maximumTranscribeAudioBase64Chars,
                  let wavData = Data(base64Encoded: encoded),
                  wavData.count >= 44,
                  wavData.prefix(4) == Data("RIFF".utf8) else {
                throw invalid("The transcription payload is invalid.", requestID: requestID)
            }
            var locale: String?
            if let requested = payload["locale"] {
                guard let tag = requested as? String, isBCP47Locale(tag) else {
                    throw invalid("The transcription payload is invalid.", requestID: requestID)
                }
                locale = tag
            }
            return HostRequest(requestID: requestID, type: type, payload: .transcribe(wavData: wavData, locale: locale))

        case .complete:
            let payload = try exactPayload(object["payload"], keys: ["messages"], requestID: requestID)
            guard let messages = payload["messages"] as? [[String: Any]],
                  isValidCompletionMessages(messages),
                  let messagesData = try? JSONSerialization.data(withJSONObject: messages, options: [.sortedKeys]) else {
                throw invalid("The completion payload is invalid.", requestID: requestID)
            }
            return HostRequest(requestID: requestID, type: type, payload: .complete(messagesData: messagesData))

        case .createSession:
            let payload = try exactPayload(object["payload"], keys: ["sdp", "mode"], requestID: requestID)
            guard let sdp = payload["sdp"] as? String,
                  let modeName = payload["mode"] as? String,
                  let mode = RealtimeMode(rawValue: modeName) else {
                throw invalid("The session payload is invalid.", requestID: requestID)
            }
            guard isValidSDP(sdp) else {
                let code: HostFailure.Code = sdp.lengthOfBytes(using: .utf8) > BrowserGuideHostConstants.maximumSDPBytes
                    ? .payloadTooLarge
                    : .invalidRequest
                throw HostFailure(
                    code: code,
                    message: code == .payloadTooLarge
                        ? "The WebRTC session description exceeds the allowed size."
                        : "The WebRTC session description is invalid.",
                    retryable: false,
                    requestID: requestID
                )
            }
            return HostRequest(requestID: requestID, type: type, payload: .createSession(sdp: sdp, mode: mode))
        }
    }

    public static func success(requestID: String, data: [String: Any]) throws -> Data {
        let encoded = try encode([
            "version": BrowserGuideHostConstants.protocolVersion,
            "requestId": requestID,
            "ok": true,
            "data": data,
        ])
        guard encoded.count <= BrowserGuideHostConstants.maximumNativeResponseBytes else {
            throw HostFailure(
                code: .payloadTooLarge,
                message: "The native response exceeds the allowed size.",
                retryable: false,
                requestID: requestID
            )
        }
        return encoded
    }

    public static func failure(_ failure: HostFailure) throws -> Data {
        try encode([
            "version": BrowserGuideHostConstants.protocolVersion,
            "requestId": failure.requestID,
            "ok": false,
            "error": [
                "code": failure.code.rawValue,
                "message": failure.message,
                "retryable": failure.retryable,
            ],
        ])
    }

    public static func isValidSDP(_ value: String) -> Bool {
        let size = value.lengthOfBytes(using: .utf8)
        return size >= 4
            && size <= BrowserGuideHostConstants.maximumSDPBytes
            && (value.hasPrefix("v=0\r\n") || value.hasPrefix("v=0\n"))
    }

    /// Optional keys exist for one reason: a field added after a helper
    /// shipped must not make that helper reject the request. Required keys stay
    /// exact, so nothing unrecognised slips through either way.
    private static func isBCP47Locale(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$"#, options: .regularExpression) != nil
    }

    private static func exactPayload(
        _ rawPayload: Any?,
        keys: Set<String>,
        optionalKeys: Set<String> = [],
        requestID: String
    ) throws -> [String: Any] {
        guard let payload = rawPayload as? [String: Any],
              keys.isSubset(of: Set(payload.keys)),
              Set(payload.keys).isSubset(of: keys.union(optionalKeys)) else {
            throw invalid("The native request payload contains missing or unsupported fields.", requestID: requestID)
        }
        return payload
    }

    /// Bounded Anthropic-style conversation: user/assistant turns whose content
    /// blocks are text, tool_use, or tool_result with exact keys and size caps.
    private static func isValidCompletionMessages(_ messages: [[String: Any]]) -> Bool {
        guard (1...BrowserGuideHostConstants.maximumCompletionMessages).contains(messages.count) else { return false }
        for message in messages {
            guard Set(message.keys) == ["role", "content"],
                  let role = message["role"] as? String, role == "user" || role == "assistant",
                  let content = message["content"] as? [[String: Any]],
                  (1...BrowserGuideHostConstants.maximumCompletionBlocks).contains(content.count) else { return false }
            for block in content {
                switch block["type"] as? String {
                case "text":
                    guard Set(block.keys) == ["type", "text"],
                          let text = block["text"] as? String,
                          !text.isEmpty,
                          text.count <= BrowserGuideHostConstants.maximumCompletionTextChars else { return false }
                case "tool_use":
                    guard Set(block.keys) == ["type", "id", "name", "input"],
                          let id = block["id"] as? String, !id.isEmpty, id.count <= 200,
                          let name = block["name"] as? String,
                          name == "show_guidance" || name == "clear_guidance",
                          let input = block["input"] as? [String: Any],
                          JSONSerialization.isValidJSONObject(input) else { return false }
                case "tool_result":
                    guard Set(block.keys) == ["type", "tool_use_id", "content"],
                          let toolUseId = block["tool_use_id"] as? String, !toolUseId.isEmpty, toolUseId.count <= 200,
                          let resultContent = block["content"] as? String,
                          resultContent.count <= BrowserGuideHostConstants.maximumToolResultChars else { return false }
                default:
                    return false
                }
            }
        }
        return true
    }

    private static func isWebOrigin(_ value: String) -> Bool {
        guard value.count <= 500, let url = URL(string: value),
              let scheme = url.scheme, scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty,
              url.path.isEmpty || url.path == "/" else { return false }
        return true
    }

    private static func validRequestID(_ raw: Any?) -> Bool {
        guard let value = raw as? String else { return false }
        return value.range(
            of: #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func isInteger(_ raw: Any?, equalTo expected: Int) -> Bool {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.intValue == expected && number.doubleValue == Double(expected)
    }

    private static func invalid(
        _ message: String,
        requestID: String = BrowserGuideHostConstants.unknownRequestID
    ) -> HostFailure {
        HostFailure(code: .invalidRequest, message: message, retryable: false, requestID: requestID)
    }

    private static func encode(_ object: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw HostFailure(
                code: .internalError,
                message: "The native host could not encode its response.",
                retryable: false,
                requestID: object["requestId"] as? String ?? BrowserGuideHostConstants.unknownRequestID
            )
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
