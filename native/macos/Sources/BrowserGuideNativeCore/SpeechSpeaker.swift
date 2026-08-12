import AVFoundation
import Foundation

/// Spike 3a: local text-to-speech for the voice fallback. The answer is spoken
/// directly on this Mac by the helper — no audio ever crosses a network.
public final class SpeechSpeaker: @unchecked Sendable {
    private let lock = NSLock()
    private let synthesizer = AVSpeechSynthesizer()

    public init() {}

    public func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        lock.lock()
        defer { lock.unlock() }
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        synthesizer.speak(utterance)
    }

    public var isSpeaking: Bool {
        lock.lock()
        defer { lock.unlock() }
        return synthesizer.isSpeaking
    }
}
