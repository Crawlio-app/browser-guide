import {
  MAX_ACCESSIBLE_NAME,
  MAX_ELEMENT_TEXT,
  MAX_PAGE_CANDIDATES,
  MAX_PAGE_CONTEXT_CHARACTERS,
  type AriaCheckedState,
  type AriaCurrentState,
  type ElementVisibility,
  type PageContext,
  type PageElementCandidate,
  type SemanticGroup,
  type ViewportRect,
} from "../../shared/page-context.js";
import { redactText, sanitizeOrigin, sanitizePageContext, sanitizeUrl } from "../../shared/sanitization.js";
import { ElementRegistry } from "./element-registry.js";

const CANDIDATE_SELECTOR = [
  "a[href]", "button", "input:not([type='hidden'])", "select", "textarea", "summary", "details",
  "[role]", "[aria-label]", "[aria-labelledby]", "[tabindex]:not([tabindex='-1'])",
  "h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header", "footer", "aside",
  "section", "article", "p", "li", "td", "th", "label", "img[alt]",
].join(",");
const MAX_SCANNED_ELEMENTS = 4_000;
const MUTATION_ACTIVITY_HEARTBEAT_MS = 120;
const SKIP_ANCESTOR_SELECTOR = "[data-browser-guide-root],script,style,noscript,template,[aria-hidden='true']";
const SENSITIVE_CONTENT_SELECTOR = "input,textarea,[contenteditable='true'],[contenteditable='plaintext-only']";

const TAG_ROLES: Record<string, string> = {
  A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button",
  H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary",
  SECTION: "region", ARTICLE: "article", P: "paragraph", LI: "listitem", TD: "cell", TH: "columnheader",
  IMG: "img", LABEL: "label",
};

const SEMANTIC_GROUP_BY_TAG: Record<string, SemanticGroup> = {
  NAV: "navigation",
  MAIN: "main",
  HEADER: "banner",
  FOOTER: "contentinfo",
  ASIDE: "complementary",
  SECTION: "region",
  ARTICLE: "article",
  FORM: "form",
  UL: "list",
  OL: "list",
  TABLE: "table",
  DIALOG: "dialog",
};

const SEMANTIC_GROUP_BY_ROLE: Partial<Record<string, SemanticGroup>> = {
  navigation: "navigation",
  main: "main",
  banner: "banner",
  contentinfo: "contentinfo",
  complementary: "complementary",
  region: "region",
  article: "article",
  form: "form",
  list: "list",
  table: "table",
  dialog: "dialog",
  alertdialog: "dialog",
};

export class PageObserver {
  private readonly mutationObserver: MutationObserver;
  private invalidationTimer: number | null = null;
  private activityHeartbeatTimer: number | null = null;
  private pendingSnapshotId: string | null = null;

