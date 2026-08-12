import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeHostClient,
  NativeHostClientError,
  type NativeMessagingPort,
} from "../../src/extension/native-host-client.js";
import type { NativeHostRequest, NativeSuccessData } from "../../src/shared/native-protocol.js";

class FakeEvent<Callback extends (...args: never[]) => void> {
  private readonly listeners = new Set<Callback>();

  addListener(callback: Callback): void {
    this.listeners.add(callback);
  }

  removeListener(callback: Callback): void {
    this.listeners.delete(callback);
  }

  emit(...args: Parameters<Callback>): void {
    for (const listener of this.listeners) listener(...args);
  }
}

class FakeNativePort implements NativeMessagingPort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly messages: NativeHostRequest[] = [];
  disconnected = false;

  postMessage(message: object): void {
    this.messages.push(message as NativeHostRequest);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  respond(index: number, data: NativeSuccessData): void {
    const request = this.messages[index];
    if (!request) throw new Error("Missing native request at index " + index);
    this.onMessage.emit({ version: 1, requestId: request.requestId, ok: true, data });
  }

  respondRaw(value: unknown): void {
    this.onMessage.emit(value);
  }

  remoteDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174000",
  "323e4567-e89b-42d3-a456-426614174000",
  "423e4567-e89b-42d3-a456-426614174000",
  "523e4567-e89b-42d3-a456-426614174000",
  "623e4567-e89b-42d3-a456-426614174000",
];

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeHostClient", () => {
  it("shares one CONNECTING port and marks it OPEN only after a valid response", async () => {
    const harness = createHarness();
    const first = harness.client.health();
    const second = harness.client.health();

    await vi.waitFor(() => expect(harness.ports[0]?.messages).toHaveLength(2));
    expect(harness.connectNative).toHaveBeenCalledOnce();
    expect(harness.ports[0]?.messages.map((message) => message.type)).toEqual(["HOST_HEALTH", "HOST_HEALTH"]);
    expect(harness.client.connectionState).toBe("CONNECTING");
    harness.ports[0]?.respond(0, { ready: true, configured: false });
    harness.ports[0]?.respond(1, { ready: true, configured: true, model: "gpt-realtime" });

    await expect(first).resolves.toEqual({ ready: true, configured: false });
    await expect(second).resolves.toEqual({ ready: true, configured: true, model: "gpt-realtime" });
    expect(harness.client.connectionState).toBe("OPEN");
  });

  it("reuses the request ID and reconnects only once after a genuine disconnect", async () => {
    const harness = createHarness();
    const health = harness.client.health();
    await vi.waitFor(() => expect(harness.ports[0]?.messages).toHaveLength(1));
    harness.ports[0]?.respond(0, { ready: true, configured: true });
    await health;

    const session = harness.client.createSession("v=0\r\ns=offer\r\n", "voice");
    await vi.waitFor(() => expect(harness.ports[0]?.messages).toHaveLength(2));
    const originalId = harness.ports[0]?.messages[1]?.requestId;
    harness.lastError = "Native host has exited.";
    harness.ports[0]?.remoteDisconnect();

    await vi.waitFor(() => expect(harness.ports[1]?.messages).toHaveLength(1));
    expect(harness.ports[1]?.messages[0]?.requestId).toBe(originalId);
    harness.ports[1]?.respond(0, { answerSdp: "v=0\r\ns=answer\r\n", upstreamRequestId: "req_1" });
    await expect(session).resolves.toEqual({ answerSdp: "v=0\r\ns=answer\r\n", upstreamRequestId: "req_1" });
    expect(harness.connectNative).toHaveBeenCalledTimes(2);

    const secondSession = harness.client.createSession("v=0\r\ns=second-offer\r\n", "text");
    const failure = secondSession.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.ports[1]?.messages).toHaveLength(2));
    harness.ports[1]?.remoteDisconnect();
    await vi.waitFor(() => expect(harness.ports[2]?.messages).toHaveLength(1));
    harness.ports[2]?.remoteDisconnect();

    const error = await failure;
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).code).toBe("HOST_NOT_FOUND");
    expect(harness.connectNative).toHaveBeenCalledTimes(3);
  });

  it("enforces the exact eight-second configure timeout and closes the stale port", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const configure = harness.client.configure("sk-" + "x".repeat(32));
    const failure = configure.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.ports[0]?.messages).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(harness.ports[0]?.disconnected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await failure;
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).code).toBe("TIMEOUT");
    expect(harness.ports[0]?.disconnected).toBe(true);
    expect(harness.client.connectionState).toBe("CLOSED");
  });

  it("distinguishes missing optional permission without opening a native port", async () => {
    const harness = createHarness(false);
    const error = await harness.client.health().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).code).toBe("PERMISSION_REQUIRED");
    expect((error as NativeHostClientError).permissionNeeded).toBe(true);
    expect(harness.connectNative).not.toHaveBeenCalled();
  });

  it("bounds the full health operation even if the permission check stalls", async () => {
    vi.useFakeTimers();
    const connectNative = vi.fn(() => new FakeNativePort());
    const client = new NativeHostClient({
      connectNative,
      hasPermission: () => new Promise<boolean>(() => undefined),
      createRequestId: () => ids[0] ?? "",
    });
    const result = client.health().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(connectNative).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).code).toBe("TIMEOUT");
    expect(client.connectionState).toBe("CLOSED");
  });

  it("rejects an uncorrelated or structurally invalid host response and closes", async () => {
    const harness = createHarness();
    const health = harness.client.health();
    const failure = health.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.ports[0]?.messages).toHaveLength(1));
    const request = harness.ports[0]?.messages[0];
    harness.ports[0]?.respondRaw({
      version: 1,
      requestId: request?.requestId,
      ok: true,
      data: { ready: true, configured: true },
      extra: true,
    });

    const error = await failure;
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).code).toBe("INVALID_RESPONSE");
    expect(harness.ports[0]?.disconnected).toBe(true);
  });

  it("explicitly closes the native port and pending work", async () => {
    const harness = createHarness();
    const health = harness.client.health();
    const failure = health.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.ports[0]?.messages).toHaveLength(1));
    harness.client.disconnect();

    const error = await failure;
    expect(error).toBeInstanceOf(NativeHostClientError);
    expect((error as NativeHostClientError).retryable).toBe(false);
    expect(harness.ports[0]?.disconnected).toBe(true);
    expect(harness.client.connectionState).toBe("CLOSED");
  });
});

function createHarness(permitted = true): {
  client: NativeHostClient;
  ports: FakeNativePort[];
  connectNative: ReturnType<typeof vi.fn<() => FakeNativePort>>;
  lastError: string | undefined;
} {
  const ports: FakeNativePort[] = [];
  let idIndex = 0;
  const connectNative = vi.fn(() => {
    const port = new FakeNativePort();
    ports.push(port);
    return port;
  });
  const harness = {
    ports,
    connectNative,
    lastError: undefined as string | undefined,
    client: null as unknown as NativeHostClient,
  };
  harness.client = new NativeHostClient({
    connectNative,
    hasPermission: async () => permitted,
    createRequestId: () => {
      const id = ids[idIndex];
      idIndex += 1;
      if (!id) throw new Error("Test exhausted deterministic request IDs.");
      return id;
    },
    getLastError: () => harness.lastError,
  });
  return harness;
}
