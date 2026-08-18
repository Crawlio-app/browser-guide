// The cross-platform native messaging host: the Node port of
// BrowserGuideNativeHost.swift. Speaks the identical framed protocol and
// passes the same conformance suite (tests/native/) as the Swift helper.

import { FrameDecoder, FramingError, encodeFrame } from "./framing.js";
import { HostFailure, UNKNOWN_REQUEST_ID, decodeRequest, encodeFailure, encodeSuccess } from "./protocol.js";
import { FileCredentialStore, SiteMemoryStore, SharedEvidenceStore } from "./stores.js";
import { RealtimeClient } from "./realtime.js";
import { AnthropicClient } from "./anthropic.js";
import { HostService } from "./service.js";

function makeService(environment = process.env) {
  // The same test hooks the Swift DEBUG build honors, so the conformance
  // suite runs unchanged. Both are inert outside tests: the in-memory store
  // holds nothing durable and the delayed transport never leaves the process.
  const useMemoryStore = environment.BROWSER_GUIDE_TEST_IN_MEMORY_KEYCHAIN === "1";
  const fileStore = new FileCredentialStore();
  const keyStore = useMemoryStore ? makeInMemoryKeyStore() : fileStore;
  const importer = useMemoryStore ? null : fileStore;
  const memory = useMemoryStore ? null : new SiteMemoryStore();
  const evidence = useMemoryStore ? null : new SharedEvidenceStore();

  const rawDelay = environment.BROWSER_GUIDE_TEST_REALTIME_DELAY_MILLISECONDS;
  const delayMs = rawDelay === undefined ? null : Number(rawDelay);
  const realtimeClient = delayMs !== null && Number.isInteger(delayMs) && delayMs >= 1 && delayMs <= 10_000
    ? new RealtimeClient({
      transport: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { status: 200, body: "v=0\r\n", requestIdHeader: "browser-guide-debug-delay" };
      },
      timeoutSeconds: 20,
    })
    : new RealtimeClient();

  const anthropicClient = useMemoryStore ? null : new AnthropicClient();
  return new HostService({ keyStore, importer, memory, evidence, realtimeClient, anthropicClient });
}

function makeInMemoryKeyStore() {
  let apiKey = null;
  return {
    readApiKey: () => apiKey,
    saveApiKey: (key) => { apiKey = key; },
    deleteApiKey: () => { apiKey = null; },
  };
}

export function runHelper() {
  const service = makeService();
  const decoder = new FrameDecoder();
  let writable = true;
  let writeChain = Promise.resolve();
  // Key configuration, deletion, and health are an ordered control plane.
  // Session creation waits for earlier control work but never becomes the
  // control tail, so its upstream network wait cannot block later controls.
  let controlTail = Promise.resolve();
  const inFlight = new Set();

  const write = (payload) => {
    if (!writable) return;
    let framed;
    try {
      framed = encodeFrame(payload);
    } catch {
      return;
    }
    writeChain = writeChain.then(() => new Promise((resolve) => {
      if (!writable) return resolve();
      process.stdout.write(framed, (error) => {
        if (error) writable = false;
        resolve();
      });
    }));
  };

  const writeFailure = (failure) => write(encodeFailure(failure));

  process.stdout.on("error", (error) => {
    writable = false;
    if (error?.code === "EPIPE") process.exit(0);
  });

  const submit = (request) => {
    const preceding = controlTail;
    const task = (async () => {
      await preceding;
      const outcome = await service.handle(request);
      if (outcome.failure) writeFailure(outcome.failure);
      else write(encodeSuccess(outcome.requestId, outcome.data));
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    if (request.type !== "HOST_CREATE_SESSION") controlTail = task;
  };

  const shutdown = async (code) => {
    await Promise.allSettled([...inFlight]);
    await writeChain;
    process.exit(code);
  };

  process.stdin.on("data", (chunk) => {
    let payloads;
    try {
      payloads = decoder.append(chunk);
    } catch (error) {
      const tooLarge = error instanceof FramingError && error.kind === "messageTooLarge";
      writeFailure(new HostFailure(
        tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
        tooLarge ? "The native message exceeds the allowed size." : "The native message frame is invalid.",
        false,
        UNKNOWN_REQUEST_ID,
      ));
      void shutdown(0);
      return;
    }
    for (const payload of payloads) {
      try {
        submit(decodeRequest(payload));
      } catch (error) {
        if (error instanceof HostFailure) writeFailure(error);
        else {
          writeFailure(new HostFailure("INTERNAL_ERROR", "The native host could not process the request.", false, UNKNOWN_REQUEST_ID));
        }
      }
    }
  });

  process.stdin.on("end", () => {
    try {
      decoder.finish();
    } catch {
      writeFailure(new HostFailure("INVALID_REQUEST", "The native message frame was truncated.", false, UNKNOWN_REQUEST_ID));
    }
    void shutdown(0);
  });

  process.stdin.resume();
}
