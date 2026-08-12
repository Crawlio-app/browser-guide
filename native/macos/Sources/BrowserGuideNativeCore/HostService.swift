import Foundation

public struct BrowserGuideHostService: Sendable {
    private let keyStore: any APIKeyStoring
    private let realtimeClient: RealtimeClient

    public init(
        keyStore: any APIKeyStoring = KeychainStore(),
        realtimeClient: RealtimeClient = RealtimeClient()
    ) {
        self.keyStore = keyStore
        self.realtimeClient = realtimeClient
    }

    public func handle(_ request: HostRequest) async -> Data {
        do {
            let responseData = try await execute(request)
            return try HostProtocolCodec.success(requestID: request.requestID, data: responseData)
        } catch let failure as HostFailure {
            return (try? HostProtocolCodec.failure(failure)) ?? Data()
        } catch let error as KeychainStoreError {
            let failure = mapKeychainError(error, request: request)
            return (try? HostProtocolCodec.failure(failure)) ?? Data()
        } catch let error as RealtimeClientError {
            let failure = mapRealtimeError(error, requestID: request.requestID)
            return (try? HostProtocolCodec.failure(failure)) ?? Data()
        } catch {
            let failure = HostFailure(
                code: .internalError,
                message: "The native host could not complete the request.",
                retryable: false,
                requestID: request.requestID
            )
            return (try? HostProtocolCodec.failure(failure)) ?? Data()
        }
    }

    private func mapKeychainError(_ error: KeychainStoreError, request: HostRequest) -> HostFailure {
        let message: String
        switch (request.type, error) {
        case (.forgetKey, .deleteOutcomeUnknown):
            message = "Keychain removal crossed its deadline. Its outcome is not yet known; check again before retrying."
        case (.configureKey, .timedOut):
            message = "Keychain did not confirm the new API key before its deadline. Any late save will be rolled back."
        default:
            message = "macOS Keychain could not complete the request."
        }
        return HostFailure(
            code: .secureStorageError,
            message: message,
            retryable: true,
            requestID: request.requestID
        )
    }

    private func execute(_ request: HostRequest) async throws -> [String: Any] {
        switch request.payload {
        case .none where request.type == .health:
            return [
                "ready": true,
                "configured": try keyStore.readAPIKey() != nil,
                "model": BrowserGuideHostConstants.realtimeModel,
            ]

        case .configureKey(let key) where request.type == .configureKey:
            try keyStore.saveAPIKey(key)
            return ["configured": true]

        case .none where request.type == .forgetKey:
            try keyStore.deleteAPIKey()
            return ["configured": false]

        case .createSession(let sdp, let mode) where request.type == .createSession:
            guard let apiKey = try keyStore.readAPIKey() else {
                throw HostFailure(
                    code: .notConfigured,
                    message: "Add an OpenAI API key in Browser Guide first.",
                    retryable: false,
                    requestID: request.requestID
                )
            }
            let result = try await realtimeClient.createSession(sdp: sdp, mode: mode, apiKey: apiKey)
            var data: [String: Any] = ["answerSdp": result.answerSDP]
            if let upstreamRequestID = result.upstreamRequestID {
                data["upstreamRequestId"] = upstreamRequestID
            }
            return data

        default:
            throw HostFailure(
                code: .invalidRequest,
                message: "The native request payload does not match its type.",
                retryable: false,
                requestID: request.requestID
            )
        }
    }

    private func mapRealtimeError(_ error: RealtimeClientError, requestID: String) -> HostFailure {
        switch error {
        case .rateLimited:
            return HostFailure(
                code: .rateLimited,
                message: "OpenAI Realtime is temporarily rate limited.",
                retryable: true,
                requestID: requestID
            )
        case .timedOut:
            return HostFailure(
                code: .upstreamError,
                message: "OpenAI Realtime did not respond before the timeout.",
                retryable: true,
                requestID: requestID
            )
        case .networkFailure:
            return HostFailure(
                code: .upstreamError,
                message: "OpenAI Realtime could not be reached.",
                retryable: true,
                requestID: requestID
            )
        case .unauthorized:
            return HostFailure(
                code: .invalidAPIKey,
                message: "OpenAI rejected the configured API key.",
                retryable: false,
                requestID: requestID
            )
        case .upstreamFailure(let retryable):
            return HostFailure(
                code: .upstreamError,
                message: "OpenAI Realtime rejected the session request.",
                retryable: retryable,
                requestID: requestID
            )
        case .invalidResponse:
            return HostFailure(
                code: .upstreamError,
                message: "OpenAI Realtime returned an invalid session response.",
                retryable: false,
                requestID: requestID
            )
        }
    }
}
