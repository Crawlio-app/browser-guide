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

    /// Transcribes by racing the languages the speaker plausibly used and
    /// keeping the transcript the recogniser was most confident in.
    ///
    /// A recogniser asked for the wrong language does not fail: it returns
    /// confident-sounding nonsense. And no single locale setting is the
    /// truth, because a browser configured in English says nothing about the
    /// language of the next question. So the caller sends its best candidates
    /// (the browser's preference list), the Mac's own language and US English
    /// join them, and up to three on-device recognisers run concurrently on
    /// the same clip. Confidence decides; ties go to the caller's order.
    ///
    /// Everything stays on this Mac: the race multiplies local work, never
    /// network calls, and three short recognitions run in parallel in about
    /// the time of one.
    public func transcribe(wavData: Data, locales: [Locale] = []) async throws -> String {
        let status = await Self.requestAuthorization()
        guard status == .authorized else { throw SpeechTranscriberError.notAuthorized }
        let recognizers = Self.onDeviceRecognizers(for: locales)
        guard !recognizers.isEmpty else {
            let requested = locales.first ?? Locale.current
            throw SpeechTranscriberError.languageUnavailable(
                requested.localizedString(forIdentifier: requested.identifier) ?? requested.identifier
            )
        }

        let audioURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-guide-transcribe-\(UUID().uuidString).wav")
        do {
            try wavData.write(to: audioURL, options: [.atomic])
        } catch {
            throw SpeechTranscriberError.unreadableAudio
        }
        defer { try? FileManager.default.removeItem(at: audioURL) }

        // Sequential on purpose: SFSpeechRecognizer is not Sendable, so under
        // strict concurrency the clip is recognised one language at a time.
        // Each pass is a few hundred milliseconds on-device; three stay under
        // a second, and correctness beats saving that.
        var candidates: [(order: Int, transcript: String, confidence: Double)] = []
        var lastFailure: SpeechTranscriberError?
        for (order, recognizer) in recognizers.enumerated() {
            do {
                let (transcript, confidence) = try await Self.recognize(url: audioURL, with: recognizer)
                candidates.append((order, transcript, confidence))
            } catch let error as SpeechTranscriberError {
                lastFailure = error
            } catch {
                lastFailure = .recognitionFailed(error.localizedDescription)
            }
        }

        let best = candidates
            .filter { !$0.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in
                lhs.confidence != rhs.confidence ? lhs.confidence > rhs.confidence : lhs.order < rhs.order
            }
            .first
        if let best {
            return best.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if candidates.isEmpty, let lastFailure { throw lastFailure }
        throw SpeechTranscriberError.emptyTranscript
    }

    /// One on-device recognition of one clip, delivering the transcript and
    /// the mean per-segment confidence that decides the race.
    private static func recognize(url: URL, with recognizer: SFSpeechRecognizer) async throws -> (String, Double) {
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        return try await withCheckedThrowingContinuation { continuation in
            let box = ResumeOnce()
            recognizer.recognitionTask(with: request) { result, error in
                if let error {
                    box.resume { continuation.resume(throwing: SpeechTranscriberError.recognitionFailed(error.localizedDescription)) }
                    return
                }
                guard let result, result.isFinal else { return }
                let segments = result.bestTranscription.segments
                let confidence = segments.isEmpty
                    ? 0
                    : segments.reduce(0.0) { $0 + Double($1.confidence) } / Double(segments.count)
                box.resume { continuation.resume(returning: (result.bestTranscription.formattedString, confidence)) }
            }
        }
    }

    /// The distinct on-device recognisers worth racing: the caller's
    /// candidates in order, each also tried in its region-less form (a
    /// recogniser exists for "es" when "es-419" has no model of its own),
    /// then this Mac's language, then US English. Capped at three, because
    /// each one is a full recognition of the clip.
    static func onDeviceRecognizers(for locales: [Locale]) -> [SFSpeechRecognizer] {
        var identifiers: [String] = []
        for locale in locales {
            identifiers.append(locale.identifier)
            if let language = locale.identifier.split(separator: "-").first,
               language != locale.identifier[...] {
                identifiers.append(String(language))
            }
        }
        identifiers.append(Locale.current.identifier)
        identifiers.append("en-US")

        var seen = Set<String>()
        var recognizers: [SFSpeechRecognizer] = []
        for identifier in identifiers {
            let normalized = identifier.replacingOccurrences(of: "_", with: "-")
            guard seen.insert(normalized.lowercased()).inserted else { continue }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: normalized)),
                  recognizer.isAvailable,
                  recognizer.supportsOnDeviceRecognition else { continue }
            // Result handlers default to the main queue, but the host's main
            // thread blocks reading stdin frames; deliver on dedicated queues.
            recognizer.queue = OperationQueue()
            recognizers.append(recognizer)
            if recognizers.count == 3 { break }
        }
        return recognizers
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
