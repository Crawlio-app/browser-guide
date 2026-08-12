import { parseGuidanceCommand } from "../../shared/assistant-contract.js";
import { isContentRequest, type ContentRequest, type GuidanceResponse } from "../../shared/protocol.js";
import { ElementRegistry } from "./element-registry.js";
import { PageObserver } from "./observer.js";
import { OverlayController } from "./overlay-controller.js";

interface ContentRuntime {
  dispose(): void;
}

declare global {
  interface Window {
    __browserGuideContentV1?: ContentRuntime;
  }
}

if (!window.__browserGuideContentV1) {
  const registry = new ElementRegistry();
  const overlay = new OverlayController((final) => {
    chrome.runtime.sendMessage({ type: final ? "GUIDE_OVERLAY_DONE" : "GUIDE_OVERLAY_NEXT" }, () => {
      void chrome.runtime.lastError;
    });
  }, () => {
    chrome.runtime.sendMessage({ type: "GUIDE_OVERLAY_DISMISSED" }, () => {
      void chrome.runtime.lastError;
    });
  });
  const reportRefsInvalidated = (snapshotId: string): void => {
    chrome.runtime.sendMessage({ type: "GUIDE_REFS_INVALIDATED", snapshotId }, () => {
      void chrome.runtime.lastError;
    });
  };
  const observer = new PageObserver(
    registry,
    (node) => overlay.ownsNode(node),
    reportRefsInvalidated,
  );
  const unsubscribeInvalidation = registry.onInvalidated((snapshotId, reason) => {
    if (reason === "new-snapshot") return;
    overlay.clear();
    if (snapshotId) reportRefsInvalidated(snapshotId);
  });

  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id || !isContentRequest(message)) return false;
    handleMessage(message).then(sendResponse).catch((error: unknown) => {
      const description = error instanceof Error ? error.message : "Content runtime failed";
      sendResponse({ ok: false, error: description });
    });
    return true;
  };

  async function handleMessage(message: ContentRequest): Promise<unknown> {
    switch (message.type) {
      case "CONTENT_CAPTURE_CONTEXT":
        return { ok: true, context: observer.capture() };
      case "CONTENT_VALIDATE_SNAPSHOT":
        return { ok: true, valid: registry.refsValid && registry.snapshotId === message.snapshotId };
      case "CONTENT_CLEAR_GUIDANCE":
        overlay.clear();
        return { ok: true, shownRefs: [] } satisfies GuidanceResponse;
      case "CONTENT_PREPARE_SCREENSHOT":
        return overlay.prepareScreenshotShield();
      case "CONTENT_VERIFY_SCREENSHOT_SHIELD":
        return { ok: true, valid: overlay.verifyScreenshotShield() };
      case "CONTENT_FINISH_SCREENSHOT":
        overlay.finishScreenshotShield();
        return { ok: true };
      case "CONTENT_END_SESSION":
        runtime.dispose();
        return { ok: true, shownRefs: [] } satisfies GuidanceResponse;
      case "CONTENT_SHOW_GUIDANCE": {
        const command = parseGuidanceCommand(message.command.name, message.command);
        if (!command || command.name !== "show_guidance") {
          return { ok: false, error: "Invalid guidance command" } satisfies GuidanceResponse;
        }
        return overlay.show(command, message.snapshotId, registry);
      }
    }
  }

  const runtime: ContentRuntime = {
    dispose() {
      observer.disconnect();
      registry.invalidate("session-ended");
      unsubscribeInvalidation();
      overlay.destroy();
      chrome.runtime.onMessage.removeListener(listener);
      delete window.__browserGuideContentV1;
    },
  };

  chrome.runtime.onMessage.addListener(listener);
  window.__browserGuideContentV1 = runtime;
}
