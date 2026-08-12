import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_TOUR_STEPS } from "../../src/extension/sidepanel/demo-tour.js";

const chromiumPath = chromium.executablePath();
const stableExtensionId = "bjgpnncbnjeahgfljjegblhmiklkcpmg";
const extensionOrigin = `chrome-extension://${stableExtensionId}`;

let context: BrowserContext | null = null;
let server: Server | null = null;
let practicePage: Page | null = null;
let sidePanelPage: Page | null = null;
let temporaryRoot = "";
let baseUrl = "";

describe.skipIf(!existsSync(chromiumPath))("model-free demo tour without the native helper", () => {
  beforeAll(async () => {
    const fixture = await readFile(resolve(process.cwd(), "tests/fixtures/practice.html"));
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(fixture);
    });
    await new Promise<void>((resolveStart) => server?.listen(0, "127.0.0.1", resolveStart));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Practice fixture server did not bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    temporaryRoot = await mkdtemp(join(tmpdir(), "browser-guide-demo-e2e-"));
    const profilePath = resolve(temporaryRoot, "profile");
    const extensionPath = resolve(temporaryRoot, "extension");
    await cp(resolve(process.cwd(), "dist/extension"), extensionPath, { recursive: true });

    // Deliberately NO native messaging host manifest: this run proves the tour
    // works in the helper-missing state. The manifest still grants page access
    // (host_permissions replaces the manual toolbar-icon activeTab gesture).
    const testManifestPath = resolve(extensionPath, "manifest.json");
    const manifest = JSON.parse(await readFile(testManifestPath, "utf8")) as Record<string, unknown>;
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as string[] : [];
    manifest.permissions = [...permissions, "nativeMessaging"];
    delete manifest.optional_permissions;
    manifest.host_permissions = ["http://127.0.0.1/*"];
    await writeFile(testManifestPath, JSON.stringify(manifest));

    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: chromiumPath,
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

    sidePanelPage = await context.newPage();
    await sidePanelPage.goto(`${extensionOrigin}/sidepanel.html`);
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("runs the full canned tour from helper-missing with zero page interference", async () => {
    if (!sidePanelPage || !context) throw new Error("Demo harness is not ready.");
    const pageErrors: string[] = [];
    sidePanelPage.on("pageerror", (error) => pageErrors.push(error.message));

    // Without a registered host, setup must land on helper-missing.
    await expect.poll(
      () => sidePanelPage?.locator("main").getAttribute("data-setup"),
      { timeout: 15_000 },
    ).toBe("helper-missing");

    // Entering the demo needs no helper and no credential. The untrusted click
    // means window.open(PRACTICE_URL) is popup-blocked, keeping the run
    // hermetic — the tour drives the local fixture instead.
    await sidePanelPage.locator(".setup-secondary", { hasText: "Try the demo first" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => sidePanelPage?.locator(".demo-banner").count()).toBe(1);

    practicePage = await context.newPage();
    await practicePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    practicePage.on("pageerror", (error) => pageErrors.push(error.message));
    await practicePage.bringToFront();
    await sidePanelPage.locator(".recovery-line button", { hasText: "Resume" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await sidePanelPage.locator(".recovery-line:not(.demo-banner)").waitFor({ state: "detached", timeout: 10_000 });

    await sidePanelPage.locator(".demo-banner button", { hasText: "Practice tour" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });

    for (const [index, step] of DEMO_TOUR_STEPS.entries()) {
      await expect.poll(
        () => sidePanelPage?.locator(".guide-card h2").innerText().catch(() => ""),
        { timeout: 10_000 },
      ).toBe(step.title);
      await expect.poll(
        () => practicePage?.locator("[data-browser-guide-root]").getAttribute("data-guide-visible"),
        { timeout: 5_000 },
      ).toBe("true");

      // Press the overlay's own Next/Done button with a physical click.
      const nextX = Number(await practicePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-x"));
      const nextY = Number(await practicePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-y"));
      expect(Number.isFinite(nextX) && Number.isFinite(nextY)).toBe(true);
      await practicePage.mouse.click(nextX, nextY);
      if (index < DEMO_TOUR_STEPS.length - 1) {
        await expect.poll(
          () => sidePanelPage?.locator(".guide-card .guide-eyebrow").innerText().then((text) => text.toLowerCase()).catch(() => ""),
          { timeout: 10_000 },
        ).toContain(`step ${index + 2}`);
      }
    }

    // Done closes the tour: overlay gone, coordinator complete.
    await expect.poll(
      () => sidePanelPage?.locator(".guide-card .guide-eyebrow").innerText().then((text) => text.toLowerCase()).catch(() => ""),
      { timeout: 10_000 },
    ).toContain("all done");
    await expect.poll(
      () => practicePage?.locator("[data-browser-guide-root]").getAttribute("data-guide-visible"),
      { timeout: 5_000 },
    ).toBe(null);

    // The read-only guarantee held for the whole tour.
    const counters = await practicePage.evaluate(() => (window as unknown as { __guideCounters: Record<string, number> }).__guideCounters);
    for (const [name, count] of Object.entries(counters)) {
      if (name === "scroll") continue; // the user's own take-me-there arrow may scroll
      expect(count, `page ${name} counter`).toBe(0);
    }
    const href = await practicePage.evaluate(() => location.href);
    expect(href).toBe(await practicePage.evaluate(() => (window as unknown as { __guideInitialHref: string }).__guideInitialHref));
    expect(pageErrors).toEqual([]);
  }, 90_000);
});
