import overlayStyles from "./overlay.css";
import type { ShowGuidanceCommand } from "../../shared/assistant-contract.js";
import {
  MAX_GUIDANCE_TARGETS,
  type ElementVisibility,
  type GuidanceMirror,
  type GuidanceViewportMirror,
  type ViewportRect,
} from "../../shared/page-context.js";
import type { ElementRegistry } from "./element-registry.js";

interface TargetVisual {
  ref: string;
  element: Element;
  spotlight: HTMLDivElement;
  marker: HTMLDivElement;
}

export interface OverlayResult {
  ok: boolean;
  shownRefs: string[];
  mirror?: GuidanceMirror;
  error?: string;
}

export type ScreenshotShieldResult =
  | { ok: true; maskedElements: 0 }
  | { ok: false; error: "privacy-protection" };

export class OverlayController {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private layer: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;
  private direction: HTMLButtonElement | null = null;
  private screenshotShieldActive = false;
  private screenshotShieldCompromised = false;
  private screenshotShieldObserver: MutationObserver | null = null;
  private guidanceHiddenForScreenshot = false;
  private targets: TargetVisual[] = [];
  private animationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedVisualViewport: VisualViewport | null = null;
  private copy: Pick<ShowGuidanceCommand, "title" | "body" | "presentation" | "waitFor" | "progress"> | null = null;
  private listening = false;
  private nextButton: HTMLButtonElement | null = null;

  constructor(
    private readonly onAdvance?: (final: boolean) => void,
    private readonly onDismiss?: () => void,
  ) {
    const staleHost = document.querySelector("[data-browser-guide-root]");
    staleHost?.remove();
    this.host = document.createElement("div");
    this.host.setAttribute("data-browser-guide-root", "v1");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.setProperty("pointer-events", "none", "important");
    this.host.style.setProperty("position", "fixed", "important");
    this.host.style.setProperty("inset", "0", "important");
    this.host.style.setProperty("z-index", "2147483647", "important");
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = overlayStyles;
    this.shadow.append(style);
    (document.documentElement || document.body).append(this.host);
  }

  show(command: ShowGuidanceCommand, snapshotId: string, registry: ElementRegistry): OverlayResult {
    this.clear();
    const requestedRefs = [...new Set(command.refs)];
    if (requestedRefs.length > MAX_GUIDANCE_TARGETS) {
      return { ok: false, shownRefs: [], error: `Guidance supports at most ${MAX_GUIDANCE_TARGETS} current refs` };
    }
    const resolved: Array<{ ref: string; element: Element }> = [];
    for (const ref of requestedRefs) {
      const result = registry.resolve(snapshotId, ref);
      if (!result.ok) {
        this.clear();
        return { ok: false, shownRefs: [], error: "Guidance rejected: " + result.error };
      }
      resolved.push({ ref, element: result.element });
    }
    if (resolved.length === 0) return { ok: false, shownRefs: [], error: "Guidance requires at least one current ref" };
    this.copy = {
      title: command.title.trim().slice(0, 48),
      body: command.body.trim().slice(0, 160),
      presentation: command.presentation,
      waitFor: command.waitFor,
      ...(command.progress ? { progress: { ...command.progress } } : {}),
    };

    this.layer = document.createElement("div");
    this.layer.className = "guide-layer";
    this.layer.setAttribute("data-guide-layer", "active");
    this.shadow.append(this.layer);

    this.targets = resolved.map(({ ref, element }, index) => {
      const spotlight = document.createElement("div");
      spotlight.className = "guide-spotlight";
      const marker = document.createElement("div");
      marker.className = index === 0 ? "guide-beacon" : "guide-marker";
      if (index > 0) marker.textContent = String(index + 1);
      this.layer?.append(spotlight, marker);
      return { ref, element, spotlight, marker };
    });

    this.card = document.createElement("div");
    this.card.className = "guide-card";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "guide-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss guidance");
    close.addEventListener("click", () => {
      this.clear();
      this.onDismiss?.();
    });
    const title = document.createElement("span");
    title.className = "guide-title";
    title.textContent = this.copy.title;
    const body = document.createElement("span");
    body.className = "guide-body";
    body.textContent = this.copy.body;
    this.card.append(close, title, body);
    if (this.copy.presentation === "step") {
      this.card.classList.add("guide-step");
      this.card.append(buildCompassMascot());
      const footer = document.createElement("div");
      footer.className = "guide-footer";
      const progress = document.createElement("span");
      progress.className = "guide-progress";
      const current = this.copy.progress?.current;
      const total = this.copy.progress?.total;
      progress.textContent = current
        ? total ? `Step ${current} of ${total}` : `Step ${current}`
        : "Walkthrough";
      const finalStep = Boolean(current && total && current >= total);
      this.nextButton = document.createElement("button");
      this.nextButton.type = "button";
      this.nextButton.textContent = finalStep ? "Done" : "Next";
      this.nextButton.className = "guide-next";
      this.nextButton.addEventListener("click", () => {
        this.onAdvance?.(finalStep);
      });
      footer.append(progress, this.nextButton);
      this.card.append(footer);
    }
    this.layer.append(this.card);

