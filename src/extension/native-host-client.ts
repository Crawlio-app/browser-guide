import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_TIMEOUT_MS,
  isNativeHostRequest,
  isNativeHostResponseFor,
  type HostClientErrorCode,
  type HostClientFailure,
  type NativeCreateSessionData,
  type NativeCredentialSourcesData,
  type NativeImportData,
  type CredentialProvider,
  type NativeForgetData,
  type NativeHealthData,
  type NativeHostRequest,
  type NativeHostResponse,
  type CompletionMessage,
  type NativeClearEvidenceData,
  type NativeCompleteData,
  type NativeTranscribeData,
  type NativeMemoryAppendData,
  type NativeMemoryClearData,
  type NativeMemoryGetData,
  type NativePublishEvidenceData,
  type NativeRequestType,
  type NativeConfigureData,
  type NativeSuccessData,
  type RealtimeSessionMode,
} from "../shared/native-protocol.js";

type ConnectionState = "CLOSED" | "CONNECTING" | "OPEN";

interface NativeMessageEvent {
  addListener(callback: (message: unknown) => void): void;
  removeListener(callback: (message: unknown) => void): void;
}

interface NativeDisconnectEvent {
  addListener(callback: () => void): void;
  removeListener(callback: () => void): void;
}

export interface NativeMessagingPort {
  postMessage(message: object): void;
  disconnect(): void;
  onMessage: NativeMessageEvent;
  onDisconnect: NativeDisconnectEvent;
}

export interface NativeHostClientOptions {
  connectNative?: (hostName: string) => NativeMessagingPort;
  hasPermission?: () => Promise<boolean>;
  createRequestId?: () => string;
  getLastError?: () => string | undefined;
}

interface PendingRequest {
  readonly port: NativeMessagingPort;
  readonly type: NativeRequestType;
  readonly resolve: (data: NativeSuccessData) => void;
  readonly reject: (error: NativeHostClientError) => void;
  readonly timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface PortListeners {
  readonly message: (message: unknown) => void;
  readonly disconnect: () => void;
}

interface NativeDataByRequest {
  HOST_HEALTH: NativeHealthData;
  HOST_CONFIGURE_KEY: NativeConfigureData;
  HOST_FORGET_KEY: NativeForgetData;
  HOST_CREATE_SESSION: NativeCreateSessionData;
  HOST_IMPORT_CREDENTIALS: NativeImportData;
  HOST_CREDENTIAL_SOURCES: NativeCredentialSourcesData;
  HOST_MEMORY_GET: NativeMemoryGetData;
  HOST_MEMORY_APPEND: NativeMemoryAppendData;
  HOST_MEMORY_CLEAR: NativeMemoryClearData;
  HOST_PUBLISH_EVIDENCE: NativePublishEvidenceData;
  HOST_CLEAR_EVIDENCE: NativeClearEvidenceData;
  HOST_TRANSCRIBE: NativeTranscribeData;
  HOST_COMPLETE: NativeCompleteData;
}

export class NativeHostClientError extends Error {
  constructor(
    readonly code: HostClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly permissionNeeded = false,
    readonly reconnectable = false,
  ) {
    super(message);
    this.name = "NativeHostClientError";
  }
}

export class NativeHostClient {
  private readonly connectNative: (hostName: string) => NativeMessagingPort;
  private readonly hasPermission: () => Promise<boolean>;
  private readonly createRequestId: () => string;
  private readonly getLastError: () => string | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<NativeMessagingPort, PortListeners>();
  private readonly expectedDisconnects = new WeakSet<NativeMessagingPort>();
  private port: NativeMessagingPort | null = null;
  private connectionPromise: Promise<NativeMessagingPort> | null = null;
  private generation = 0;
  private state: ConnectionState = "CLOSED";

  constructor(options: NativeHostClientOptions = {}) {
    this.connectNative = options.connectNative ?? ((hostName) => (
      chrome.runtime.connectNative(hostName) as unknown as NativeMessagingPort
    ));
    this.hasPermission = options.hasPermission ?? hasNativeMessagingPermission;
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.getLastError = options.getLastError ?? (() => chrome.runtime.lastError?.message);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  health(): Promise<NativeHealthData> {
    const request = this.makeRequest("HOST_HEALTH");
    return this.runBounded(request, NATIVE_TIMEOUT_MS.health);
  }

  configure(key: string): Promise<NativeConfigureData> {
    const request = this.makeRequest("HOST_CONFIGURE_KEY", { key });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.configure);
  }

