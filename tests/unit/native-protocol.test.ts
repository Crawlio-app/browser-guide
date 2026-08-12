import { describe, expect, it } from "vitest";
import {
  NATIVE_MAX_SDP_BYTES,
  isHostBridgeRequest,
  isHostConfigureResponse,
  isHostCreateSessionResponse,
  isHostHealthResponse,
  isNativeHostRequest,
  isNativeHostResponseFor,
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
      data: { ready: true, configured: false, model: "gpt-realtime" },
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

    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true } })).toBe(true);
    expect(isHostHealthResponse({ ok: true, health: { ready: true, configured: true, extra: true } })).toBe(false);
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
});
