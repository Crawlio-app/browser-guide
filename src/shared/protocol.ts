import { isPageContext, type GuidanceMirror, type PageContext } from "./page-context.js";
import type { GuidanceCommand } from "./assistant-contract.js";

export type PermissionPauseReason = "not-authorized" | "origin-changed" | "page-changed" | "restricted-page" | "access-lost";

export type GuideMode = "ask" | "find" | "walkthrough";
export type GuideTurnStatus = "capturing" | "responding" | "pointing" | "complete" | "failed" | "superseded";

export interface GuideTurn {
  turnId: string;
  snapshotId: string;
  mode: GuideMode;
  status: GuideTurnStatus;
}

export type WalkthroughPhase = "active" | "awaiting-page-change" | "awaiting-user" | "paused" | "complete";
export type WalkthroughPauseReason = "user" | "page-churn" | "origin-changed" | "tab-changed" | "restricted-page" | "access-lost" | "stale-evidence" | "limit";

export interface WalkthroughSession {
  id: string;
  goal: string;
  phase: WalkthroughPhase;
  step: number;
  origin: string;
  startedAt: number;
  refreshCount: number;
  pauseReason?: WalkthroughPauseReason;
}

export interface ExtensionRuntimeState {
  status: "ready" | "permission-paused";
  tabId?: number;
  authorizedOrigin?: string;
  pauseReason?: PermissionPauseReason;
  refsValid: boolean;
  latestSnapshotId?: string;
}

export type SidePanelRequest =
  | { type: "GUIDE_GET_STATE" }
  | { type: "GUIDE_ENGINE_PREFERENCE_GET" }
  | { type: "GUIDE_ENGINE_PREFERENCE_SET"; engine: "realtime" | "claude" }
  | { type: "GUIDE_CAPTURE_CONTEXT"; shareVisual: boolean }
  | { type: "GUIDE_SHOW_GUIDANCE"; snapshotId: string; command: GuidanceCommand }
  | { type: "GUIDE_CLEAR_GUIDANCE" }
  | { type: "GUIDE_END_SESSION" }
  | { type: "GUIDE_RESUME_REQUEST" };

export type ServiceWorkerEvent =
  | { type: "GUIDE_RUNTIME_STATE"; state: ExtensionRuntimeState }
  | { type: "GUIDE_TOGGLE_LISTENING" }
  | { type: "GUIDE_REFS_INVALIDATED"; snapshotId?: string };

export type ContentRequest =
  | { type: "CONTENT_CAPTURE_CONTEXT" }
  | { type: "CONTENT_VALIDATE_SNAPSHOT"; snapshotId: string }
  | { type: "CONTENT_SHOW_GUIDANCE"; snapshotId: string; command: GuidanceCommand }
  | { type: "CONTENT_CLEAR_GUIDANCE" }
  | { type: "CONTENT_PREPARE_SCREENSHOT" }
  | { type: "CONTENT_VERIFY_SCREENSHOT_SHIELD" }
  | { type: "CONTENT_FINISH_SCREENSHOT" }
  | { type: "CONTENT_END_SESSION" };

export type CaptureResponse =
  | { ok: true; context: PageContext }
  | { ok: false; error: string; pauseReason?: PermissionPauseReason };

export type GuidanceResponse = { ok: true; shownRefs: string[]; mirror?: GuidanceMirror } | { ok: false; error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isExtensionRuntimeState(value: unknown): value is ExtensionRuntimeState {
  if (!isRecord(value)
    || (value.status !== "ready" && value.status !== "permission-paused")
    || typeof value.refsValid !== "boolean") return false;
  if (value.tabId !== undefined && (!Number.isInteger(value.tabId) || (value.tabId as number) < 0)) return false;
  if (value.authorizedOrigin !== undefined
    && (typeof value.authorizedOrigin !== "string" || !isWebOrigin(value.authorizedOrigin))) return false;
  if (value.latestSnapshotId !== undefined
    && (typeof value.latestSnapshotId !== "string" || value.latestSnapshotId.length > 128)) return false;
  if (value.pauseReason !== undefined && !isPermissionPauseReason(value.pauseReason)) return false;
  if (value.status === "ready" && (value.tabId === undefined || value.authorizedOrigin === undefined || value.pauseReason !== undefined)) return false;
  if (value.refsValid && value.latestSnapshotId === undefined) return false;
  return true;
}

function isPermissionPauseReason(value: unknown): value is PermissionPauseReason {
  return value === "not-authorized" || value === "origin-changed" || value === "page-changed"
    || value === "restricted-page" || value === "access-lost";
}

function isWebOrigin(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
  } catch {
    return false;
  }
}