  constructor(
    private readonly registry: ElementRegistry,
    private readonly isOverlayNode: (node: Node) => boolean,
    private readonly reportMutationActivity: (snapshotId: string) => void = () => undefined,
  ) {
    this.mutationObserver = new MutationObserver((mutations) => this.handleMutations(mutations));
    const root = document.documentElement;
    if (root) {
      this.mutationObserver.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "aria-label", "aria-labelledby", "aria-hidden", "aria-expanded", "aria-selected", "aria-checked", "aria-current",
          "role", "hidden", "disabled", "class", "style",
        ],
      });
    }
  }

  capture(): PageContext {
    const snapshotId = this.registry.beginSnapshot();
    const ranked = collectRankedElements();
    const elements: PageElementCandidate[] = [];
    let truncated = ranked.length > MAX_PAGE_CANDIDATES;
    const base = {
      snapshotId,
      capturedAt: new Date().toISOString(),
      title: redactText(document.title || "Untitled page", 240),
      url: sanitizeUrl(location.href),
      origin: sanitizeOrigin(location.origin),
      viewport: {
        width: Math.max(0, Math.round(window.innerWidth)),
        height: Math.max(0, Math.round(window.innerHeight)),
        devicePixelRatio: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1,
      },
    };

    for (const element of ranked) {
      if (elements.length >= MAX_PAGE_CANDIDATES) {
        truncated = true;
        break;
      }
      const previewRef = this.registry.nextRefPreview();
      const candidate = candidateFromElement(element, previewRef);
      if (!candidate) continue;
      const projected = JSON.stringify({ ...base, elements: [...elements, candidate], truncated, characterCount: 0 }).length;
      if (projected > MAX_PAGE_CONTEXT_CHARACTERS - 32) {
        truncated = true;
        break;
      }
      const ref = this.registry.register(element);
      elements.push(ref === previewRef ? candidate : { ...candidate, ref });
    }

    let context: PageContext = { ...base, elements, truncated, characterCount: 0 };
    context.characterCount = JSON.stringify(context).length;
    while (context.characterCount > MAX_PAGE_CONTEXT_CHARACTERS && context.elements.length > 0) {
      context.elements.pop();
      context.truncated = true;
      context.characterCount = JSON.stringify({ ...context, characterCount: 0 }).length;
    }
    return sanitizePageContext(context);
  }

  disconnect(): void {
    this.mutationObserver.disconnect();
    if (this.invalidationTimer !== null) window.clearTimeout(this.invalidationTimer);
    if (this.activityHeartbeatTimer !== null) window.clearTimeout(this.activityHeartbeatTimer);
    this.invalidationTimer = null;
    this.activityHeartbeatTimer = null;
    this.pendingSnapshotId = null;
  }

  private handleMutations(mutations: MutationRecord[]): void {
    const meaningful = mutations.some((mutation) => isMeaningfulMutation(mutation, this.isOverlayNode));
    if (!meaningful) return;
    const snapshotId = this.registry.snapshotId;
    if (!snapshotId) return;
    if (this.invalidationTimer !== null) {
      window.clearTimeout(this.invalidationTimer);
    }
    if (this.pendingSnapshotId !== snapshotId && this.activityHeartbeatTimer !== null) {
      window.clearTimeout(this.activityHeartbeatTimer);
      this.activityHeartbeatTimer = null;
    }
    this.pendingSnapshotId = snapshotId;
    if (!this.registry.refsValid && this.activityHeartbeatTimer === null) {
      this.activityHeartbeatTimer = window.setTimeout(() => {
        this.activityHeartbeatTimer = null;
        if (this.pendingSnapshotId === snapshotId
          && this.registry.snapshotId === snapshotId
          && !this.registry.refsValid) {
          this.reportMutationActivity(snapshotId);
        }
      }, MUTATION_ACTIVITY_HEARTBEAT_MS);
    }
    this.invalidationTimer = window.setTimeout(() => {
      this.invalidationTimer = null;
      if (this.activityHeartbeatTimer !== null) window.clearTimeout(this.activityHeartbeatTimer);
      this.activityHeartbeatTimer = null;
      const pendingSnapshotId = this.pendingSnapshotId;
      this.pendingSnapshotId = null;
      if (!pendingSnapshotId || this.registry.snapshotId !== pendingSnapshotId) return;
      if (this.registry.refsValid) {
        this.registry.invalidate("mutation");
      } else {
        this.reportMutationActivity(pendingSnapshotId);
      }
    }, 60);
  }
}

export function inferRole(element: Element): string {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  return TAG_ROLES[element.tagName] ?? "generic";
}

export function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return redactText(ariaLabel, MAX_ACCESSIBLE_NAME);

  const labelledBy = element.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (labelledBy.length > 0) {
    const label = labelledBy.slice(0, 5).map((id) => {
      const source = document.getElementById(id);
      return source ? safeElementText(source, MAX_ACCESSIBLE_NAME) : "";
    }).filter(Boolean).join(" ");
    if (label) return redactText(label, MAX_ACCESSIBLE_NAME);
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const label = [...(element.labels ?? [])].map((item) => safeElementText(item, 100)).filter(Boolean).join(" ");
    if (label) return redactText(label, MAX_ACCESSIBLE_NAME);
    const placeholder = element.getAttribute("placeholder")?.trim();
    if (placeholder) return redactText(placeholder, MAX_ACCESSIBLE_NAME);
  }
  if (element instanceof HTMLImageElement && element.alt.trim()) return redactText(element.alt.trim(), MAX_ACCESSIBLE_NAME);
  const title = element.getAttribute("title")?.trim();
  if (title) return redactText(title, MAX_ACCESSIBLE_NAME);
  return redactText(safeElementText(element, MAX_ACCESSIBLE_NAME), MAX_ACCESSIBLE_NAME);
}

