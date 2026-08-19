// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, formatElapsed, startVoiceCapture } from "../../src/extension/sidepanel/voice-capture.js";

/**
 * A fake AudioWorklet whose port can deliver a block after stop() is called,
 * which is what really happens: the worklet renders on the audio thread and
 * posts to this one, so at the moment someone presses send the end of their
 * sentence is still in flight.
 */
function installAudioStubs(): { deliver: (samples: Float32Array) => void } {
  let onmessage: ((event: { data: Float32Array }) => void) | null = null;
  const port = {
    get onmessage() { return onmessage; },
    set onmessage(handler: ((event: { data: Float32Array }) => void) | null) { onmessage = handler; },
  };

  vi.stubGlobal("AudioWorkletNode", class {
    port = port;
    disconnect(): void { /* nothing to release in the stub */ }
  });
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = 16_000;
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource(): { connect(): void; disconnect(): void } {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    async resume(): Promise<void> { /* already running */ }
    async close(): Promise<void> { /* nothing to close in the stub */ }
  });
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });

  return { deliver: (samples) => onmessage?.({ data: samples }) };
}

const stream = { getTracks: () => [] } as unknown as MediaStream;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice capture", () => {
  it("keeps the audio still in flight when the recording is stopped", async () => {
    const audio = installAudioStubs();
    const capture = await startVoiceCapture(stream, { recordPcm: true });

    const spoken = new Float32Array(16_000).fill(0.2);
    audio.deliver(spoken);

    // The last block arrives after stop() is called, exactly as it does when
    // someone presses send on the final word.
    const stopped = capture.stop();
    const tail = new Float32Array(8_000).fill(0.3);
    audio.deliver(tail);

    const wav = await stopped;
    expect(wav).not.toBeNull();
    // 44-byte header plus every sample from both blocks, tail included.
    expect(wav?.byteLength).toBe(44 + (spoken.length + tail.length) * 2);
  });

  it("discards everything when the recording is cancelled", async () => {
    const audio = installAudioStubs();
    const capture = await startVoiceCapture(stream, { recordPcm: true });
    audio.deliver(new Float32Array(16_000).fill(0.2));
    capture.cancel();
    await expect(capture.stop()).resolves.toBeNull();
  });

  it("writes a 16 kHz mono 16-bit WAV, which is what the helper transcribes", () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -0.5, 1, -1])], 5, 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);          // mono
    expect(view.getUint32(24, true)).toBe(16_000);     // sample rate
    expect(view.getUint16(34, true)).toBe(16);         // bits per sample
    // Full scale clamps rather than wrapping, which would sound like a click.
    expect(view.getInt16(44 + 6, true)).toBe(32_767);
    expect(view.getInt16(44 + 8, true)).toBe(-32_768);
  });

  it("shows elapsed time the way a recorder does", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(61_000)).toBe("1:01");
  });
});
