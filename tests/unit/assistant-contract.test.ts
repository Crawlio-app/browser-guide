import { describe, expect, it } from "vitest";
import { parseGuidanceCommand, REALTIME_APPLICATION_TOOLS } from "../../src/shared/assistant-contract.js";

describe("read-only assistant contract", () => {
  it("exposes exactly the two visual guidance tools", () => {
    expect(REALTIME_APPLICATION_TOOLS.map((tool) => tool.name)).toEqual(["show_guidance", "clear_guidance"]);
  });

  it("accepts current ref-shaped guidance and rejects selectors or action tools", () => {
    expect(parseGuidanceCommand("show_guidance", {
      refs: ["e2", "e3"],
      title: "Billing",
      body: "Use this section to review invoices.",
    })).toMatchObject({ name: "show_guidance", refs: ["e2", "e3"] });
    expect(parseGuidanceCommand("show_guidance", {
      refs: ["#billing"],
      title: "Billing",
      body: "Unsafe selector.",
    })).toBeNull();
    expect(parseGuidanceCommand("show_guidance", {
      refs: ["e2"],
      title: " ",
      body: "Blank title.",
    })).toBeNull();
    expect(parseGuidanceCommand("show_guidance", {
      refs: ["e2"],
      title: "Billing",
      body: "Unexpected executable hint.",
      selector: "#billing",
    })).toBeNull();
    expect(parseGuidanceCommand("browser_click", { ref: "e2" })).toBeNull();
  });
});
