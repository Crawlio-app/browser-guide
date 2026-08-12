import { isHostHealthResponse } from "../../shared/native-protocol.js";
import { isRecord } from "../../shared/protocol.js";

const GUIDE_URL = "https://docs.crawlio.app/browser-guide/overview";
const ALL_SET_DELAY_MS = 1_400;

/** Human labels for every optional capability this build can declare. The
 *  modal list derives from the live manifest so a new permission can never
 *  ship without a matching line of consent copy. */
const PERMISSION_LABELS: Record<string, string> = {
  nativeMessaging: "Confirm the local Keychain helper is genuine",
};

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing wizard element: #" + id);
  return element as T;
}

const connectCard = requiredElement<HTMLDivElement>("connect-card");
const micCard = requiredElement<HTMLDivElement>("mic-card");
const connectTitle = requiredElement<HTMLHeadingElement>("connect-title");
const connectSubtitle = requiredElement<HTMLParagraphElement>("connect-subtitle");
const connectStatus = requiredElement<HTMLParagraphElement>("connect-status");
const connectButton = requiredElement<HTMLButtonElement>("connect-btn");
const recheckButton = requiredElement<HTMLButtonElement>("recheck-btn");
const stepGrant = requiredElement<HTMLDivElement>("step-grant");
const stepTour = requiredElement<HTMLDivElement>("step-tour");
const allSetMascot = requiredElement<HTMLElement>("allset-mascot");
const modalOverlay = requiredElement<HTMLDivElement>("modal-overlay");
const permissionList = requiredElement<HTMLUListElement>("permission-list");
const permissionStatus = requiredElement<HTMLParagraphElement>("permission-status");
const authorizeButton = requiredElement<HTMLButtonElement>("authorize-btn");
const cancelButton = requiredElement<HTMLButtonElement>("cancel-btn");

let outstanding: string[] = [];
let modalOpener: HTMLElement | null = null;

void (async () => {
  if (location.hash === "#microphone") {
    connectCard.hidden = true;
    micCard.hidden = false;
    initMicrophoneView();
    return;
  }

  // All async preparation happens now: the Authorize click handler must reach
  // chrome.permissions.request() as its first await or Chrome drops the user
  // gesture and silently refuses the prompt.
  const declared = declaredOptionalPermissions();
  outstanding = await missingPermissions(declared);
  for (const permission of declared) {
    const item = document.createElement("li");
    item.textContent = PERMISSION_LABELS[permission] ?? permission;
    permissionList.append(item);
  }

  if (outstanding.length === 0) {
    const health = await helperHealth();
    if (health.ok) {
      // Re-entry: everything already works, hand straight off to the guide.
      window.location.href = GUIDE_URL;
      return;
    }
    enterRecheckMode(health.error);
  }
})();

connectButton.addEventListener("click", () => {
  permissionStatus.textContent = "";
  modalOpener = connectButton;
  modalOverlay.classList.add("visible");
  authorizeButton.focus();
});

function closeModal(): void {
  modalOverlay.classList.remove("visible");
  modalOpener?.focus();
  modalOpener = null;
}

cancelButton.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (event) => {
  if (event.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalOverlay.classList.contains("visible")) closeModal();
});

authorizeButton.addEventListener("click", () => {
  authorizeButton.disabled = true;
  // permissions.request must be the first await to keep the user gesture.
  const request: Promise<boolean> = outstanding.length === 0
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        chrome.permissions.request({ permissions: outstanding as chrome.runtime.ManifestPermissions[] }, (granted) => {
          const error = chrome.runtime.lastError;
          resolve(error ? false : granted);
        });
      });
  void request.then(async (granted) => {
    const remaining = await missingPermissions(declaredOptionalPermissions());
    if (!granted || remaining.length > 0) {
      permissionStatus.textContent = "Access was not granted. Review Chrome's prompt and try again.";
      return;
    }
    outstanding = [];
    const health = await helperHealth();
    closeModal();
    if (health.ok) {
      finishOnboarding();
    } else {
      enterRecheckMode(health.error);
    }
  }).catch((error: unknown) => {
    permissionStatus.textContent = "Chrome could not complete the request: "
      + (error instanceof Error ? error.message : "unknown error");
  }).finally(() => {
    authorizeButton.disabled = false;
  });
});

recheckButton.addEventListener("click", () => {
  recheckButton.disabled = true;
  setStatus(null);
  void helperHealth().then((health) => {
    if (health.ok) finishOnboarding();
    else setStatus(health.error);
  }).finally(() => {
    recheckButton.disabled = false;
  });
});

function enterRecheckMode(message: string): void {
  connectButton.hidden = true;
  recheckButton.hidden = false;
  setStatus(message);
}

function setStatus(message: string | null): void {
  connectStatus.hidden = message === null;
  connectStatus.textContent = message ?? "";
}

