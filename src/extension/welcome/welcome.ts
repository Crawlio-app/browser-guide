import { isHostConfigureResponse, isHostHealthResponse } from "../../shared/native-protocol.js";
import { isRecord } from "../../shared/protocol.js";

type HelperState = "checking" | "permission" | "missing" | "done";
type KeyState = "waiting" | "missing" | "done";
type MicState = "checking" | "intro" | "denied" | "missing" | "done";

const GUIDE_URL = "https://browser-guide-docs.vercel.app";
const REDIRECT_DELAY_MS = 1_400;

let helperState: HelperState = "checking";
let keyState: KeyState = "waiting";
let micState: MicState = "checking";
let micAnnounced = false;
let micStatus: PermissionStatus | null = null;
let helperWasIncomplete = false;
let redirectTimer: number | null = null;

const helperStep = query("#step-helper");
const keyStep = query("#step-key");
const micStep = query("#step-mic");
const finish = query("#finish");
const helperAllow = query<HTMLButtonElement>("#helper-allow");
const helperRecheck = query<HTMLButtonElement>("#helper-recheck");
const helperError = query("#helper-error");
const keyForm = query<HTMLFormElement>("#key-form");
const keyInput = query<HTMLInputElement>("#wizard-key");
const keySave = query<HTMLButtonElement>("#key-save");
const keyError = query("#key-error");
const micEnable = query<HTMLButtonElement>("#mic-enable");
const micRetry = query<HTMLButtonElement>("#mic-retry");
const micHint = query("#mic-hint");
const micAddressRow = query("#mic-address-row");
const settingsAddress = query("#settings-address");
const copyAddress = query<HTMLButtonElement>("#copy-address");
const redirectNote = query("#redirect-note");

settingsAddress.textContent = "chrome://settings/content/siteDetails?site=" + encodeURIComponent(location.origin);

helperAllow.addEventListener("click", () => {
  void requestHelperPermission();
});
helperRecheck.addEventListener("click", () => {
  void refreshHelper();
});
keyInput.addEventListener("input", () => {
  keySave.disabled = keyInput.value.trim().length === 0;
});
keyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveKey();
});
micEnable.addEventListener("click", () => {
  void requestMicrophone();
});
micRetry.addEventListener("click", () => {
  void requestMicrophone();
});
copyAddress.addEventListener("click", () => {
  const address = settingsAddress.textContent ?? "";
  void navigator.clipboard.writeText(address).then(() => {
    copyAddress.textContent = "Copied";
    window.setTimeout(() => {
      copyAddress.textContent = "Copy";
    }, 1_600);
  }).catch(() => undefined);
});

if (location.hash === "#microphone") micStep.classList.add("spotlight");

void refreshHelper();
void refreshMicrophone();

async function refreshHelper(): Promise<void> {
  setHelper("checking");
  setError(helperError, null);
  try {
    const response = await withDeadline(runtimeSend<unknown>({ type: "GUIDE_HOST_HEALTH" }), 10_000);
    if (isHostHealthResponse(response) && response.ok) {
      setKey(response.health.configured === true ? "done" : "missing");
      setHelper("done");
      return;
    }
    const code = isRecord(response) && typeof response.code === "string" ? response.code : "";
    if (code === "PERMISSION_REQUIRED") {
      setHelper("permission");
      setKey("waiting");
      return;
    }
    if (code === "NOT_CONFIGURED" || code === "INVALID_API_KEY" || code === "SECURE_STORAGE_ERROR") {
      setKey("missing");
      setHelper("done");
      return;
    }
    setHelper("missing");
    setKey("waiting");
    setError(helperError, describeFailure(code, response));
  } catch (error) {
    setHelper("missing");
    setKey("waiting");
    setError(helperError, error instanceof Error && error.message
      ? "Chrome reported: " + error.message.slice(0, 300)
      : "The helper check did not finish.");
  }
}

async function requestHelperPermission(): Promise<void> {
  setError(helperError, null);
  const granted = await new Promise<boolean>((resolve) => {
    chrome.permissions.request({ permissions: ["nativeMessaging"] }, (result) => {
      const error = chrome.runtime.lastError;
      resolve(error ? false : result);
    });
  });
  if (!granted) {
    setError(helperError, "Chrome needs this one-time permission before Browser Guide can reach the helper.");
    return;
  }
  await refreshHelper();
}

