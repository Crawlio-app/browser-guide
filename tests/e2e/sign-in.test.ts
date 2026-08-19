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
async function openPanel(
  helper: HelperKind,
  environment: Record<string, string> = {},
  settleMs = 6_000,
): Promise<Page> {
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
  // asks too. Most tests here are about what the sign-in screen says, so they
  // let that burst drain first; the cold-start test passes 0 to land in it.
  if (settleMs > 0) await new Promise((settle) => setTimeout(settle, settleMs));

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

    // One primary route, named, carrying the account it belongs to. The
    // second button is the launch action for the sign-in that is absent.
    const buttons = panel.locator(".signin-button");
    // Poll on the account, not the count: the pre-detection fallback also
    // shows two buttons, so a count alone cannot tell the states apart.
    await expect.poll(() => buttons.first().textContent(), { timeout: 15_000 })
      .toContain("tester@example.test");
    expect(await buttons.count()).toBe(2);
    const primary = buttons.first();
    expect(await primary.textContent()).toContain("Continue with Codex");
    expect(await primary.getAttribute("class")).toContain("primary");

    // What is missing is stated, and is an action rather than a dead end.
    const missing = panel.locator(".signin-missing-row");
    expect(await missing.count()).toBe(1);
    expect(await missing.locator("p").textContent())
      .toBe("Claude Code: Sign in to Claude Code to create one.");
    expect(await missing.locator("button").textContent()).toBe("Sign in to Claude Code");

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
    // The transport reason for this state only repeats the headline in
    // vocabulary nobody outside this codebase uses, so it stays off screen.
    expect(await panel.locator(".setup-error").count()).toBe(0);
  }, 90_000);

  it("sends you to the real sign-in and picks it up when it appears", async () => {
    // No Codex sign-in yet, so the option is a launch rather than a dead end.
    // It appears after two polls, which is what finishing a real login looks
    // like from here.
    const panel = await openPanel("stub", { BROWSER_GUIDE_TEST_SIGNIN_AFTER: "2" });
    await expect.poll(() => setupTitle(panel), { timeout: 15_000 }).toBe("Connect your sign-in");

    const launch = panel.locator(".signin-missing-row button", { hasText: "Sign in to Codex" });
    await expect.poll(() => launch.count(), { timeout: 20_000 }).toBe(1);
    await launch.click();

    // Waiting replaces the options so a second attempt cannot be started, and
    // nothing has to be pressed once the sign-in exists.
    await expect.poll(() => panel.locator(".signin-waiting-title").textContent(), { timeout: 10_000 })
      .toContain("Waiting for your Codex sign-in");
    await expect.poll(() => panel.locator(".signin-button").count(), { timeout: 5_000 }).toBe(0);

    await expect.poll(() => panel.locator(".instrument-bar").count(), { timeout: 30_000 }).toBe(1);
    expect(await panel.locator("#setup-title").count()).toBe(0);
  }, 90_000);

  it("lets a wait be abandoned without losing the other routes", async () => {
    const panel = await openPanel("stub", { BROWSER_GUIDE_TEST_SIGNIN_AFTER: "999" });
    await expect.poll(() => setupTitle(panel), { timeout: 15_000 }).toBe("Connect your sign-in");
    await panel.locator(".signin-missing-row button", { hasText: "Sign in to Codex" }).click();
    await expect.poll(() => panel.locator(".signin-waiting-title").count(), { timeout: 10_000 }).toBe(1);

    await panel.locator(".setup-secondary", { hasText: "Cancel" }).click();
    await expect.poll(() => panel.locator(".signin-waiting-title").count(), { timeout: 5_000 }).toBe(0);
    expect(await panel.locator(".signin-missing-row button").count()).toBeGreaterThan(0);
  }, 90_000);

  it("reaches sign-in even when the panel opens into the install itself", async () => {
    // Opening the panel the instant the extension installs puts its health
    // check in the same breath as the warm-up and the welcome page. Chrome can
    // tear the shared port down under that, and the panel used to strand there
    // reporting a closed connection, which no one can act on. A read that was
    // never answered is now worth one more attempt.
    const panel = await openPanel("stub", {}, 0);
    await expect.poll(() => setupTitle(panel), { timeout: 30_000 }).toBe("Connect your sign-in");
    await expect.poll(() => panel.locator(".signin-button").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  }, 90_000);

  it("lets the person choose the engine when both credentials exist", async () => {
    // OpenAI key and Claude sign-in both present. Realtime wins by default,
    // because it is the stronger engine for voice and visuals, and one click
    // flips to Claude and back. A default must never be a lock.
    const panel = await openPanel("stub", { BROWSER_GUIDE_TEST_OPENAI: "1", BROWSER_GUIDE_TEST_CLAUDE: "1" });
    await expect.poll(() => panel.locator(".instrument-bar").count(), { timeout: 20_000 }).toBe(1);

    const chip = panel.locator(".engine-chip");
    await expect.poll(() => chip.count(), { timeout: 10_000 }).toBe(1);
    expect(await chip.textContent()).toBe("via OpenAI");

    await chip.click();
    await expect.poll(() => chip.textContent(), { timeout: 5_000 }).toBe("via Claude");

    // The choice survives the panel being closed and reopened.
    const again = await context!.newPage();
    await again.goto(`${extensionOrigin}/sidepanel.html`);
    await expect.poll(() => again.locator(".engine-chip").textContent(), { timeout: 15_000 })
      .toBe("via Claude");
  }, 90_000);

  it("does not present a lapsed sign-in as a connected account", async () => {
    // The stored copy of a sign-in outlives the sign-in itself. Treating
    // presence as proof put the panel in a ready state, with an account chip,
    // for someone who was signed out, and the first question was the first
    // anyone heard of it.
    const panel = await openPanel("stub", { BROWSER_GUIDE_TEST_CLAUDE: "1", BROWSER_GUIDE_TEST_CLAUDE_LAPSED: "1" });
    await expect.poll(() => setupTitle(panel), { timeout: 15_000 }).toBe("Connect your sign-in");

    // No ready surface, and no chip claiming an account.
    expect(await panel.locator(".instrument-bar").count()).toBe(0);
    expect(await panel.locator(".account-chip").count()).toBe(0);

    // And it says why it is asking, rather than looking like a fresh install.
    expect(await panel.locator(".setup-note").textContent())
      .toContain("Claude Code sign-in expired");
  }, 90_000);

  it("does ask for an install when Chrome has no helper registered at all", async () => {
    const panel = await openPanel("absent");
    await expect.poll(() => setupTitle(panel), { timeout: 20_000 }).toBe("Install the helper");
    expect(await panel.locator(".install-command code").textContent()).toBe("npx crawlio-browser-guide init");
  }, 90_000);
});
