import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageContext } from "../../src/shared/page-context.js";
import { groundElements } from "../../src/shared/semantic-grounding.js";

declare global {
  interface Window {
    __dispatchBrowserGuide(message: unknown): Promise<unknown>;
    __guideCounters: Record<string, number>;
    __guideInitialHref: string;
  }
}

const chromePath = process.env.BROWSER_GUIDE_CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let server: Server;
let browser: Browser;
let page: Page;
let baseUrl = "";

describe.skipIf(!existsSync(chromePath))("production content bundle in Chrome", () => {
  beforeAll(async () => {
    const fixture = await readFile(resolve(process.cwd(), "tests/fixtures/guidance.html"));
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(fixture);
    });
    await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    baseUrl = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const harness = [
      "(() => {",
      "  const listeners = [];",
      "  const runtime = {",
      "    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
      "    onMessage: {",
      "      addListener(listener) { listeners.push(listener); },",
      "      removeListener(listener) { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); }",
      "    },",
      "    sendMessage(_message, callback) { if (callback) callback(); },",
      "    get lastError() { return undefined; }",
      "  };",
      "  const chromeValue = window.chrome || {};",
      "  Object.defineProperty(chromeValue, 'runtime', { value: runtime, configurable: true });",
      "  window.__dispatchBrowserGuide = (message) => new Promise((resolve, reject) => {",
      "    const timeout = setTimeout(() => reject(new Error('content response timed out')), 5000);",
      "    for (const listener of listeners) {",
      "      const handled = listener(message, { id: runtime.id }, (value) => { clearTimeout(timeout); resolve(value); });",
      "      if (handled === true) return;",
      "    }",
      "    clearTimeout(timeout);",
      "    reject(new Error('no content listener handled the request'));",
      "  });",
      "})();",
    ].join("\n");
    await page.addInitScript({ content: harness });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: resolve(process.cwd(), "dist/extension/content.js") });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  });

  it("shows a two-step grounded walkthrough while every page-action counter stays at zero", async () => {
    const initialHref = page.url();
    const capture = await page.evaluate(() => window.__dispatchBrowserGuide({ type: "CONTENT_CAPTURE_CONTEXT" })) as {
      ok: boolean;
      context: PageContext;
    };
    expect(capture.ok).toBe(true);
    expect(JSON.stringify(capture.context)).not.toContain("private-person@example.test");
    expect(JSON.stringify(capture.context)).not.toContain("do-not-collect");
    const grounded = groundElements("Where do I review invoices?", capture.context.elements);
    const target = capture.context.elements.find((element) => element.ref === grounded[0]?.ref);
    expect(target).toBeDefined();
    expect(target?.name).toContain("Review invoices");

    const shield = await page.evaluate(() => window.__dispatchBrowserGuide({ type: "CONTENT_PREPARE_SCREENSHOT" })) as {
      ok: boolean;
      error?: string;
    };
    expect(shield).toEqual({ ok: false, error: "privacy-protection" });
    await page.evaluate(() => window.__dispatchBrowserGuide({ type: "CONTENT_FINISH_SCREENSHOT" }));

    const guidance = await page.evaluate(
      ({ snapshotId, ref }) => window.__dispatchBrowserGuide({
        type: "CONTENT_SHOW_GUIDANCE",
        snapshotId,
        command: {
          name: "show_guidance",
          refs: [ref],
          title: "Invoices live here",
          body: "Choose Review invoices yourself to inspect the list.",
          presentation: "step",
          waitFor: "page_change",
          progress: { current: 1, total: 2 },
        },
      }),
      { snapshotId: capture.context.snapshotId, ref: target?.ref ?? "e999" },
    ) as { ok: boolean; shownRefs: string[] };
    expect(guidance).toMatchObject({ ok: true, shownRefs: [target?.ref] });

    const host = page.locator("[data-browser-guide-root]");
    await expect.poll(() => host.getAttribute("data-guide-visible")).toBe("true");
    expect(await host.evaluate((element) => ({
      pointerEvents: (element as HTMLElement).style.pointerEvents,
      closedShadow: element.shadowRoot === null,
    }))).toEqual({ pointerEvents: "none", closedShadow: true });

    await page.evaluate(() => {
      const button = document.querySelector("button[aria-label='Review invoices']");
      button?.setAttribute("aria-expanded", "true");
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "Invoice list is ready";
      document.querySelector(".billing")?.append(status);
    });
    await expect.poll(() => host.getAttribute("data-guide-visible")).toBeNull();

    const staleGuidance = await page.evaluate(
      ({ snapshotId, ref }) => window.__dispatchBrowserGuide({
        type: "CONTENT_SHOW_GUIDANCE",
        snapshotId,
        command: {
          name: "show_guidance",
          refs: [ref],
          title: "Stale",
          body: "This old snapshot must be rejected.",
          presentation: "step",
          waitFor: "page_change",
        },
      }),
      { snapshotId: capture.context.snapshotId, ref: target?.ref ?? "e999" },
    ) as { ok: boolean };
    expect(staleGuidance.ok).toBe(false);

    const refreshed = await page.evaluate(() => window.__dispatchBrowserGuide({ type: "CONTENT_CAPTURE_CONTEXT" })) as {
      ok: boolean;
      context: PageContext;
    };
    expect(refreshed.ok).toBe(true);
    expect(refreshed.context.snapshotId).not.toBe(capture.context.snapshotId);
    const refreshedTarget = refreshed.context.elements.find((element) => element.name.includes("Review invoices"));
    expect(refreshedTarget?.expanded).toBe(true);
    const secondGuidance = await page.evaluate(
      ({ snapshotId, ref }) => window.__dispatchBrowserGuide({
        type: "CONTENT_SHOW_GUIDANCE",
        snapshotId,
        command: {
          name: "show_guidance",
          refs: [ref],
          title: "List opened",
          body: "Review the visible invoice list, then continue when ready.",
          presentation: "step",
          waitFor: "user_confirm",
          progress: { current: 2, total: 2 },
        },
      }),
      { snapshotId: refreshed.context.snapshotId, ref: refreshedTarget?.ref ?? "e999" },
    ) as { ok: boolean; shownRefs: string[] };
    expect(secondGuidance).toMatchObject({ ok: true, shownRefs: [refreshedTarget?.ref] });
    await expect.poll(() => host.getAttribute("data-guide-visible")).toBe("true");

    const counters = await page.evaluate(() => window.__guideCounters);
    expect(counters).toEqual({
      click: 0,
      input: 0,
      key: 0,
      submit: 0,
      scroll: 0,
      focus: 0,
      history: 0,
      location: 0,
    });
    expect(page.url()).toBe(initialHref);

    await page.evaluate(() => window.__dispatchBrowserGuide({ type: "CONTENT_END_SESSION" }));
    await expect.poll(() => page.locator("[data-browser-guide-root]").count()).toBe(0);
    expect(await page.evaluate(() => window.__guideCounters)).toEqual(counters);
  });
});
