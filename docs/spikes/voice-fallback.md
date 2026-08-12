# Spike 3a — Voice without OpenAI Realtime

**Status: prototype built on the `spike/voice-fallback` branch, awaiting live measurement + merge decision. Nothing here ships on `main`.**

## Prototype findings (2026-08-12)

- The helper gained two spike-only messages — `HOST_TRANSCRIBE` (SFSpeechRecognizer, `requiresOnDeviceRecognition = true`) and `HOST_COMPLETE` (Anthropic Messages API with the imported Claude token via the Fase 1a `freshAnthropicAccessToken` re-sync) — unreachable from the extension; the model tool surface is unchanged.
- **`HOST_SPEAK` was built and then removed**: the product's Speak toggle now uses `speechSynthesis` directly in the panel (local system voices, macOS and Windows alike), so the fallback needs no helper-side TTS at all. One less message, one less Swift component, and the same architecture serves the future Node helper port.
- **Audio format correction to the original proposal**: AVFoundation cannot decode MediaRecorder's webm/opus, so the panel-side design captures PCM (AudioWorklet) and ships 16 kHz mono 16-bit WAV instead. The 768 KiB request ceiling then caps one utterance at ~22 s — fine for push-to-talk, and chunking can lift it later.
- **Claude Code credential discovery (macOS)**: the sign-in does NOT live in `~/.claude/.credentials.json` on Macs — that is the Linux path. It lives in the login Keychain under services prefixed `Claude Code-credentials` (including per-profile suffixed variants, some holding only MCP-server tokens). The importer now enumerates those items and picks the sign-in with the freshest `expiresAt`. This fix applies to the *product's* claude-code import too, which silently never worked on Keychain-based Macs.
- Run the measurement loop with `npm run spike:voice` (from a real terminal — macOS will ask once for Speech Recognition permission and once for Keychain access, both attributed to your terminal). It speaks a fixture question with the system voice, transcribes it on-device, answers through your own Claude token, and speaks the answer aloud, printing per-stage latency.

## Problem

Voice currently requires an OpenAI credential (Codex import or pasted key) because the audio path is OpenAI Realtime over WebRTC. A user who only has a Claude Code sign-in gets typed answers but no voice. The goal is a fallback voice loop that works with the Anthropic token the harness already imports.

## Candidates

### A. Apple-native in the helper (recommended)

Speech-to-text with `SFSpeechRecognizer` (on-device where the OS supports it) and text-to-speech with `AVSpeechSynthesizer`, both inside the existing Swift helper. Zero extra installation, zero model downloads, no new binaries. The trade-off: macOS-only — but the helper is macOS-only today, and each future helper port (see spike 3b) would use its platform's native STT or opt into whisper.cpp.

### B. Embedded whisper.cpp

Cross-platform and offline, but adds 40–150 MB of model weights to a product whose distribution story is already the hard part. Lazy model download mitigates size but adds a first-run failure mode. Rejected as the default; remains the natural choice for the Node helper port if 3b proceeds and A stays Swift-only.

### C. Web Speech API in Chrome

Zero install, but Chrome's implementation has historically shipped audio to Google servers, which contradicts the privacy policy's "one recipient" claim. The new on-device variant is not broadly available. Rejected as a default.

## Confirmed seams (from code, not speculation)

- `SessionBroker` (`voice-session.ts`) plus the provider-agnostic `VoiceSessionCallbacks` are the clean boundary: the callbacks carry only text and state — no WebRTC types. An alternative `SttSessionProvider` that emits the same callback sequence leaves the panel UI, walkthrough coordinator, and overlay untouched.
- Native messaging framing caps one frame at 1 MiB. Push-to-talk audio (Opus via `MediaRecorder`) fits ~60–90 seconds per frame — a single `HOST_TRANSCRIBE` request per utterance needs no streaming or duplex protocol.
- The extension's `connect-src 'none'` CSP already forces every network byte through the helper, which is exactly where the Anthropic call belongs.

## Proposed flow

1. Panel lifts `getUserMedia` out of `openConnection`; a `MediaRecorder` tee runs only between `startListening` and `disableMicrophone` (note: a muted track emits silence frames, not nothing — stop the recorder, don't rely on mute).
2. One utterance → one `HOST_TRANSCRIBE {audio, mimeType}` frame → `SFSpeechRecognizer` in the helper → transcript.
3. `HOST_COMPLETE {prompt}` → Anthropic Messages API using the user's own imported OAuth token (their token, their `user:inference` scope, with the documented oauth beta header). Same evidence boundary and read-only tool contract as today.
4. Response text returns to the panel for display; `AVSpeechSynthesizer` speaks it directly on the Mac — no audio ever travels back over the wire.

## What the prototype must measure before a merge decision

- End-to-end latency (stop speaking → first spoken syllable) vs. Realtime's, on Apple silicon and Intel.
- `SFSpeechRecognizer` accuracy on product vocabulary ("walkthrough", UI control names) and its on-device vs. server-mode behavior per macOS version — server mode would need the same privacy disclosure scrutiny as candidate C.
- Claims impact: docs currently say "one recipient (OpenAI)". With this fallback the recipient becomes "OpenAI or Anthropic, whichever credential you connected" — an honest, deliberate update.

## Decision asked of the maintainer

Approve building prototype A behind a dev flag (no default-path changes), with the latency/accuracy measurements above as the merge gate.
