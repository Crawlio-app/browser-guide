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
let fixturePage: Page | null = null;
let sidePanelPage: Page | null = null;
let temporaryRoot = "";
let baseUrl = "";
let hostLogPath = "";

describe.skipIf(!existsSync(chromiumPath))("controlled full product flow", () => {
  beforeAll(async () => {
    const fixture = await readFile(resolve(process.cwd(), "tests/fixtures/guidance.html"));
    server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(fixture);
    });
    await new Promise<void>((resolveStart) => server?.listen(0, "127.0.0.1", resolveStart));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    temporaryRoot = await mkdtemp(join(tmpdir(), "browser-guide-product-e2e-"));
    const profilePath = resolve(temporaryRoot, "profile");
    const extensionPath = resolve(temporaryRoot, "extension");
    const hostPath = resolve(temporaryRoot, "com.crawlio.browser_guide");
    const hostScriptPath = resolve(temporaryRoot, "native-host-stub.mjs");
    hostLogPath = resolve(temporaryRoot, "native-host.log");
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

    const nativeManifest = JSON.stringify({
      name: "com.crawlio.browser_guide",
      description: "Browser Guide controlled E2E native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: [`${extensionOrigin}/`],
    });
    const nativeManifestPath = resolve(profilePath, "NativeMessagingHosts/com.crawlio.browser_guide.json");
    await mkdir(resolve(nativeManifestPath, ".."), { recursive: true });
    await writeFile(nativeManifestPath, nativeManifest);

    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: chromiumPath,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        BROWSER_GUIDE_TEST_HOST_LOG: hostLogPath,
      },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--window-position=-2000,-2000",
        "--window-size=1000,760",
      ],
    });
    await context.addInitScript(installControlledRealtime);
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    expect(worker.url()).toBe(`${extensionOrigin}/service-worker.js`);
    const nativeProbe = await worker.evaluate(() => new Promise<{ response?: unknown; error?: string }>((resolveProbe) => {
      const port = chrome.runtime.connectNative("com.crawlio.browser_guide");
      const timeout = setTimeout(() => {
        port.disconnect();
        resolveProbe({ error: "probe timeout" });
      }, 3_000);
      port.onMessage.addListener((response) => {
        clearTimeout(timeout);
        port.disconnect();
        resolveProbe({ response });
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        resolveProbe({ error: chrome.runtime.lastError?.message ?? "native port disconnected" });
      });
      port.postMessage({
        version: 1,
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        type: "HOST_HEALTH",
      });
    }));
    if (!(nativeProbe.response && typeof nativeProbe.response === "object" && "ok" in nativeProbe.response)) {
      throw new Error(`Controlled native host probe failed: ${nativeProbe.error ?? JSON.stringify(nativeProbe.response)}`);
    }

    sidePanelPage = await context.newPage();
    await sidePanelPage.goto(`${extensionOrigin}/sidepanel.html`);
    try {
      await sidePanelPage.locator(".empty-instrument h1").waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      const state = await sidePanelPage.locator("main").getAttribute("data-setup");
      const copy = (await sidePanelPage.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 800);
      const hostLog = await readFile(hostLogPath, "utf8").catch(() => "native host was never launched");
      throw new Error(`The controlled product did not reach ready (setup=${state ?? "none"}): ${copy}; host=${hostLog.trim()}`);
    }
    // Assert the surface, not its copy: the headline changes with whether the
    // tab has been shared yet, which at this point it has not.
    if (await sidePanelPage.locator(".intent-launcher button").count() !== 3) {
      throw new Error("The ready product surface did not render.");
    }

    fixturePage = await context.newPage();
    await fixturePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidePanelPage.locator(".recovery-line button", { hasText: "Resume" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await sidePanelPage.locator(".recovery-line").waitFor({ state: "detached", timeout: 10_000 });
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose());
  });

  it("keeps the ready-state intent launcher inside narrow and short panels", async () => {
    if (!sidePanelPage) throw new Error("Product flow harness is not ready.");
    for (const viewport of [
      { width: 320, height: 420 },
      { width: 320, height: 760 },
      { width: 420, height: 520 },
      { width: 600, height: 760 },
    ]) {
      await sidePanelPage.setViewportSize(viewport);
      const layout = await sidePanelPage.evaluate(() => {
        const buttons = [...document.querySelectorAll(".intent-launcher button")].map((button) => {
          const box = button.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            clipped: button.scrollWidth > button.clientWidth + 1,
          };
        });
        return {
          buttons,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.buttons).toHaveLength(3);
      for (const button of layout.buttons) {
        expect(button.left).toBeGreaterThanOrEqual(0);
        expect(button.right).toBeLessThanOrEqual(viewport.width);
        expect(button.clipped).toBe(false);
      }
      expect(layout.scrollWidth).toBe(layout.clientWidth);
    }
    await sidePanelPage.setViewportSize({ width: 480, height: 700 });
  });

  it("runs typed, fake-microphone, pointer, and two-step walkthrough paths without page action", async () => {
    if (!sidePanelPage || !fixturePage) throw new Error("Product flow harness is not ready.");
    const pageErrors: string[] = [];
    sidePanelPage.on("pageerror", (error) => pageErrors.push(error.message));
    fixturePage.on("pageerror", (error) => pageErrors.push(error.message));

    // Agent eyes consent: OFF by default, no indicator until the user opts in,
    // and turning it off again removes the visible indicator.
    await expect.poll(
      () => sidePanelPage?.locator(".eyes-toggle").getAttribute("aria-pressed"),
      { timeout: 5_000 },
    ).toBe("false");
    expect(await sidePanelPage.locator(".eyes-indicator").count()).toBe(0);
    await sidePanelPage.locator(".eyes-toggle").evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => sidePanelPage?.locator(".eyes-indicator").count(), { timeout: 5_000 }).toBe(1);
    await sidePanelPage.locator(".eyes-toggle").evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => sidePanelPage?.locator(".eyes-indicator").count(), { timeout: 5_000 }).toBe(0);

    await submitFromBackground(sidePanelPage, fixturePage, "Where do I review invoices?");
    await expect.poll(() => sidePanelPage?.locator(".guide-answer").last().innerText(), { timeout: 5_000 }).toContain("Review invoices is highlighted");
    await expect.poll(() => fixturePage?.locator("[data-browser-guide-root]").getAttribute("data-guide-visible"), { timeout: 5_000 }).toBe("true");
    await expect.poll(() => sidePanelPage?.locator("main").getAttribute("data-toolbar-state"), { timeout: 5_000 }).toBe("ready");

    await fixturePage.bringToFront();
    await sidePanelPage.locator(".voice-beacon").evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => sidePanelPage?.locator(".user-question-text").allInnerTexts(), { timeout: 10_000 }).toContain("Where is Review invoices?");
    await expect.poll(() => sidePanelPage?.locator(".guide-answer").allInnerTexts(), { timeout: 10_000 }).toContain("The prerecorded voice question points to Review invoices.");
    await expect.poll(() => sidePanelPage?.locator("main").getAttribute("data-toolbar-state"), { timeout: 5_000 }).toBe("ready");

    // Selecting Walkthrough starts a tour of the current page automatically.
    await fixturePage.bringToFront();
    await sidePanelPage.locator(".mode-row > button", { hasText: "Walkthrough" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => sidePanelPage?.locator(".mode-row > button", { hasText: "Walkthrough" }).getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => sidePanelPage?.locator(".user-question-text").allInnerTexts(), { timeout: 6_000 }).toContain("Show me around this page");
    await expect.poll(async () => {
      const step = sidePanelPage?.locator(".guide-card .guide-eyebrow");
      return step && await step.count() > 0 ? step.innerText() : "";
    }, { timeout: 6_000 }).toContain("STEP 1");
    await fixturePage.waitForTimeout(100);

    await fixturePage.evaluate(() => {
      const control = document.querySelector("button[aria-label='Review invoices']");
      control?.setAttribute("aria-expanded", "true");
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "Invoice list is ready";
      document.querySelector(".billing")?.append(status);
    });
    await expect.poll(async () => {
      const step = sidePanelPage?.locator(".guide-card .guide-eyebrow");
      return step && await step.count() > 0 ? step.innerText() : "";
    }, { timeout: 6_000 }).toContain("STEP 2");
    await expect.poll(() => fixturePage?.locator("[data-browser-guide-root]").getAttribute("data-guide-visible"), { timeout: 5_000 }).toBe("true");

    // The step card carries a real Next button inside the closed shadow root.
    // Its center is mirrored on the host, so a genuine mouse click can hit it.
    const nextX = Number(await fixturePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-x"));
    const nextY = Number(await fixturePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-y"));
    expect(Number.isFinite(nextX) && nextX > 0).toBe(true);
    expect(Number.isFinite(nextY) && nextY > 0).toBe(true);
    await fixturePage.mouse.click(nextX, nextY);
    await expect.poll(async () => {
      const step = sidePanelPage?.locator(".guide-card .guide-eyebrow");
      return step && await step.count() > 0 ? step.innerText() : "";
    }, { timeout: 8_000 }).toContain("STEP 3");

    // Step 3 of 3 renders a Done button; pressing it completes the walkthrough
    // and clears the on-page guidance.
    const doneX = Number(await fixturePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-x"));
    const doneY = Number(await fixturePage.locator("[data-browser-guide-root]").getAttribute("data-guide-next-y"));
    await fixturePage.mouse.click(doneX, doneY);
    await expect.poll(async () => {
      const step = sidePanelPage?.locator(".guide-card .guide-eyebrow");
      return step && await step.count() > 0 ? step.innerText() : "";
    }, { timeout: 6_000 }).toContain("WALKTHROUGH COMPLETE");
    await expect.poll(() => fixturePage?.locator("[data-browser-guide-root]").getAttribute("data-guide-visible"), { timeout: 5_000 }).toBe(null);

    expect(await fixturePage.evaluate(() => (window as unknown as { __guideCounters: Record<string, number> }).__guideCounters)).toEqual({
      click: 0,
      input: 0,
      key: 0,
      submit: 0,
      scroll: 0,
      focus: 0,
      history: 0,
      location: 0,
    });
    expect(pageErrors).toEqual([]);
  }, 30_000);
});

