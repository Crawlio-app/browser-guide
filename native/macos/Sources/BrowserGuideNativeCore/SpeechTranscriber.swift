import Foundation
import Speech

/// Spike 3a: on-device speech-to-text for the voice fallback. Recognition is
/// forced on-device — if this Mac cannot transcribe locally, the request fails
/// rather than silently shipping audio to Apple's servers.
public enum SpeechTranscriberError: Error, Equatable, Sendable {
    case notAuthorized
    case onDeviceUnavailable
    case unreadableAudio
    case recognitionFailed(String)
    case emptyTranscript
}

public struct SpeechTranscriber: Sendable {
    public init() {}

    public func transcribe(wavData: Data, locale: Locale = Locale(identifier: "en-US")) async throws -> String {
        let status = await Self.requestAuthorization()
        guard status == .authorized else { throw SpeechTranscriberError.notAuthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw SpeechTranscriberError.onDeviceUnavailable
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw SpeechTranscriberError.onDeviceUnavailable
        }
        // Result handlers default to the main queue, but the host's main thread
        // blocks reading stdin frames; deliver on a dedicated queue instead.
        recognizer.queue = OperationQueue()

        let audioURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-guide-transcribe-\(UUID().uuidString).wav")
        do {
            try wavData.write(to: audioURL, options: [.atomic])
        } catch {
            throw SpeechTranscriberError.unreadableAudio
        }
        defer { try? FileManager.default.removeItem(at: audioURL) }

        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        let transcript: String = try await withCheckedThrowingContinuation { continuation in
            let box = ResumeOnce()
            recognizer.recognitionTask(with: request) { result, error in
                if let error {
                    box.resume { continuation.resume(throwing: SpeechTranscriberError.recognitionFailed(error.localizedDescription)) }
                    return
                }
                guard let result, result.isFinal else { return }
                box.resume { continuation.resume(returning: result.bestTranscription.formattedString) }
            }
        }
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SpeechTranscriberError.emptyTranscript }
        return trimmed
    }

    static func requestAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current != .notDetermined { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}

/// SFSpeechRecognizer's callback can fire after a final result or error;
/// a continuation must resume exactly once.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func resume(_ body: () -> Void) {
        lock.lock()
        let first = !resumed
        resumed = true
        lock.unlock()
        if first { body() }
    }
}
