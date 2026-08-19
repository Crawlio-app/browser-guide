import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageContext } from "../../src/shared/page-context.js";
import type { ExtensionRuntimeState } from "../../src/shared/protocol.js";

const STATE_KEY = "browserGuideRuntimeStateV1";
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sidePanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

interface ServiceWorkerHarness {
  chromeStub: typeof chrome;
  runtimeMessageListeners: RuntimeMessageListener[];
  actionListeners: Array<(tab: chrome.tabs.Tab) => void>;
  commandListeners: Array<(command: string) => void>;
  tabUpdatedListeners: Array<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void>;
  tabActivatedListeners: Array<(activeInfo: chrome.tabs.TabActiveInfo) => void>;
  tabRemovedListeners: Array<(tabId: number) => void>;
  tabReplacedListeners: Array<(addedTabId: number, removedTabId: number) => void>;
  windowFocusListeners: Array<(windowId: number) => void>;
  tabMessages: unknown[];
  storageWrites: unknown[];
  executeScript: ReturnType<typeof vi.fn>;
  captureVisibleTab: ReturnType<typeof vi.fn>;
  sidePanelOpen: ReturnType<typeof vi.fn>;
  setPanelBehavior: ReturnType<typeof vi.fn>;
  getStateCalls(): number;
  getQueryCalls(): number;
  setActiveTab(tab: chrome.tabs.Tab): void;
  resolveContext(context?: PageContext): void;
  resolveScreenshot(dataUrl?: string): void;
  resolveState(state?: ExtensionRuntimeState): void;
}

interface HarnessOptions {
  deferContext?: boolean;
  deferScreenshot?: boolean;
}

const capturedPageContext: PageContext = {
  snapshotId: "snapshot-capture",
  capturedAt: "2026-08-09T00:00:00.000Z",
  title: "Fixture",
  url: "https://fixture.test/account",
  origin: "https://fixture.test",
  viewport: { width: 800, height: 600, devicePixelRatio: 2 },
  elements: [],
  truncated: false,
  characterCount: 120,
};

