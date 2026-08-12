import { describe, expect, it, vi } from "vitest";
import type { ShowGuidanceCommand } from "../../src/shared/assistant-contract.js";
import {
  WALKTHROUGH_MAX_DURATION_MS,
  WALKTHROUGH_QUIET_WINDOW_MS,
  WALKTHROUGH_REFRESH_INTERVAL_MS,
  WalkthroughCoordinator,
} from "../../src/shared/walkthrough.js";

const origin = "https://fixture.test";

function step(waitFor: ShowGuidanceCommand["waitFor"] = "page_change", current = 1): ShowGuidanceCommand {
  return {
    name: "show_guidance",
    refs: ["e1"],
    title: "Review invoices",
    body: "Choose this control, then wait for the page to change.",
    presentation: "step",
    waitFor,
    progress: { current, total: 12 },
  };
}

describe("bounded walkthrough policy", () => {
  it("refreshes only after page-change guidance, a quiet window, and the two-second rate limit", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(7);
      return array;
    });
    const coordinator = new WalkthroughCoordinator();
    const started = coordinator.start("Review an invoice", origin, 1_000);
    expect(started).toMatchObject({ goal: "Review an invoice", phase: "active", step: 1, refreshCount: 0 });
    expect(started.id).toHaveLength(24);
    expect(coordinator.invalidate(origin, 1_100)).toEqual({ action: "ignore" });

    expect(coordinator.receiveGuidance(step())).toMatchObject({ phase: "awaiting-page-change" });
    expect(coordinator.invalidate(origin, 1_100)).toEqual({ action: "schedule", delayMs: WALKTHROUGH_QUIET_WINDOW_MS });
    expect(coordinator.beginRefresh(1_700)).toMatchObject({ phase: "active", refreshCount: 1 });

    coordinator.receiveGuidance(step("page_change", 2));
    expect(coordinator.invalidate(origin, 1_800)).toEqual({
      action: "schedule",
      delayMs: WALKTHROUGH_REFRESH_INTERVAL_MS - 100,
    });
  });

  it("waits for the quiet window after the last reported mutation", () => {
    const coordinator = new WalkthroughCoordinator();
    coordinator.start("Review an invoice", origin, 2_000);
    coordinator.receiveGuidance(step());

    expect(coordinator.invalidate(origin, 2_100)).toEqual({
      action: "schedule",
      delayMs: WALKTHROUGH_QUIET_WINDOW_MS,
    });
    expect(coordinator.invalidate(origin, 2_500)).toEqual({
      action: "schedule",
      delayMs: WALKTHROUGH_QUIET_WINDOW_MS,
    });
    expect(coordinator.beginRefresh(2_700)).toBeNull();
    expect(coordinator.refreshDelay(2_700)).toBe(400);
    expect(coordinator.beginRefresh(3_100)).toMatchObject({ phase: "active", refreshCount: 1 });
  });

  it("supports manual Continue when no detectable page change occurs", () => {
    const coordinator = new WalkthroughCoordinator();
    coordinator.start("Open billing settings", origin, 5_000);
    expect(coordinator.receiveGuidance(step("user_confirm"))).toMatchObject({ phase: "awaiting-user" });
    expect(coordinator.invalidate(origin, 5_100)).toEqual({ action: "ignore" });
    expect(coordinator.beginRefresh(5_200)).toMatchObject({ phase: "active", refreshCount: 1 });
    coordinator.receiveGuidance(step("user_confirm", 2));
    expect(coordinator.beginRefresh(5_300)).toBeNull();
    expect(coordinator.refreshDelay(5_300)).toBe(WALKTHROUGH_REFRESH_INTERVAL_MS - 100);
  });

  it("enters a terminal complete phase for the reported final step", () => {
    const coordinator = new WalkthroughCoordinator();
    coordinator.start("Open billing settings", origin, 6_000);
    expect(coordinator.receiveGuidance({ ...step("none", 3), progress: { current: 3, total: 3 } }))
      .toMatchObject({ phase: "complete", step: 3 });
    expect(coordinator.complete()).toMatchObject({ phase: "complete" });
    expect(coordinator.pause("user")).toMatchObject({ phase: "complete", pauseReason: undefined });
    expect(coordinator.receiveGuidance(step("page_change", 2)))
      .toMatchObject({ phase: "complete", step: 3, pauseReason: undefined });
    expect(coordinator.resume(origin, 6_100)).toBeNull();
  });

  it("pauses on cross-origin navigation and excessive DOM churn", () => {
    const changedOrigin = new WalkthroughCoordinator();
    changedOrigin.start("Review an invoice", origin, 10_000);
    changedOrigin.receiveGuidance(step());
    expect(changedOrigin.invalidate("https://accounts.fixture.test", 10_100)).toEqual({
      action: "pause",
      reason: "origin-changed",
    });
    expect(changedOrigin.session).toMatchObject({ phase: "paused", pauseReason: "origin-changed" });

    const churning = new WalkthroughCoordinator();
    churning.start("Review an invoice", origin, 20_000);
    for (let index = 0; index < 4; index += 1) {
      const invalidatedAt = 20_100 + index * 2_100;
      churning.receiveGuidance(step("page_change", index + 1));
      expect(churning.invalidate(origin, invalidatedAt).action).toBe("schedule");
      expect(churning.beginRefresh(invalidatedAt + 600)).not.toBeNull();
    }
    churning.receiveGuidance(step("page_change", 5));
    expect(churning.invalidate(origin, 28_500)).toEqual({ action: "pause", reason: "page-churn" });
    expect(churning.session).toMatchObject({ phase: "paused", pauseReason: "page-churn" });
  });

  it("enforces the twelve-step and thirty-minute dead-man limits", () => {
    const stepLimited = new WalkthroughCoordinator();
    stepLimited.start("Review an invoice", origin, 30_000);
    stepLimited.receiveGuidance(step("page_change", 12));
    expect(stepLimited.invalidate(origin, 30_100)).toEqual({ action: "pause", reason: "limit" });

    const timeLimited = new WalkthroughCoordinator();
    timeLimited.start("Review an invoice", origin, 40_000);
    timeLimited.receiveGuidance(step());
    expect(timeLimited.invalidate(origin, 40_000 + WALKTHROUGH_MAX_DURATION_MS)).toEqual({
      action: "pause",
      reason: "limit",
    });
  });

  it("exposes and enforces the thirty-minute deadline without requiring page activity", () => {
    const coordinator = new WalkthroughCoordinator();
    coordinator.start("Review an invoice", origin, 60_000);
    coordinator.receiveGuidance(step("user_confirm"));
    expect(coordinator.expiresAt).toBe(60_000 + WALKTHROUGH_MAX_DURATION_MS);
    expect(coordinator.expire(60_000 + WALKTHROUGH_MAX_DURATION_MS - 1)).toBeNull();
    expect(coordinator.session).toMatchObject({ phase: "awaiting-user", pauseReason: undefined });

    expect(coordinator.expire(60_000 + WALKTHROUGH_MAX_DURATION_MS)).toMatchObject({
      phase: "paused",
      pauseReason: "limit",
    });
    expect(coordinator.expiresAt).toBeNull();
    expect(coordinator.resume(origin, 60_000 + WALKTHROUGH_MAX_DURATION_MS + 1)).toMatchObject({
      phase: "paused",
      pauseReason: "limit",
    });
  });

  it("requires the original origin to resume a user-paused session", () => {
    const coordinator = new WalkthroughCoordinator();
    coordinator.start("Review an invoice", origin, 50_000);
    coordinator.pause("user");
    expect(coordinator.resume("https://other.test", 50_100)).toBeNull();
    expect(coordinator.resume(origin, 50_200)).toMatchObject({ phase: "awaiting-user", pauseReason: undefined });
    coordinator.stop();
    expect(coordinator.session).toBeNull();
  });
});