  forget(): Promise<NativeForgetData> {
    const request = this.makeRequest("HOST_FORGET_KEY");
    return this.runBounded(request, NATIVE_TIMEOUT_MS.forget);
  }

  createSession(sdp: string, mode: RealtimeSessionMode): Promise<NativeCreateSessionData> {
    const request = this.makeRequest("HOST_CREATE_SESSION", { sdp, mode });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.createSession);
  }

  importCredentials(provider: CredentialProvider): Promise<NativeImportData> {
    const request = this.makeRequest("HOST_IMPORT_CREDENTIALS", { provider });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.importCredentials);
  }

  credentialSources(): Promise<NativeCredentialSourcesData> {
    const request = this.makeRequest("HOST_CREDENTIAL_SOURCES");
    return this.runBounded(request, NATIVE_TIMEOUT_MS.importCredentials);
  }

  memoryGet(origin: string): Promise<NativeMemoryGetData> {
    const request = this.makeRequest("HOST_MEMORY_GET", { origin });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.memory);
  }

  memoryAppend(origin: string, question: string, answer: string): Promise<NativeMemoryAppendData> {
    const request = this.makeRequest("HOST_MEMORY_APPEND", { origin, question, answer });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.memory);
  }

  memoryClear(origin?: string): Promise<NativeMemoryClearData> {
    const request = this.makeRequest("HOST_MEMORY_CLEAR", origin === undefined ? undefined : { origin });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.memory);
  }

  publishEvidence(origin: string, title: string, evidence: string): Promise<NativePublishEvidenceData> {
    const request = this.makeRequest("HOST_PUBLISH_EVIDENCE", { origin, title, evidence });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.evidence);
  }

  clearEvidence(): Promise<NativeClearEvidenceData> {
    const request = this.makeRequest("HOST_CLEAR_EVIDENCE");
    return this.runBounded(request, NATIVE_TIMEOUT_MS.evidence);
  }

  transcribe(audio: string, locale?: string): Promise<NativeTranscribeData> {
    const request = this.makeRequest("HOST_TRANSCRIBE", {
      audio,
      format: "wav",
      ...(locale ? { locale } : {}),
    });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.transcribe);
  }

  complete(messages: CompletionMessage[]): Promise<NativeCompleteData> {
    const request = this.makeRequest("HOST_COMPLETE", { messages });
    return this.runBounded(request, NATIVE_TIMEOUT_MS.complete);
  }

  disconnect(): void {
    this.generation += 1;
    this.connectionPromise = null;
    const port = this.port;
    this.port = null;
    this.state = "CLOSED";
    if (!port) return;
    this.closePort(port, new NativeHostClientError(
      "HOST_DISCONNECTED",
      "The native host connection was closed.",
      false,
    ));
  }

  private makeRequest(type: "HOST_HEALTH"): Extract<NativeHostRequest, { type: "HOST_HEALTH" }>;
  private makeRequest(type: "HOST_FORGET_KEY"): Extract<NativeHostRequest, { type: "HOST_FORGET_KEY" }>;
  private makeRequest(
    type: "HOST_CREDENTIAL_SOURCES",
  ): Extract<NativeHostRequest, { type: "HOST_CREDENTIAL_SOURCES" }>;
  private makeRequest(
    type: "HOST_CONFIGURE_KEY",
    payload: { key: string },
  ): Extract<NativeHostRequest, { type: "HOST_CONFIGURE_KEY" }>;
  private makeRequest(
    type: "HOST_CREATE_SESSION",
    payload: { sdp: string; mode: RealtimeSessionMode },
  ): Extract<NativeHostRequest, { type: "HOST_CREATE_SESSION" }>;
  private makeRequest(
    type: "HOST_IMPORT_CREDENTIALS",
    payload: { provider: CredentialProvider },
  ): Extract<NativeHostRequest, { type: "HOST_IMPORT_CREDENTIALS" }>;
  private makeRequest(
    type: "HOST_MEMORY_GET",
    payload: { origin: string },
  ): Extract<NativeHostRequest, { type: "HOST_MEMORY_GET" }>;
  private makeRequest(
    type: "HOST_MEMORY_APPEND",
    payload: { origin: string; question: string; answer: string },
  ): Extract<NativeHostRequest, { type: "HOST_MEMORY_APPEND" }>;
  private makeRequest(
    type: "HOST_MEMORY_CLEAR",
    payload?: { origin: string },
  ): Extract<NativeHostRequest, { type: "HOST_MEMORY_CLEAR" }>;
  private makeRequest(
    type: "HOST_PUBLISH_EVIDENCE",
    payload: { origin: string; title: string; evidence: string },
  ): Extract<NativeHostRequest, { type: "HOST_PUBLISH_EVIDENCE" }>;
  private makeRequest(type: "HOST_CLEAR_EVIDENCE"): Extract<NativeHostRequest, { type: "HOST_CLEAR_EVIDENCE" }>;
  private makeRequest(
    type: "HOST_TRANSCRIBE",
    payload: { audio: string; format: "wav"; locale?: string },
  ): Extract<NativeHostRequest, { type: "HOST_TRANSCRIBE" }>;
  private makeRequest(
    type: "HOST_COMPLETE",
    payload: { messages: CompletionMessage[] },
  ): Extract<NativeHostRequest, { type: "HOST_COMPLETE" }>;
  private makeRequest(
    type: NativeRequestType,
    payload?: { key: string }
      | { sdp: string; mode: RealtimeSessionMode }
      | { provider: CredentialProvider }
      | { origin: string }
      | { origin: string; question: string; answer: string }
      | { origin: string; title: string; evidence: string }
      | { audio: string; format: "wav"; locale?: string }
      | { messages: CompletionMessage[] },
  ): NativeHostRequest {
    const requestId = this.createRequestId();
    let request: NativeHostRequest;
    switch (type) {
      case "HOST_HEALTH":
        request = { version: NATIVE_PROTOCOL_VERSION, requestId, type };
        break;
      case "HOST_FORGET_KEY":
      case "HOST_CREDENTIAL_SOURCES":
        request = { version: NATIVE_PROTOCOL_VERSION, requestId, type };
        break;
      case "HOST_CONFIGURE_KEY":
        request = { version: NATIVE_PROTOCOL_VERSION, requestId, type, payload: payload as { key: string } };
        break;
      case "HOST_IMPORT_CREDENTIALS":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { provider: CredentialProvider },
        };
        break;
      case "HOST_CREATE_SESSION":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { sdp: string; mode: RealtimeSessionMode },
        };
        break;
      case "HOST_MEMORY_GET":
        request = { version: NATIVE_PROTOCOL_VERSION, requestId, type, payload: payload as { origin: string } };
        break;
      case "HOST_MEMORY_APPEND":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { origin: string; question: string; answer: string },
        };
        break;
      case "HOST_MEMORY_CLEAR":
        request = payload === undefined
          ? { version: NATIVE_PROTOCOL_VERSION, requestId, type }
          : { version: NATIVE_PROTOCOL_VERSION, requestId, type, payload: payload as { origin: string } };
        break;
      case "HOST_PUBLISH_EVIDENCE":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { origin: string; title: string; evidence: string },
        };
        break;
      case "HOST_CLEAR_EVIDENCE":
        request = { version: NATIVE_PROTOCOL_VERSION, requestId, type };
        break;
      case "HOST_TRANSCRIBE":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { audio: string; format: "wav"; locale?: string },
        };
        break;
      case "HOST_COMPLETE":
        request = {
          version: NATIVE_PROTOCOL_VERSION,
          requestId,
          type,
          payload: payload as { messages: CompletionMessage[] },
        };
        break;
    }
    if (!isNativeHostRequest(request)) {
      throw new NativeHostClientError("INVALID_REQUEST", "The native host request is invalid.", false);
    }
    return request;
  }

  private async requestWithOneReconnect<T extends NativeRequestType>(
    request: Extract<NativeHostRequest, { type: T }>,
    timeoutMs: number,
    reconnectsRemaining = 1,
  ): Promise<NativeDataByRequest[T]> {
    try {
      const port = await this.ensurePort();
      return await this.send(port, request, timeoutMs) as NativeDataByRequest[T];
    } catch (error) {
      if (!(error instanceof NativeHostClientError) || reconnectsRemaining <= 0) throw error;
      if (error.reconnectable || retryableRead(request.type, error.code)) {
        return this.requestWithOneReconnect(request, timeoutMs, reconnectsRemaining - 1);
      }
      throw error;
    }
  }

  private runBounded<T extends NativeRequestType>(
    request: Extract<NativeHostRequest, { type: T }>,
    timeoutMs: number,
  ): Promise<NativeDataByRequest[T]> {
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.disconnect();
        reject(new NativeHostClientError(
          "TIMEOUT",
          "The native host did not respond in time.",
          true,
        ));
      }, timeoutMs);
      void this.requestWithOneReconnect(request, timeoutMs).then((data) => {
        globalThis.clearTimeout(timeout);
        resolve(data);
      }).catch((error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private ensurePort(): Promise<NativeMessagingPort> {
    if (this.port && (this.state === "CONNECTING" || this.state === "OPEN")) {
      return Promise.resolve(this.port);
    }
    if (this.connectionPromise) return this.connectionPromise;
    const generation = ++this.generation;
    this.state = "CONNECTING";
    const connection = this.openPort(generation);
    this.connectionPromise = connection;
    void connection.finally(() => {
      if (this.connectionPromise === connection) this.connectionPromise = null;
    }).catch(() => undefined);
    return connection;
  }

  private async openPort(generation: number): Promise<NativeMessagingPort> {
    let permitted: boolean;
    try {
      permitted = await this.hasPermission();
    } catch {
      permitted = false;
    }
    // Another port died while this one was waiting on the permission check,
    // which is ordinary when an install fires several requests at once.
    // Nothing has been posted yet, so one more attempt is safe for any request.
    if (generation !== this.generation) {
      throw new NativeHostClientError("HOST_DISCONNECTED", "The native host connection was closed.", false, false, true);
    }
    if (!permitted) {
      this.state = "CLOSED";
      throw new NativeHostClientError(
        "PERMISSION_REQUIRED",
        "Allow Browser Guide to communicate with its installed native host.",
        true,
        true,
      );
    }

    let port: NativeMessagingPort;
    try {
      port = this.connectNative(NATIVE_HOST_NAME);
    } catch {
      this.state = "CLOSED";
      throw unavailableHostError();
    }
    if (generation !== this.generation) {
      this.expectedDisconnects.add(port);
      port.disconnect();
      throw new NativeHostClientError("HOST_DISCONNECTED", "The native host connection was closed.", false, false, true);
    }
    this.port = port;
    this.attachPort(port);
    return port;
  }

  private send(
    port: NativeMessagingPort,
    request: NativeHostRequest,
    timeoutMs: number,
  ): Promise<NativeSuccessData> {
    return new Promise((resolve, reject) => {
      if (port !== this.port || this.state === "CLOSED") {
        // Named for what it is: the message never left. Reconnecting is safe
        // for a write as much as a read, because nothing was delivered.
        reject(new NativeHostClientError(
          "HOST_DISCONNECTED",
          "The native host disconnected before the request was sent.",
          true,
          false,
          true,
        ));
        return;
      }
      if (this.pending.has(request.requestId)) {
        reject(new NativeHostClientError("INVALID_REQUEST", "The native request ID was already in use.", false));
        return;
      }
      const timeout = globalThis.setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending || pending.port !== port) return;
        this.pending.delete(request.requestId);
        const error = new NativeHostClientError(
          "TIMEOUT",
          "The native host did not respond in time.",
          true,
        );
        pending.reject(error);
        this.closePort(port, error);
      }, timeoutMs);
      this.pending.set(request.requestId, { port, type: request.type, resolve, reject, timeout });
      try {
        port.postMessage(request);
      } catch {
        globalThis.clearTimeout(timeout);
        this.pending.delete(request.requestId);
        const wasOpen = this.state === "OPEN";
        const error = new NativeHostClientError(
          "HOST_DISCONNECTED",
          "The native host disconnected while the request was being sent.",
          true,
          false,
          wasOpen,
        );
        reject(error);
        this.closePort(port, error);
      }
    });
  }

  private attachPort(port: NativeMessagingPort): void {
    const message = (value: unknown) => this.handleMessage(port, value);
    const disconnect = () => this.handleDisconnect(port);
    this.listeners.set(port, { message, disconnect });
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
  }

  private handleMessage(port: NativeMessagingPort, value: unknown): void {
    if (port !== this.port) return;
    const requestId = extractRequestId(value);
    if (!requestId) {
      this.closePort(port, new NativeHostClientError(
        "INVALID_RESPONSE",
        "The native host returned an invalid response.",
        false,
      ));
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || pending.port !== port || !isNativeHostResponseFor(value, pending.type, requestId)) {
      this.closePort(port, new NativeHostClientError(
        "INVALID_RESPONSE",
        "The native host returned an invalid response.",
        false,
      ));
      return;
    }
    globalThis.clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    this.state = "OPEN";
    const response = value as NativeHostResponse;
    if (!response.ok) {
      pending.reject(new NativeHostClientError(
        response.error.code,
        response.error.message,
        response.error.retryable,
      ));
      return;
    }
    pending.resolve(response.data);
  }

  private handleDisconnect(port: NativeMessagingPort): void {
    const description = this.getLastError();
    const expected = this.expectedDisconnects.has(port);
    this.expectedDisconnects.delete(port);
    const wasOpen = port === this.port && this.state === "OPEN";
    if (port === this.port) {
      this.port = null;
      this.state = "CLOSED";
      this.generation += 1;
    }
    this.detachPort(port);
    const error = expected
      ? new NativeHostClientError("HOST_DISCONNECTED", "The native host connection was closed.", false)
      : wasOpen
        ? new NativeHostClientError(
          "HOST_DISCONNECTED",
          "The native host disconnected unexpectedly.",
          true,
          false,
          true,
        )
        : unavailableHostError(description);
    this.rejectPending(port, error);
  }

  private closePort(port: NativeMessagingPort, error: NativeHostClientError): void {
    this.expectedDisconnects.add(port);
    if (port === this.port) {
      this.port = null;
      this.state = "CLOSED";
      this.generation += 1;
    }
    this.rejectPending(port, error);
    this.detachPort(port);
    try {
      port.disconnect();
    } catch {
      // The port is already closed; local state and pending requests are clean.
    }
  }

  private rejectPending(port: NativeMessagingPort, error: NativeHostClientError): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.port !== port) continue;
      globalThis.clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  private detachPort(port: NativeMessagingPort): void {
    const listeners = this.listeners.get(port);
    if (!listeners) return;
    port.onMessage.removeListener(listeners.message);
    port.onDisconnect.removeListener(listeners.disconnect);
    this.listeners.delete(port);
  }
}

