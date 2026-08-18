import { createServer, type Server } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const chromiumPath = chromium.executablePath();
const stableExtensionId = "bjgpnncbnjeahgfljjegblhmiklkcpmg";
const extensionOrigin = `chrome-extension://${stableExtensionId}`;

let context: BrowserContext | null = null;
let server: Server | null = null;
let panel: Page | null = null;
let temporaryRoot = "";
let baseUrl = "";

/**
 * The whole product on an Anthropic sign-in, with no OpenAI credential
 * anywhere: the helper reports one, the panel picks the Claude engine, and a
 * typed question is answered and pointed at the page.
 */
describe.skipIf(!existsSync(chromiumPath))("Claude engine with no OpenAI credential", () => {
  beforeAll(async () => {
    const fixture = await readFile(resolve(process.cwd(), "tests/fixtures/guidance.html"));
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(fixture);
    });
    await new Promise<void>((start) => server?.listen(0, "127.0.0.1", start));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    temporaryRoot = await mkdtemp(join(tmpdir(), "browser-guide-claude-e2e-"));
    const profilePath = resolve(temporaryRoot, "profile");
    const extensionPath = resolve(temporaryRoot, "extension");
    const hostPath = resolve(temporaryRoot, "com.crawlio.browser_guide");
    const hostScriptPath = resolve(temporaryRoot, "native-host-stub.mjs");
    await cp(resolve(process.cwd(), "dist/extension"), extensionPath, { recursive: true });
    await cp(resolve(process.cwd(), "tests/fixtures/native-host-stub.mjs"), hostScriptPath);
    await writeFile(hostPath, `#!/bin/zsh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hostScriptPath)} "$@"\n`);
    await chmod(hostPath, 0o755);

    const testManifestPath = resolve(extensionPath, "manifest.json");
    const manifest = JSON.parse(await readFile(testManifestPath, "utf8")) as Record<string, unknown>;
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as string[] : [];
    manifest.permissions = [...permissions, "nativeMessaging"];
    delete manifest.optional_permissions;
    manifest.host_permissions = ["http://127.0.0.1/*"];
    await writeFile(testManifestPath, JSON.stringify(manifest));

    const nativeManifestPath = resolve(profilePath, "NativeMessagingHosts/com.crawlio.browser_guide.json");
    await mkdir(resolve(nativeManifestPath, ".."), { recursive: true });
    await writeFile(nativeManifestPath, JSON.stringify({
      name: "com.crawlio.browser_guide",
      description: "Browser Guide Claude engine E2E native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: [`${extensionOrigin}/`],
    }));

    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: chromiumPath,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        // No OpenAI credential; a Claude sign-in is present.
        BROWSER_GUIDE_TEST_OPENAI: "0",
        BROWSER_GUIDE_TEST_CLAUDE: "1",
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
    await new Promise((settle) => setTimeout(settle, 6_000));

    panel = await context.newPage();
    await panel.goto(`${extensionOrigin}/sidepanel.html`);
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await new Promise<void>((close) => server ? server.close(() => close()) : close());
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("answers and points using the Anthropic sign-in alone", async () => {
    const workspace = panel!;
    // Ready without ever asking for a key: the sign-in is the whole setup.
    await expect.poll(() => workspace.locator(".instrument-bar").count(), { timeout: 20_000 }).toBe(1);
    expect(await workspace.locator("#setup-title").count()).toBe(0);

    const page = await context!.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    const resume = workspace.locator(".recovery-line button", { hasText: "Resume" });
    if (await resume.count()) await resume.evaluate((element) => (element as HTMLButtonElement).click());
    await expect.poll(() => workspace.locator(".recovery-line").count(), { timeout: 10_000 }).toBe(0);

    await workspace.evaluate(() => {
      const area = document.querySelector("#guide-question") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(area, "Where is Review invoices?");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await workspace.locator("form.composer").evaluate((form) => (form as HTMLFormElement).requestSubmit());

    // The canned helper points first and only speaks on the round that
    // carries the tool result, so this sentence can only appear if the whole
    // loop ran: completion, guidance enforcement, tool result, second call.
    await expect.poll(() => workspace.locator(".workspace").innerText(), { timeout: 30_000 })
      .toContain("Review invoices is highlighted on the page.");
    expect(await workspace.locator(".issue-line").count()).toBe(0);

    // The page was pointed at, and never touched: the overlay is present and
    // every interaction counter the fixture keeps is still zero.
    await expect.poll(() => page.evaluate(() => document.querySelectorAll("[data-browser-guide-root]").length), { timeout: 10_000 })
      .toBe(1);
    const counters = await page.evaluate(() => (window as unknown as { __guideCounters: Record<string, number> }).__guideCounters);
    expect(Object.values(counters).every((count) => count === 0)).toBe(true);
  }, 90_000);
});
