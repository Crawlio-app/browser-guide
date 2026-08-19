import { describe, expect, it } from "vitest";
import {
  NATIVE_MAX_MEMORY_ANSWER_CHARS,
  NATIVE_MAX_SDP_BYTES,
  isHostBridgeRequest,
  isHostConfigureResponse,
  isHostCreateSessionResponse,
  isHostCredentialSourcesResponse,
  isHostHealthResponse,
  isHostMemoryGetResponse,
  isNativeHostRequest,
  isNativeHostResponseFor,
  isWebOrigin,
} from "../../src/shared/native-protocol.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const apiKey = "sk-" + "x".repeat(32);
const offerSdp = "v=0\r\ns=browser-guide-offer\r\n";
const answerSdp = "v=0\r\ns=browser-guide-answer\r\n";

describe("native messaging protocol", () => {
  it("accepts only exact, versioned request envelopes", () => {
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_HEALTH" })).toBe(true);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CONFIGURE_KEY", payload: { key: apiKey } })).toBe(true);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_CREATE_SESSION",
      payload: { sdp: offerSdp, mode: "voice" },
    })).toBe(true);

    expect(isNativeHostRequest({ version: 2, requestId, type: "HOST_HEALTH" })).toBe(false);
    expect(isNativeHostRequest({ version: 1, requestId: "predictable-1", type: "HOST_HEALTH" })).toBe(false);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_HEALTH", payload: {} })).toBe(false);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CONFIGURE_KEY", payload: { key: apiKey, debug: true } })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_CREATE_SESSION",
      payload: { sdp: "not-sdp", mode: "voice" },
    })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_CREATE_SESSION",
      payload: { sdp: "v=0\n" + "x".repeat(NATIVE_MAX_SDP_BYTES), mode: "voice" },
    })).toBe(false);
  });

  it("matches strict responses to both request ID and operation", () => {
    const health = {
      version: 1,
      requestId,
      ok: true,
      data: { ready: true, configured: false, claude: false, model: "gpt-realtime" },
    };
    expect(isNativeHostResponseFor(health, "HOST_HEALTH", requestId)).toBe(true);
    expect(isNativeHostResponseFor(health, "HOST_CONFIGURE_KEY", requestId)).toBe(false);
    expect(isNativeHostResponseFor(health, "HOST_HEALTH", "223e4567-e89b-42d3-a456-426614174000")).toBe(false);
    expect(isNativeHostResponseFor({ ...health, debug: true }, "HOST_HEALTH", requestId)).toBe(false);
    expect(isNativeHostResponseFor({
      version: 1,
      requestId,
      ok: false,
      error: { code: "NOT_CONFIGURED", message: "Add a key.", retryable: false },
    }, "HOST_CREATE_SESSION", requestId)).toBe(true);
    expect(isNativeHostResponseFor({
      version: 1,
      requestId,
      ok: false,
      error: { code: "INVALID_API_KEY", message: "Replace the OpenAI API key.", retryable: false },
    }, "HOST_CREATE_SESSION", requestId)).toBe(true);
    expect(isNativeHostResponseFor({
      version: 1,
      requestId,
      ok: false,
      error: { code: "ARBITRARY", message: "Nope.", retryable: false },
    }, "HOST_HEALTH", requestId)).toBe(false);
  });

  it("validates the side-panel boundary and its operation-specific results", () => {
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_HEALTH" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_CONFIGURE_KEY", key: apiKey })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_CREATE_SESSION", sdp: offerSdp, mode: "text" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_HEALTH", url: "http://127.0.0.1" })).toBe(false);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_CREATE_SESSION", sdp: offerSdp, mode: "screen" })).toBe(false);

    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true, claude: false } })).toBe(true);
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true, claude: false, extra: true } })).toBe(false);
    expect(isHostConfigureResponse({ ok: true, configured: true })).toBe(true);
    expect(isHostConfigureResponse({ ok: true, configured: false })).toBe(false);
    expect(isHostCreateSessionResponse({ ok: true, answerSdp, upstreamRequestId: "req_native-1" })).toBe(true);
    expect(isHostCreateSessionResponse({ ok: true, answerSdp: "not-sdp" })).toBe(false);
    expect(isHostHealthResponse({
      ok: false,
      error: "Native permission is required.",
      code: "PERMISSION_REQUIRED",
      retryable: true,
      permissionNeeded: true,
    })).toBe(true);
  });

  it("survives a helper that is a version behind or ahead of the extension", () => {
    // The extension reloads with every build; the helper only changes when it
    // is reinstalled, so these two shapes coexist in the wild. Rejecting
    // either one closes the port and takes the whole product down, which is
    // exactly what a required `claude` field once did.
    const older = { version: 1, requestId, ok: true, data: { ready: true, configured: true, model: "gpt-realtime" } };
    const newer = { version: 1, requestId, ok: true, data: { ready: true, configured: true, claude: true, model: "gpt-realtime" } };
    expect(isNativeHostResponseFor(older, "HOST_HEALTH", requestId)).toBe(true);
    expect(isNativeHostResponseFor(newer, "HOST_HEALTH", requestId)).toBe(true);
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: false } })).toBe(true);
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: false, claude: false } })).toBe(true);

    // Still strict about the things that carry meaning.
    expect(isNativeHostResponseFor({
      version: 1,
      requestId,
      ok: true,
      data: { ready: true, configured: true, claude: "yes" },
    }, "HOST_HEALTH", requestId)).toBe(false);
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true, unexpected: 1 } })).toBe(false);
  });

  it("carries display identity without letting it become an injection channel", () => {
    const health = (account: unknown) => isHostHealthResponse({
      ok: true,
      health: { ready: true, configured: true, claude: false, account },
    });
    expect(health({ provider: "codex", label: "person@example.test", plan: "plus" })).toBe(true);
    expect(health({ provider: "claude-code", plan: "max", expiresAt: 1_800_000_000_000 })).toBe(true);
    expect(health({ provider: "claude-code" })).toBe(true);
    // Absent stays valid: a helper from before this field existed omits it.
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true } })).toBe(true);

    expect(health({ provider: "chatgpt" })).toBe(false);
    expect(health({ label: "person@example.test" })).toBe(false);
    expect(health({ provider: "codex", token: "sk-live" })).toBe(false);
    expect(health({ provider: "codex", label: "line one\nline two" })).toBe(false);
    expect(health({ provider: "codex", label: "x".repeat(400) })).toBe(false);
    expect(health({ provider: "codex", expiresAt: -1 })).toBe(false);
    expect(health({ provider: "codex", expiresAt: "soon" })).toBe(false);
  });

  it("carries the speaker's language candidates, bounded, on transcribe", () => {
    const wav = "UklGR" + "A".repeat(60);
    const request = (payload: Record<string, unknown>) => isNativeHostRequest({
      version: 1, requestId, type: "HOST_TRANSCRIBE", payload: { audio: wav, format: "wav", ...payload },
    });
    expect(request({})).toBe(true);
    expect(request({ locale: "es-MX" })).toBe(true);
    expect(request({ locales: ["es-MX", "en-US"] })).toBe(true);
    expect(request({ locale: "es-MX", locales: ["es-MX", "en"] })).toBe(true);

    expect(request({ locales: [] })).toBe(false);
    expect(request({ locales: ["not a tag!"] })).toBe(false);
    expect(request({ locales: ["en", "es", "fr", "de", "it", "pt"] })).toBe(false);
    expect(request({ locales: "es-MX" })).toBe(false);
  });

  it("bounds the credential-source answer the setup screen leads with", () => {
    const sources = (value: unknown) => isHostCredentialSourcesResponse({ ok: true, sources: value });
    expect(sources([])).toBe(true);
    expect(sources([
      { provider: "codex", available: true, label: "person@example.test", plan: "plus" },
      { provider: "claude-code", available: false, detail: "Sign in to Claude Code to create one." },
    ])).toBe(true);

    expect(sources([{ provider: "codex" }])).toBe(false);
    expect(sources([{ provider: "codex", available: "yes" }])).toBe(false);
    expect(sources([{ provider: "codex", available: true, key: "sk-live" }])).toBe(false);
    expect(sources("codex")).toBe(false);
    expect(sources(Array.from({ length: 9 }, () => ({ provider: "codex", available: true })))).toBe(false);

    // The request itself carries nothing, and a stray field must not pass.
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CREDENTIAL_SOURCES" })).toBe(true);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CREDENTIAL_SOURCES", payload: {} })).toBe(false);
  });

  it("bounds the per-site memory messages to real web origins and sized text", () => {
    const origin = "https://example.test";
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_MEMORY_GET", payload: { origin } })).toBe(true);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_MEMORY_APPEND",
      payload: { origin, question: "What is this page?", answer: "A billing dashboard." },
    })).toBe(true);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_MEMORY_CLEAR" })).toBe(true);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_MEMORY_CLEAR", payload: { origin } })).toBe(true);

    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_MEMORY_GET", payload: { origin: "chrome://settings" } })).toBe(false);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_MEMORY_GET", payload: { origin: "https://example.test/path" } })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_MEMORY_APPEND",
      payload: { origin, question: "", answer: "a" },
    })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_MEMORY_APPEND",
      payload: { origin, question: "q", answer: "a".repeat(NATIVE_MAX_MEMORY_ANSWER_CHARS + 1) },
    })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_MEMORY_APPEND",
      payload: { origin, question: "q", answer: "a", extra: true },
    })).toBe(false);

    expect(isHostBridgeRequest({ type: "GUIDE_HOST_MEMORY_GET", origin })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_MEMORY_APPEND", origin, question: "q", answer: "a" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_MEMORY_CLEAR" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_MEMORY_CLEAR", origin })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_MEMORY_GET", origin: "file:///etc" })).toBe(false);

    const notes = { version: 1, requestId, ok: true, data: { notes: [{ q: "q", a: "a", at: 1 }] } };
    expect(isNativeHostResponseFor(notes, "HOST_MEMORY_GET", requestId)).toBe(true);
    expect(isNativeHostResponseFor(notes, "HOST_MEMORY_APPEND", requestId)).toBe(false);
    expect(isNativeHostResponseFor({
      version: 1,
      requestId,
      ok: true,
      data: { notes: [{ q: "q", a: "a", at: 1, ref: "e12" }] },
    }, "HOST_MEMORY_GET", requestId)).toBe(false);

    expect(isHostMemoryGetResponse({ ok: true, notes: [] })).toBe(true);
    expect(isHostMemoryGetResponse({ ok: true, notes: [{ q: "q", a: "a" }] })).toBe(false);

    expect(isWebOrigin("http://localhost:4173")).toBe(true);
    expect(isWebOrigin("https://user:pass@example.test")).toBe(false);
    expect(isWebOrigin("https://example.test?q=1")).toBe(false);
  });

  it("bounds the agent-eyes evidence messages and their results", () => {
    const origin = "https://example.test";
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_PUBLISH_EVIDENCE",
      payload: { origin, title: "Dashboard", evidence: "{\"elements\":[]}" },
    })).toBe(true);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CLEAR_EVIDENCE" })).toBe(true);

    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_PUBLISH_EVIDENCE",
      payload: { origin: "chrome://settings", title: "t", evidence: "{}" },
    })).toBe(false);
    expect(isNativeHostRequest({
      version: 1,
      requestId,
      type: "HOST_PUBLISH_EVIDENCE",
      payload: { origin, title: "t", evidence: "" },
    })).toBe(false);
    expect(isNativeHostRequest({ version: 1, requestId, type: "HOST_CLEAR_EVIDENCE", payload: {} })).toBe(false);

    expect(isHostBridgeRequest({ type: "GUIDE_HOST_PUBLISH_EVIDENCE", origin, title: "t", evidence: "{}" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_CLEAR_EVIDENCE" })).toBe(true);
    expect(isHostBridgeRequest({ type: "GUIDE_HOST_PUBLISH_EVIDENCE", origin, title: "t", evidence: "{}", extra: 1 })).toBe(false);

    const published = { version: 1, requestId, ok: true, data: { published: true } };
    expect(isNativeHostResponseFor(published, "HOST_PUBLISH_EVIDENCE", requestId)).toBe(true);
    expect(isNativeHostResponseFor(published, "HOST_CLEAR_EVIDENCE", requestId)).toBe(false);
  });
});