    this.host.setAttribute("data-guide-visible", "true");
    this.host.setAttribute("data-guide-ref-count", String(resolved.length));
    this.startAlignment();
    const mirror = this.align();
    if (!mirror) return { ok: false, shownRefs: [], error: "Guidance target geometry is unavailable" };
    requestAnimationFrame(() => this.layer?.classList.add("guide-ready"));
    return { ok: true, shownRefs: resolved.map(({ ref }) => ref), mirror };
  }

  prepareScreenshotShield(): ScreenshotShieldResult {
    // A second prepare cannot reset a guard that is already protecting an
    // in-flight capture. Treat overlapping capture attempts as a compromise;
    // only the matching finish operation may clear it.
    if (this.screenshotShieldActive) {
      this.screenshotShieldCompromised = true;
      return { ok: false, error: "privacy-protection" };
    }
    if (hasUnsafeTopLayer() || collectSensitiveVisualElements().some(isVisuallyExposed)) {
      return { ok: false, error: "privacy-protection" };
    }
    if (this.layer) {
      this.layer.style.visibility = "hidden";
      this.guidanceHiddenForScreenshot = true;
    }
    this.screenshotShieldActive = true;
    this.screenshotShieldCompromised = false;
    this.screenshotShieldObserver = new MutationObserver((records) => {
      // Screenshot pixels and the evidence snapshot must describe one stable
      // page. Any mutation after preparation (including text-node edits) makes
      // that impossible to prove, even if the page later reverts the change.
      if (records.length > 0 || !this.host.isConnected) this.screenshotShieldCompromised = true;
    });
    this.screenshotShieldObserver.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return { ok: true, maskedElements: 0 };
  }

  verifyScreenshotShield(): boolean {
    return this.screenshotShieldActive
      && !this.screenshotShieldCompromised
      && this.host.isConnected
      && !hasUnsafeTopLayer()
      && !collectSensitiveVisualElements().some(isVisuallyExposed);
  }

  finishScreenshotShield(): void {
    this.screenshotShieldObserver?.disconnect();
    this.screenshotShieldObserver = null;
    this.screenshotShieldActive = false;
    this.screenshotShieldCompromised = false;
    if (this.guidanceHiddenForScreenshot && this.layer) this.layer.style.removeProperty("visibility");
    this.guidanceHiddenForScreenshot = false;
  }

  clear(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.listening) {
      window.removeEventListener("scroll", this.scheduleAlignment, true);
      window.removeEventListener("resize", this.scheduleAlignment);
      this.observedVisualViewport?.removeEventListener("scroll", this.scheduleAlignment);
      this.observedVisualViewport?.removeEventListener("resize", this.scheduleAlignment);
      this.listening = false;
    }
    this.observedVisualViewport = null;
    this.layer?.remove();
    this.layer = null;
    this.card = null;
    this.direction = null;
    this.nextButton = null;
    this.targets = [];
    this.copy = null;
    this.guidanceHiddenForScreenshot = false;
    this.host.removeAttribute("data-guide-visible");
    this.host.removeAttribute("data-guide-ref-count");
    this.host.removeAttribute("data-guide-anchor-x");
    this.host.removeAttribute("data-guide-anchor-y");
    this.host.removeAttribute("data-guide-next-x");
    this.host.removeAttribute("data-guide-next-y");
    this.host.removeAttribute("data-guide-device-pixel-ratio");
    this.host.removeAttribute("data-guide-viewport-width");
    this.host.removeAttribute("data-guide-viewport-height");
  }

  destroy(): void {
    this.clear();
    this.finishScreenshotShield();
    this.host.remove();
  }

  ownsNode(node: Node): boolean {
    return node === this.host || (node instanceof Element && Boolean(node.closest("[data-browser-guide-root]")));
  }

  private startAlignment(): void {
    if (!this.listening) {
      window.addEventListener("scroll", this.scheduleAlignment, { capture: true, passive: true });
      window.addEventListener("resize", this.scheduleAlignment, { passive: true });
      this.observedVisualViewport = window.visualViewport;
      this.observedVisualViewport?.addEventListener("scroll", this.scheduleAlignment, { passive: true });
      this.observedVisualViewport?.addEventListener("resize", this.scheduleAlignment, { passive: true });
      this.listening = true;
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.scheduleAlignment);
      for (const target of this.targets) this.resizeObserver.observe(target.element);
      this.resizeObserver.observe(document.documentElement);
    }
  }

  private readonly scheduleAlignment = (): void => {
    if (this.animationFrame !== null) return;
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      this.align();
    });
  };

  private align(): GuidanceMirror | undefined {
    if (!this.layer || !this.copy || this.targets.length === 0) return undefined;
    const viewport = readViewportMirror();
    const viewportRight = viewport.offsetLeft + viewport.width;
    const viewportBottom = viewport.offsetTop + viewport.height;
    const targetMirrors: GuidanceMirror["targets"] = [];
    let firstRect: ViewportRect | null = null;
    let firstVisible = false;

    for (const [index, target] of this.targets.entries()) {
      if (!target.element.isConnected) {
        this.clear();
        return undefined;
      }
      const rect = normalizedRect(target.element.getBoundingClientRect(), viewport);
      const visibility = classifyVisibility(rect, viewport);
      const visible = visibility === "visible";
      targetMirrors.push({ ref: target.ref, rect, visibility });
      if (index === 0) {
        firstRect = rect;
        firstVisible = visible;
      }
      target.spotlight.style.opacity = visible ? "1" : "0";
      target.marker.style.opacity = visible ? "1" : "0";
      if (!visible) continue;
      const padding = 5;
      target.spotlight.style.transform = "translate(" + snap(rect.left - padding, viewport) + "px, " + snap(rect.top - padding, viewport) + "px)";
      target.spotlight.style.width = Math.max(2, snap(rect.width + padding * 2, viewport)) + "px";
      target.spotlight.style.height = Math.max(2, snap(rect.height + padding * 2, viewport)) + "px";
      const markerX = Math.min(viewportRight - 18, Math.max(viewport.offsetLeft + 18, rect.right + 8));
      const markerY = Math.min(viewportBottom - 18, Math.max(viewport.offsetTop + 18, rect.top - 4));
      target.marker.style.left = snap(markerX, viewport) + "px";
      target.marker.style.top = snap(markerY, viewport) + "px";
    }

    if (!firstRect || !this.card) return undefined;
    this.host.setAttribute("data-guide-anchor-x", String(snap(firstRect.left + firstRect.width / 2, viewport)));
    this.host.setAttribute("data-guide-anchor-y", String(snap(firstRect.top + firstRect.height / 2, viewport)));
    this.host.setAttribute("data-guide-device-pixel-ratio", String(viewport.devicePixelRatio));
    this.host.setAttribute("data-guide-viewport-width", String(viewport.width));
    this.host.setAttribute("data-guide-viewport-height", String(viewport.height));
    if (firstVisible) {
      this.direction?.remove();
      this.direction = null;
      positionCard(this.card, firstRect, viewport);
    } else {
      if (!this.direction) {
        // A button, not a passive cue: pressing it brings the target into
        // view. The scroll happens only as a direct response to this press.
        this.direction = document.createElement("button");
        this.direction.type = "button";
        this.direction.className = "guide-direction";
        this.direction.addEventListener("click", () => {
          const target = this.targets[0]?.element;
          if (!target?.isConnected) return;
          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        });
        this.layer.append(this.direction);
      }
      const targetX = firstRect.left + firstRect.width / 2;
      const targetY = firstRect.top + firstRect.height / 2;
      const cueX = Math.min(viewportRight - 34, Math.max(viewport.offsetLeft + 34, targetX));
      const cueY = Math.min(viewportBottom - 34, Math.max(viewport.offsetTop + 34, targetY));
      const centerX = viewport.offsetLeft + viewport.width / 2;
      const centerY = viewport.offsetTop + viewport.height / 2;
      const angle = Math.atan2(targetY - centerY, targetX - centerX) * 180 / Math.PI;
      this.direction.style.left = snap(cueX - 21, viewport) + "px";
      this.direction.style.top = snap(cueY - 21, viewport) + "px";
      this.direction.style.transform = "rotate(" + Math.round(angle) + "deg)";
      this.card.style.left = snap(Math.min(viewportRight - 300, Math.max(viewport.offsetLeft + 14, cueX - 143)), viewport) + "px";
      const cardTop = cueY + (cueY < centerY ? 34 : -120);
      this.card.style.top = snap(Math.min(viewportBottom - 120, Math.max(viewport.offsetTop + 14, cardTop)), viewport) + "px";
    }

    if (this.nextButton) {
      const nextRect = this.nextButton.getBoundingClientRect();
      this.host.setAttribute("data-guide-next-x", String(Math.round(nextRect.left + nextRect.width / 2)));
      this.host.setAttribute("data-guide-next-y", String(Math.round(nextRect.top + nextRect.height / 2)));
    }

    return {
      primaryRef: this.targets[0]?.ref ?? targetMirrors[0]?.ref ?? "",
      title: this.copy.title,
      body: this.copy.body,
      presentation: this.copy.presentation,
      waitFor: this.copy.waitFor,
      ...(this.copy.progress ? { progress: { ...this.copy.progress } } : {}),
      viewport,
      targets: targetMirrors,
    };
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function buildCompassMascot(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "guide-mascot");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", "12");
  ring.setAttribute("cy", "13");
  ring.setAttribute("r", "8.6");
  ring.setAttribute("fill", "#ffffff");
  ring.setAttribute("stroke", "#2f8f6f");
  ring.setAttribute("stroke-width", "1.6");
  const needle = document.createElementNS(SVG_NS, "path");
  needle.setAttribute("d", "M12 1.6 L13.8 5.4 L10.2 5.4 Z");
  needle.setAttribute("fill", "#2f8f6f");
  const leftEye = document.createElementNS(SVG_NS, "circle");
  leftEye.setAttribute("class", "guide-mascot-eye");
  leftEye.setAttribute("cx", "9.3");
  leftEye.setAttribute("cy", "11.6");
  leftEye.setAttribute("r", "1.15");
  leftEye.setAttribute("fill", "#1d1f1c");
  const rightEye = document.createElementNS(SVG_NS, "circle");
  rightEye.setAttribute("class", "guide-mascot-eye");
  rightEye.setAttribute("cx", "14.7");
  rightEye.setAttribute("cy", "11.6");
  rightEye.setAttribute("r", "1.15");
  rightEye.setAttribute("fill", "#1d1f1c");
  const smile = document.createElementNS(SVG_NS, "path");
  smile.setAttribute("d", "M9.5 15 Q12 17 14.5 15");
  smile.setAttribute("fill", "none");
  smile.setAttribute("stroke", "#1d1f1c");
  smile.setAttribute("stroke-width", "1.2");
  smile.setAttribute("stroke-linecap", "round");
  svg.append(ring, needle, leftEye, rightEye, smile);
  return svg;
}

