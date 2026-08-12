// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElementRegistry } from "../../src/extension/content/element-registry.js";
import { OverlayController } from "../../src/extension/content/overlay-controller.js";

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

describe("read-only overlay controller", () => {
  let targetRect = { left: 100, top: 120, width: 180, height: 40 };

  beforeEach(() => {
    document.body.innerHTML = "<button id='target'>Billing</button>";
    targetRect = { left: 100, top: 120, width: 180, height: 40 };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect(this: Element) {
      if (this.id !== "target") {
        return { x: 0, y: 0, left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700, toJSON: () => ({}) } as DOMRect;
      }
      return {
        x: targetRect.left,
        y: targetRect.top,
        left: targetRect.left,
        top: targetRect.top,
        width: targetRect.width,
        height: targetRect.height,
        right: targetRect.left + targetRect.width,
        bottom: targetRect.top + targetRect.height,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "visualViewport");
    document.body.innerHTML = "";
  });

  it("mounts one closed-shadow, pointer-transparent host and cleans it up", () => {
    const first = new OverlayController();
    const firstHost = document.querySelector("[data-browser-guide-root]") as HTMLElement;
    expect(firstHost).not.toBeNull();
    expect(firstHost.shadowRoot).toBeNull();
    expect(firstHost.getAttribute("aria-hidden")).toBe("true");
    expect(firstHost.style.getPropertyValue("pointer-events")).toBe("none");
    const second = new OverlayController();
    expect(document.querySelectorAll("[data-browser-guide-root]")).toHaveLength(1);
    first.destroy();
    second.destroy();
    expect(document.querySelector("[data-browser-guide-root]")).toBeNull();
  });

  it("shows only current refs, tracks user-driven geometry, and rejects invented refs", async () => {
    const target = document.getElementById("target") as HTMLButtonElement;
    const registry = new ElementRegistry();
    const snapshotId = registry.beginSnapshot();
    const ref = registry.register(target);
    const overlay = new OverlayController();
    const shown = overlay.show({
      name: "show_guidance",
      refs: [ref],
      title: "Billing",
      body: "Open this area yourself to review invoices.",
      presentation: "point",
      waitFor: "none",
    }, snapshotId, registry);
    expect(shown).toMatchObject({
      ok: true,
      shownRefs: ["e1"],
      mirror: {
        primaryRef: "e1",
        presentation: "point",
        waitFor: "none",
        viewport: { coordinateSpace: "layout-viewport-css-px", width: 900, height: 700, devicePixelRatio: 2 },
        targets: [{ ref: "e1", visibility: "visible" }],
      },
    });
    const host = document.querySelector("[data-browser-guide-root]") as HTMLElement;
    expect(host.dataset.guideVisible).toBe("true");
    expect(host.dataset.guideAnchorX).toBe("190");

    targetRect = { left: 360, top: 250, width: 160, height: 44 };
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(host.dataset.guideAnchorX).toBe("440");
    expect(host.dataset.guideAnchorY).toBe("272");

    expect(overlay.show({
      name: "show_guidance",
      refs: ["e999"],
      title: "Invented",
      body: "This must fail closed.",
      presentation: "point",
      waitFor: "none",
    }, snapshotId, registry)).toMatchObject({ ok: false, shownRefs: [] });
    expect(host.dataset.guideVisible).toBeUndefined();
    overlay.destroy();
  });

  it("hard-caps guidance at three deduplicated current targets", () => {
    const registry = new ElementRegistry();
    const snapshotId = registry.beginSnapshot();
    const refs = ["target", "second", "third", "fourth"].map((id) => {
      const element = id === "target" ? document.getElementById(id) as Element : document.body.appendChild(document.createElement("button"));
      return registry.register(element);
    });
    const overlay = new OverlayController();
    expect(overlay.show({
      name: "show_guidance",
      refs,
      title: "Too many",
      body: "This comparison must fail closed.",
      presentation: "point",
      waitFor: "none",
    }, snapshotId, registry)).toMatchObject({ ok: false, shownRefs: [] });
    const host = document.querySelector("[data-browser-guide-root]") as HTMLElement;
    expect(host.dataset.guideVisible).toBeUndefined();
    overlay.destroy();
  });

  it("mirrors visual-viewport offsets and snaps target geometry to physical pixels", () => {
    const visualViewport = new EventTarget();
    Object.assign(visualViewport, { width: 600.25, height: 500.25, offsetLeft: 20, offsetTop: 30, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    targetRect = { left: 100.26, top: 120.26, width: 180.2, height: 40.2 };
    const target = document.getElementById("target") as HTMLButtonElement;
    const registry = new ElementRegistry();
    const snapshotId = registry.beginSnapshot();
    const ref = registry.register(target);
    const overlay = new OverlayController();
    const result = overlay.show({
      name: "show_guidance",
      refs: [ref],
      title: "Billing",
      body: "Review this section.",
      presentation: "step",
      waitFor: "user_confirm",
      progress: { current: 2, total: 3 },
    }, snapshotId, registry);
    expect(result.mirror).toMatchObject({
      presentation: "step",
      waitFor: "user_confirm",
      progress: { current: 2, total: 3 },
      viewport: { width: 600.25, height: 500.25, offsetLeft: 20, offsetTop: 30, devicePixelRatio: 2, scale: 1 },
      targets: [{ rect: { left: 100.5, top: 120.5, width: 180, height: 40 } }],
    });
    overlay.destroy();
  });

  it("declares pointer transparency and reduced-motion behavior in isolated CSS", () => {
    const css = readFileSync(resolve(process.cwd(), "src/extension/content/overlay.css"), "utf8");
    expect(css).toMatch(/pointer-events:\s*none\s*!important/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/animation:\s*none\s*!important/);
  });

  it("fails visual capture closed around form controls and verifies the guard", () => {
    const secretInput = document.createElement("input");
    secretInput.value = "private-value";
    document.body.append(secretInput);
    const overlay = new OverlayController();
    expect(overlay.prepareScreenshotShield()).toEqual({ ok: false, error: "privacy-protection" });
    const host = document.querySelector("[data-browser-guide-root]") as HTMLElement;
    expect(document.body.textContent).not.toContain("private-value");
    secretInput.remove();
    expect(overlay.prepareScreenshotShield()).toEqual({ ok: true, maskedElements: 0 });
    expect(overlay.verifyScreenshotShield()).toBe(true);
    host.remove();
    expect(overlay.verifyScreenshotShield()).toBe(false);
    overlay.finishScreenshotShield();
    overlay.destroy();
  });

  it("permanently compromises an in-flight visual capture after any page mutation", async () => {
    const overlay = new OverlayController();
    const target = document.getElementById("target") as HTMLButtonElement;
    const text = target.firstChild as Text;

    expect(overlay.prepareScreenshotShield()).toEqual({ ok: true, maskedElements: 0 });
    text.data = "Invoices";
    await Promise.resolve();
    expect(overlay.verifyScreenshotShield()).toBe(false);

    // Reverting the text and trying to prepare again must not reset an active
    // capture's compromise. Only finish starts a new privacy epoch.
    text.data = "Billing";
    await Promise.resolve();
    expect(overlay.verifyScreenshotShield()).toBe(false);
    expect(overlay.prepareScreenshotShield()).toEqual({ ok: false, error: "privacy-protection" });
    expect(overlay.verifyScreenshotShield()).toBe(false);

    overlay.finishScreenshotShield();
    expect(overlay.prepareScreenshotShield()).toEqual({ ok: true, maskedElements: 0 });
    target.setAttribute("aria-expanded", "true");
    await Promise.resolve();
    expect(overlay.verifyScreenshotShield()).toBe(false);
    overlay.finishScreenshotShield();
    overlay.destroy();
  });

  it("contains no page-event interception hooks beyond the shadow Next and arrow buttons", () => {
    const controller = readFileSync(resolve(process.cwd(), "src/extension/content/overlay-controller.ts"), "utf8");
    const runtime = readFileSync(resolve(process.cwd(), "src/extension/content/index.ts"), "utf8");
    const source = controller + runtime;
    expect(source).not.toContain("preventDefault");
    expect(source).not.toContain("stopPropagation");
    // Exactly three interactive listeners are permitted, all on Browser
    // Guide's own closed-shadow controls: the step card's Next button, the
    // take-me-there direction arrow, and the card's dismiss button. Nothing
    // may listen on page elements.
    const interactiveListeners = source.match(/addEventListener\(\s*["'](?:click|keydown|keyup|keypress|submit|input|change)["']/g) ?? [];
    expect(interactiveListeners).toHaveLength(3);
    expect(controller).toMatch(/guide-next[\s\S]{0,220}addEventListener\(\s*["']click["']/);
    expect(controller).toMatch(/guide-direction[\s\S]{0,220}addEventListener\(\s*["']click["']/);
    expect(controller).toMatch(/guide-close[\s\S]{0,220}addEventListener\(\s*["']click["']/);
    expect(runtime).not.toMatch(/addEventListener\(\s*["'](?:click|keydown|keyup|keypress|submit|input|change)["']/);
    // The single scroll call must live inside the direction-arrow handler.
    const scrollCalls = source.match(/scrollIntoView\s*\(/g) ?? [];
    expect(scrollCalls).toHaveLength(1);
    expect(controller).toMatch(/guide-direction[\s\S]{0,420}scrollIntoView\s*\(/);
  });
});
