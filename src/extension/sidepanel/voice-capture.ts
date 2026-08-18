/**
 * Microphone capture for the recorder UI and for the Claude engine.
 *
 * Both engines need to show the user that their voice is being heard, so the
 * level meter is always available. Only the Claude engine needs the audio
 * itself, so PCM accumulation is opt-in: with Realtime, WebRTC already carries
 * the microphone and recording it twice would be waste.
 */

/** Target rate for on-device speech recognition; also what the WAV declares. */
export const CAPTURE_SAMPLE_RATE = 16_000;
/** Bars in the level meter. Kept in the module so the UI and the smoothing
 *  window cannot drift apart. */
export const LEVEL_BAR_COUNT = 28;

export interface VoiceCapture {
  /** Newest first: a normalized 0..1 level per bar, oldest sample last. */
  levels(): readonly number[];
  elapsedMs(): number;
  /** Stops the capture. Returns WAV bytes when PCM was requested. */
  stop(): Promise<Uint8Array | null>;
  /** Stops and discards everything, including the microphone tracks. */
  cancel(): void;
}

export interface VoiceCaptureOptions {
  /** Accumulate PCM so the utterance can be transcribed by the helper. */
  recordPcm?: boolean;
  /** Called when the level history changes, so the UI can repaint. */
  onLevel?: (levels: readonly number[]) => void;
  /** Stop tracks on cancel/stop. False when another owner holds the stream. */
  ownsStream?: boolean;
}

export async function startVoiceCapture(
  stream: MediaStream,
  options: VoiceCaptureOptions = {},
): Promise<VoiceCapture> {
  const { recordPcm = false, onLevel, ownsStream = false } = options;
  const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  if (context.state === "suspended") await context.resume();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1_024;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  const chunks: Float32Array[] = [];
  let recordedSamples = 0;
  let worklet: AudioWorkletNode | null = null;
  if (recordPcm) {
    await context.audioWorklet.addModule(chrome.runtime.getURL("audio-processor.js"));
    worklet = new AudioWorkletNode(context, "browser-guide-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      chunks.push(event.data);
      recordedSamples += event.data.length;
    };
    source.connect(worklet);
  }

  const startedAt = performance.now();
  const levels: number[] = new Array<number>(LEVEL_BAR_COUNT).fill(0);
  const sampleBuffer = new Uint8Array(analyser.fftSize);
  let frame: number | null = null;
  let closed = false;

  const readLevel = (): number => {
    analyser.getByteTimeDomainData(sampleBuffer);
    let sum = 0;
    for (const sample of sampleBuffer) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / sampleBuffer.length);
    // Speech sits low in a linear RMS scale; this curve lifts normal talking
    // into the visible range without pinning loud syllables at the ceiling.
    return Math.min(1, Math.sqrt(rms * 3.2));
  };

  const tick = () => {
    if (closed) return;
    levels.shift();
    levels.push(readLevel());
    onLevel?.(levels);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
    }
    source.disconnect();
    analyser.disconnect();
    void context.close().catch(() => undefined);
    if (ownsStream) for (const track of stream.getTracks()) track.stop();
  };

  return {
    levels: () => levels,
    elapsedMs: () => performance.now() - startedAt,
    async stop() {
      const sampleRate = context.sampleRate;
      teardown();
      if (!recordPcm || recordedSamples === 0) return null;
      return encodeWav(chunks, recordedSamples, sampleRate);
    },
    cancel() {
      chunks.length = 0;
      recordedSamples = 0;
      teardown();
    },
  };
}

/** 16-bit PCM WAV: what SFSpeechRecognizer reads and what the helper expects. */
export function encodeWav(chunks: readonly Float32Array[], sampleCount: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
