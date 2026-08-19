import Foundation
import Speech

/// Spike 3a: on-device speech-to-text for the voice fallback. Recognition is
/// forced on-device — if this Mac cannot transcribe locally, the request fails
/// rather than silently shipping audio to Apple's servers.
public enum SpeechTranscriberError: Error, Equatable, Sendable {
    case notAuthorized
    case onDeviceUnavailable
    /// No on-device model for the language that was actually spoken. Carries
    /// the language so the message can name it instead of failing vaguely.
    case languageUnavailable(String)
    case unreadableAudio
    case recognitionFailed(String)
    case emptyTranscript
}

public struct SpeechTranscriber: Sendable {
    public init() {}

    /// Transcribes in the language the caller says was spoken.
    ///
    /// The language is not a detail: a recogniser asked for the wrong one does
    /// not fail, it returns confident nonsense. This used to default to US
    /// English for everybody, so every question asked in another language came
    /// back as words the user never said.
    ///
    /// When the requested language has no on-device model, the fallback is the
    /// Mac's own language before US English, and the error names the language
    /// rather than saying recognition is unavailable.
    public func transcribe(wavData: Data, locale: Locale? = nil) async throws -> String {
        let status = await Self.requestAuthorization()
        guard status == .authorized else { throw SpeechTranscriberError.notAuthorized }
        let requested = locale ?? Locale.current
        guard let recognizer = Self.onDeviceRecognizer(for: requested) else {
            throw SpeechTranscriberError.languageUnavailable(
                requested.localizedString(forIdentifier: requested.identifier) ?? requested.identifier
            )
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

    /// The first recogniser that can work entirely on this Mac, preferring the
    /// language that was spoken, then this Mac's own, then US English. Trying
    /// the region-less form matters: a recogniser exists for "es" when
    /// "es-419" has no model of its own.
    static func onDeviceRecognizer(for requested: Locale) -> SFSpeechRecognizer? {
        var candidates: [String] = [requested.identifier]
        if let language = requested.identifier.split(separator: "-").first, language != requested.identifier[...] {
            candidates.append(String(language))
        }
        candidates.append(Locale.current.identifier)
        candidates.append("en-US")

        var seen = Set<String>()
        for identifier in candidates {
            let normalized = identifier.replacingOccurrences(of: "_", with: "-")
            guard seen.insert(normalized).inserted else { continue }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: normalized)),
                  recognizer.isAvailable,
                  recognizer.supportsOnDeviceRecognition else { continue }
            return recognizer
        }
        return nil
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