export function safeElementText(element: Element, maxLength = MAX_ELEMENT_TEXT): string {
  if (element.matches(SENSITIVE_CONTENT_SELECTOR)) return "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SENSITIVE_CONTENT_SELECTOR) || parent.closest(SKIP_ANCESTOR_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const pieces: string[] = [];
  let length = 0;
  for (let node = walker.nextNode(); node && length < maxLength; node = walker.nextNode()) {
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    pieces.push(text);
    length += text.length + 1;
  }
  return redactText(pieces.join(" "), maxLength);
}

export function detectSection(element: Element): string {
  const container = findSemanticContainer(element);
  if (container) {
    const label = container.element.getAttribute("aria-label")
      || safeComponentHint(container.element)
      || nearestHeadingText(container.element);
    return redactText(label ? container.group + ": " + label : container.group, 120);
  }
  return "page";
}

export function detectSemanticGroup(element: Element): SemanticGroup {
  return findSemanticContainer(element)?.group ?? "page";
}

export function classifyVisibility(rect: DOMRect): ElementVisibility {
  if (rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) return "visible";
  if (rect.bottom <= 0) return "above";
  if (rect.top >= window.innerHeight) return "below";
  if (rect.right <= 0) return "left";
  if (rect.left >= window.innerWidth) return "right";
  return "outside";
}

function collectRankedElements(): Element[] {
  const body = document.body;
  if (!body) return [];
  const candidates = [...body.querySelectorAll(CANDIDATE_SELECTOR)].slice(0, MAX_SCANNED_ELEMENTS)
    .filter((element) => !element.closest(SKIP_ANCESTOR_SELECTOR) && isRelevant(element));
  return candidates.sort((left, right) => rankElement(right) - rankElement(left));
}

function isRelevant(element: Element): boolean {
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || (style.opacity !== "" && Number(style.opacity) === 0)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const role = inferRole(element);
  return role !== "generic" || accessibleName(element).length > 0 || safeElementText(element, 40).length > 0;
}

function rankElement(element: Element): number {
  const rect = element.getBoundingClientRect();
  const visible = classifyVisibility(rect) === "visible";
  const role = inferRole(element);
  const interactive = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "tab", "menuitem"].includes(role);
  const semantic = ["heading", "navigation", "main", "region", "article"].includes(role);
  const distance = Math.abs(rect.top - window.innerHeight / 2);
  return (visible ? 1_000_000 : 0) + (interactive ? 20_000 : 0) + (semantic ? 10_000 : 0) - Math.min(distance, 100_000);
}

function candidateFromElement(element: Element, ref: string): PageElementCandidate | null {
  const rect = element.getBoundingClientRect();
  const role = inferRole(element);
  const name = accessibleName(element);
  const text = role === "textbox" || role === "searchbox" ? "" : safeElementText(element);
  if (!name && !text && role === "generic") return null;
  const expanded = ariaBoolean(element, "aria-expanded");
  const selected = ariaBoolean(element, "aria-selected");
  const checked = ariaChecked(element);
  const current = ariaCurrent(element);
  const occlusionConfidence = estimateOcclusionConfidence(element, rect);
  return {
    ref,
    role,
    name: name || text.slice(0, MAX_ACCESSIBLE_NAME),
    text: text && text !== name ? text : undefined,
    visibility: classifyVisibility(rect),
    section: detectSection(element),
    semanticGroup: detectSemanticGroup(element),
    rect: roundedRect(rect),
    disabled: element.matches(":disabled,[aria-disabled='true']") || undefined,
    expanded,
    selected,
    checked,
    current,
    occlusionConfidence,
  };
}

