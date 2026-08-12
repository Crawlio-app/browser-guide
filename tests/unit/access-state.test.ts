import { describe, expect, it } from "vitest";
import { assessActiveTabAccess } from "../../src/shared/access-state.js";
import type { ExtensionRuntimeState } from "../../src/shared/protocol.js";

const ready: ExtensionRuntimeState = {
  status: "ready",
  tabId: 7,
  authorizedOrigin: "https://example.test",
  refsValid: false,
};

describe("temporary activeTab access", () => {
  it("allows only the authorized tab and origin", () => {
    expect(assessActiveTabAccess(ready, { tabId: 7, rawUrl: "https://example.test/account" })).toBeNull();
    expect(assessActiveTabAccess(ready, { tabId: 8, rawUrl: "https://example.test/account" })).toBe("not-authorized");
  });

  it("fails closed when Chrome withholds the URL after permission loss", () => {
    expect(assessActiveTabAccess(ready, { tabId: 7 })).toBe("access-lost");
  });

  it("pauses on cross-origin navigation and restricted pages", () => {
    expect(assessActiveTabAccess(ready, { tabId: 7, rawUrl: "https://other.test/" })).toBe("origin-changed");
    expect(assessActiveTabAccess(ready, { tabId: 7, rawUrl: "chrome://settings/" })).toBe("restricted-page");
  });
});