async function saveKey(): Promise<void> {
  const key = keyInput.value.trim();
  setError(keyError, null);
  if (key.length < 20 || key.length > 600) {
    setError(keyError, "Paste a valid OpenAI Platform API key.");
    return;
  }
  keyInput.value = "";
  keySave.disabled = true;
  keySave.textContent = "Saving…";
  try {
    const response = await withDeadline(
      runtimeSend<unknown>({ type: "GUIDE_HOST_CONFIGURE_KEY", key }),
      10_000,
    );
    if (!isHostConfigureResponse(response) || !response.ok) {
      throw new Error(isRecord(response) && typeof response.error === "string"
        ? response.error.slice(0, 300)
        : "The key could not be saved to Keychain.");
    }
    setKey("done");
  } catch (error) {
    setError(keyError, error instanceof Error && error.message ? error.message : "The key could not be saved to Keychain.");
  } finally {
    keySave.textContent = "Save to Keychain";
  }
}

async function refreshMicrophone(): Promise<void> {
  try {
    if (!micStatus) {
      micStatus = await navigator.permissions.query({ name: "microphone" as PermissionName });
      micStatus.addEventListener("change", () => {
        void applyMicrophoneStatus();
      });
    }
    await applyMicrophoneStatus();
  } catch {
    setMic("intro");
  }
}

async function applyMicrophoneStatus(): Promise<void> {
  const state = micStatus?.state;
  if (state === "granted") markMicReady();
  else if (state === "denied") setMic("denied");
  else setMic("intro");
}

async function requestMicrophone(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    markMicReady();
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotFoundError" || name === "OverconstrainedError") setMic("missing");
    else setMic("denied");
  }
}

function markMicReady(): void {
  if (!micAnnounced) {
    micAnnounced = true;
    try {
      chrome.runtime.sendMessage({ type: "GUIDE_MIC_READY" }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // The panel may simply not be open; readiness still shows here.
    }
  }
  setMic("done");
}

function setHelper(state: HelperState): void {
  // "checking" always precedes "done", so only a state the user had to act on
  // counts as an incomplete visit — otherwise reopening the wizard from
  // Options would bounce straight to the guide.
  if (state === "permission" || state === "missing") helperWasIncomplete = true;
  helperState = state;
  helperStep.dataset.state = state;
  showLines(helperStep, state);
  helperAllow.hidden = state !== "permission" && state !== "missing";
  helperRecheck.hidden = state !== "missing";
  render();
  maybeAdvanceToGuide();
}

function setKey(state: KeyState): void {
  keyState = state;
  keyStep.dataset.state = state;
  showLines(keyStep, state);
  keyForm.hidden = state !== "missing";
  if (state === "missing") keySave.disabled = keyInput.value.trim().length === 0;
  render();
}

function setMic(state: MicState): void {
  micState = state;
  micStep.dataset.state = state;
  showLines(micStep, state);
  micEnable.hidden = state !== "intro";
  micRetry.hidden = state !== "denied" && state !== "missing";
  micAddressRow.hidden = state !== "denied";
  micHint.hidden = state !== "denied";
  render();
}

function render(): void {
  const helperDone = helperState === "done";
  mark(helperStep, helperDone, !helperDone);
  mark(micStep, micState === "done", helperDone && micState !== "done");
  mark(keyStep, keyState === "done", false);
  finish.dataset.ready = helperDone ? "true" : "false";
}

// The crawlio funnel: the moment the required permission is granted, hand the
// user to the hosted guide. Only fires when the grant happened during THIS
// visit, and never on the #microphone deep link from the side panel.
function maybeAdvanceToGuide(): void {
  if (helperState !== "done" || !helperWasIncomplete) return;
  if (location.hash === "#microphone") return;
  if (redirectTimer !== null) return;
  redirectNote.hidden = false;
  redirectTimer = window.setTimeout(() => {
    window.location.href = GUIDE_URL + "/?from=extension";
  }, REDIRECT_DELAY_MS);
}

function mark(step: HTMLElement, done: boolean, current: boolean): void {
  step.classList.toggle("done", done);
  step.classList.toggle("current", current && !done);
}

function showLines(step: HTMLElement, state: string): void {
  for (const line of step.querySelectorAll<HTMLElement>("[data-when]")) {
    line.hidden = line.dataset.when !== state;
  }
}

function describeFailure(code: string, response: unknown): string {
  const message = isRecord(response) && typeof response.error === "string"
    ? response.error.slice(0, 300)
    : "The helper did not answer.";
  return code ? code + " — " + message : message;
}

function setError(element: HTMLElement, message: string | null): void {
  element.hidden = message === null;
  element.textContent = message ?? "";
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Missing wizard element: " + selector);
  return element;
}

function runtimeSend<T = unknown>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("The local helper did not answer in time.")),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
