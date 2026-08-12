import { describe, expect, it } from "vitest";
import {
  isCaptureResponse,
  isContentRequest,
  isExtensionRuntimeState,
  isGuidanceResponse,
  isSidePanelRequest,
} from "../../src/shared/protocol.js";

describe("extension protocol validation", () => {
  it("accepts bounded runtime state and rejects malformed boundary values", () => {
    expect(isExtensionRuntimeState({
      status: "ready",
      tabId: 8,
      authorizedOrigin: "https://fixture.test",
      refsValid: true,
      latestSnapshotId: "snapshot-1",
    })).toBe(true);
    expect(isExtensionRuntimeState({ status: "ready", refsValid: "yes" })).toBe(false);
    expect(isExtensionRuntimeState({ status: "ready", tabId: 8, authorizedOrigin: "https://fixture.test/path", refsValid: false })).toBe(false);
    expect(isExtensionRuntimeState({ status: "ready", tabId: 8, authorizedOrigin: "https://fixture.test", refsValid: true })).toBe(false);
    expect(isExtensionRuntimeState({ status: "ready", refsValid: true, tabId: -1 })).toBe(false);
    expect(isExtensionRuntimeState({ status: "paused", refsValid: false })).toBe(false);
    expect(isExtensionRuntimeState({ status: "permission-paused", refsValid: false, pauseReason: "invented" })).toBe(false);
  });

  it("rejects malformed side-panel and content requests", () => {
    expect(isSidePanelRequest({ type: "GUIDE_CAPTURE_CONTEXT", shareVisual: true })).toBe(true);
    expect(isSidePanelRequest({ type: "GUIDE_CAPTURE_CONTEXT", shareVisual: "yes" })).toBe(false);
    expect(isSidePanelRequest({ type: "GUIDE_SHOW_GUIDANCE", snapshotId: "x".repeat(129), command: {} })).toBe(false);
    expect(isContentRequest({ type: "CONTENT_PREPARE_SCREENSHOT" })).toBe(true);
    expect(isContentRequest({ type: "CONTENT_VERIFY_SCREENSHOT_SHIELD" })).toBe(true);
    expect(isContentRequest({ type: "CONTENT_SHOW_GUIDANCE", snapshotId: 123, command: {} })).toBe(false);
    expect(isContentRequest({ type: "CONTENT_EVALUATE", source: "alert(1)" })).toBe(false);
  });

  it("validates content responses before the side panel or service worker trusts them", () => {
    expect(isGuidanceResponse({ ok: true, shownRefs: ["e1"] })).toBe(true);
    expect(isGuidanceResponse({ ok: true, shownRefs: ["#selector"] })).toBe(false);
    expect(isGuidanceResponse({ ok: false, error: "stale" })).toBe(true);
    expect(isCaptureResponse({ ok: true, context: null })).toBe(false);
    expect(isCaptureResponse({ ok: false, error: "access lost", pauseReason: "access-lost" })).toBe(true);
  });
});
