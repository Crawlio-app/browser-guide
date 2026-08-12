import { describe, expect, it } from "vitest";
import { contextForModel, isPageContext, type PageContext } from "../../src/shared/page-context.js";

const enrichedContext: PageContext = {
  snapshotId: "snapshot-enriched",
  capturedAt: "2026-08-09T00:00:00.000Z",
  title: "Account",
  url: "https://fixture.test/account",
  origin: "https://fixture.test",
  viewport: { width: 1_000, height: 700, devicePixelRatio: 2 },
  elements: [{
    ref: "e1",
    role: "tab",
    name: "Billing",
    visibility: "visible",
    section: "navigation: Account",
    semanticGroup: "navigation",
    rect: { x: 20, y: 30, width: 120, height: 32, top: 30, right: 140, bottom: 62, left: 20 },
    expanded: false,
    selected: true,
    checked: "mixed",
    current: "page",
    occlusionConfidence: 0.4,
  }],
  truncated: false,
  characterCount: 600,
  visualOmission: { omitted: true, reason: "not-requested" },
};

describe("PageContext enriched evidence", () => {
  it("accepts bounded ARIA, semantic, occlusion, and visual-omission metadata", () => {
    expect(isPageContext(enrichedContext)).toBe(true);
  });

  it("rejects invented state tokens and out-of-range occlusion confidence", () => {
    expect(isPageContext({
      ...enrichedContext,
      elements: [{ ...enrichedContext.elements[0], current: "account" }],
    })).toBe(false);
    expect(isPageContext({
      ...enrichedContext,
      elements: [{ ...enrichedContext.elements[0], occlusionConfidence: 1.01 }],
    })).toBe(false);
    expect(isPageContext({
      ...enrichedContext,
      visualOmission: { omitted: true, reason: "unknown" },
    })).toBe(false);
  });

  it("keeps omission metadata visible to the model while stripping screenshot bytes", () => {
    const safe = contextForModel({ ...enrichedContext, screenshotDataUrl: "data:image/png;base64,AAAA" });
    expect(safe).not.toHaveProperty("screenshotDataUrl");
    expect(safe.visualOmission).toEqual({ omitted: true, reason: "not-requested" });
  });
});