describe("service worker startup and content runtime readiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses snapshot validation as a non-mutating readiness probe", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState();

    const response = await sendSidePanelRequest(harness, { type: "GUIDE_RESUME_REQUEST" });

    expect(response).toMatchObject({ ok: true });
    expect(harness.tabMessages).toEqual([{
      type: "CONTENT_VALIDATE_SNAPSHOT",
      snapshotId: "browser-guide-runtime-probe",
    }]);
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  it("keeps the built-in panel behavior off and opens the panel itself on a toolbar click", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState();

    await vi.waitFor(() => expect(harness.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false }));

    harness.actionListeners[0]?.(tab(17));
    expect(harness.sidePanelOpen).toHaveBeenCalledWith({ windowId: 4 });
    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "ready",
      tabId: 17,
      authorizedOrigin: "https://fixture.test",
    }));
  });

  it("reports a missing activeTab grant as not-authorized, never as a restricted page", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState();
    harness.setActiveTab({ id: 17, windowId: 4 } as chrome.tabs.Tab);

    const response = await sendSidePanelRequest(harness, { type: "GUIDE_RESUME_REQUEST" });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("toolbar icon") as unknown,
    });
    expect(latestStoredState(harness)).toMatchObject({
      status: "permission-paused",
      pauseReason: "not-authorized",
    });
  });

  it("reports a visible non-web page as restricted on resume", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState();
    harness.setActiveTab({ id: 17, windowId: 4, url: "chrome://extensions" } as chrome.tabs.Tab);

    const response = await sendSidePanelRequest(harness, { type: "GUIDE_RESUME_REQUEST" });

    expect(response).toMatchObject({ ok: false, error: "This page cannot be shared." });
    expect(latestStoredState(harness)).toMatchObject({
      status: "permission-paused",
      pauseReason: "restricted-page",
    });
  });

  it("coalesces cold-start state reads before activation and never overwrites the activated tab", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");

    harness.actionListeners[0]?.(tab(17));
    const pendingState = sendSidePanelRequest(harness, { type: "GUIDE_GET_STATE" });
    expect(harness.getStateCalls()).toBe(1);
    expect(harness.storageWrites).toEqual([]);

    harness.resolveState(readyState(5));
    await pendingState;
    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "ready",
      tabId: 17,
      authorizedOrigin: "https://fixture.test",
      refsValid: false,
    }));
    expect(harness.getStateCalls()).toBe(1);
  });

  it("waits for hydration before a keyboard activation queries or mutates browser state", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");

    harness.commandListeners[0]?.("toggle-listening");
    expect(harness.getQueryCalls()).toBe(0);
    expect(harness.storageWrites).toEqual([]);

    harness.resolveState();
    await vi.waitFor(() => expect(harness.getQueryCalls()).toBe(1));
    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({ status: "ready", tabId: 17 }));
    expect(harness.getStateCalls()).toBe(1);
  });

  it("applies a content invalidation sent during cold-start to the restored snapshot", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");

    harness.runtimeMessageListeners[0]?.(
      { type: "GUIDE_REFS_INVALIDATED", snapshotId: "snapshot-restored" },
      { id: extensionId, tab: tab(17) },
      () => undefined,
    );
    expect(harness.storageWrites).toEqual([]);

    harness.resolveState(readyState(17, true));
    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "ready",
      tabId: 17,
      refsValid: false,
    }));
    expect(latestStoredState(harness).latestSnapshotId).toBeUndefined();
    expect(harness.getStateCalls()).toBe(1);
  });

  it("applies same-origin loading invalidation only after the authorized tab is restored", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");

    harness.tabUpdatedListeners[0]?.(17, { status: "loading" }, tab(17));
    expect(harness.tabMessages).toEqual([]);
    harness.resolveState(readyState(17, true));

    await vi.waitFor(() => expect(harness.tabMessages).toContainEqual({ type: "CONTENT_END_SESSION" }));
    await vi.waitFor(() => expect(latestStoredState(harness).refsValid).toBe(false));
  });

  it("applies activation and removal pauses against hydrated tab ownership", async () => {
    const activated = createHarness();
    vi.stubGlobal("chrome", activated.chromeStub);
    await import("../../src/extension/service-worker.js");
    activated.tabActivatedListeners[0]?.({ tabId: 99, windowId: 4 });
    activated.resolveState(readyState(17, true));
    await vi.waitFor(() => expect(latestStoredState(activated)).toMatchObject({
      status: "permission-paused",
      pauseReason: "not-authorized",
    }));

    vi.unstubAllGlobals();
    vi.resetModules();
    const removed = createHarness();
    vi.stubGlobal("chrome", removed.chromeStub);
    await import("../../src/extension/service-worker.js");
    removed.tabRemovedListeners[0]?.(17);
    removed.resolveState(readyState(17, true));
    await vi.waitFor(() => expect(latestStoredState(removed)).toMatchObject({
      status: "permission-paused",
      pauseReason: "access-lost",
    }));
  });

  it("resumes the shared tab when the user comes back to it", async () => {
    // Switching away pauses, which is right: the grant is per tab. Switching
    // back used to leave it paused with nothing on screen saying that
    // returning was enough, so the session looked lost whenever anyone
    // glanced at another tab.
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState({
      status: "permission-paused",
      tabId: 17,
      authorizedOrigin: "https://fixture.test",
      pauseReason: "not-authorized",
      refsValid: false,
    });
    harness.tabActivatedListeners[0]?.({ tabId: 17, windowId: 4 });

    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "ready",
      tabId: 17,
      authorizedOrigin: "https://fixture.test",
    }));
  });

  it("does not let a restricted page condemn every tab that follows", async () => {
    // Clicking the icon on chrome://extensions is refused, correctly. That
    // verdict used to persist across tab switches, so Gmail then showed
    // "Chrome does not allow guidance on this page" with no way out.
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState({
      status: "permission-paused",
      pauseReason: "restricted-page",
      refsValid: false,
    });
    harness.tabActivatedListeners[0]?.({ tabId: 42, windowId: 4 });

    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "permission-paused",
      pauseReason: "not-authorized",
    }));
  });

  it("pauses and tears down an authorized tab when Chrome replaces it", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.tabReplacedListeners[0]?.(23, 17);
    harness.resolveState(readyState(17, true));

    await vi.waitFor(() => expect(latestStoredState(harness)).toMatchObject({
      status: "permission-paused",
      pauseReason: "access-lost",
      refsValid: false,
    }));
    expect(harness.tabMessages).toContainEqual({ type: "CONTENT_END_SESSION" });
  });

  it("cannot publish stale DOM evidence after the active-surface epoch changes", async () => {
    const harness = createHarness({ deferContext: true });
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState(readyState(17));

    const pending = sendSidePanelRequest(harness, { type: "GUIDE_CAPTURE_CONTEXT", shareVisual: false });
    await vi.waitFor(() => expect(harness.tabMessages).toContainEqual({ type: "CONTENT_CAPTURE_CONTEXT" }));
    harness.windowFocusListeners[0]?.(8);
    harness.resolveContext();

    const response = await pending;
    expect(response).toMatchObject({ ok: false, pauseReason: "not-authorized" });
    expect(JSON.stringify(response)).not.toContain("snapshot-capture");
  });

  it("does not call captureVisibleTab when the exact active tab changes before capture", async () => {
    const harness = createHarness();
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState(readyState(17));

    const pending = sendSidePanelRequest(harness, { type: "GUIDE_CAPTURE_CONTEXT", shareVisual: true });
    await vi.waitFor(() => expect(harness.tabMessages).toContainEqual({ type: "CONTENT_PREPARE_SCREENSHOT" }));
    harness.setActiveTab(tab(99));

    await expect(pending).resolves.toMatchObject({ ok: false, pauseReason: "not-authorized" });
    expect(harness.captureVisibleTab).not.toHaveBeenCalled();
    expect(JSON.stringify(await pending)).not.toContain("data:image/jpeg");
  });

  it("discards captured pixels when the activation epoch changes before the post-check", async () => {
    const harness = createHarness({ deferScreenshot: true });
    vi.stubGlobal("chrome", harness.chromeStub);
    await import("../../src/extension/service-worker.js");
    harness.resolveState(readyState(17));

    const pending = sendSidePanelRequest(harness, { type: "GUIDE_CAPTURE_CONTEXT", shareVisual: true });
    await vi.waitFor(() => expect(harness.captureVisibleTab).toHaveBeenCalledTimes(1));
    harness.windowFocusListeners[0]?.(8);
    harness.resolveScreenshot();

    const response = await pending;
    expect(response).toMatchObject({ ok: false, pauseReason: "not-authorized" });
    expect(JSON.stringify(response)).not.toContain("data:image/jpeg");
    expect(harness.captureVisibleTab).toHaveBeenCalledWith(4, { format: "jpeg", quality: 60 }, expect.any(Function));
  });
});

