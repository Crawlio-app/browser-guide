import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

const chromiumPath = chromium.executablePath();
const stableExtensionId = "bjgpnncbnjeahgfljjegblhmiklkcpmg";
const extensionOrigin = `chrome-extension://${stableExtensionId}`;

let context: BrowserContext | null = null;
let temporaryRoot = "";

type HelperKind = "stub" | "broken" | "absent";

/**
 * Boots the panel with no OpenAI credential stored, so every run lands on the
 * sign-in step. Nothing else in the suite exercises that state, and it is
 * where every sign-in decision is made.
 *
 * `helper` picks what Chrome finds at the other end of the native port:
 * a working stub, a registered helper that dies on launch, or no manifest at
 * all. Those three produce the three answers the panel must keep apart.
 */
async function openPanel(helper: HelperKind, environment: Record<string, string> = {}): Promise<Page> {
  temporaryRoot = await mkdtemp(join(tmpdir(), "browser-guide-signin-e2e-"));
  const profilePath = resolve(temporaryRoot, "profile");
  const extensionPath = resolve(temporaryRoot, "extension");
  await cp(resolve(process.cwd(), "dist/extension"), extensionPath, { recursive: true });

  const testManifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(testManifestPath, "utf8")) as Record<string, unknown>;
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as string[] : [];
  manifest.permissions = [...permissions, "nativeMessaging"];
  delete manifest.optional_permissions;
  await writeFile(testManifestPath, JSON.stringify(manifest));

  if (helper !== "absent") {
    const hostPath = resolve(temporaryRoot, "com.crawlio.browser_guide");
    if (helper === "stub") {
      const hostScriptPath = resolve(temporaryRoot, "native-host-stub.mjs");
      await cp(resolve(process.cwd(), "tests/fixtures/native-host-stub.mjs"), hostScriptPath);
      await writeFile(hostPath, `#!/bin/zsh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hostScriptPath)} "$@"\n`);
    } else {
      // Registered with Chrome, and dies the moment it is launched: the helper
      // is installed, so telling anyone to install it would be wrong.
      await writeFile(hostPath, "#!/bin/zsh\nexit 1\n");
    }
    await chmod(hostPath, 0o755);

    const nativeManifestPath = resolve(profilePath, "NativeMessagingHosts/com.crawlio.browser_guide.json");
    await mkdir(resolve(nativeManifestPath, ".."), { recursive: true });
    await writeFile(nativeManifestPath, JSON.stringify({
      name: "com.crawlio.browser_guide",
      description: "Browser Guide sign-in E2E native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: [`${extensionOrigin}/`],
    }));
  }

  context = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    executablePath: chromiumPath,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      BROWSER_GUIDE_TEST_OPENAI: "0",
      ...environment,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--window-position=-2000,-2000",
      "--window-size=1000,760",
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  expect(worker.url()).toBe(`${extensionOrigin}/service-worker.js`);

  // Install fires a warm-up health check and opens the welcome page, which
  // asks too. Opening the panel into that burst is a cold-start race, not the
  // subject of these tests, so let it drain first.
  await new Promise((settle) => setTimeout(settle, 6_000));

  const panel = await context.newPage();
  await panel.goto(`${extensionOrigin}/sidepanel.html`);
  return panel;
}

const setupTitle = (panel: Page) => panel.locator("#setup-title").textContent();

describe.skipIf(!existsSync(chromiumPath))("sign-in surface", () => {
  afterEach(async () => {
    await context?.close();
    context = null;
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  });

  it("leads with the sign-in this computer has and keeps the key behind a disclosure", async () => {
    const panel = await openPanel("stub");
    await expect.poll(() => setupTitle(panel), { timeout: 15_000 }).toBe("Connect your sign-in");

    // One primary route, named, carrying the account it belongs to.
    const buttons = panel.locator(".signin-button");
    await expect.poll(() => buttons.count(), { timeout: 10_000 }).toBe(1);
    const primary = buttons.first();
    expect(await primary.textContent()).toContain("Continue with Codex");
    expect(await primary.textContent()).toContain("tester@example.test");
    expect(await primary.getAttribute("class")).toContain("primary");

    // What is missing is stated, not silently dropped.
    expect(await panel.locator(".signin-absent li").allTextContents())
      .toEqual(["Claude Code: Sign in to Claude Code to create one."]);

    // The API key is an escape hatch, not a peer of the sign-in.
    expect(await panel.locator("#platform-key").count()).toBe(0);
    await panel.locator(".setup-secondary", { hasText: "Paste an API key instead" }).click();
    expect(await panel.locator("#platform-key").count()).toBe(1);
  }, 90_000);

  it("still offers every route when the helper is too old to answer", async () => {
    // A helper installed before the sources request exists rejects it. That is
    // routine version skew, not a failure, and hiding options on that basis
    // would strand whoever is running the older helper.
    const panel = await openPanel("stub", { BROWSER_GUIDE_TEST_LEGACY_HEALTH: "1" });
    await expect.poll(() => setupTitle(panel), { timeout: 15_000 }).toBe("Connect your sign-in");

    const buttons = panel.locator(".signin-button");
    await expect.poll(() => buttons.count(), { timeout: 10_000 }).toBe(2);
    expect(await buttons.allTextContents()).toEqual([
      "Continue with Codex",
      "Continue with Claude Code",
    ]);
    expect(await panel.locator(".setup-error").count()).toBe(0);
  }, 90_000);

  it("never tells someone to install a helper that is already installed", async () => {
    // Installed and unable to answer. The remedy is to retry, and the panel
    // must not send anyone back through an install it already completed.
    const panel = await openPanel("broken");
    await expect.poll(() => setupTitle(panel), { timeout: 20_000 }).toBe("The helper did not answer");
    expect(await panel.locator(".setup-action").textContent()).toBe("Try again");
    expect(await panel.locator(".install-command").count()).toBe(0);
  }, 90_000);

  it("does ask for an install when Chrome has no helper registered at all", async () => {
    const panel = await openPanel("absent");
    await expect.poll(() => setupTitle(panel), { timeout: 20_000 }).toBe("Install the helper");
    expect(await panel.locator(".install-command code").textContent()).toBe("npx crawlio-browser-guide init");
  }, 90_000);
});
