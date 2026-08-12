// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSession, type SessionBroker, type VoiceSessionCallbacks } from "../../src/extension/sidepanel/voice-session.js";
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

const channels: FakeDataChannel[] = [];

beforeEach(() => {
  channels.length = 0;
  class FakePeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "connected";
    private readonly dataChannel = new FakeDataChannel();

    constructor() {
      super();
      channels.push(this.dataChannel);
    }

    addTransceiver(): RTCRtpTransceiver {
      return {} as RTCRtpTransceiver;
    }

    createDataChannel(): RTCDataChannel {
      return this.dataChannel as unknown as RTCDataChannel;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0\r\ns=fake-offer\r\n" };
    }

    async setLocalDescription(): Promise<void> {}

    async setRemoteDescription(): Promise<void> {
      this.dataChannel.open();
    }

    close(): void {
      this.connectionState = "closed";
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Realtime turn isolation", () => {
  it("starts one connection and rejects a concurrent turn without cancelling the first", async () => {
    let resolveSession: ((answer: string) => void) | null = null;
    const createSession = vi.fn(() => new Promise<string>((resolve) => {
      resolveSession = resolve;
    }));
    const broker: SessionBroker = { createSession, disconnect: vi.fn(async () => undefined) };
    const onGuidance = vi.fn(async () => ({ ok: true }));
    const session = createVoiceSession(broker, onGuidance);

    const first = session.sendTyped("First question", pageContext("snapshot-one"));
    const concurrent = session.sendTyped("Second question", pageContext("snapshot-two"));
    await expect(concurrent).rejects.toThrow(/already starting a turn/i);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(resolveSession).not.toBeNull();
    (resolveSession as unknown as (answer: string) => void)("v=0\r\ns=fake-answer\r\n");
    await expect(first).resolves.toMatchObject({ snapshotId: "snapshot-one", status: "responding" });
    expect(session.currentTurn).toMatchObject({ snapshotId: "snapshot-one" });
    expect(onGuidance).not.toHaveBeenCalled();

    await session.close();
  });

  it("ignores a late tool call from a superseded channel and points only with the fresh turn", async () => {
    const broker: SessionBroker = {
      createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n"),
      disconnect: vi.fn(async () => undefined),
    };
    const onGuidance = vi.fn(async () => ({ ok: true }));
    const session = createVoiceSession(broker, onGuidance);

    await session.sendTyped("Old question", pageContext("snapshot-old"));
    const oldChannel = channels[0];
    expect(oldChannel).toBeDefined();
    await session.supersedeActiveTurn();
    await session.sendTyped("Fresh question", pageContext("snapshot-fresh"));
    const freshChannel = channels[1];
    expect(freshChannel).toBeDefined();

    oldChannel?.emit(toolResponse("old-call", "e1"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onGuidance).not.toHaveBeenCalled();

    freshChannel?.emit(toolResponse("fresh-call", "e1"));
    await vi.waitFor(() => expect(onGuidance).toHaveBeenCalledTimes(1));
    expect(onGuidance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "show_guidance", refs: ["e1"] }),
      expect.objectContaining({ snapshotId: "snapshot-fresh", status: "responding" }),
    );

    await session.close();
  });

  it("correlates transcript deltas to the active Realtime response on a reused channel", async () => {
    const broker: SessionBroker = { createSession: vi.fn(async () => "v=0\r\ns=fake-answer\r\n") };
    const assistantTranscript = vi.fn();
    const session = new VoiceSession(broker, {
      onState: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: assistantTranscript,
      onGuidance: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
    });

    await session.sendTyped("First", pageContext("snapshot-first"));
    const channel = channels[0];
    channel?.emit({ type: "response.created", response: { id: "response-one" } });
    channel?.emit({ type: "response.done", response: { id: "response-one", status: "completed", output: [] } });
    await vi.waitFor(() => expect(session.currentTurn).toBeNull());

    await session.sendTyped("Second", pageContext("snapshot-second"));
    channel?.emit({ type: "response.created", response: { id: "response-two" } });
    channel?.emit({ type: "response.output_text.delta", response_id: "response-one", delta: "stale" });
    channel?.emit({ type: "response.output_text.delta", response_id: "response-two", delta: "fresh" });

    expect(assistantTranscript).toHaveBeenCalledTimes(1);
    expect(assistantTranscript).toHaveBeenCalledWith("fresh", false);
    await session.close();
  });
});

function createVoiceSession(
  broker: SessionBroker,
  onGuidance: VoiceSessionCallbacks["onGuidance"],
): VoiceSession {
  return new VoiceSession(broker, {
    onState: vi.fn(),
    onUserTranscript: vi.fn(),
    onAssistantTranscript: vi.fn(),
    onGuidance,
    onError: vi.fn(),
  });
}

function pageContext(snapshotId: string): PageContext {
  return {
    snapshotId,
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
}

function toolResponse(callId: string, ref: string): unknown {
  return {
    type: "response.done",
    response: {
      status: "completed",
      output: [{
        type: "function_call",
        name: "show_guidance",
        call_id: callId,
        arguments: JSON.stringify({
          refs: [ref],
          title: "Review invoices",
          body: "Choose this control yourself to continue.",
          presentation: "point",
          waitFor: "none",
        }),
      }],
    },
  };
}
