import { parseGuidanceCommand } from "../shared/assistant-contract.js";
import {
  isExtensionRuntimeState,
  isGuidanceResponse,
  isRecord,
  isSidePanelRequest,
  type CaptureResponse,
  type ContentRequest,
  type ExtensionRuntimeState,
  type GuidanceResponse,
  type PermissionPauseReason,
  type ServiceWorkerEvent,
  type SidePanelRequest,
} from "../shared/protocol.js";
import { sanitizePageContext } from "../shared/sanitization.js";
import { isPageContext, type PageContext, type VisualOmissionReason } from "../shared/page-context.js";
import { assessActiveTabAccess, webOrigin } from "../shared/access-state.js";
import {
  isHostBridgeRequest,
  type HostBridgeRequest,
  type HostClientResponse,
  type NativeHealthData,
} from "../shared/native-protocol.js";
import { NativeHostClient, toHostClientFailure } from "./native-host-client.js";

const STATE_KEY = "browserGuideRuntimeStateV1";
const ENGINE_PREFERENCE_KEY = "browserGuideEnginePreferenceV1";
const MAX_SCREENSHOT_DATA_URL_BYTES = 1_500_000;
const SCREENSHOT_QUALITY_STEPS = [60, 42, 28] as const;
const CONTENT_RUNTIME_PROBE_SNAPSHOT_ID = "browser-guide-runtime-probe";
const DEFAULT_STATE: ExtensionRuntimeState = {
  status: "permission-paused",
  pauseReason: "not-authorized",
  refsValid: false,
};
let runtimeState: ExtensionRuntimeState = DEFAULT_STATE;
let visibleTabActivationEpoch = 0;
const nativeHost = new NativeHostClient();
const stateReady = loadState().catch((error: unknown) => {
  runtimeState = DEFAULT_STATE;
  const description = error instanceof Error ? error.message : "unknown Chrome storage error";
  console.error("[ServiceWorker] Could not restore runtime state: " + description);
});

void configurePanelLaunch();
void prewarmNativeHost();

chrome.runtime.onInstalled.addListener((details) => {
  void configurePanelLaunch();
  if (details.reason !== "install") return;
  chrome.action.setBadgeBackgroundColor({ color: "#48e9c1" }, () => {
    void chrome.runtime.lastError;
  });
  chrome.action.setBadgeText({ text: "NEW" }, () => {
    void chrome.runtime.lastError;
  });
  // The onboarding wizard is the options page, so opening it needs no tab APIs.
  chrome.runtime.openOptionsPage(() => {
    void chrome.runtime.lastError;
  });
});

chrome.action.onClicked.addListener((tab) => {
  // Open synchronously inside the click so the user-gesture requirement holds.
  if (tab.windowId !== undefined) void openSidePanel(tab.windowId);
  void handleExplicitActivation(tab, false);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-listening" && command !== "start-voice") return;
  void handleToggleListeningCommand();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isRecord(message) && message.type === "GUIDE_REFS_INVALIDATED") {
    void handleRefsInvalidated(message, sender);
    return false;
  }
  if (!isOwnSidePanelSender(sender)) return false;
  if (isHostBridgeRequest(message)) {
    handleHostBridgeRequest(message).then(sendResponse).catch((error: unknown) => {
      sendResponse(toHostClientFailure(error));
    });
    return true;
  }
  if (!isSidePanelRequest(message)) return false;
  handleSidePanelRequest(message).then(sendResponse).catch((error: unknown) => {
    const description = error instanceof Error ? error.message : "Browser Guide request failed";
    sendResponse({ ok: false, error: description });
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  advanceVisibleTabActivationEpoch();
  void handleTabActivated(tabId);
});

chrome.windows.onFocusChanged.addListener(() => {
  advanceVisibleTabActivationEpoch();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  void handleTabReplaced(removedTabId);
});

async function handleToggleListeningCommand(): Promise<void> {
  await ensureStateLoaded();
  try {
    const tab = await getActiveTab();
    if (tab.windowId !== undefined) await openSidePanel(tab.windowId);
    await handleExplicitActivation(tab, true);
  } catch {
    await pause("not-authorized");
  }
}

async function handleRefsInvalidated(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  await ensureStateLoaded();
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.tab.id !== runtimeState.tabId
    || (message.snapshotId !== undefined && typeof message.snapshotId !== "string")
    || (message.snapshotId !== undefined && runtimeState.latestSnapshotId !== undefined
      && message.snapshotId !== runtimeState.latestSnapshotId)) return;
  await updateState({ refsValid: false, latestSnapshotId: undefined });
  await broadcastState();
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  await ensureStateLoaded();
  if (tabId !== runtimeState.tabId || (changeInfo.status !== "loading" && !changeInfo.url)) return;
  const nextUrl = changeInfo.url ?? tab.url;
  const nextOrigin = nextUrl ? webOrigin(nextUrl) : null;
  if (!nextOrigin || nextOrigin !== runtimeState.authorizedOrigin) {
    await pause("origin-changed");
    return;
  }
  await invalidatePageRuntime(tabId);
}

