import { describe, expect, it } from "vitest";
import { groundElements } from "../../src/shared/semantic-grounding.js";
import type { PageElementCandidate } from "../../src/shared/page-context.js";

const rect = { x: 0, y: 0, width: 100, height: 30, top: 0, right: 100, bottom: 30, left: 0 };
const candidates: PageElementCandidate[] = [
  { ref: "e1", role: "button", name: "Save changes", text: "Save", section: "main: Account settings", visibility: "visible", rect },
  { ref: "e2", role: "link", name: "Billing", text: "Plans and invoices", section: "navigation: Account", visibility: "visible", rect },
  { ref: "e3", role: "heading", name: "Recent activity", section: "main", visibility: "below", rect },
];

describe("semantic grounding", () => {
  it("scores role, accessible name, text, and section evidence", () => {
    const results = groundElements("Where do I see billing invoices?", candidates);
    expect(results[0]?.ref).toBe("e2");
    expect(results[0]?.reasons).toContain("name:1");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("returns no fabricated refs when there is no lexical evidence", () => {
    expect(groundElements("quantum astronomy", candidates)).toEqual([]);
  });
});