function createHarness(options: HarnessOptions = {}): ServiceWorkerHarness {
  const runtimeMessageListeners: RuntimeMessageListener[] = [];
  const actionListeners: Array<(tab: chrome.tabs.Tab) => void> = [];
  const commandListeners: Array<(command: string) => void> = [];
  const tabUpdatedListeners: ServiceWorkerHarness["tabUpdatedListeners"] = [];
  const tabActivatedListeners: ServiceWorkerHarness["tabActivatedListeners"] = [];
  const tabRemovedListeners: ServiceWorkerHarness["tabRemovedListeners"] = [];
  const tabReplacedListeners: ServiceWorkerHarness["tabReplacedListeners"] = [];
  const windowFocusListeners: ServiceWorkerHarness["windowFocusListeners"] = [];
  const tabMessages: unknown[] = [];
  const storageWrites: unknown[] = [];
  const contextCallbacks: Array<(response: unknown) => void> = [];
  const screenshotCallbacks: Array<(dataUrl?: string) => void> = [];
  let stateCalls = 0;
  let queryCalls = 0;
  let activeTab = tab(17);
  let stateCallback: ((result: Record<string, unknown>) => void) | null = null;
  const executeScript = vi.fn((_injection, callback: () => void) => callback());
  const sidePanelOpen = vi.fn(() => Promise.resolve());
  const setPanelBehavior = vi.fn(() => Promise.resolve());
  const captureVisibleTab = vi.fn((
    _windowId: number,
    _options: chrome.extensionTypes.ImageDetails,
    callback: (dataUrl?: string) => void,
  ) => {
    if (options.deferScreenshot) screenshotCallbacks.push(callback);
    else callback("data:image/jpeg;base64,AAAA");
  });
  const inertEvent = { addListener: vi.fn() };
  const chromeStub = {
    runtime: {
      id: extensionId,
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      onInstalled: inertEvent,
      onMessage: { addListener: (listener: RuntimeMessageListener) => runtimeMessageListeners.push(listener) },
      sendMessage: (_message: unknown, callback?: () => void) => callback?.(),
      connectNative: vi.fn(),
    },
    action: {
      onClicked: { addListener: (listener: (currentTab: chrome.tabs.Tab) => void) => actionListeners.push(listener) },
      setBadgeBackgroundColor: vi.fn(),
      setBadgeText: vi.fn((_details, callback?: () => void) => callback?.()),
    },
    commands: {
      onCommand: { addListener: (listener: (command: string) => void) => commandListeners.push(listener) },
    },
    tabs: {
      onUpdated: { addListener: (listener: ServiceWorkerHarness["tabUpdatedListeners"][number]) => tabUpdatedListeners.push(listener) },
      onActivated: { addListener: (listener: ServiceWorkerHarness["tabActivatedListeners"][number]) => tabActivatedListeners.push(listener) },
      onRemoved: { addListener: (listener: ServiceWorkerHarness["tabRemovedListeners"][number]) => tabRemovedListeners.push(listener) },
      onReplaced: { addListener: (listener: ServiceWorkerHarness["tabReplacedListeners"][number]) => tabReplacedListeners.push(listener) },
      query: (_query: unknown, callback: (tabs: chrome.tabs.Tab[]) => void) => {
        queryCalls += 1;
        callback([activeTab]);
      },
      sendMessage: (_tabId: number, message: unknown, callback: (response: unknown) => void) => {
        tabMessages.push(message);
        if (isRecordWithType(message, "CONTENT_VALIDATE_SNAPSHOT")) {
          callback({ ok: true, valid: (message as { snapshotId?: unknown }).snapshotId === capturedPageContext.snapshotId });
        } else if (isRecordWithType(message, "CONTENT_CAPTURE_CONTEXT")) {
          if (options.deferContext) contextCallbacks.push(callback);
          else callback({ ok: true, context: capturedPageContext });
        } else if (isRecordWithType(message, "CONTENT_PREPARE_SCREENSHOT")) {
          callback({ ok: true, maskedElements: 0 });
        } else if (isRecordWithType(message, "CONTENT_VERIFY_SCREENSHOT_SHIELD")) {
          callback({ ok: true, valid: true });
        } else {
          callback({ ok: true, shownRefs: [] });
        }
      },
      captureVisibleTab,
    },
    windows: {
      onFocusChanged: { addListener: (listener: ServiceWorkerHarness["windowFocusListeners"][number]) => windowFocusListeners.push(listener) },
    },
    scripting: { executeScript },
    sidePanel: {
      setPanelBehavior,
      open: sidePanelOpen,
    },
    storage: {
      session: {
        get: (_key: string, callback: (result: Record<string, unknown>) => void) => {
          stateCalls += 1;
          stateCallback = callback;
        },
        set: (value: unknown, callback: () => void) => {
          storageWrites.push(value);
          callback();
        },
      },
    },
  } as unknown as typeof chrome;

  return {
    chromeStub,
    runtimeMessageListeners,
    actionListeners,
    commandListeners,
    tabUpdatedListeners,
    tabActivatedListeners,
    tabRemovedListeners,
    tabReplacedListeners,
    windowFocusListeners,
    tabMessages,
    storageWrites,
    executeScript,
    captureVisibleTab,
    sidePanelOpen,
    setPanelBehavior,
    getStateCalls: () => stateCalls,
    getQueryCalls: () => queryCalls,
    setActiveTab(nextTab) {
      activeTab = nextTab;
    },
    resolveContext(context = capturedPageContext) {
      const callback = contextCallbacks.shift();
      if (!callback) throw new Error("No page-context capture is pending.");
      callback({ ok: true, context });
    },
    resolveScreenshot(dataUrl = "data:image/jpeg;base64,AAAA") {
      const callback = screenshotCallbacks.shift();
      if (!callback) throw new Error("No screenshot capture is pending.");
      callback(dataUrl);
    },
    resolveState(state) {
      if (!stateCallback) throw new Error("Runtime state was not requested.");
      const callback = stateCallback;
      stateCallback = null;
      callback(state ? { [STATE_KEY]: state } : {});
    },
  };
}