async function handleTabActivated(tabId: number): Promise<void> {
  await ensureStateLoaded();
  if (runtimeState.tabId !== undefined && tabId === runtimeState.tabId) {
    // Coming back to the tab that was already shared. The grant did not go
    // anywhere, so neither should the session: leaving it paused made
    // switching tabs feel like losing the page, and nothing on screen said
    // that returning was enough to fix it.
    if (runtimeState.status === "permission-paused") await resumeIfStillAuthorized();
    return;
  }
  // "Restricted page" describes a tab, and this activation just left that
  // tab. Keeping the verdict made it a trap: click the icon once on
  // chrome://extensions and every tab afterwards said Chrome does not allow
  // guidance, with no way out on screen. On any other tab the truth is
  // simply "not shared yet", whose banner says what to do about it.
  if (runtimeState.pauseReason === "restricted-page") {
    await pause("not-authorized");
    return;
  }
  if (runtimeState.tabId === undefined) return;
  await pause("not-authorized");
}

async function handleTabRemoved(tabId: number): Promise<void> {
  await ensureStateLoaded();
  if (tabId !== runtimeState.tabId) return;
  advanceVisibleTabActivationEpoch();
  await pause("access-lost");
}

async function handleTabReplaced(removedTabId: number): Promise<void> {
  await ensureStateLoaded();
  if (removedTabId !== runtimeState.tabId) return;
  advanceVisibleTabActivationEpoch();
  await pause("access-lost");
}

async function handleExplicitActivation(tab: chrome.tabs.Tab, toggleListening: boolean): Promise<void> {
  await ensureStateLoaded();
  const origin = tab.url ? webOrigin(tab.url) : null;
  if (tab.id === undefined || tab.windowId === undefined || !origin) {
    await pause("restricted-page");
    return;
  }
  await updateState({
    status: "ready",
    tabId: tab.id,
    authorizedOrigin: origin,
    pauseReason: undefined,
    refsValid: false,
    latestSnapshotId: undefined,
  });
  markSharedTab(tab.id, true);
  chrome.action.setBadgeText({ text: "" }, () => {
    void chrome.runtime.lastError;
  });
  await broadcastState();
  if (toggleListening) {
    globalThis.setTimeout(() => {
      broadcast({ type: "GUIDE_TOGGLE_LISTENING" });
    }, 120);
  }
}

let healthInFlight: Promise<NativeHealthData> | null = null;

/**
 * One health check at a time, shared by everyone who asks.
 *
 * Installing fires three at once: this worker warms the helper up, the welcome
 * page checks, and the side panel checks. They are the same question, they go
 * down the same port, and they arrive in the noisiest moment of the
 * extension's life. Asking once is both cheaper and steadier.
 */
function sharedHealth(): Promise<NativeHealthData> {
  if (healthInFlight) return healthInFlight;
  const request = nativeHost.health().finally(() => {
    if (healthInFlight === request) healthInFlight = null;
  });
  healthInFlight = request;
  return request;
}