async function submitFromBackground(panel: Page, fixture: Page, question: string): Promise<void> {
  await panel.locator("#guide-question").fill(question);
  await fixture.bringToFront();
  await panel.locator("form.composer").evaluate((element) => {
    (element as HTMLFormElement).requestSubmit();
  });
}

function installControlledRealtime(): void {
  if (location.protocol !== "chrome-extension:") return;
  const nativeQuery = navigator.permissions.query.bind(navigator.permissions);
  Object.defineProperty(navigator.permissions, "query", {
    configurable: true,
    value: (descriptor: PermissionDescriptor) => descriptor?.name === ("microphone" as PermissionName)
      ? Promise.resolve({ state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} } as unknown as PermissionStatus)
      : nativeQuery(descriptor),
  });
  const controlled = globalThis as typeof globalThis & { __browserGuideControlledChannels?: ControlledChannel[] };
  controlled.__browserGuideControlledChannels = [];
  let callSequence = 0;

  class ControlledChannel extends EventTarget {
    readyState: RTCDataChannelState = "connecting";
    private prompt = "";
    private awaitingToolResult = false;
    private continuations = 0;

    send(raw: string): void {
      const event = JSON.parse(raw) as Record<string, unknown>;
      if (event.type === "conversation.item.create") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "message" && Array.isArray(item.content)) {
          this.prompt = item.content
            .map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "")
            .join("\n");
        }
      }
      if (event.type !== "response.create") return;
      setTimeout(() => {
        if (this.awaitingToolResult) {
          this.awaitingToolResult = false;
          this.emit({ type: "response.done", response: { output: [] } });
          this.emit({ type: "output_audio_buffer.stopped" });
        } else {
          this.respondToPrompt();
        }
      }, 10);
    }

    close(): void {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }

    open(): void {
      this.readyState = "open";
      this.dispatchEvent(new Event("open"));
    }

    voiceTurn(): void {
      if (this.readyState !== "open") return;
      this.emit({ type: "input_audio_buffer.speech_started" });
      this.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "Where is Review invoices?" });
      this.emit({ type: "input_audio_buffer.speech_stopped" });
      this.emit({ type: "response.created" });
      this.emit({ type: "response.output_audio_transcript.delta", delta: "The prerecorded voice question " });
      this.emit({ type: "response.output_audio_transcript.done", transcript: "The prerecorded voice question points to Review invoices." });
      this.emitTool({
        refs: ["e1"],
        title: "Review invoices",
        body: "This is the current invoice control.",
        presentation: "point",
        waitFor: "none",
      });
    }

    private respondToPrompt(): void {
      const continuation = this.prompt.includes("WALKTHROUGH CONTINUATION");
      if (continuation) this.continuations += 1;
      const walkthrough = continuation || this.prompt.includes("Start a bounded, read-only walkthrough");
      const answer = continuation
        ? "The refreshed page is ready for the next step."
        : walkthrough ? "Start with Review invoices."
          : "Review invoices is highlighted in the Billing section.";
      this.emit({ type: "response.output_text.done", text: answer });
      this.emitTool(walkthrough ? {
        refs: ["e1"],
        title: continuation ? "Review the list" : "Open invoices",
        body: continuation ? "Review the visible list, then continue when ready." : "Choose Review invoices yourself and wait for the list.",
        presentation: "step",
        waitFor: continuation ? "user_confirm" : "page_change",
        progress: { current: continuation ? 1 + this.continuations : 1, total: 3 },
      } : {
        refs: ["e1"],
        title: "Review invoices",
        body: "This is the current invoice control.",
        presentation: "point",
        waitFor: "none",
      });
    }

    private emitTool(argumentsValue: Record<string, unknown>): void {
      callSequence += 1;
      this.awaitingToolResult = true;
      this.emit({
        type: "response.done",
        response: {
          output: [{
            type: "function_call",
            name: "show_guidance",
            call_id: `controlled-call-${callSequence}`,
            arguments: JSON.stringify(argumentsValue),
          }],
        },
      });
    }

    private emit(payload: unknown): void {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    }
  }

  class ControlledPeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "connected";
    private channel: ControlledChannel | null = null;

    addTrack(): RTCRtpSender {
      return {} as RTCRtpSender;
    }

    addTransceiver(): RTCRtpTransceiver {
      return {} as RTCRtpTransceiver;
    }

    createDataChannel(): RTCDataChannel {
      this.channel = new ControlledChannel();
      controlled.__browserGuideControlledChannels?.push(this.channel);
      return this.channel as unknown as RTCDataChannel;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0\r\ns=browser-guide-controlled-offer\r\n" };
    }

    async setLocalDescription(): Promise<void> {}

    async setRemoteDescription(): Promise<void> {
      this.channel?.open();
    }

    close(): void {
      this.connectionState = "closed";
    }
  }

  class ControlledTrack {
    private active = false;

    get enabled(): boolean {
      return this.active;
    }

    set enabled(value: boolean) {
      this.active = value;
      if (value) setTimeout(() => controlled.__browserGuideControlledChannels?.at(-1)?.voiceTurn(), 20);
    }

    stop(): void {
      this.active = false;
    }
  }

  const track = new ControlledTrack();
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: ControlledPeerConnection,
  });
}

interface ControlledChannel {
  voiceTurn(): void;
}
