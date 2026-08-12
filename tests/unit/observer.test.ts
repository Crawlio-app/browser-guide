// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElementRegistry } from "../../src/extension/content/element-registry.js";
import { accessibleName, PageObserver, safeElementText } from "../../src/extension/content/observer.js";

describe("accessible page observation", () => {
  beforeEach(() => {
    document.head.innerHTML = "<title>Fixture account</title>";
    document.body.innerHTML = [
      "<main aria-label='Account settings'>",
      "<h1>Account settings</h1>",
      "<label for='email'>Email address</label>",
      "<input id='email' type='email' value='private@example.test'>",
      "<label for='password'>Password</label>",
      "<input id='password' type='password' value='never-collect-this'>",
      "<textarea aria-label='Private note'>textarea-secret-value</textarea>",
      "<div contenteditable='true'>editable-secret-value</div>",
      "<button aria-label='Save changes'>Save</button>",
      "</main>",
    ].join("");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect(this: Element) {
      const top = this instanceof HTMLElement && this.tagName === "BUTTON" ? 180 : 80;
      return {
        x: 40, y: top, width: 180, height: 32, top, right: 220, bottom: top + 32, left: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementsFromPoint");
    document.body.innerHTML = "";
  });

  it("never includes passwords, input values, textarea contents, or contenteditable contents", () => {
    const registry = new ElementRegistry();
    const observer = new PageObserver(registry, () => false);
    const context = observer.capture();
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("never-collect-this");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("textarea-secret-value");
    expect(serialized).not.toContain("editable-secret-value");
    expect(serialized).toContain("Email address");
    expect(serialized).toContain("Save changes");
    expect(context.elements.every((element) => /^e[1-9][0-9]*$/.test(element.ref))).toBe(true);
    expect(context.elements.length).toBeLessThanOrEqual(300);
    expect(context.characterCount).toBeLessThanOrEqual(12_000);
    observer.disconnect();
  });

  it("uses labels instead of form control values for accessible names", () => {
    const email = document.getElementById("email") as HTMLInputElement;
    expect(accessibleName(email)).toBe("Email address");
    expect(safeElementText(email)).toBe("");
  });

  it("captures bounded ARIA state, semantic grouping, and read-only occlusion evidence", () => {
    const button = document.querySelector("button") as HTMLButtonElement;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-selected", "true");
    button.setAttribute("aria-checked", "mixed");
    button.setAttribute("aria-current", "page");
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [button],
    });

    const registry = new ElementRegistry();
    const observer = new PageObserver(registry, () => false);
    const context = observer.capture();
    const candidate = context.elements.find((element) => element.name === "Save changes");
    expect(candidate).toMatchObject({
      semanticGroup: "main",
      expanded: false,
      selected: true,
      checked: "mixed",
      current: "page",
      occlusionConfidence: 0,
    });
    observer.disconnect();
  });

  it("reports full sampled occlusion without inspecting the covering element's content", () => {
    const button = document.querySelector("button") as HTMLButtonElement;
    const cover = document.createElement("div");
    cover.textContent = "opaque cover";
    document.body.append(cover);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [cover, button],
    });

    const registry = new ElementRegistry();
    const observer = new PageObserver(registry, () => false);
    const context = observer.capture();
    expect(context.elements.find((element) => element.name === "Save changes")?.occlusionConfidence).toBe(1);
    observer.disconnect();
  });

  it("keeps opaque refs scoped to the snapshot that produced them", () => {
    const registry = new ElementRegistry();
    const observer = new PageObserver(registry, () => false);
    const first = observer.capture();
    const firstRef = first.elements[0]?.ref;
    const second = observer.capture();
    expect(firstRef).toMatch(/^e[1-9][0-9]*$/);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(registry.resolve(first.snapshotId, firstRef ?? "e0")).toEqual({ ok: false, error: "stale-snapshot" });
    observer.disconnect();
  });

  it("invalidates all refs after a meaningful DOM mutation", async () => {
    const registry = new ElementRegistry();
    const observer = new PageObserver(registry, () => false);
    observer.capture();
    expect(registry.refsValid).toBe(true);
    const button = document.createElement("button");
    button.textContent = "A new action";
    document.body.append(button);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(registry.refsValid).toBe(false);
    observer.disconnect();
  });

  it("keeps reporting bounded, snapshot-scoped mutation activity after refs are invalid", async () => {
    const registry = new ElementRegistry();
    const reportMutationActivity = vi.fn();
    const observer = new PageObserver(registry, () => false, reportMutationActivity);
    const snapshotId = observer.capture().snapshotId;

    const first = document.createElement("button");
    first.textContent = "First change";
    document.body.append(first);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(registry.refsValid).toBe(false);
    expect(reportMutationActivity).not.toHaveBeenCalled();

    const second = document.createElement("button");
    second.textContent = "Second change";
    document.body.append(second);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const third = document.createElement("button");
    third.textContent = "Third change before the debounce settles";
    document.body.append(third);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(reportMutationActivity).not.toHaveBeenCalled();
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(reportMutationActivity).toHaveBeenCalledTimes(1);
    expect(reportMutationActivity).toHaveBeenCalledWith(snapshotId);

    observer.disconnect();
  });

  it("does not apply delayed activity from an older snapshot to a fresh capture", async () => {
    const registry = new ElementRegistry();
    const reportMutationActivity = vi.fn();
    const observer = new PageObserver(registry, () => false, reportMutationActivity);
    observer.capture();

    document.body.append(document.createElement("button"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const fresh = observer.capture();
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(registry.snapshotId).toBe(fresh.snapshotId);
    expect(registry.refsValid).toBe(true);
    expect(reportMutationActivity).not.toHaveBeenCalled();
    observer.disconnect();
  });
});
