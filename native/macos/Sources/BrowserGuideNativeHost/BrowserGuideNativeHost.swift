import BrowserGuideNativeCore
import Foundation

@main
struct BrowserGuideNativeHost {
    static func main() async {
        let input = FileHandle.standardInput
        let writer = NativeResponseWriter(output: FileHandle.standardOutput)
        let requestTasks = NativeRequestTaskRegistry()
        let service = makeService()
        var decoder = NativeMessageFrameDecoder()

        while true {
            let chunk = input.availableData
            if chunk.isEmpty {
                do {
                    try decoder.finish()
                } catch {
                    await writer.writeFailure(
                        HostFailure(
                            code: .invalidRequest,
                            message: "The native message frame was truncated.",
                            retryable: false,
                            requestID: BrowserGuideHostConstants.unknownRequestID
                        )
                    )
                }
                await requestTasks.cancelAll()
                return
            }

            let payloads: [Data]
            do {
                payloads = try decoder.append(chunk)
            } catch NativeMessageFramingError.messageTooLarge {
                await writer.writeFailure(
                    HostFailure(
                        code: .payloadTooLarge,
                        message: "The native message exceeds the allowed size.",
                        retryable: false,
                        requestID: BrowserGuideHostConstants.unknownRequestID
                    )
                )
                await requestTasks.cancelAll()
                return
            } catch {
                await writer.writeFailure(
                    HostFailure(
                        code: .invalidRequest,
                        message: "The native message frame is invalid.",
                        retryable: false,
                        requestID: BrowserGuideHostConstants.unknownRequestID
                    )
                )
                await requestTasks.cancelAll()
                return
            }

            for payload in payloads {
                do {
                    let request = try HostProtocolCodec.decodeRequest(payload)
                    await requestTasks.submit(requestType: request.type) {
                        let response = await service.handle(request)
                        _ = await writer.write(response)
                    }
                } catch let failure as HostFailure {
                    await writer.writeFailure(failure)
                } catch {
                    let failure = HostFailure(
                        code: .internalError,
                        message: "The native host could not process the request.",
                        retryable: false,
                        requestID: BrowserGuideHostConstants.unknownRequestID
                    )
                    await writer.writeFailure(failure)
                }
            }
        }
    }

    private static func makeService() -> BrowserGuideHostService {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let keyStore: any APIKeyStoring = environment["BROWSER_GUIDE_TEST_IN_MEMORY_KEYCHAIN"] == "1"
            ? DebugMemoryKeyStore()
            : KeychainStore()
        if let rawDelay = environment["BROWSER_GUIDE_TEST_REALTIME_DELAY_MILLISECONDS"],
           let delayMilliseconds = UInt64(rawDelay),
           (1...10_000).contains(delayMilliseconds) {
            return BrowserGuideHostService(
                keyStore: keyStore,
                realtimeClient: RealtimeClient(
                    transport: DebugDelayedRealtimeTransport(delayMilliseconds: delayMilliseconds),
                    timeoutSeconds: 20
                )
            )
        }
        return BrowserGuideHostService(keyStore: keyStore)
        #else
        return BrowserGuideHostService()
        #endif
    }
}

/// Owns stdout so concurrent request completions can never interleave native frames.
private actor NativeResponseWriter {
    private let output: FileHandle
    private var isWritable = true

    init(output: FileHandle) {
        self.output = output
    }

    func writeFailure(_ failure: HostFailure) {
        guard let response = try? HostProtocolCodec.failure(failure) else { return }
        _ = write(response)
    }

    @discardableResult
    func write(_ payload: Data) -> Bool {
        guard isWritable,
              !payload.isEmpty,
              let framed = try? NativeMessageFrameDecoder.encode(
                payload,
                maximumMessageBytes: BrowserGuideHostConstants.maximumNativeResponseBytes
              ) else {
            return false
        }
        do {
            try output.write(contentsOf: framed)
            return true
        } catch {
            isWritable = false
            return false
        }
    }
}

/// Retains in-flight requests without retaining completed tasks for the port's lifetime.
private actor NativeRequestTaskRegistry {
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var controlTail: Task<Void, Never>?

    func submit(
        requestType: HostRequestType,
        _ operation: @escaping @Sendable () async -> Void
    ) {
        let taskID = UUID()
        // Key configuration, deletion, and health are an ordered control plane.
        // Session creation waits for earlier control work, but never becomes the
        // control tail, so its upstream network wait cannot block later controls.
        let precedingControl = controlTail
        tasks[taskID] = Task { [weak self] in
            if let precedingControl {
                await precedingControl.value
            }
            await operation()
            await self?.remove(taskID)
        }
        if requestType != .createSession {
            controlTail = tasks[taskID]
        }
    }

    func cancelAll() {
        for task in tasks.values {
            task.cancel()
        }
        tasks.removeAll()
        controlTail = nil
    }

    private func remove(_ taskID: UUID) {
        tasks.removeValue(forKey: taskID)
    }
}

#if DEBUG
private final class DebugMemoryKeyStore: APIKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var apiKey: String?

    func readAPIKey() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return apiKey
    }

    func saveAPIKey(_ apiKey: String) throws {
        lock.lock()
        self.apiKey = apiKey
        lock.unlock()
    }

    func deleteAPIKey() throws {
        lock.lock()
        apiKey = nil
        lock.unlock()
    }
}

private struct DebugDelayedRealtimeTransport: HTTPTransport {
    let delayMilliseconds: UInt64

    func data(for request: URLRequest, maximumResponseBytes: Int) async throws -> (Data, HTTPURLResponse) {
        try await Task.sleep(nanoseconds: delayMilliseconds * 1_000_000)
        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["x-request-id": "browser-guide-debug-delay"]
              ) else {
            throw RealtimeClientError.invalidResponse
        }
        return (Data("v=0\r\n".utf8), response)
    }
}
#endif
