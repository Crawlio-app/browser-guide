import Foundation

public struct BrowserGuideHostService: Sendable {
    private let keyStore: any APIKeyStoring
    private let importer: (any CredentialImporting)?
    private let memory: SiteMemoryStore?
    private let evidence: SharedEvidenceStore?
    private let realtimeClient: RealtimeClient
    private let transcriber: SpeechTranscriber?
    private let anthropicClient: AnthropicClient?

    public init(
        keyStore: any APIKeyStoring,
        importer: (any CredentialImporting)? = nil,
        memory: SiteMemoryStore? = nil,
        evidence: SharedEvidenceStore? = nil,
        realtimeClient: RealtimeClient = RealtimeClient(),
        transcriber: SpeechTranscriber? = nil,
        anthropicClient: AnthropicClient? = nil
    ) {
        self.keyStore = keyStore
        self.importer = importer
        self.memory = memory
        self.evidence = evidence
        self.realtimeClient = realtimeClient
        self.transcriber = transcriber
        self.anthropicClient = anthropicClient
    }

    public init(realtimeClient: RealtimeClient = RealtimeClient()) {
        let store = FileCredentialStore()
        self.init(
            keyStore: store,
            importer: store,
            memory: SiteMemoryStore(),
            evidence: SharedEvidenceStore(),
            realtimeClient: realtimeClient,
            transcriber: SpeechTranscriber(),
            anthropicClient: AnthropicClient()
        )
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
        } catch let error as CredentialStoreError {
            let failure = mapCredentialError(error, requestID: request.requestID)
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

        case .importCredentials(let provider) where request.type == .importCredentials:
            guard let importer else {
                throw HostFailure(
                    code: .secureStorageError,
                    message: "Credential import is unavailable in this host build.",
                    retryable: false,
                    requestID: request.requestID
                )
            }
            let outcome = try importer.importCredentials(from: provider)
            return [
                "imported": true,
                "provider": outcome.provider.rawValue,
                "method": outcome.method,
                "configured": outcome.configured,
            ]

        case .memoryGet(let origin) where request.type == .memoryGet:
            let notes = (try? memory?.notes(for: origin)) ?? nil
            return ["notes": notes ?? []]

        case .memoryAppend(let origin, let question, let answer) where request.type == .memoryAppend:
            try memory?.append(origin: origin, question: question, answer: answer)
            return ["stored": true]

        case .memoryClear(let origin) where request.type == .memoryClear:
            try memory?.clear(origin: origin)
            return ["cleared": true]

        case .publishEvidence(let origin, let title, let pageEvidence) where request.type == .publishEvidence:
            try evidence?.publish(origin: origin, title: title, evidence: pageEvidence)
            return ["published": true]

        case .none where request.type == .clearEvidence:
            evidence?.clear()
            return ["cleared": true]

        case .transcribe(let wavData) where request.type == .transcribe:
            guard let transcriber else { throw spikeUnavailable(request) }
            do {
                return ["transcript": try await transcriber.transcribe(wavData: wavData)]
            } catch let error as SpeechTranscriberError {
                throw mapTranscriberError(error, requestID: request.requestID)
            }

        case .complete(let prompt) where request.type == .complete:
            guard let anthropicClient, let importer else { throw spikeUnavailable(request) }
            guard let accessToken = try importer.freshAnthropicAccessToken(now: Date()) else {
                throw HostFailure(
                    code: .notConfigured,
                    message: "Connect your Claude Code sign-in first — the voice fallback answers with your own Claude token.",
                    retryable: false,
                    requestID: request.requestID
                )
            }
            do {
                return ["text": try await anthropicClient.complete(prompt: prompt, accessToken: accessToken)]
            } catch let error as RealtimeClientError {
                // The transport errors are shared with the Realtime client, but
                // this leg talks to Anthropic — say so.
                throw mapAnthropicError(error, requestID: request.requestID)
            }

        case .createSession(let sdp, let mode) where request.type == .createSession:
            guard let apiKey = try keyStore.readAPIKey() else {
                throw HostFailure(
                    code: .notConfigured,
                    message: "Add an OpenAI API key in Browser Guide first.",
                    retryable: false,
                    requestID: request.requestID
                )
            }
            let result: RealtimeSessionResult
            do {
                result = try await realtimeClient.createSession(sdp: sdp, mode: mode, apiKey: apiKey)
            } catch RealtimeClientError.unauthorized {
                // A rejected imported key may simply be stale: re-read the
                // harness source once (Codex rotates its own key) and retry.
                guard importer?.resyncOpenAICredentialFromSource() == true,
                      let refreshedKey = try keyStore.readAPIKey() else {
                    throw RealtimeClientError.unauthorized
                }
                result = try await realtimeClient.createSession(sdp: sdp, mode: mode, apiKey: refreshedKey)
            }
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

    private func mapAnthropicError(_ error: RealtimeClientError, requestID: String) -> HostFailure {
        switch error {
        case .rateLimited:
            return HostFailure(
                code: .rateLimited,
                message: "Anthropic is temporarily rate limited for your account. Try again in a moment.",
                retryable: true,
                requestID: requestID
            )
        case .unauthorized:
            return HostFailure(
                code: .notConfigured,
                message: "Anthropic rejected your Claude sign-in. Open Claude Code once to refresh it, then try again.",
                retryable: false,
                requestID: requestID
            )
        case .timedOut, .networkFailure:
            return HostFailure(
                code: .upstreamError,
                message: "Anthropic could not be reached.",
                retryable: true,
                requestID: requestID
            )
        case .upstreamFailure(let retryable):
            return HostFailure(
                code: .upstreamError,
                message: "Anthropic rejected the completion request.",
                retryable: retryable,
                requestID: requestID
            )
        case .invalidResponse:
            return HostFailure(
                code: .upstreamError,
                message: "Anthropic returned an invalid completion response.",
                retryable: false,
                requestID: requestID
            )
        }
    }

    private func spikeUnavailable(_ request: HostRequest) -> HostFailure {
        HostFailure(
            code: .internalError,
            message: "The voice fallback is unavailable in this host build.",
            retryable: false,
            requestID: request.requestID
        )
    }

    private func mapTranscriberError(_ error: SpeechTranscriberError, requestID: String) -> HostFailure {
        switch error {
        case .notAuthorized:
            return HostFailure(
                code: .notConfigured,
                message: "Speech recognition permission is required. Grant it in System Settings > Privacy & Security > Speech Recognition.",
                retryable: false,
                requestID: requestID
            )
        case .onDeviceUnavailable:
            return HostFailure(
                code: .internalError,
                message: "On-device speech recognition is unavailable for English on this Mac; the fallback never sends audio to a server.",
                retryable: false,
                requestID: requestID
            )
        case .unreadableAudio:
            return HostFailure(
                code: .invalidRequest,
                message: "The recorded audio could not be read.",
                retryable: false,
                requestID: requestID
            )
        case .recognitionFailed(let reason):
            return HostFailure(
                code: .internalError,
                message: "Speech recognition failed: \(reason)",
                retryable: true,
                requestID: requestID
            )
        case .emptyTranscript:
            return HostFailure(
                code: .invalidRequest,
                message: "No speech was detected in the recording.",
                retryable: true,
                requestID: requestID
            )
        }
    }

    private func mapCredentialError(_ error: CredentialStoreError, requestID: String) -> HostFailure {
        switch error {
        case .importSourceMissing(let message), .importSourceInvalid(let message):
            return HostFailure(
                code: .notConfigured,
                message: message,
                retryable: false,
                requestID: requestID
            )
        case .malformedStore:
            return HostFailure(
                code: .secureStorageError,
                message: "The credential store file is damaged. Remove ~/.config/browser-guide/credentials.json and add your key again.",
                retryable: false,
                requestID: requestID
            )
        case .ioFailure(let message):
            return HostFailure(
                code: .secureStorageError,
                message: message,
                retryable: true,
                requestID: requestID
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
