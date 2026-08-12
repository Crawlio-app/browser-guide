export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type ElementVisibility = "visible" | "above" | "below" | "left" | "right" | "outside";

export type AriaCheckedState = boolean | "mixed";
export type AriaCurrentState = boolean | "page" | "step" | "location" | "date" | "time";

export type SemanticGroup =
  | "page"
  | "navigation"
  | "main"
  | "banner"
  | "contentinfo"
  | "complementary"
  | "region"
  | "article"
  | "form"
  | "list"
  | "table"
  | "dialog";

export type VisualOmissionReason =
  | "not-requested"
  | "privacy-protection"
  | "capture-unavailable"
  | "capture-failed";

export interface VisualOmissionMetadata {
  omitted: true;
  reason: VisualOmissionReason;
}

export interface GuidanceViewportMirror {
  coordinateSpace: "layout-viewport-css-px";
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  devicePixelRatio: number;
  scale: number;
}

export interface GuidanceTargetMirror {
  ref: string;
  rect: ViewportRect;
  visibility: ElementVisibility;
}

export interface GuidanceMirror {
  primaryRef: string;
  title: string;
  body: string;
  presentation: "point" | "step";
  waitFor: "none" | "page_change" | "user_confirm";
  progress?: { current: number; total?: number };
  viewport: GuidanceViewportMirror;
  targets: GuidanceTargetMirror[];
}

export interface PageElementCandidate {
  ref: string;
  role: string;
  name: string;
  text?: string;
  visibility: ElementVisibility;
  section: string;
  semanticGroup?: SemanticGroup;
  rect: ViewportRect;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  checked?: AriaCheckedState;
  current?: AriaCurrentState;
  /** Fraction of sampled visible points blocked by another element: 0 is clear, 1 is fully occluded. */
  occlusionConfidence?: number;
}

export interface PageContext {
  snapshotId: string;
  capturedAt: string;
  title: string;
  url: string;
  origin: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  elements: PageElementCandidate[];
  truncated: boolean;
  characterCount: number;
  visualOmission?: VisualOmissionMetadata;
  screenshotDataUrl?: string;
}

export const MAX_PAGE_CANDIDATES = 300;
export const MAX_PAGE_CONTEXT_CHARACTERS = 12_000;
export const MAX_ELEMENT_TEXT = 180;
export const MAX_ACCESSIBLE_NAME = 160;
export const MAX_GUIDANCE_TARGETS = 3;

export function contextForModel(context: PageContext): Omit<PageContext, "screenshotDataUrl"> {
  const { screenshotDataUrl: _screenshot, ...safeContext } = context;
  return safeContext;
}

export function isPageContext(value: unknown): value is PageContext {
  if (!isObject(value) || !Array.isArray(value.elements) || value.elements.length > MAX_PAGE_CANDIDATES) return false;
  if (typeof value.snapshotId !== "string" || value.snapshotId.length > 128) return false;
  if (typeof value.capturedAt !== "string" || typeof value.title !== "string" || typeof value.url !== "string" || typeof value.origin !== "string") return false;
  if (!isObject(value.viewport) || !finite(value.viewport.width) || !finite(value.viewport.height) || !finite(value.viewport.devicePixelRatio)) return false;
  if (typeof value.truncated !== "boolean" || !finite(value.characterCount) || value.characterCount > MAX_PAGE_CONTEXT_CHARACTERS + 256) return false;
  if (value.visualOmission !== undefined && !isVisualOmission(value.visualOmission)) return false;
  return value.elements.every(isCandidate);
}

function isCandidate(value: unknown): value is PageElementCandidate {
  if (!isObject(value) || typeof value.ref !== "string" || !/^e[1-9][0-9]*$/.test(value.ref)) return false;
  if (typeof value.role !== "string" || typeof value.name !== "string" || typeof value.section !== "string") return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (!["visible", "above", "below", "left", "right", "outside"].includes(String(value.visibility))) return false;
  if (value.semanticGroup !== undefined && !SEMANTIC_GROUPS.includes(value.semanticGroup as SemanticGroup)) return false;
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return false;
  if (value.expanded !== undefined && typeof value.expanded !== "boolean") return false;
  if (value.selected !== undefined && typeof value.selected !== "boolean") return false;
  if (value.checked !== undefined && typeof value.checked !== "boolean" && value.checked !== "mixed") return false;
  if (value.current !== undefined && !ARIA_CURRENT_STATES.includes(value.current as AriaCurrentState)) return false;
  if (value.occlusionConfidence !== undefined
    && (!finite(value.occlusionConfidence) || value.occlusionConfidence < 0 || value.occlusionConfidence > 1)) return false;
  const rect = value.rect;
  if (!isObject(rect)) return false;
  return ["x", "y", "width", "height", "top", "right", "bottom", "left"].every((key) => finite(rect[key]));
}

const SEMANTIC_GROUPS: readonly SemanticGroup[] = [
  "page", "navigation", "main", "banner", "contentinfo", "complementary", "region", "article", "form", "list", "table", "dialog",
];

const ARIA_CURRENT_STATES: readonly AriaCurrentState[] = [true, false, "page", "step", "location", "date", "time"];

const VISUAL_OMISSION_REASONS: readonly VisualOmissionReason[] = [
  "not-requested", "privacy-protection", "capture-unavailable", "capture-failed",
];

function isVisualOmission(value: unknown): value is VisualOmissionMetadata {
  return isObject(value) && value.omitted === true
    && VISUAL_OMISSION_REASONS.includes(value.reason as VisualOmissionReason);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