function finishOnboarding(): void {
  markStepDone(stepGrant);
  stepTour.classList.add("current");
  connectTitle.textContent = "You're all set!";
  connectSubtitle.textContent = "Taking you to your first tour…";
  allSetMascot.hidden = false;
  connectButton.hidden = true;
  recheckButton.hidden = true;
  setStatus(null);
  // A short pause lets the green check land before the handoff.
  window.setTimeout(() => {
    window.location.href = GUIDE_URL + "?from=extension";
  }, ALL_SET_DELAY_MS);
}

function markStepDone(step: HTMLElement): void {
  step.classList.remove("current");
  step.classList.add("done");
  const dot = step.querySelector(".step-dot");
  if (!dot) return;
  dot.textContent = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M20 6 9 17l-5-5");
  svg.append(path);
  dot.append(svg);
}

function declaredOptionalPermissions(): string[] {
  const manifest = chrome.runtime.getManifest();
  return [...(manifest.optional_permissions ?? [])];
}

async function missingPermissions(declared: string[]): Promise<string[]> {
  // permissions.contains is all-or-nothing, so probe each one individually.
  const gaps: string[] = [];
  for (const permission of declared) {
    const held = await new Promise<boolean>((resolve) => {
      chrome.permissions.contains({ permissions: [permission] as chrome.runtime.ManifestPermissions[] }, (result) => {
        const error = chrome.runtime.lastError;
        resolve(error ? false : result);
      });
    });
    if (!held) gaps.push(permission);
  }
  return gaps;
}

async function helperHealth(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await withDeadline(runtimeSend<unknown>({ type: "GUIDE_HOST_HEALTH" }), 10_000);
    if (isHostHealthResponse(response) && response.ok) return { ok: true };
    const code = isRecord(response) && typeof response.code === "string" ? response.code : "";
    // Key-related states still prove the helper is reachable; the side panel
    // asks for the key when it is needed.
    if (code === "NOT_CONFIGURED" || code === "INVALID_API_KEY" || code === "SECURE_STORAGE_ERROR") {
      return { ok: true };
    }
    const message = isRecord(response) && typeof response.error === "string"
      ? response.error.slice(0, 300)
      : "The helper did not answer.";
    return {
      ok: false,
      error: (code ? code + " — " : "") + message
        + " Open Browser Guide Helper once (or run npm run install:helper), then check again.",
    };
  } catch (error) {
    return {
      ok: false,
      error: "Chrome reported: " + (error instanceof Error ? error.message.slice(0, 240) : "no response")
        + ". Reload the extension or restart Chrome, then check again.",
    };
  }
}

/* ── Microphone view (deep link from the panel's voice beacon) ── */

function initMicrophoneView(): void {
  const enable = requiredElement<HTMLButtonElement>("mic-enable");
  const retry = requiredElement<HTMLButtonElement>("mic-retry");
  const hint = requiredElement<HTMLParagraphElement>("mic-hint");
  const addressRow = requiredElement<HTMLDivElement>("mic-address-row");
  const address = requiredElement<HTMLElement>("settings-address");
  const copy = requiredElement<HTMLButtonElement>("copy-address");
  const title = requiredElement<HTMLHeadingElement>("mic-title");
  const subtitle = requiredElement<HTMLParagraphElement>("mic-subtitle");
  let announced = false;
  let status: PermissionStatus | null = null;

  address.textContent = "chrome://settings/content/siteDetails?site=" + encodeURIComponent(location.origin);

  const show = (state: "intro" | "denied" | "missing" | "done"): void => {
    for (const line of micCard.querySelectorAll<HTMLElement>("[data-when]")) {
      line.hidden = line.dataset.when !== state;
    }
    enable.hidden = state !== "intro";
    retry.hidden = state !== "denied" && state !== "missing";
    addressRow.hidden = state !== "denied";
    hint.hidden = state !== "denied";
    if (state === "done") {
      title.textContent = "Microphone ready";
      subtitle.textContent = "The mic turns on only while you are speaking to the guide";
      if (!announced) {
        announced = true;
        try {
          chrome.runtime.sendMessage({ type: "GUIDE_MIC_READY" }, () => {
            void chrome.runtime.lastError;
          });
        } catch {
          // The panel may simply not be open.
        }
      }
    }
  };

  const apply = (): void => {
    const state = status?.state;
    if (state === "granted") show("done");
    else if (state === "denied") show("denied");
    else show("intro");
  };

  const request = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      show("done");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotFoundError" || name === "OverconstrainedError") show("missing");
      else show("denied");
    }
  };

  enable.addEventListener("click", () => void request());
  retry.addEventListener("click", () => void request());
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(address.textContent ?? "").then(() => {
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1_600);
    }).catch(() => undefined);
  });

  void navigator.permissions.query({ name: "microphone" as PermissionName }).then((result) => {
    status = result;
    result.addEventListener("change", apply);
    apply();
  }).catch(() => show("intro"));
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
