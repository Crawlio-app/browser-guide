// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSession, type SessionBroker } from "../../src/extension/sidepanel/voice-session.js";
import type { PageContext } from "../../src/shared/page-context.js";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  emit(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

const pageContext: PageContext = {
  snapshotId: "snapshot-voice-flow",
  capturedAt: "2026-08-09T00:00:00.000Z",
  title: "Invoices",
  url: "https://fixture.test/invoices",
  origin: "https://fixture.test",
  viewport: { width: 1_000, height: 700, devicePixelRatio: 1 },
  elements: [{
    ref: "e1",
    role: "button",
    name: "Review invoices",
    visibility: "visible",
    section: "main",
    rect: { x: 20, y: 30, width: 140, height: 40, top: 30, right: 160, bottom: 70, left: 20 },
  }],
  truncated: false,
  characterCount: 120,
};

let channel: FakeDataChannel;
let microphoneTrack: { enabled: boolean; stop: ReturnType<typeof vi.fn> };

beforeEach(() => {
  channel = new FakeDataChannel();
  microphoneTrack = { enabled: false, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [microphoneTrack],
    getTracks: () => [microphoneTrack],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });

  class FakePeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "connected";

    addTrack(): RTCRtpSender {
      return {} as RTCRtpSender;
    }

    addTransceiver(): RTCRtpTransceiver {
      return {} as RTCRtpTransceiver;
    }

    createDataChannel(): RTCDataChannel {
      return channel as unknown as RTCDataChannel;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0\r\ns=fake-offer\r\n" };
    }

    async setLocalDescription(): Promise<void> {}

    async setRemoteDescription(): Promise<void> {
      channel.open();
    }

    close(): void {
      this.connectionState = "closed";
    }
  }

  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Realtime voice guidance flow", () => {
  it("turns a spoken transcript into an answer and a grounded visual pointer without page action", async () => {
    const createSession = vi.fn(async () => "v=0\r\ns=fake-answer\r\n");
    const broker = { createSession } as SessionBroker;
    const states: string[] = [];
    const userTranscript = vi.fn();
    const assistantTranscript = vi.fn();
    const onGuidance = vi.fn(async () => ({ ok: true }));
    const session = new VoiceSession(broker, {
      onState: (state) => states.push(state),
      onUserTranscript: userTranscript,
      onAssistantTranscript: assistantTranscript,
      onGuidance,
      onError: vi.fn(),
    });

    await session.startListening(pageContext);
    expect(createSession).toHaveBeenCalledWith(expect.stringContaining("v=0"), "voice");
    expect(microphoneTrack.enabled).toBe(true);
    expect(session.currentState).toBe("listening");

    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-one" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-one",
      transcript: "Where do I review invoices?",
    });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "audio-item-one" });
    channel.emit({ type: "response.created", response: { id: "response-one" } });
    channel.emit({ type: "response.output_audio_transcript.delta", response_id: "response-one", delta: "Use the highlighted " });
    channel.emit({
      type: "response.output_audio_transcript.done",
      response_id: "response-one",
      transcript: "Use the highlighted Review invoices button.",
    });
    channel.emit({
      type: "response.done",
      response: {
        id: "response-one",
        status: "completed",
        output: [{
          type: "function_call",
          name: "show_guidance",
          call_id: "call-grounded-1",
          arguments: JSON.stringify({
            refs: ["e1"],
            title: "Review invoices",
            body: "This is the control you asked about.",
          }),
        }],
      },
    });

    await vi.waitFor(() => expect(onGuidance).toHaveBeenCalledTimes(1));
    expect(userTranscript).toHaveBeenCalledWith("Where do I review invoices?", true);
    expect(assistantTranscript).toHaveBeenCalledWith("Use the highlighted Review invoices button.", true);
    expect(onGuidance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "show_guidance",
        refs: ["e1"],
        presentation: "point",
        waitFor: "none",
      }),
      expect.objectContaining({
        turnId: expect.any(String),
        snapshotId: "snapshot-voice-flow",
        mode: "ask",
        status: "responding",
      }),
    );
    expect(channel.sent.map((raw) => JSON.parse(raw) as { type?: string; item?: { type?: string } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "conversation.item.create", item: expect.objectContaining({ type: "function_call_output" }) }),
        expect.objectContaining({ type: "response.create" }),
      ]));
    expect(states).toEqual(expect.arrayContaining(["listening", "thinking", "speaking", "pointing"]));

    await session.close();
    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("keeps the voice session open until the audio playout drain signal, then closes", async () => {
    const broker = { createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n") } as SessionBroker;
    const states: string[] = [];
    const session = new VoiceSession(broker, {
      onState: (state) => states.push(state),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
    });

    await session.startListening(pageContext);
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-drain" });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "audio-item-drain" });
    channel.emit({ type: "response.created", response: { id: "response-drain" } });
    channel.emit({ type: "response.output_audio_transcript.delta", response_id: "response-drain", delta: "Here " });
    channel.emit({
      type: "response.done",
      response: { id: "response-drain", status: "completed", output: [] },
    });
    await vi.waitFor(() => expect(session.currentTurn).toBeNull());

    // Generation is done but audio is still playing: the connection must live.
    expect(microphoneTrack.stop).not.toHaveBeenCalled();
    expect(session.currentState).toBe("idle");

    channel.emit({ type: "output_audio_buffer.stopped", response_id: "response-drain" });
    await vi.waitFor(() => expect(microphoneTrack.stop).toHaveBeenCalledOnce());
    expect(session.currentState).toBe("idle");
  });

  it("supersedes a stopped capture within a bounded delay when VAD never saw speech", async () => {
    const turns: Array<{ status: string }> = [];
    const states: string[] = [];
    const disconnect = vi.fn(async () => undefined);
    const session = new VoiceSession({ createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n"), disconnect }, {
      onState: (state) => states.push(state),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
      onTurn: (turn) => turns.push(turn),
    });

    await session.startListening(pageContext);
    vi.useFakeTimers();
    session.stopListening();

    expect(session.currentState).toBe("thinking");
    expect(session.currentTurn).toMatchObject({ status: "capturing" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.currentTurn).toBeNull();
    expect(session.busy).toBe(false);
    expect(session.currentState).toBe("idle");
    expect(turns.at(-1)).toMatchObject({ status: "superseded" });
    expect(states.at(-1)).toBe("idle");
    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a stopped capture alive when VAD reports speech during the grace window", async () => {
    const session = new VoiceSession({ createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n") }, {
      onState: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
    });

    await session.startListening(pageContext);
    vi.useFakeTimers();
    session.stopListening();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-delayed" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.currentTurn).toMatchObject({ status: "capturing" });
    expect(session.currentState).toBe("thinking");
    expect(microphoneTrack.stop).not.toHaveBeenCalled();
    await session.close();
  });

  it("rejects late transcripts from closed or unbound audio items on the next turn", async () => {
    const userTranscript = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const session = new VoiceSession({ createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n"), disconnect }, {
      onState: vi.fn(),
      onUserTranscript: userTranscript,
      onAssistantTranscript: vi.fn(),
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
    });

    await session.startListening(pageContext);
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-old" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-old",
      transcript: "First question",
    });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "audio-item-old" });
    channel.emit({ type: "response.created", response: { id: "response-old" } });
    channel.emit({
      type: "response.done",
      response: { id: "response-old", status: "completed", output: [] },
    });
    expect(session.currentTurn).toBeNull();
    channel.emit({ type: "output_audio_buffer.stopped", response_id: "response-old" });
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
    userTranscript.mockClear();

    const oldChannel = channel;
    channel = new FakeDataChannel();
    await session.startListening({ ...pageContext, snapshotId: "snapshot-voice-flow-two" });
    oldChannel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-old",
      transcript: "Stale first question",
    });
    expect(userTranscript).not.toHaveBeenCalled();

    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-unbound",
      transcript: "Unbound stale question",
    });
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-unbound" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-unbound",
      transcript: "Still stale",
    });
    expect(userTranscript).not.toHaveBeenCalled();

    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "audio-item-new" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "audio-item-new",
      transcript: "Fresh second question",
    });
    expect(userTranscript).toHaveBeenCalledOnce();
    expect(userTranscript).toHaveBeenCalledWith("Fresh second question", true);

    await session.close();
  });

  it("fails and tears down a Realtime turn that never completes", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onTurn = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const session = new VoiceSession({
      createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n"),
      disconnect,
    }, {
      onState: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError,
      onTurn,
    });

    await session.sendTyped("Where is billing?", pageContext);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());

    expect(session.currentTurn).toBeNull();
    expect(session.busy).toBe(false);
    expect(onTurn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("took too long"), "realtime");
  });
});
