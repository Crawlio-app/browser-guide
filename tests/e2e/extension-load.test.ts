import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";

const chromiumPath = chromium.executablePath();
const stableExtensionId = "bjgpnncbnjeahgfljjegblhmiklkcpmg";
let context: BrowserContext | null = null;
let profileDirectory = "";

describe.skipIf(!existsSync(chromiumPath))("load-unpacked extension package", () => {
  afterAll(async () => {
    await context?.close();
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
  });

  it("registers its MV3 worker with a fresh identity and renders the side panel", async () => {
    const extensionPath = resolve(process.cwd(), "dist/extension");
    profileDirectory = await mkdtemp(join(tmpdir(), "browser-guide-profile-"));
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      executablePath: chromiumPath,
      args: [
        "--disable-extensions-except=" + extensionPath,
        "--load-extension=" + extensionPath,
        "--no-first-run",
        "--window-position=-2000,-2000",
        "--window-size=900,700",
      ],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    expect(worker.url()).toBe(`chrome-extension://${stableExtensionId}/service-worker.js`);
    // The click contract lives in chrome.action.onClicked (which Chrome skips
    // while openPanelOnActionClick handles the gesture), so it must stay off.
    await expect.poll(async () => {
      const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
      return behavior.openPanelOnActionClick;
    }).toBe(false);
    const workerUrl = new URL(worker.url());
    const extensionOrigin = workerUrl.protocol + "//" + workerUrl.host;

    const sidePanelPage = await context.newPage();
    const pageErrors: string[] = [];
    sidePanelPage.on("pageerror", (error) => pageErrors.push(error.message));
    await sidePanelPage.goto(extensionOrigin + "/sidepanel.html");
    await expect.poll(() => sidePanelPage.locator(".setup-card").count()).toBe(1);
    await expect.poll(() => sidePanelPage.locator(".setup-card h1").innerText()).toBe("Allow the helper");
    await expect.poll(() => sidePanelPage.locator("main").getAttribute("data-setup")).toBe("permission-needed");
    const setupCopy = await sidePanelPage.locator(".setup-card").innerText();
    expect(setupCopy).not.toMatch(/connect|pair|localhost|private beta/i);
    expect(await sidePanelPage.locator("input[name='browser-guide-transient-key']").count()).toBe(0);
    expect(await sidePanelPage.locator("body").getAttribute("data-extension-id")).toBeNull();
    const stored = await worker.evaluate(async () => chrome.storage.local.get(null));
    expect(stored).toEqual({});

    for (const viewport of [
      { width: 320, height: 420 },
      { width: 320, height: 760 },
      { width: 420, height: 520 },
      { width: 600, height: 760 },
    ]) {
      await sidePanelPage.setViewportSize(viewport);
      const layout = await sidePanelPage.evaluate(() => {
        const card = document.querySelector(".setup-card")?.getBoundingClientRect();
        return {
          card: card ? { left: card.left, right: card.right, width: card.width } : null,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.card).not.toBeNull();
      expect(layout.card?.left ?? -1).toBeGreaterThanOrEqual(0);
      expect(layout.card?.right ?? viewport.width + 1).toBeLessThanOrEqual(viewport.width);
      expect(layout.card?.width ?? 361).toBeLessThanOrEqual(360);
      expect(layout.scrollWidth).toBe(layout.clientWidth);
    }

    await sidePanelPage.keyboard.press("Tab");
    await expect.poll(() => sidePanelPage.locator(".setup-action").evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await sidePanelPage.locator(".setup-action").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    expect(pageErrors).toEqual([]);

    const wizardPage = await context.newPage();
    const wizardErrors: string[] = [];
    wizardPage.on("pageerror", (error) => wizardErrors.push(error.message));
    await wizardPage.goto(extensionOrigin + "/welcome.html");
    await expect.poll(() => wizardPage.locator("#connect-title").innerText()).toBe("Connect Browser Guide");
    await expect.poll(() => wizardPage.locator("#step-install.done").count()).toBe(1);
    await expect.poll(() => wizardPage.locator("#step-grant.current").count()).toBe(1);
    await expect.poll(() => wizardPage.locator("#connect-btn:visible").innerText()).toContain("Review & Grant Access");

    // The trust modal derives its consent list from the live manifest.
    await wizardPage.locator("#connect-btn").evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => wizardPage.locator(".modal-overlay.visible").count()).toBe(1);
    await expect.poll(() => wizardPage.locator("#permission-list li").allInnerTexts()).toContain("Confirm the local Keychain helper is genuine");
    await wizardPage.locator("#cancel-btn").evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => wizardPage.locator(".modal-overlay.visible").count()).toBe(0);

    for (const viewport of [{ width: 360, height: 640 }, { width: 1280, height: 800 }]) {
      await wizardPage.setViewportSize(viewport);
      const layout = await wizardPage.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(layout.scrollWidth).toBe(layout.clientWidth);
    }
    expect(wizardErrors).toEqual([]);
  });
});