export function isSidePanelRequest(value: unknown): value is SidePanelRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "GUIDE_GET_STATE":
    case "GUIDE_ENGINE_PREFERENCE_GET":
    case "GUIDE_CLEAR_GUIDANCE":
    case "GUIDE_END_SESSION":
    case "GUIDE_RESUME_REQUEST":
      return true;
    case "GUIDE_ENGINE_PREFERENCE_SET":
      return value.engine === "realtime" || value.engine === "claude";
    case "GUIDE_CAPTURE_CONTEXT":
      return typeof value.shareVisual === "boolean";
    case "GUIDE_SHOW_GUIDANCE":
      return typeof value.snapshotId === "string" && value.snapshotId.length <= 128 && isRecord(value.command);
    default:
      return false;
  }
}

export function isContentRequest(value: unknown): value is ContentRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "CONTENT_CAPTURE_CONTEXT" || value.type === "CONTENT_CLEAR_GUIDANCE"
    || value.type === "CONTENT_PREPARE_SCREENSHOT" || value.type === "CONTENT_FINISH_SCREENSHOT"
    || value.type === "CONTENT_VERIFY_SCREENSHOT_SHIELD"
    || value.type === "CONTENT_END_SESSION") return true;
  if (value.type === "CONTENT_VALIDATE_SNAPSHOT") {
    return typeof value.snapshotId === "string" && value.snapshotId.length <= 128;
  }
  return value.type === "CONTENT_SHOW_GUIDANCE"
    && typeof value.snapshotId === "string"
    && value.snapshotId.length <= 128
    && isRecord(value.command);
}

export function isCaptureResponse(value: unknown): value is CaptureResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return isPageContext(value.context);
  return typeof value.error === "string" && value.error.length <= 1_000
    && (value.pauseReason === undefined || isPermissionPauseReason(value.pauseReason));
}

export function isGuidanceResponse(value: unknown): value is GuidanceResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string" && value.error.length <= 1_000;
  if (!Array.isArray(value.shownRefs) || value.shownRefs.length > 3
    || !value.shownRefs.every((ref) => isElementRef(ref))) return false;
  return value.mirror === undefined || isGuidanceMirror(value.mirror, value.shownRefs as string[]);
}

function isGuidanceMirror(value: unknown, shownRefs: string[]): value is GuidanceMirror {
  if (!isRecord(value)
    || !isElementRef(value.primaryRef)
    || !shownRefs.includes(value.primaryRef)
    || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 48
    || typeof value.body !== "string" || value.body.length < 1 || value.body.length > 160
    || (value.presentation !== "point" && value.presentation !== "step")
    || (value.waitFor !== "none" && value.waitFor !== "page_change" && value.waitFor !== "user_confirm")
    || !isRecord(value.viewport)
    || value.viewport.coordinateSpace !== "layout-viewport-css-px"
    || !boundedFinite(value.viewport.width, 0, 100_000)
    || !boundedFinite(value.viewport.height, 0, 100_000)
    || !boundedFinite(value.viewport.offsetLeft, -100_000, 100_000)
    || !boundedFinite(value.viewport.offsetTop, -100_000, 100_000)
    || !boundedFinite(value.viewport.devicePixelRatio, 0.1, 20)
    || !boundedFinite(value.viewport.scale, 0.01, 100)
    || !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > 3) return false;
  if (value.progress !== undefined) {
    if (!isRecord(value.progress)
      || !Number.isInteger(value.progress.current)
      || (value.progress.current as number) < 1
      || (value.progress.current as number) > 12) return false;
    if (value.progress.total !== undefined
      && (!Number.isInteger(value.progress.total)
        || (value.progress.total as number) < (value.progress.current as number)
        || (value.progress.total as number) > 12)) return false;
  }
  return value.targets.every((target) => {
    if (!isRecord(target) || !isElementRef(target.ref) || !shownRefs.includes(target.ref)
      || !["visible", "above", "below", "left", "right", "outside"].includes(String(target.visibility))
      || !isRecord(target.rect)) return false;
    const rect = target.rect;
    return ["x", "y", "width", "height", "top", "right", "bottom", "left"]
      .every((key) => boundedFinite(rect[key], -1_000_000, 1_000_000));
  });
}

function isElementRef(value: unknown): value is string {
  return typeof value === "string" && /^e[1-9][0-9]*$/.test(value);
}

function boundedFinite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