export function toHostClientFailure(error: unknown): HostClientFailure {
  if (error instanceof NativeHostClientError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      ...(error.permissionNeeded ? { permissionNeeded: true as const } : {}),
    };
  }
  return {
    ok: false,
    error: "The native host request failed.",
    code: "INTERNAL_ERROR",
    retryable: false,
  };
}

function extractRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

/**
 * Requests that only read. When a host vanishes after a message was posted,
 * whether it acted on it first is unknowable, so retrying anything that writes
 * risks applying it twice. These cannot be applied at all.
 */
const READ_ONLY_REQUESTS: ReadonlySet<NativeRequestType> = new Set<NativeRequestType>([
  "HOST_HEALTH",
  "HOST_MEMORY_GET",
  "HOST_CREDENTIAL_SOURCES",
]);

/**
 * A host that was posted to and then vanished without answering is worth one
 * more try for a read. Without it, a read issued while Chrome is still
 * settling after an install fails permanently and the panel reports a dead end
 * nobody can act on.
 *
 * Only HOST_UNAVAILABLE qualifies: it is raised solely when a port we were
 * using died on its own. HOST_DISCONNECTED covers deliberate closes, and
 * retrying those would ignore a caller that asked us to stop. HOST_NOT_FOUND
 * cannot be retried into existence, PERMISSION_REQUIRED needs a person, and
 * TIMEOUT means the host may be slow, where a second wait would double a delay
 * the caller already bounded.
 */
function retryableRead(type: NativeRequestType, code: HostClientErrorCode): boolean {
  return code === "HOST_UNAVAILABLE" && READ_ONLY_REQUESTS.has(type);
}

function unavailableHostError(description?: string): NativeHostClientError {
  // Chrome says "not found" only when no manifest names this extension, which
  // is the one case where installing is the remedy. Every other disconnect
  // means the helper is registered and simply did not answer, and the two must
  // stay distinguishable: the panel offers "install" for one and "try again"
  // for the other.
  const missing = description?.toLowerCase().includes("not found")
    || description?.toLowerCase().includes("not registered")
    || description?.toLowerCase().includes("forbidden");
  return new NativeHostClientError(
    missing ? "HOST_NOT_FOUND" : "HOST_UNAVAILABLE",
    missing
      ? "The Browser Guide native host is not installed or is not allowed for this extension."
      : "The Browser Guide native host is unavailable.",
    true,
  );
}

function hasNativeMessagingPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }, (allowed) => {
      const error = chrome.runtime.lastError;
      resolve(!error && allowed);
    });
  });
}