function intersectsViewport(rect: ViewportRect, viewport: GuidanceViewportMirror): boolean {
  return rect.bottom > viewport.offsetTop
    && rect.right > viewport.offsetLeft
    && rect.top < viewport.offsetTop + viewport.height
    && rect.left < viewport.offsetLeft + viewport.width
    && rect.width > 0
    && rect.height > 0;
}

function classifyVisibility(rect: ViewportRect, viewport: GuidanceViewportMirror): ElementVisibility {
  const right = viewport.offsetLeft + viewport.width;
  const bottom = viewport.offsetTop + viewport.height;
  if (intersectsViewport(rect, viewport)) return "visible";
  if (rect.bottom <= viewport.offsetTop) return "above";
  if (rect.top >= bottom) return "below";
  if (rect.right <= viewport.offsetLeft) return "left";
  if (rect.left >= right) return "right";
  return "outside";
}

function positionCard(card: HTMLDivElement, rect: ViewportRect, viewport: GuidanceViewportMirror): void {
  const right = viewport.offsetLeft + viewport.width;
  const bottom = viewport.offsetTop + viewport.height;
  const cardWidth = Math.max(0, Math.min(286, viewport.width - 28));
  // Step cards carry a footer row, so reserve a little more height than the
  // plain point card needs.
  const x = Math.min(right - cardWidth - 14, Math.max(viewport.offsetLeft + 14, rect.left));
  const below = rect.bottom + 16;
  const y = below + 148 < bottom ? below : Math.max(viewport.offsetTop + 14, rect.top - 164);
  card.style.left = snap(x, viewport) + "px";
  card.style.top = snap(y, viewport) + "px";
}