async function prewarmNativeHost(): Promise<void> {
  // The first Keychain read after a helper update runs a slow signature
  // evaluation. Doing it here keeps that latency out of the user's first
  // panel or wizard interaction. Every failure mode is expected and silent.
  try {
    await sharedHealth();
  } catch {
    // Warmup only; real requests surface their own state.
  }
}

function openSidePanel(windowId: number): Promise<void> {
  return chrome.sidePanel.open({ windowId }).catch((error: unknown) => {
    const description = error instanceof Error ? error.message : "unknown Chrome error";
    console.error("[ServiceWorker] Could not open the side panel: " + description);
  });
}

async function configurePanelLaunch(): Promise<void> {
  try {
    // The activation contract lives in chrome.action.onClicked; Chrome does not
    // dispatch that event while openPanelOnActionClick is handling the click.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (error) {
    const description = error instanceof Error ? error.message : "unknown Chrome error";
    console.error("[ServiceWorker] Could not configure the toolbar side-panel behavior: " + description);
  }
}

async function handleSidePanelRequest(message: SidePanelRequest): Promise<unknown> {
  await ensureStateLoaded();
  switch (message.type) {
    case "GUIDE_GET_STATE":
      return { ok: true, state: runtimeState };
    // Session storage on purpose: nothing this extension writes to Chrome
    // survives a browser restart, and that is a claim worth keeping intact
    // for one preference. The cost is honest and small: after a restart the
    // default engine answers until someone flips the chip again.
    case "GUIDE_ENGINE_PREFERENCE_GET": {
      const stored = await chrome.storage.session.get(ENGINE_PREFERENCE_KEY);
      const engine = stored[ENGINE_PREFERENCE_KEY];
      return { ok: true, engine: engine === "claude" || engine === "realtime" ? engine : null };
    }
    case "GUIDE_ENGINE_PREFERENCE_SET":
      await chrome.storage.session.set({ [ENGINE_PREFERENCE_KEY]: message.engine });
      return { ok: true, engine: message.engine };
    case "GUIDE_CAPTURE_CONTEXT":
      return captureContext(message.shareVisual);
    case "GUIDE_SHOW_GUIDANCE":
      return showGuidance(message.snapshotId, message.command);
    case "GUIDE_CLEAR_GUIDANCE":
      return relayIfAvailable({ type: "CONTENT_CLEAR_GUIDANCE" });
    case "GUIDE_END_SESSION": {
      const response = await relayIfAvailable({ type: "CONTENT_END_SESSION" });
      await updateState({ refsValid: false, latestSnapshotId: undefined });
      await broadcastState();
      return response;
    }
    case "GUIDE_RESUME_REQUEST":
      return resumeIfStillAuthorized();
  }
}

