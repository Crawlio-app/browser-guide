import type { ShowGuidanceCommand } from "./assistant-contract.js";
import type { WalkthroughPauseReason, WalkthroughSession } from "./protocol.js";

export const WALKTHROUGH_MAX_STEPS = 12;
export const WALKTHROUGH_MAX_DURATION_MS = 30 * 60 * 1_000;
export const WALKTHROUGH_REFRESH_INTERVAL_MS = 2_000;
export const WALKTHROUGH_QUIET_WINDOW_MS = 600;
const CHURN_WINDOW_MS = 10_000;
const CHURN_LIMIT = 4;

export type WalkthroughInvalidationDecision =
  | { action: "ignore" }
  | { action: "schedule"; delayMs: number }
  | { action: "pause"; reason: WalkthroughPauseReason };

export class WalkthroughCoordinator {
  private current: WalkthroughSession | null = null;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private lastInvalidationAt = Number.NEGATIVE_INFINITY;
  private invalidations: number[] = [];

  get session(): WalkthroughSession | null {
    return this.current ? { ...this.current } : null;
  }

  get expiresAt(): number | null {
    if (!this.current || this.current.phase === "complete"
      || (this.current.phase === "paused" && this.current.pauseReason === "limit")) return null;
    return this.current.startedAt + WALKTHROUGH_MAX_DURATION_MS;
  }

  start(goal: string, origin: string, now = Date.now()): WalkthroughSession {
    const cleanGoal = goal.trim().slice(0, 1_000);
    if (!cleanGoal) throw new Error("A walkthrough needs a goal.");
    if (!isWebOrigin(origin)) throw new Error("A walkthrough needs a current web page.");
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
    this.lastInvalidationAt = Number.NEGATIVE_INFINITY;
    this.invalidations = [];
    this.current = {
      id: createId(),
      goal: cleanGoal,
      phase: "active",
      step: 1,
      origin,
      startedAt: now,
      refreshCount: 0,
    };
    return { ...this.current };
  }

  receiveGuidance(command: ShowGuidanceCommand): WalkthroughSession | null {
    if (!this.current) return null;
    if (this.current.phase === "complete") return { ...this.current };
    const reportedStep = command.progress?.current;
    const step = reportedStep === undefined
      ? Math.min(WALKTHROUGH_MAX_STEPS, this.current.refreshCount + 1)
      : Math.min(WALKTHROUGH_MAX_STEPS, Math.max(this.current.step, reportedStep));
    const reportedComplete = command.waitFor === "none"
      && command.progress?.total !== undefined
      && command.progress.current >= command.progress.total;
    this.current = {
      ...this.current,
      step,
      phase: reportedComplete ? "complete" : command.waitFor === "page_change"
        ? "awaiting-page-change"
        : command.waitFor === "user_confirm" ? "awaiting-user" : "active",
      pauseReason: undefined,
    };
    return { ...this.current };
  }

  invalidate(origin: string, now = Date.now()): WalkthroughInvalidationDecision {
    const session = this.current;
    if (!session || session.phase !== "awaiting-page-change") return { action: "ignore" };
    if (origin !== session.origin) {
      this.pause("origin-changed");
      return { action: "pause", reason: "origin-changed" };
    }
    const limit = this.limitReason(now);
    if (limit) {
      this.pause(limit);
      return { action: "pause", reason: limit };
    }
    this.invalidations = this.invalidations.filter((timestamp) => now - timestamp <= CHURN_WINDOW_MS);
    this.invalidations.push(now);
    this.lastInvalidationAt = now;
    if (this.invalidations.length > CHURN_LIMIT) {
      this.pause("page-churn");
      return { action: "pause", reason: "page-churn" };
    }
    return { action: "schedule", delayMs: this.refreshDelay(now) };
  }

  beginRefresh(now = Date.now()): WalkthroughSession | null {
    if (!this.current || (this.current.phase !== "awaiting-page-change" && this.current.phase !== "awaiting-user")) return null;
    const limit = this.limitReason(now);
    if (limit) {
      this.pause(limit);
      return null;
    }
    if (this.refreshDelay(now) > 0) return null;
    this.lastRefreshAt = now;
    this.current = {
      ...this.current,
      phase: "active",
      refreshCount: this.current.refreshCount + 1,
      pauseReason: undefined,
    };
    return { ...this.current };
  }

  refreshDelay(now = Date.now()): number {
    const rateDelay = this.lastRefreshAt + WALKTHROUGH_REFRESH_INTERVAL_MS - now;
    const quietDelay = this.lastInvalidationAt + WALKTHROUGH_QUIET_WINDOW_MS - now;
    return Math.max(0, rateDelay, quietDelay);
  }

  pause(reason: WalkthroughPauseReason = "user"): WalkthroughSession | null {
    if (!this.current) return null;
    if (this.current.phase === "complete") return { ...this.current };
    this.current = { ...this.current, phase: "paused", pauseReason: reason };
    return { ...this.current };
  }

  complete(): WalkthroughSession | null {
    if (!this.current) return null;
    this.current = { ...this.current, phase: "complete", pauseReason: undefined };
    return { ...this.current };
  }

  resume(origin: string, now = Date.now()): WalkthroughSession | null {
    if (!this.current || this.current.phase !== "paused" || origin !== this.current.origin) return null;
    const limit = this.limitReason(now);
    if (limit) return this.pause(limit);
    this.invalidations = [];
    this.current = { ...this.current, phase: "awaiting-user", pauseReason: undefined };
    return { ...this.current };
  }

  expire(now = Date.now()): WalkthroughSession | null {
    if (!this.current || this.current.phase === "complete") return null;
    if (now < this.current.startedAt + WALKTHROUGH_MAX_DURATION_MS) return null;
    return this.pause("limit");
  }

  stop(): void {
    this.current = null;
    this.invalidations = [];
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
    this.lastInvalidationAt = Number.NEGATIVE_INFINITY;
  }

  private limitReason(now: number): WalkthroughPauseReason | null {
    if (!this.current) return "limit";
    return now - this.current.startedAt >= WALKTHROUGH_MAX_DURATION_MS
      || this.current.refreshCount >= WALKTHROUGH_MAX_STEPS - 1
      || this.current.step >= WALKTHROUGH_MAX_STEPS
      ? "limit"
      : null;
  }
}

function isWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function createId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