function readViewportMirror(): GuidanceViewportMirror {
  const visualViewport = window.visualViewport;
  const devicePixelRatio = bounded(window.devicePixelRatio, 1, 0.1, 16);
  return {
    coordinateSpace: "layout-viewport-css-px",
    width: bounded(visualViewport?.width ?? window.innerWidth, 0, 0, 100_000),
    height: bounded(visualViewport?.height ?? window.innerHeight, 0, 0, 100_000),
    offsetLeft: bounded(visualViewport?.offsetLeft, 0, -100_000, 100_000),
    offsetTop: bounded(visualViewport?.offsetTop, 0, -100_000, 100_000),
    devicePixelRatio,
    scale: bounded(visualViewport?.scale, 1, 0.1, 16),
  };
}

function normalizedRect(rect: DOMRect, viewport: GuidanceViewportMirror): ViewportRect {
  const left = snap(bounded(rect.left, 0, -1_000_000, 1_000_000), viewport);
  const top = snap(bounded(rect.top, 0, -1_000_000, 1_000_000), viewport);
  const width = snap(bounded(rect.width, 0, 0, 1_000_000), viewport);
  const height = snap(bounded(rect.height, 0, 0, 1_000_000), viewport);
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    right: snap(left + width, viewport),
    bottom: snap(top + height, viewport),
    left,
  };
}

function snap(value: number, viewport: GuidanceViewportMirror): number {
  const physicalScale = viewport.devicePixelRatio * viewport.scale;
  return Math.round(value * physicalScale) / physicalScale;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function collectSensitiveVisualElements(): Element[] {
  const selected = new Set<Element>(document.querySelectorAll(
    "input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],iframe,pre,code",
  ));
  const secretPattern = /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!secretPattern.test(node.textContent ?? "")) continue;
    if (node.parentElement) selected.add(node.parentElement);
  }
  return [...selected].filter((element) => !element.closest("[data-browser-guide-root]"));
}

function isVisuallyExposed(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden"
    || (style.opacity !== "" && Number(style.opacity) === 0)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && intersectsViewport(normalizedRect(rect, readViewportMirror()), readViewportMirror());
}

function hasUnsafeTopLayer(): boolean {
  if (document.fullscreenElement) return true;
  try {
    return Boolean(document.querySelector(":modal, :popover-open"));
  } catch {
    return Boolean(document.querySelector("dialog[open], [popover]"));
  }
}
