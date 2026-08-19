import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionDir = resolve(import.meta.dirname, "../../dist/extension");
const stableExtensionId = "bjgpnncbnjeahgfljjegblhmiklkcpmg";

describe("built extension safety surface", () => {
  it("contains no standard API key name, key-shaped value, or source map", () => {
    const files = filesUnder(extensionDir);
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    const output = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(output).not.toContain("OPENAI_API_KEY");
    expect(output).not.toMatch(/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/);
    expect(readFileSync(resolve(extensionDir, "licenses/React-MIT.txt"), "utf8")).toContain("Meta Platforms");
    expect(readFileSync(resolve(extensionDir, "licenses/Crawlio-Apache-2.0.txt"), "utf8")).toContain("Apache License");
  });

  it("ships minimal permissions, optional native messaging, and its own stable identity", () => {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, "manifest.json"), "utf8")) as {
      permissions: string[];
      optional_permissions?: string[];
      host_permissions?: string[];
      optional_host_permissions?: string[];
      side_panel: { default_path: string };
      key?: string;
      content_security_policy?: { extension_pages?: string };
    };
    // Exact, so widening the surface is always a deliberate edit here.
    // tabGroups only names and colours the tab that is already shared; it
    // grants no access to any page and no ability to act on one, and it is
    // what makes the shared tab visible from the tab strip.
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage", "sidePanel", "tabGroups"]);
    // Reading or acting on tabs is a different matter and stays out.
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.optional_permissions).toEqual(["nativeMessaging"]);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(extensionIdForKey(manifest.key)).toBe(stableExtensionId);
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("nativeMessaging");
    expect(manifest.content_security_policy?.extension_pages ?? "").not.toContain("api.openai.com");

    const serviceWorker = readFileSync(resolve(extensionDir, "service-worker.js"), "utf8");
    expect(serviceWorker).toContain("chrome.action.onClicked");
    expect(serviceWorker).toContain("chrome.sidePanel.open");
    expect(serviceWorker).toContain("chrome.sidePanel.setPanelBehavior");
    expect(serviceWorker).toContain("openPanelOnActionClick");
    expect(serviceWorker).toContain("com.crawlio.browser_guide");
  });

  it("contains the responsive reduced-motion side-panel contract", () => {
    const styles = readFileSync(resolve(extensionDir, "styles.css"), "utf8");
    expect(styles).toContain("width: min(100%, 360px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(/:focus-visible/);
    expect(styles).not.toMatch(/min-height:\s*(?:6[2-9][0-9]|[7-9][0-9]{2}|[1-9][0-9]{3,})px/);
  });
});

function extensionIdForKey(key: string | undefined): string | null {
  if (!key) return null;
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return [...digest].map((byte) => alphabet.charAt(byte >> 4) + alphabet.charAt(byte & 15)).join("");
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
