/**
 * Microphone capture for the recording bar and for the Claude engine.
 *
 * The waveform follows the same recipe Codex uses: rectify and noise-gate the
 * raw samples, average them into one bar per four CSS pixels, normalise with a
 * gamma curve so ordinary speech fills the strip, and paint mirrored bars whose
 * colour is inherited from the canvas's CSS `color`. Both engines show it, so
 * a flat strip always means the microphone, never the visualisation.
 *
 * Only the Claude engine needs the audio itself; with Realtime, WebRTC already
 * carries the microphone and recording it twice would be waste.
 */

/** Target rate for on-device speech recognition; also what the WAV declares. */
export const CAPTURE_SAMPLE_RATE = 16_000;
/** Silence floor: below this a bar is drawn at its baseline. */
const NOISE_FLOOR = 0.0025;
/** Normalisation window and curve. */
const LEVEL_FLOOR = 0.006;
const LEVEL_CEILING = 0.16;
const LEVEL_GAMMA = 0.6;
/** Seconds of history the strip holds. */
const BUFFER_SECONDS = 10;
/** One bar per this many CSS pixels. */
const PIXELS_PER_BAR = 4;
/**
 * How long to keep listening after stop is pressed, so the blocks the worklet
 * has already posted can arrive. A render quantum is 128 samples, and several
 * can be queued behind a busy main thread; this is generous on purpose,
 * because the cost of waiting is nothing and the cost of not waiting is the
 * last word of every question.
 */
const TAIL_FLUSH_MS = 120;

export interface VoiceCapture {
  elapsedMs(): number;
  /**
   * Loudest sample seen so far. Lets the caller tell "the microphone heard
   * nothing" apart from "the recogniser could not make out the words", which
   * are different problems with different fixes.
   */
  peakLevel(): number;
  /** Stops the capture. Returns WAV bytes when PCM was requested. */
  stop(): Promise<Uint8Array | null>;
  /** Stops and discards everything. */
  cancel(): void;
}

export interface VoiceCaptureOptions {
  /** Accumulate PCM so the utterance can be transcribed by the helper. */
  recordPcm?: boolean;
  /** Canvas the waveform paints into. */
  canvas?: HTMLCanvasElement | null;
  /** Called once per whole second, so the timer does not re-render at 60fps. */
  onSecond?: (elapsedMs: number) => void;
  /** Stop the stream's tracks on teardown. */
  ownsStream?: boolean;
}

export async function startVoiceCapture(
  stream: MediaStream,
  options: VoiceCaptureOptions = {},
): Promise<VoiceCapture> {
  const { recordPcm = false, canvas = null, onSecond, ownsStream = false } = options;
  const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  if (context.state === "suspended") await context.resume();
  const source = context.createMediaStreamSource(stream);
  await context.audioWorklet.addModule(chrome.runtime.getURL("audio-processor.js"));
  const worklet = new AudioWorkletNode(context, "browser-guide-recorder", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });
  source.connect(worklet);

  const pcm: Float32Array[] = [];
  let pcmSamples = 0;
  let peak = 0;
  const bars: number[] = [];
  let pending = new Float32Array(0);
  let barCount = 0;
  let samplesPerBar = Math.max(1, Math.floor(context.sampleRate * BUFFER_SECONDS / 64));
  const startedAt = performance.now();
  let lastWholeSecond = -1;
  let closed = false;

  const measureBars = (): void => {
    if (!canvas) return;
    const width = canvas.clientWidth;
    if (width <= 0) return;
    const next = Math.max(1, Math.floor(width / PIXELS_PER_BAR));
    if (next === barCount) return;
    barCount = next;
    samplesPerBar = Math.max(1, Math.floor(context.sampleRate * BUFFER_SECONDS / barCount));
    while (bars.length > barCount) bars.shift();
  };

  const draw = (): void => {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * ratio);
    const height = Math.floor(canvas.clientHeight * ratio);
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const paint = canvas.getContext("2d");
    if (!paint) return;
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.clearRect(0, 0, width, height);
    paint.save();
    const middle = height / 2;
    paint.translate(0, middle);
    paint.fillStyle = window.getComputedStyle(canvas).color || "#000";
    const slot = width / Math.max(1, barCount);
    let firstHeard = -1;
    for (let index = 0; index < bars.length; index += 1) {
      if ((bars[index] ?? 0) > NOISE_FLOOR) {
        firstHeard = index;
        break;
      }
    }
    for (let index = 0; index < bars.length; index += 1) {
      const level = (bars[index] ?? 0) * 10;
      const half = Math.max(ratio * 0.5, level * middle);
      // The strip fills left to right: everything before the first sound the
      // microphone actually heard stays dim.
      paint.globalAlpha = firstHeard === -1 || index < firstHeard ? 0.35 : 1;
      paint.fillRect(index * slot, -half, slot / 2, half * 2);
    }
    paint.restore();
  };

  const normalize = (rms: number): number => {
    const above = Math.max(0, rms - LEVEL_FLOOR);
    return Math.min(1, above / (LEVEL_CEILING - LEVEL_FLOOR)) ** LEVEL_GAMMA;
  };

  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (closed) return;
    const samples = event.data;
    if (recordPcm) {
      pcm.push(samples.slice());
      pcmSamples += samples.length;
    }
    measureBars();

    // Rectify and gate in place, then average into bars.
    let sum = 0;
    const rectified = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const magnitude = Math.abs(samples[index] ?? 0);
      if (magnitude > peak) peak = magnitude;
      sum += magnitude * magnitude;
      rectified[index] = magnitude < NOISE_FLOOR ? NOISE_FLOOR : magnitude;
    }
    const merged = new Float32Array(pending.length + rectified.length);
    merged.set(pending, 0);
    merged.set(rectified, pending.length);
    let offset = 0;
    while (offset + samplesPerBar <= merged.length) {
      let barSum = 0;
      for (let index = offset; index < offset + samplesPerBar; index += 1) barSum += merged[index] ?? 0;
      bars.push(normalize(barSum / samplesPerBar));
      if (bars.length > barCount) bars.shift();
      offset += samplesPerBar;
    }
    pending = merged.slice(offset);
    draw();

    const elapsed = performance.now() - startedAt;
    const whole = Math.floor(elapsed / 1_000);
    if (whole !== lastWholeSecond) {
      lastWholeSecond = whole;
      onSecond?.(whole * 1_000);
    }
  };

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    worklet.port.onmessage = null;
    worklet.disconnect();
    source.disconnect();
    void context.close().catch(() => undefined);
    if (canvas) {
      const paint = canvas.getContext("2d");
      paint?.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (ownsStream) for (const track of stream.getTracks()) track.stop();
  };

  return {
    elapsedMs: () => performance.now() - startedAt,
    peakLevel: () => peak,
    async stop() {
      const sampleRate = context.sampleRate;
      // The worklet posts blocks to this thread asynchronously, so at the
      // instant someone presses send there is always audio in flight, and it
      // is the end of what they just said. Tearing down first silently threw
      // that away, which reads as the recording missing the last word.
      if (recordPcm) await new Promise((flush) => setTimeout(flush, TAIL_FLUSH_MS));
      teardown();
      if (!recordPcm || pcmSamples === 0) return null;
      return encodeWav(pcm, pcmSamples, sampleRate);
    },
    cancel() {
      pcm.length = 0;
      pcmSamples = 0;
      peak = 0;
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

/** M:SS, the way a recording timer reads. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