export function estimateOcclusionConfidence(element: Element, rect = element.getBoundingClientRect()): number | undefined {
  if (classifyVisibility(rect) !== "visible") return undefined;
  const elementsFromPoint = typeof document.elementsFromPoint === "function"
    ? (x: number, y: number) => document.elementsFromPoint(x, y)
    : typeof document.elementFromPoint === "function"
      ? (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return hit ? [hit] : [];
      }
      : null;
  if (!elementsFromPoint) return undefined;

  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return undefined;
  const insetX = Math.min(2, Math.max(0, (right - left) / 4));
  const insetY = Math.min(2, Math.max(0, (bottom - top) / 4));
  const points = uniquePoints([
    [left + (right - left) / 2, top + (bottom - top) / 2],
    [left + insetX, top + insetY],
    [right - insetX, top + insetY],
    [left + insetX, bottom - insetY],
    [right - insetX, bottom - insetY],
  ]);

  let blocked = 0;
  let sampled = 0;
  try {
    for (const [x, y] of points) {
      const topElement = elementsFromPoint(x, y).find((hit) => !hit.closest("[data-browser-guide-root]"));
      if (!topElement) continue;
      sampled += 1;
      if (topElement !== element && !element.contains(topElement)) blocked += 1;
    }
  } catch {
    return undefined;
  }
  return sampled > 0 ? Math.round((blocked / sampled) * 100) / 100 : undefined;
}

function roundedRect(rect: DOMRect): ViewportRect {
  return {
    x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), left: Math.round(rect.left),
  };
}

function ariaBoolean(element: Element, attribute: "aria-expanded" | "aria-selected"): boolean | undefined {
  const value = element.getAttribute(attribute)?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function ariaChecked(element: Element): AriaCheckedState | undefined {
  const value = element.getAttribute("aria-checked")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return value === "mixed" ? "mixed" : undefined;
}

function ariaCurrent(element: Element): AriaCurrentState | undefined {
  const value = element.getAttribute("aria-current")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "page" || value === "step" || value === "location" || value === "date" || value === "time") return value;
  return undefined;
}

function findSemanticContainer(element: Element): { element: Element; group: SemanticGroup } | null {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    const role = current.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
    const group = (role ? SEMANTIC_GROUP_BY_ROLE[role] : undefined) ?? SEMANTIC_GROUP_BY_TAG[current.tagName];
    if (group) return { element: current, group };
  }
  return null;
}

function uniquePoints(points: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  return points.filter(([x, y]) => {
    const key = Math.round(x * 10) + ":" + Math.round(y * 10);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeComponentHint(element: Element): string {
  for (const attribute of ["data-component", "data-section", "data-block", "data-module"]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value && /^[A-Za-z][A-Za-z0-9_-]{0,48}$/.test(value) && !/\d{5,}/.test(value)) {
      return value.replace(/[-_]+/g, " ");
    }
  }
  return "";
}

function nearestHeadingText(container: Element): string {
  const heading = container.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > header h1, :scope > header h2");
  return heading ? safeElementText(heading, 80) : "";
}

function isMeaningfulMutation(mutation: MutationRecord, isOverlayNode: (node: Node) => boolean): boolean {
  if (isOverlayNode(mutation.target)) return false;
  if (mutation.type === "attributes") {
    return mutation.target instanceof Element && !mutation.target.closest("[data-browser-guide-root]");
  }
  if (mutation.type === "characterData") {
    const parent = mutation.target.parentElement;
    return Boolean(parent?.closest(CANDIDATE_SELECTOR) && !parent.closest("[data-browser-guide-root]"));
  }
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !isOverlayNode(node) && (
    node.nodeType === Node.TEXT_NODE
    || (node instanceof Element && (node.matches(CANDIDATE_SELECTOR) || Boolean(node.querySelector(CANDIDATE_SELECTOR))))
  ));
}