async function handleHostBridgeRequest(message: HostBridgeRequest): Promise<HostClientResponse> {
  try {
    switch (message.type) {
      case "GUIDE_HOST_HEALTH":
        return { ok: true, health: await sharedHealth() };
      case "GUIDE_HOST_CONFIGURE_KEY": {
        const result = await nativeHost.configure(message.key);
        return { ok: true, configured: result.configured };
      }
      case "GUIDE_HOST_FORGET_KEY": {
        const result = await nativeHost.forget();
        return { ok: true, configured: result.configured };
      }
      case "GUIDE_HOST_IMPORT_CREDENTIALS": {
        const result = await nativeHost.importCredentials(message.provider);
        return {
          ok: true,
          imported: result.imported,
          provider: result.provider,
          method: result.method,
          configured: result.configured,
          ...(result.account ? { account: result.account } : {}),
        };
      }
      case "GUIDE_HOST_CREDENTIAL_SOURCES": {
        const result = await nativeHost.credentialSources();
        return { ok: true, sources: result.sources };
      }
      case "GUIDE_HOST_MEMORY_GET": {
        const result = await nativeHost.memoryGet(message.origin);
        return { ok: true, notes: result.notes };
      }
      case "GUIDE_HOST_MEMORY_APPEND": {
        const result = await nativeHost.memoryAppend(message.origin, message.question, message.answer);
        return { ok: true, stored: result.stored };
      }
      case "GUIDE_HOST_MEMORY_CLEAR": {
        const result = await nativeHost.memoryClear(message.origin);
        return { ok: true, cleared: result.cleared };
      }
      case "GUIDE_HOST_PUBLISH_EVIDENCE": {
        const result = await nativeHost.publishEvidence(message.origin, message.title, message.evidence);
        return { ok: true, published: result.published };
      }
      case "GUIDE_HOST_CLEAR_EVIDENCE": {
        const result = await nativeHost.clearEvidence();
        return { ok: true, cleared: result.cleared };
      }
      case "GUIDE_HOST_TRANSCRIBE": {
        const result = await nativeHost.transcribe(message.audio, message.locale, message.locales);
        return { ok: true, transcript: result.transcript };
      }
      case "GUIDE_HOST_COMPLETE": {
        const result = await nativeHost.complete(message.messages);
        return { ok: true, content: result.content, stopReason: result.stopReason };
      }
      case "GUIDE_HOST_CREATE_SESSION": {
        const result = await nativeHost.createSession(message.sdp, message.mode);
        return {
          ok: true,
          answerSdp: result.answerSdp,
          ...(result.upstreamRequestId ? { upstreamRequestId: result.upstreamRequestId } : {}),
        };
      }
      case "GUIDE_HOST_DISCONNECT":
        nativeHost.disconnect();
        return { ok: true };
    }
  } catch (error) {
    return toHostClientFailure(error);
  }
}

async function captureContext(shareVisual: boolean): Promise<CaptureResponse> {
  const tab = await getActiveTab();
  const accessFailure = validateTabAccess(tab);
  if (accessFailure) {
    await pause(accessFailure);
    return { ok: false, error: "Page access paused. Use the Browser Guide toolbar icon to resume on this site.", pauseReason: accessFailure };
  }
  const tabId = tab.id as number;
  try {
    const tabCaptureBinding = bindActiveTabCapture(tab);
    await ensureContentRuntime(tabId);
    const contentResponse = await sendToTab<unknown>(
      tabId,
      { type: "CONTENT_CAPTURE_CONTEXT" },
    );
    if (!isRecord(contentResponse) || contentResponse.ok !== true || !isPageContext(contentResponse.context)) {
      const error = isRecord(contentResponse) && typeof contentResponse.error === "string"
        ? contentResponse.error.slice(0, 1_000)
        : "The page view could not be captured.";
      return { ok: false, error };
    }
    let context = contentResponse.context;
    if (!shareVisual) {
      context = withVisualOmission(context, "not-requested");
    } else {
      let shieldPrepared = false;
      try {
        const shield = await sendToTab<unknown>(tabId, { type: "CONTENT_PREPARE_SCREENSHOT" });
        if (!isRecord(shield) || shield.ok !== true) {
          context = withVisualOmission(context, "privacy-protection");
        } else {
          shieldPrepared = true;
          try {
            await nextPaint();
            if (!await screenshotShieldIsValid(tabId)) {
              context = withVisualOmission(context, "privacy-protection");
            } else {
              const screenshotDataUrl = await captureVisibleTab(tabCaptureBinding);
              if (!await screenshotShieldIsValid(tabId)) {
                context = withVisualOmission(context, "privacy-protection");
              } else {
                await assertActiveTabCaptureBinding(tabCaptureBinding);
                const { visualOmission: _visualOmission, ...contextWithoutOmission } = context;
                context = { ...contextWithoutOmission, screenshotDataUrl };
              }
            }
          } catch (error) {
            if (error instanceof ActiveTabBindingChangedError) throw error;
            context = withVisualOmission(context, "capture-failed");
          }
        }
      } catch (error) {
        if (error instanceof ActiveTabBindingChangedError) throw error;
        context = withVisualOmission(context, "privacy-protection");
      } finally {
        if (shieldPrepared) {
          await sendToTab(tabId, { type: "CONTENT_FINISH_SCREENSHOT" }).catch(() => undefined);
        }
      }
    }
    context = sanitizePageContext(context);
    const freshness = await sendToTab<unknown>(tabId, {
      type: "CONTENT_VALIDATE_SNAPSHOT",
      snapshotId: context.snapshotId,
    });
    if (!isRecord(freshness) || freshness.ok !== true || freshness.valid !== true) {
      return { ok: false, error: "The page changed while Browser Guide was reading it. Try the fresh view again." };
    }
    await assertActiveTabCaptureBinding(tabCaptureBinding);
    await updateState({
      status: "ready",
      pauseReason: undefined,
      refsValid: true,
      latestSnapshotId: context.snapshotId,
    });
    await assertActiveTabCaptureBinding(tabCaptureBinding);
    await broadcastState();
    await assertActiveTabCaptureBinding(tabCaptureBinding);
    return { ok: true, context };
  } catch (error) {
    const pauseReason: PermissionPauseReason = error instanceof ActiveTabBindingChangedError
      ? "not-authorized"
      : "access-lost";
    await pause(pauseReason);
    return {
      ok: false,
      error: pauseReason === "not-authorized"
        ? "The active tab or window changed before the page view was captured. Use the Browser Guide toolbar icon to resume."
        : "Browser Guide no longer has access to this page. Use the toolbar icon to resume.",
      pauseReason,
    };
  }
}

