import { describe, expect, it } from "vitest";
import { parseGuidanceCommand } from "../../src/shared/assistant-contract.js";
import type { PageContext, PageElementCandidate } from "../../src/shared/page-context.js";
import { DEMO_TOUR_STEPS, isPracticePage, resolveDemoStep } from "../../src/extension/sidepanel/demo-tour.js";

const rect = { x: 10, y: 10, width: 120, height: 32, top: 10, right: 130, bottom: 42, left: 10 };

function element(overrides: Partial<PageElementCandidate> & { ref: string; role: string; name: string }): PageElementCandidate {
  return { visibility: "visible", section: "main", rect, ...overrides };
}

function practiceContext(elements: PageElementCandidate[], title = "Browser Guide Practice — Aurora Billing"): PageContext {
  return {
    snapshotId: "snapshot-demo",
    capturedAt: new Date(0).toISOString(),
    title,
    url: "https://practice.example/",
    origin: "https://practice.example",
    viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
    elements,
    truncated: false,
    characterCount: 1_000,
  };
}

function fullPracticeElements(): PageElementCandidate[] {
  return [
    element({ ref: "e1", role: "region", name: "Browser Guide practice page" }),
    element({ ref: "e2", role: "heading", name: "Welcome to the practice space" }),
    element({ ref: "e3", role: "navigation", name: "Practice navigation" }),
    element({ ref: "e4", role: "searchbox", name: "Search invoices" }),
    element({ ref: "e5", role: "button", name: "Review invoices" }),
    element({ ref: "e6", role: "button", name: "Download yearly statement", visibility: "below" }),
    element({ ref: "e7", role: "link", name: "Read the full guide" }),
  ];
}

describe("demo tour", () => {
  it("emits commands that pass the exact contract the service worker enforces", () => {
    const context = practiceContext(fullPracticeElements());
    DEMO_TOUR_STEPS.forEach((_, index) => {
      const command = resolveDemoStep(context, index);
      expect(command, `step ${index + 1} must resolve`).not.toBeNull();
      const parsed = parseGuidanceCommand("show_guidance", command);
      expect(parsed, `step ${index + 1} must satisfy parseGuidanceCommand`).not.toBeNull();
      expect(command?.waitFor).toBe("user_confirm");
      expect(command?.progress).toEqual({ current: index + 1, total: DEMO_TOUR_STEPS.length });
    });
    expect(DEMO_TOUR_STEPS.length).toBeLessThanOrEqual(12);
  });

  it("prefers enabled, on-screen, unoccluded matches but accepts off-viewport targets", () => {
    const context = practiceContext([
      element({ ref: "e1", role: "region", name: "Browser Guide practice page" }),
      element({ ref: "e10", role: "button", name: "Review invoices", disabled: true }),
      element({ ref: "e11", role: "button", name: "Review invoices", visibility: "below" }),
      element({ ref: "e12", role: "button", name: "Review invoices", occlusionConfidence: 0.8 }),
      element({ ref: "e13", role: "button", name: "Review invoices", occlusionConfidence: 0.1 }),
    ]);
    const reviewStep = DEMO_TOUR_STEPS.findIndex((step) => step.match.nameIncludes === "Review invoices");
    expect(resolveDemoStep(context, reviewStep)?.refs).toEqual(["e13"]);

    const offViewportOnly = practiceContext([
      element({ ref: "e20", role: "button", name: "Review invoices", visibility: "below" }),
    ]);
    expect(resolveDemoStep(offViewportOnly, reviewStep)?.refs).toEqual(["e20"]);
  });

  it("returns null when the page lacks the step target", () => {
    const context = practiceContext([element({ ref: "e1", role: "button", name: "Unrelated" })]);
    expect(resolveDemoStep(context, 0)).toBeNull();
    expect(resolveDemoStep(practiceContext(fullPracticeElements()), DEMO_TOUR_STEPS.length)).toBeNull();
  });

  it("detects the practice page by title prefix or marker element, never by URL", () => {
    const elements = fullPracticeElements();
    expect(isPracticePage(practiceContext(elements))).toBe(true);
    expect(isPracticePage(practiceContext(elements, "Something else entirely"))).toBe(true);
    expect(isPracticePage(practiceContext(
      elements.filter((el) => el.name !== "Browser Guide practice page"),
      "Something else entirely",
    ))).toBe(false);
    // A lookalike title without the tour's first target is not the practice page.
    expect(isPracticePage(practiceContext(
      [element({ ref: "e1", role: "button", name: "Unrelated" })],
    ))).toBe(false);
  });
});
