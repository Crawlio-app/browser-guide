// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ElementRegistry } from "../../src/extension/content/element-registry.js";

describe("ElementRegistry", () => {
  it("keeps a stable opaque ref within one snapshot", () => {
    const registry = new ElementRegistry();
    const element = document.createElement("button");
    document.body.append(element);
    const snapshotId = registry.beginSnapshot();
    expect(registry.register(element)).toBe("e1");
    expect(registry.register(element)).toBe("e1");
    expect(registry.resolve(snapshotId, "e1")).toEqual({ ok: true, element });
  });

  it("rejects invented, stale, and detached refs", () => {
    const registry = new ElementRegistry();
    const element = document.createElement("button");
    document.body.append(element);
    const first = registry.beginSnapshot();
    registry.register(element);
    expect(registry.resolve(first, "e999")).toEqual({ ok: false, error: "invalid-ref" });
    const second = registry.beginSnapshot();
    registry.register(element);
    expect(registry.resolve(first, "e1")).toEqual({ ok: false, error: "stale-snapshot" });
    element.remove();
    expect(registry.resolve(second, "e1")).toEqual({ ok: false, error: "detached-element" });
  });

  it("invalidates refs and notifies once after a meaningful change", () => {
    const registry = new ElementRegistry();
    const listener = vi.fn();
    registry.onInvalidated(listener);
    const snapshot = registry.beginSnapshot();
    registry.invalidate("mutation");
    registry.invalidate("mutation");
    expect(registry.refsValid).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot, "mutation");
  });
});