async function screenshotShieldIsValid(tabId: number): Promise<boolean> {
  const response = await sendToTab<unknown>(tabId, { type: "CONTENT_VERIFY_SCREENSHOT_SHIELD" });
  return isRecord(response) && response.ok === true && response.valid === true;
}

async function showGuidance(snapshotId: string, rawCommand: unknown): Promise<GuidanceResponse> {
  if (!runtimeState.refsValid || runtimeState.latestSnapshotId !== snapshotId) {
    return { ok: false, error: "Guidance rejected because the page refs are stale." };
  }
  if (!isRecord(rawCommand) || typeof rawCommand.name !== "string") return { ok: false, error: "Invalid guidance command." };
  const command = parseGuidanceCommand(rawCommand.name, rawCommand);
  if (!command) return { ok: false, error: "Model tool validation failed." };
  if (command.name === "clear_guidance") {
    return relayIfAvailable({ type: "CONTENT_CLEAR_GUIDANCE" });
  }
  if (runtimeState.tabId === undefined) return { ok: false, error: "No authorized tab." };
  const response = await sendToTab<unknown>(runtimeState.tabId, { type: "CONTENT_SHOW_GUIDANCE", snapshotId, command });
  return isGuidanceResponse(response) ? response : { ok: false, error: "The page returned an invalid guidance response." };
}

async function resumeIfStillAuthorized(): Promise<{ ok: boolean; state: ExtensionRuntimeState; error?: string }> {
  const tab = await getActiveTab();
  if (tab.id === undefined || tab.url === undefined) {
    // Without an activeTab grant Chrome hides the URL entirely; that is a
    // missing toolbar gesture, not a restricted page.
    await pause("not-authorized");
    return {
      ok: false,
      state: runtimeState,
      error: "Click the Browser Guide toolbar icon once to share this page.",
    };
  }
  const origin = webOrigin(tab.url);
  if (!origin) {
    await pause("restricted-page");
    return { ok: false, state: runtimeState, error: "This page cannot be shared." };
  }
  try {
    await ensureContentRuntime(tab.id);
    await updateState({
      status: "ready",
      tabId: tab.id,
      authorizedOrigin: origin,
      pauseReason: undefined,
      refsValid: false,
      latestSnapshotId: undefined,
    });
    markSharedTab(tab.id, true);
    await broadcastState();
    return { ok: true, state: runtimeState };
  } catch {
    await pause("not-authorized");
    return {
      ok: false,
      state: runtimeState,
      error: "Click the Browser Guide toolbar icon once to grant temporary access to this site.",
    };
  }
}