function readyState(tabId: number, withSnapshot = false): ExtensionRuntimeState {
  return {
    status: "ready",
    tabId,
    authorizedOrigin: "https://fixture.test",
    refsValid: withSnapshot,
    ...(withSnapshot ? { latestSnapshotId: "snapshot-restored" } : {}),
  };
}

function tab(id: number, windowId = 4): chrome.tabs.Tab {
  return {
    id,
    windowId,
    url: "https://fixture.test/account",
  } as chrome.tabs.Tab;
}

function latestStoredState(harness: ServiceWorkerHarness): ExtensionRuntimeState {
  const write = harness.storageWrites.at(-1);
  if (!write || typeof write !== "object" || !(STATE_KEY in write)) {
    throw new Error("No runtime state was stored.");
  }
  return (write as Record<string, ExtensionRuntimeState>)[STATE_KEY] as ExtensionRuntimeState;
}

function sendSidePanelRequest(harness: ServiceWorkerHarness, message: unknown): Promise<unknown> {
  const listener = harness.runtimeMessageListeners[0];
  if (!listener) throw new Error("Service worker runtime listener was not installed.");
  return new Promise((resolve) => {
    const asynchronous = listener(message, { id: extensionId, url: sidePanelUrl }, resolve);
    expect(asynchronous).toBe(true);
  });
}

function isRecordWithType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value
    && (value as { type?: unknown }).type === type;
}