function validateTabAccess(tab: chrome.tabs.Tab): PermissionPauseReason | null {
  return assessActiveTabAccess(runtimeState, { tabId: tab.id, rawUrl: tab.url });
}

async function ensureContentRuntime(tabId: number): Promise<void> {
  try {
    await probeContentRuntime(tabId);
    return;
  } catch {
    await executeContentScript(tabId);
  }
  await probeContentRuntime(tabId);
}

async function probeContentRuntime(tabId: number): Promise<void> {
  const response = await sendToTab<unknown>(tabId, {
    type: "CONTENT_VALIDATE_SNAPSHOT",
    snapshotId: CONTENT_RUNTIME_PROBE_SNAPSHOT_ID,
  });
  if (!isRecord(response) || response.ok !== true || typeof response.valid !== "boolean") {
    throw new Error("The content runtime returned an invalid readiness response.");
  }
}

function executeContentScript(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sendToTab<T = GuidanceResponse>(tabId: number, message: ContentRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function relayIfAvailable(message: ContentRequest): Promise<GuidanceResponse> {
  if (runtimeState.tabId === undefined) return { ok: true, shownRefs: [] };
  try {
    const response = await sendToTab<unknown>(runtimeState.tabId, message);
    return isGuidanceResponse(response) ? response : { ok: false, error: "The page returned an invalid guidance response." };
  } catch {
    return { ok: true, shownRefs: [] };
  }
}

interface ActiveTabCaptureBinding {
  tabId: number;
  windowId: number;
  activationEpoch: number;
}

class ActiveTabBindingChangedError extends Error {
  constructor() {
    super("The active tab or window changed during visual capture.");
    this.name = "ActiveTabBindingChangedError";
  }
}

function advanceVisibleTabActivationEpoch(): void {
  visibleTabActivationEpoch = (visibleTabActivationEpoch + 1) % Number.MAX_SAFE_INTEGER;
}

function bindActiveTabCapture(tab: chrome.tabs.Tab): ActiveTabCaptureBinding {
  if (tab.id === undefined || tab.windowId === undefined) throw new ActiveTabBindingChangedError();
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    activationEpoch: visibleTabActivationEpoch,
  };
}

async function assertActiveTabCaptureBinding(binding: ActiveTabCaptureBinding): Promise<void> {
  if (binding.activationEpoch !== visibleTabActivationEpoch) throw new ActiveTabBindingChangedError();
  const activeTab = await getActiveTab();
  if (binding.activationEpoch !== visibleTabActivationEpoch
    || activeTab.id !== binding.tabId
    || activeTab.windowId !== binding.windowId
    || runtimeState.status !== "ready"
    || runtimeState.tabId !== binding.tabId) {
    throw new ActiveTabBindingChangedError();
  }
}

async function captureVisibleTab(binding: ActiveTabCaptureBinding): Promise<string> {
  for (const quality of SCREENSHOT_QUALITY_STEPS) {
    await assertActiveTabCaptureBinding(binding);
    const dataUrl = await captureVisibleTabAtQuality(binding.windowId, quality);
    await assertActiveTabCaptureBinding(binding);
    if (isBoundedJpegDataUrl(dataUrl)) return dataUrl;
  }
  throw new Error("Chrome returned an oversized screenshot at every allowed quality.");
}

function captureVisibleTabAtQuality(windowId: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (typeof dataUrl !== "string") reject(new Error("Chrome did not return a screenshot."));
      else resolve(dataUrl);
    });
  });
}

function withVisualOmission(context: PageContext, reason: VisualOmissionReason): PageContext {
  const { screenshotDataUrl: _screenshotDataUrl, ...contextWithoutScreenshot } = context;
  return { ...contextWithoutScreenshot, visualOmission: { omitted: true, reason } };
}

function isBoundedJpegDataUrl(value: string): boolean {
  return value.startsWith("data:image/jpeg;base64,")
    && new TextEncoder().encode(value).byteLength <= MAX_SCREENSHOT_DATA_URL_BYTES
    && /^[A-Za-z0-9+/=]+$/.test(value.slice("data:image/jpeg;base64,".length));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 50));
}

function getActiveTab(): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!tabs[0]) reject(new Error("No active tab."));
      else resolve(tabs[0]);
    });
  });
}

async function loadState(): Promise<void> {
  const stored = await new Promise<unknown>((resolve) => {
    chrome.storage.session.get(STATE_KEY, (result) => {
      const error = chrome.runtime.lastError;
      resolve(error ? undefined : result[STATE_KEY]);
    });
  });
  runtimeState = isExtensionRuntimeState(stored) ? stored : DEFAULT_STATE;
}

async function ensureStateLoaded(): Promise<void> {
  await stateReady;
}

async function updateState(patch: Partial<ExtensionRuntimeState>): Promise<void> {
  await ensureStateLoaded();
  runtimeState = { ...runtimeState, ...patch };
  for (const [key, value] of Object.entries(runtimeState)) {
    if (value === undefined) delete (runtimeState as unknown as Record<string, unknown>)[key];
  }
  await new Promise<void>((resolve) => {
    chrome.storage.session.set({ [STATE_KEY]: runtimeState }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/**
 * Marks the shared tab in the toolbar, so which page is being read is visible
 * from the tab strip rather than only inside the panel. Claude in Chrome makes
 * the same thing visible by putting the tab it has taken into a named group;
 * a per-tab badge says the same thing without asking for a new permission.
 */
/**
 * Puts the shared tab in a named, coloured group, which is how Claude in
 * Chrome shows which tab it has taken. Nothing is grouped until a tab is
 * actually shared, and the group is dissolved the moment it is not.
 */
function groupSharedTab(tabId: number, shared: boolean): void {
  try {
    if (!shared) {
      chrome.tabs.ungroup?.(tabId, () => {
        void chrome.runtime.lastError;
      });
      return;
    }
    chrome.tabs.group?.({ tabIds: tabId }, (groupId) => {
      if (chrome.runtime.lastError || groupId === undefined) {
        void chrome.runtime.lastError;
        return;
      }
      chrome.tabGroups?.update?.(groupId, { title: "Browser Guide", color: "blue" }, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch {
    // Grouping is a courtesy; the badge below still says which tab it is.
  }
}

function markSharedTab(tabId: number | undefined, shared: boolean): void {
  if (tabId === undefined) return;
  groupSharedTab(tabId, shared);
  // Every call here is decoration. A tab that closed mid-update, or a Chrome
  // build without one of these, must never be able to fail an activation.
  try {
    chrome.action.setBadgeText?.({ tabId, text: shared ? "●" : "" }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setTitle?.({
      tabId,
      title: shared ? "Browser Guide is reading this tab" : "Browser Guide",
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The marker is unavailable; sharing itself is unaffected.
  }
}

async function pause(reason: PermissionPauseReason): Promise<void> {
  await ensureStateLoaded();
  markSharedTab(runtimeState.tabId, false);
  if (runtimeState.tabId !== undefined) await disposeContentRuntime(runtimeState.tabId);
  await updateState({
    status: "permission-paused",
    pauseReason: reason,
    refsValid: false,
    latestSnapshotId: undefined,
  });
  await broadcastState();
}

async function invalidatePageRuntime(tabId: number): Promise<void> {
  await ensureStateLoaded();
  await disposeContentRuntime(tabId);
  await updateState({ refsValid: false, latestSnapshotId: undefined });
  await broadcastState();
}

async function disposeContentRuntime(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, { type: "CONTENT_END_SESSION" });
  } catch {
    // Missing access or an unloaded document is already a disposed page runtime.
  }
}

function broadcastState(): Promise<void> {
  return broadcast({ type: "GUIDE_RUNTIME_STATE", state: runtimeState });
}

function broadcast(event: ServiceWorkerEvent): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(event, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function isOwnSidePanelSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.url === undefined) return false;
  const url = sender.url.split("#", 1)[0];
  return url === chrome.runtime.getURL("sidepanel.html")
    || url === chrome.runtime.getURL("welcome.html");
}
