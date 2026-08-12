import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GuidanceCommand, ShowGuidanceCommand } from "../../shared/assistant-contract.js";
import { contextForModel, isPageContext, type PageContext } from "../../shared/page-context.js";
import { sanitizePageContext } from "../../shared/sanitization.js";
import {
  isHostConfigureResponse,
  isHostCreateSessionResponse,
  isHostForgetResponse,
  isHostHealthResponse,
  isHostImportResponse,
  isHostMemoryClearResponse,
  isHostMemoryGetResponse,
  isWebOrigin,
  type CredentialProvider,
  type SiteMemoryNote,
} from "../../shared/native-protocol.js";
import {
  isCaptureResponse,
  isExtensionRuntimeState,
  isGuidanceResponse,
  isRecord,
  type ExtensionRuntimeState,
  type GuideMode,
  type GuideTurn,
  type WalkthroughPauseReason,
  type WalkthroughSession,
} from "../../shared/protocol.js";
import { WalkthroughCoordinator } from "../../shared/walkthrough.js";
import { DEMO_TOUR_GOAL, isPracticePage, resolveDemoStep } from "./demo-tour.js";
import { SessionBrokerError, VoiceSession, type GuideUiState, type RealtimeMode, type SessionBroker, type VoiceErrorKind } from "./voice-session.js";

type SetupState = "booting" | "helper-missing" | "permission-needed" | "key-missing" | "demo" | "ready";
type ToolbarState = "Ready" | "Guiding" | "Listening" | "Paused" | "Unavailable";

interface ConversationEntry {
  id: string;
  mode: GuideMode;
  question: string;
  answer: string;
  status: "pending" | "complete" | "failed";
  error?: string;
}

interface LastGuidance {
  command: ShowGuidanceCommand;
  snapshotId: string;
  visible: boolean;
}

interface UiIssue {
  kind: "helper" | "key" | "page" | "microphone" | "realtime" | "stale";
  message: string;
  retryQuestion?: string;
}

const INITIAL_RUNTIME: ExtensionRuntimeState = {
  status: "permission-paused",
  pauseReason: "not-authorized",
  refsValid: false,
};

const MODE_LABELS: Record<GuideMode, string> = {
  ask: "Ask",
  find: "Find",
  walkthrough: "Walkthrough",
};

const MODE_HINTS: Record<GuideMode, string> = {
  ask: "Explain the page in front of you",
  find: "Point to the right control",
  walkthrough: "One guided step at a time",
};

const PLACEHOLDERS: Record<GuideMode, string> = {
  ask: "Ask this page…",
  find: "What should I find?",
  walkthrough: "What do you want to do?",
};

const TOUR_GOAL = "Show me around this page";
const PRACTICE_URL = "https://docs.crawlio.app/browser-guide/practice";

class RuntimeSessionBroker implements SessionBroker {
  async createSession(sdp: string, mode: RealtimeMode): Promise<string> {
    const response = await runtimeSend<unknown>({ type: "GUIDE_HOST_CREATE_SESSION", sdp, mode });
    if (!isHostCreateSessionResponse(response) || !response.ok) {
      const code = isRecord(response) && typeof response.code === "string" ? response.code : "INVALID_RESPONSE";
      throw new SessionBrokerError(hostFailureKind(code), code, hostError(response, "The local helper could not start Realtime."));
    }
    return response.answerSdp;
  }

  async disconnect(): Promise<void> {
    await runtimeSend({ type: "GUIDE_HOST_DISCONNECT" }).catch(() => undefined);
  }
}

function BrowserGuideApp(): React.ReactElement {
  const [setup, setSetup] = useState<SetupState>("booting");
  const [runtime, setRuntime] = useState<ExtensionRuntimeState>(INITIAL_RUNTIME);
  const [voiceState, setVoiceState] = useState<GuideUiState>("idle");
  const [mode, setMode] = useState<GuideMode>("ask");
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [issue, setIssue] = useState<UiIssue | null>(null);
  const [shareVisual, setShareVisual] = useState(false);
  const [speakAnswers, setSpeakAnswers] = useState(false);
  const [agentEyes, setAgentEyes] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const demoStateRef = useRef<{ stepIndex: number } | null>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [lastGuidance, setLastGuidance] = useState<LastGuidance | null>(null);
  const [walkthrough, setWalkthrough] = useState<WalkthroughSession | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const runtimeRef = useRef(runtime);
  const assistantEntryId = useRef<string | null>(null);
  const activeTurnId = useRef<string | null>(null);
  const activeTurnMode = useRef<GuideMode>("ask");
  const turnEntryIds = useRef(new Map<string, string>());
  const finalAssistantText = useRef("");
  const voiceEntryId = useRef<string | null>(null);
  const walkthroughEntryId = useRef<string | null>(null);
  const activeEvidenceSnapshotId = useRef<string | null>(null);
  const activeVoiceMode = useRef<GuideMode>("ask");
  const voiceContextOrigin = useRef<string | null>(null);
  const lastVoiceQuestion = useRef("");
  const lastCaptureOrigin = useRef<string | null>(null);
  const activeTurnQuestion = useRef("");
  const lastTurnTyped = useRef(false);
  const speakAnswersRef = useRef(false);
  const transientKeyInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const walkthroughCoordinator = useRef(new WalkthroughCoordinator());
  const refreshTimer = useRef<number | null>(null);
  const walkthroughDeadlineTimer = useRef<number | null>(null);
  const advanceWalkthroughRef = useRef<() => Promise<void>>(async () => undefined);
  const submittingQuestion = useRef(false);
  const startingVoice = useRef(false);
  const continuingWalkthrough = useRef(false);
  runtimeRef.current = runtime;
  speakAnswersRef.current = speakAnswers;

  const broker = useMemo(() => new RuntimeSessionBroker(), []);

  const updateEntry = useCallback((id: string, updater: (entry: ConversationEntry) => ConversationEntry) => {
    setEntries((current) => current.map((entry) => entry.id === id ? updater(entry) : entry));
  }, []);

  const appendEntry = useCallback((entry: ConversationEntry) => {
    setEntries((current) => [...current, entry].slice(-30));
  }, []);

  const session = useMemo(() => new VoiceSession(broker, {
    onState: setVoiceState,
    onUserTranscript(text, final) {
      let id = voiceEntryId.current;
      if (!id) {
        id = makeId("voice");
        voiceEntryId.current = id;
        assistantEntryId.current = id;
        if (activeTurnId.current) turnEntryIds.current.set(activeTurnId.current, id);
        appendEntry({ id, mode: activeVoiceMode.current, question: "", answer: "", status: "pending" });
      }
      const targetId = id;
      updateEntry(targetId, (entry) => ({ ...entry, question: final ? text : entry.question + text }));
      if (final) {
        lastVoiceQuestion.current = text;
        activeTurnQuestion.current = text;
        voiceEntryId.current = null;
        if (activeVoiceMode.current === "walkthrough" && !walkthroughCoordinator.current.session && voiceContextOrigin.current) {
          walkthroughEntryId.current = targetId;
          setWalkthrough(walkthroughCoordinator.current.start(text || "Spoken walkthrough", voiceContextOrigin.current));
        }
      }
    },
    onAssistantTranscript(text, final) {
      let id = assistantEntryId.current;
      if (!id) {
        id = makeId("answer");
        assistantEntryId.current = id;
        if (activeTurnId.current) turnEntryIds.current.set(activeTurnId.current, id);
        const currentMode = activeTurnMode.current;
        appendEntry({
          id,
          mode: currentMode,
          question: currentMode === "walkthrough" ? walkthroughCoordinator.current.session?.goal ?? "Walkthrough" : "Voice question",
          answer: "",
          status: "pending",
        });
      }
      const targetId = id;
      updateEntry(targetId, (entry) => ({
        ...entry,
        answer: final ? text : entry.answer + text,
        status: "pending",
      }));
      if (final) finalAssistantText.current = text;
    },
    async onGuidance(command, turn) {
      if (command.name === "clear_guidance") {
        const response = await runtimeSend<unknown>({ type: "GUIDE_CLEAR_GUIDANCE" });
        if (isGuidanceResponse(response)) {
          setLastGuidance((current) => current ? { ...current, visible: false } : current);
          if (turn.mode === "walkthrough" && walkthroughCoordinator.current.session) {
            setWalkthrough(walkthroughCoordinator.current.complete());
            setLiveAnnouncement("Walkthrough complete.");
          }
          return response;
        }
        return { ok: false, error: "Invalid extension response." };
      }
      const currentRuntime = runtimeRef.current;
      if (!currentRuntime.refsValid || currentRuntime.latestSnapshotId !== turn.snapshotId) {
        return { ok: false, error: "The page changed; this pointer was rejected as stale." };
      }
      const response = await runtimeSend<unknown>({
        type: "GUIDE_SHOW_GUIDANCE",
        snapshotId: turn.snapshotId,
        command,
      });
      if (!isGuidanceResponse(response)) return { ok: false, error: "Invalid extension response." };
      if (response.ok) {
        setLastGuidance({ command, snapshotId: turn.snapshotId, visible: true });
        if (turn.mode === "walkthrough") {
          if (!walkthroughCoordinator.current.session && runtimeRef.current.authorizedOrigin) {
            walkthroughCoordinator.current.start(lastVoiceQuestion.current || "Spoken walkthrough", runtimeRef.current.authorizedOrigin);
          }
          const next = walkthroughCoordinator.current.receiveGuidance(command);
          setWalkthrough(next);
        }
      }
      return response;
    },
    onError(message, kind) {
      if (kind === "permission") setSetup("permission-needed");
      else if (kind === "host") setSetup("helper-missing");
      else if (kind === "key") setSetup("key-missing");
      setIssue(issueFromVoiceError(message, kind));
    },
    onTurn(turn) {
      if (turn.status !== "complete" && turn.status !== "failed" && turn.status !== "superseded") {
        activeTurnId.current = turn.turnId;
        activeTurnMode.current = turn.mode;
        if (assistantEntryId.current) turnEntryIds.current.set(turn.turnId, assistantEntryId.current);
        return;
      }
      const entryId = turnEntryIds.current.get(turn.turnId) ?? assistantEntryId.current;
      if (turn.status === "complete" && entryId) {
        const completedEntryId = entryId;
        updateEntry(completedEntryId, (entry) => ({ ...entry, status: "complete" }));
        setLiveAnnouncement(finalAssistantText.current.slice(0, 500));
        // Typed answers speak locally through the system voice; microphone
        // conversations already arrive as OpenAI audio and must not double up.
        if (speakAnswersRef.current && lastTurnTyped.current) speakLocally(finalAssistantText.current);
        if (turn.mode !== "walkthrough" && lastCaptureOrigin.current) {
          rememberSiteExchange(lastCaptureOrigin.current, activeTurnQuestion.current, finalAssistantText.current);
        }
      }
      if (turn.status === "failed" && entryId) {
        updateEntry(entryId, (entry) => ({ ...entry, status: "failed", error: "The answer did not finish." }));
      }
      if (turn.status === "superseded" && entryId) {
        updateEntry(entryId, (entry) => ({ ...entry, status: "failed", error: "Stopped before the answer finished." }));
      }
      turnEntryIds.current.delete(turn.turnId);
      if (assistantEntryId.current === entryId) assistantEntryId.current = null;
      if (voiceEntryId.current === entryId) voiceEntryId.current = null;
      if (activeTurnId.current === turn.turnId) activeTurnId.current = null;
      finalAssistantText.current = "";
      activeTurnQuestion.current = "";
    },
  }), [appendEntry, broker, updateEntry]);

  const toggleSpeakAnswers = useCallback(() => {
    setSpeakAnswers((current) => {
      if (current) stopSpeaking();
      return !current;
    });
  }, []);

  const refreshHost = useCallback(async (showBoot = true) => {
    if (showBoot) setSetup("booting");
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_HEALTH" }),
        8_000,
        "The local helper did not answer within eight seconds.",
      );
      if (!isHostHealthResponse(response) || !response.ok) {
        if (isHostHealthResponse(response) && !response.ok && response.code === "PERMISSION_REQUIRED") {
          setSetup("permission-needed");
          return;
        }
        if (isHostHealthResponse(response) && !response.ok
          && (response.code === "NOT_CONFIGURED" || response.code === "INVALID_API_KEY"
            || response.code === "SECURE_STORAGE_ERROR")) {
          setSetup("key-missing");
          setIssue({
            kind: "key",
            message: response.code === "SECURE_STORAGE_ERROR"
              ? "The local credential store is unavailable. Try again."
              : response.error,
          });
          return;
        }
        setSetup("helper-missing");
        setIssue({ kind: "helper", message: hostError(response, "Open Browser Guide Helper once, then check again.") });
        return;
      }
      setSetup(response.health.configured === true ? "ready" : "key-missing");
    } catch (error) {
      setSetup("helper-missing");
      setIssue({ kind: "helper", message: errorMessage(error, "The local helper is unavailable.") });
    }
  }, []);

  const capturePage = useCallback(async (): Promise<PageContext> => {
    const response = await runtimeSend<unknown>({ type: "GUIDE_CAPTURE_CONTEXT", shareVisual });
    if (!isCaptureResponse(response)) throw new Error("The page returned an invalid response.");
    if (!response.ok || !isPageContext(response.context)) {
      throw new Error(response.ok ? "The page returned an invalid response." : response.error);
    }
    setPageTitle(response.context.title);
    activeEvidenceSnapshotId.current = response.context.snapshotId;
    lastCaptureOrigin.current = response.context.origin;
    // Helper-backed extras only when the helper is reachable; demo-mode
    // captures must not wait on a host that is not installed.
    if (setup === "ready") {
      // Best-effort local history for this site; the turn proceeds without it.
      session.setSiteMemory(response.context.origin, await fetchSiteMemory(response.context.origin));
      if (agentEyes) publishAgentEyes(response.context);
    }
    if (shareVisual && response.context.visualOmission && response.context.visualOmission.reason !== "not-requested") {
      setIssue({ kind: "page", message: "The visual was omitted to stay within the privacy and size limit." });
    } else {
      setIssue((current) => current?.kind === "page" ? null : current);
    }
    return response.context;
  }, [agentEyes, session, setup, shareVisual]);

  const toggleAgentEyes = useCallback(() => {
    setAgentEyes((current) => {
      const next = !current;
      if (!next) {
        // OFF deletes the snapshot file; absence is the fail-closed state.
        void runtimeSend({ type: "GUIDE_HOST_CLEAR_EVIDENCE" }).catch(() => undefined);
        setLiveAnnouncement("Agent eyes off. The shared snapshot was deleted.");
      } else {
        setLiveAnnouncement("Agent eyes on. The next captured page is shared with your local coding agents.");
      }
      return next;
    });
  }, []);

  const submitQuestion = useCallback(async (override?: string, overrideMode?: GuideMode) => {
    const selectedMode = overrideMode ?? mode;
    const cleanQuestion = (override ?? question).trim();
    if (!cleanQuestion || setup !== "ready" || demoStateRef.current || voiceState === "thinking" || voiceState === "speaking"
      || submittingQuestion.current || startingVoice.current || continuingWalkthrough.current) return;
    submittingQuestion.current = true;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    if (session.busy) {
      if (session.currentTurn?.status === "capturing") await session.supersedeActiveTurn();
      else {
        submittingQuestion.current = false;
        return;
      }
    }
    const entryId = makeId("turn");
    const entry: ConversationEntry = {
      id: entryId,
      mode: selectedMode,
      question: cleanQuestion,
      answer: "",
      status: "pending",
    };
    appendEntry(entry);
    assistantEntryId.current = entryId;
    activeTurnQuestion.current = cleanQuestion;
    stopSpeaking();
    lastTurnTyped.current = true;
    setQuestion("");
    setIssue(null);
    try {
      const context = await capturePage();
      let prompt = cleanQuestion;
      if (selectedMode === "find") prompt = `Find this in the current page evidence and point to the best current match: ${cleanQuestion}`;
      if (selectedMode === "walkthrough") {
        walkthroughEntryId.current = entryId;
        const next = walkthroughCoordinator.current.start(cleanQuestion, context.origin);
        setWalkthrough(next);
        prompt = `Start a bounded, read-only walkthrough for this goal: ${cleanQuestion}. Begin with one sentence about what this page is, then give only the first step.`;
      } else if (walkthroughCoordinator.current.session?.phase !== "complete") {
        setWalkthrough(walkthroughCoordinator.current.pause("user"));
      }
      await session.sendTyped(prompt, context, selectedMode);
    } catch (error) {
      const message = errorMessage(error, "The question could not be sent.");
      updateEntry(entryId, (current) => ({ ...current, status: "failed", error: message }));
      assistantEntryId.current = null;
      setQuestion((current) => current.trim() ? current : cleanQuestion);
      setIssue({ kind: classifyQuestionError(message), message, retryQuestion: cleanQuestion });
      if (selectedMode === "walkthrough") {
        setWalkthrough(walkthroughCoordinator.current.pause("stale-evidence"));
      }
    } finally {
      submittingQuestion.current = false;
    }
  }, [appendEntry, capturePage, mode, question, session, setup, updateEntry, voiceState]);

  const advanceWalkthrough = useCallback(async () => {
    if (submittingQuestion.current || startingVoice.current || continuingWalkthrough.current) return;
    if (session.busy && session.currentTurn?.mode !== "walkthrough") {
      setWalkthrough(walkthroughCoordinator.current.pause("user"));
      setIssue({ kind: "page", message: "Walkthrough paused while Browser Guide finishes your current question." });
      return;
    }
    continuingWalkthrough.current = true;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    try {
      const active = walkthroughCoordinator.current.beginRefresh();
      if (!active) {
        setWalkthrough(walkthroughCoordinator.current.session);
        return;
      }
      setWalkthrough(active);
      const context = await capturePage();
      if (context.origin !== active.origin) {
        setWalkthrough(walkthroughCoordinator.current.pause("origin-changed"));
        await session.close();
        return;
      }
      let entryId = walkthroughEntryId.current;
      if (!entryId) {
        entryId = makeId("walkthrough");
        walkthroughEntryId.current = entryId;
        appendEntry({ id: entryId, mode: "walkthrough", question: active.goal, answer: "", status: "pending" });
      } else {
        updateEntry(entryId, (entry) => ({ ...entry, answer: "", status: "pending", error: undefined }));
      }
      assistantEntryId.current = entryId;
      lastTurnTyped.current = false;
      await session.continueWalkthrough(context, active.goal, active.step);
    } catch (error) {
      const message = errorMessage(error, "The fresh page view could not be read.");
      if (walkthroughEntryId.current) {
        updateEntry(walkthroughEntryId.current, (entry) => ({ ...entry, status: "failed", error: message }));
      }
      setIssue({ kind: "stale", message });
      setWalkthrough(walkthroughCoordinator.current.pause("stale-evidence"));
    } finally {
      continuingWalkthrough.current = false;
    }
  }, [appendEntry, capturePage, session, updateEntry]);
  // advanceWalkthroughRef is assigned below, after the demo-tour dispatcher.

  const handleRefsInvalidated = useCallback(() => {
    setLastGuidance((current) => current ? { ...current, visible: false } : current);
    const origin = runtimeRef.current.authorizedOrigin ?? "";
    const decision = walkthroughCoordinator.current.invalidate(origin);
    setWalkthrough(walkthroughCoordinator.current.session);
    if (decision.action === "pause") {
      setIssue({ kind: "page", message: pauseCopy(decision.reason) });
      void session.close();
      return;
    }
    if (decision.action !== "schedule") return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void advanceWalkthroughRef.current();
    }, decision.delayMs);
  }, [session]);

  const openMicrophoneGuide = useCallback(() => {
    window.open(chrome.runtime.getURL("welcome.html#microphone"));
  }, []);

  const toggleListening = useCallback(async () => {
    if (setup !== "ready" || demoStateRef.current) return;
    if (voiceState === "listening") {
      session.stopListening();
      return;
    }
    if (startingVoice.current || submittingQuestion.current || continuingWalkthrough.current || session.busy) return;
    const micState = await microphonePermissionState();
    if (micState === "prompt" || micState === "denied") {
      openMicrophoneGuide();
      setIssue({
        kind: "microphone",
        message: "Allow the microphone in the setup tab that just opened, then press the beacon again.",
      });
      return;
    }
    startingVoice.current = true;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    setIssue(null);
    let context: PageContext;
    try {
      context = await capturePage();
    } catch (error) {
      setIssue({
        kind: "page",
        message: errorMessage(error, "Browser Guide could not read the current page for voice."),
      });
      startingVoice.current = false;
      return;
    }
    try {
      stopSpeaking();
      lastTurnTyped.current = false;
      activeVoiceMode.current = mode;
      voiceContextOrigin.current = context.origin;
      await session.startListening(context, mode);
    } catch {
      // VoiceSession emits a cause-specific error and always closes partial media.
    } finally {
      startingVoice.current = false;
    }
  }, [capturePage, mode, openMicrophoneGuide, session, setup, voiceState]);

  const toggleListeningRef = useRef(toggleListening);
  toggleListeningRef.current = toggleListening;

  useEffect(() => {
    let mounted = true;
    void refreshHost().catch(() => undefined);
    void runtimeSend<unknown>({ type: "GUIDE_GET_STATE" }).then((response) => {
      if (!mounted || !isRecord(response) || response.ok !== true || !isExtensionRuntimeState(response.state)) return;
      setRuntime(response.state);
      // If the panel opened without a recorded toolbar grant, try to claim the
      // active tab once - the icon click that opened us usually granted it.
      if (response.state.status === "permission-paused" && response.state.pauseReason === "not-authorized") {
        void runtimeSend<unknown>({ type: "GUIDE_RESUME_REQUEST" }).then((resume) => {
          if (mounted && isRecord(resume) && isExtensionRuntimeState(resume.state)) setRuntime(resume.state);
        }).catch(() => undefined);
      }
    }).catch(() => {
      if (mounted) setIssue({ kind: "page", message: "Reload Browser Guide once to reconnect its background service." });
    });

    const listener = (message: unknown, sender: chrome.runtime.MessageSender): boolean => {
      if (sender.id !== chrome.runtime.id || !isRecord(message) || typeof message.type !== "string") return false;
      if (message.type === "GUIDE_RUNTIME_STATE" && isExtensionRuntimeState(message.state)) {
        setRuntime(message.state);
        runtimeRef.current = message.state;
        if (message.state.status === "permission-paused") {
          activeEvidenceSnapshotId.current = null;
          const reason = pauseReasonForRuntime(message.state);
          setLastGuidance((current) => current ? { ...current, visible: false } : current);
          if (walkthroughCoordinator.current.session) setWalkthrough(walkthroughCoordinator.current.pause(reason));
          void session.close();
        }
      } else if (message.type === "GUIDE_TOGGLE_LISTENING") {
        void toggleListeningRef.current();
      } else if (message.type === "GUIDE_MIC_READY") {
        setIssue((current) => current?.kind === "microphone" ? null : current);
        setLiveAnnouncement("Microphone enabled. Press the voice beacon to talk.");
      } else if (message.type === "GUIDE_OVERLAY_NEXT") {
        if (sender.tab?.id === runtimeRef.current.tabId) void continueWalkthroughRef.current();
      } else if (message.type === "GUIDE_OVERLAY_DISMISSED") {
        if (sender.tab?.id === runtimeRef.current.tabId) {
          setLastGuidance((current) => current ? { ...current, visible: false } : current);
        }
      } else if (message.type === "GUIDE_OVERLAY_DONE") {
        if (sender.tab?.id === runtimeRef.current.tabId && walkthroughCoordinator.current.session) {
          demoStateRef.current = null;
          setDemoActive(false);
          setWalkthrough(walkthroughCoordinator.current.complete());
          setLastGuidance((current) => current ? { ...current, visible: false } : current);
          setLiveAnnouncement("Walkthrough complete.");
          void runtimeSend({ type: "GUIDE_CLEAR_GUIDANCE" }).catch(() => undefined);
          void session.close();
        }
      } else if (message.type === "GUIDE_REFS_INVALIDATED") {
        const snapshotId = typeof message.snapshotId === "string" ? message.snapshotId : null;
        if (sender.tab?.id === runtimeRef.current.tabId
          && snapshotId !== null
          && snapshotId === activeEvidenceSnapshotId.current) {
          handleRefsInvalidated();
        }
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);

    const visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
        activeEvidenceSnapshotId.current = null;
        if (walkthroughCoordinator.current.session) setWalkthrough(walkthroughCoordinator.current.pause("user"));
        void runtimeSend({ type: "GUIDE_CLEAR_GUIDANCE" }).catch(() => undefined);
        void session.close();
      }
    };
    document.addEventListener("visibilitychange", visibilityListener);
    return () => {
      mounted = false;
      if (transientKeyInput.current) transientKeyInput.current.value = "";
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (walkthroughDeadlineTimer.current !== null) window.clearTimeout(walkthroughDeadlineTimer.current);
      turnEntryIds.current.clear();
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener("visibilitychange", visibilityListener);
      stopSpeaking();
      void session.close();
    };
  }, [handleRefsInvalidated, refreshHost, session]);

  useEffect(() => {
    if (walkthroughDeadlineTimer.current !== null) window.clearTimeout(walkthroughDeadlineTimer.current);
    walkthroughDeadlineTimer.current = null;
    if (!walkthrough || walkthrough.phase === "complete") return;
    const expire = () => {
      const expired = walkthroughCoordinator.current.expire();
      if (expired?.phase !== "paused" || expired.pauseReason !== "limit") return;
      setWalkthrough(expired);
      setIssue({ kind: "page", message: pauseCopy("limit") });
      void runtimeSend({ type: "GUIDE_CLEAR_GUIDANCE" }).catch(() => undefined);
      void session.close();
    };
    const expiresAt = walkthroughCoordinator.current.expiresAt;
    if (expiresAt === null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) expire();
    else walkthroughDeadlineTimer.current = window.setTimeout(expire, remaining);
    return () => {
      if (walkthroughDeadlineTimer.current !== null) window.clearTimeout(walkthroughDeadlineTimer.current);
      walkthroughDeadlineTimer.current = null;
    };
  }, [session, walkthrough?.id, walkthrough?.phase, walkthrough?.startedAt]);

  const requestNativePermission = useCallback(async () => {
    setIssue(null);
    const granted = await requestPermission("nativeMessaging");
    if (!granted) {
      setIssue({ kind: "helper", message: "Chrome needs one-time permission to reach the helper on this Mac." });
      return;
    }
    await refreshHost();
  }, [refreshHost]);

  const importCredentials = useCallback(async (provider: CredentialProvider) => {
    if (keyBusy) return;
    setKeyBusy(true);
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_IMPORT_CREDENTIALS", provider }),
        10_000,
        "The sign-in import did not finish in time.",
      );
      if (!isHostImportResponse(response) || !response.ok) {
        throw new Error(hostError(response, "The sign-in could not be imported."));
      }
      if (response.configured) {
        setSetup("ready");
      } else {
        setIssue({
          kind: "key",
          message: "Claude Code connected. Realtime voice still needs an OpenAI credential — use the Codex sign-in or paste a key.",
        });
      }
    } catch (error) {
      setIssue({ kind: "key", message: errorMessage(error, "The sign-in could not be imported.") });
    } finally {
      setKeyBusy(false);
    }
  }, [keyBusy]);

  const configureApiKey = useCallback(async () => {
    if (keyBusy) return;
    const input = transientKeyInput.current;
    const key = input?.value.trim() ?? "";
    if (key.length < 20 || key.length > 600) {
      setIssue({ kind: "key", message: "Paste a valid OpenAI Platform API key." });
      return;
    }
    if (input) input.value = "";
    setKeyPresent(false);
    setKeyBusy(true);
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_CONFIGURE_KEY", key }),
        8_000,
        "Saving did not finish within eight seconds. Try again.",
      );
      if (!isHostConfigureResponse(response) || !response.ok) {
        throw new Error(hostError(response, "The key could not be saved."));
      }
      setSetup("ready");
    } catch (error) {
      setSetup("key-missing");
      setIssue({ kind: "key", message: errorMessage(error, "The key could not be saved.") });
    } finally {
      setKeyBusy(false);
    }
  }, [keyBusy]);

  const resumePage = useCallback(async () => {
    setIssue(null);
    const response = await runtimeSend<unknown>({ type: "GUIDE_RESUME_REQUEST" });
    if (!isRecord(response) || typeof response.ok !== "boolean") {
      setIssue({ kind: "page", message: "Browser Guide could not check this tab." });
      return;
    }
    if (isExtensionRuntimeState(response.state)) setRuntime(response.state);
    if (!response.ok) {
      setIssue({ kind: "page", message: typeof response.error === "string" ? response.error.slice(0, 500) : "Use the toolbar icon once on this page." });
    }
  }, []);

  const clearGuidance = useCallback(async () => {
    await runtimeSend({ type: "GUIDE_CLEAR_GUIDANCE" });
    setLastGuidance((current) => current ? { ...current, visible: false } : current);
  }, []);

  const showAgain = useCallback(async () => {
    if (!lastGuidance) return;
    const response = await runtimeSend<unknown>({
      type: "GUIDE_SHOW_GUIDANCE",
      snapshotId: lastGuidance.snapshotId,
      command: lastGuidance.command,
    });
    if (!isGuidanceResponse(response) || !response.ok) {
      setLastGuidance((current) => current ? { ...current, visible: false } : current);
      setIssue({ kind: "stale", message: "That pointer is no longer current. Ask for a fresh view." });
      return;
    }
    setLastGuidance((current) => current ? { ...current, visible: true } : current);
  }, [lastGuidance]);

  const pauseWalkthrough = useCallback(async () => {
    setWalkthrough(walkthroughCoordinator.current.pause("user"));
    await clearGuidance();
    await session.close();
  }, [clearGuidance, session]);

  const stopWalkthrough = useCallback(async () => {
    demoStateRef.current = null;
    setDemoActive(false);
    walkthroughCoordinator.current.stop();
    walkthroughEntryId.current = null;
    setWalkthrough(null);
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    if (walkthroughDeadlineTimer.current !== null) window.clearTimeout(walkthroughDeadlineTimer.current);
    walkthroughDeadlineTimer.current = null;
    await clearGuidance();
    await session.close();
    setMode("ask");
  }, [clearGuidance, session]);

  const continueWalkthroughRef = useRef<() => Promise<void>>(async () => undefined);

  const continueWalkthrough = useCallback(async () => {
    const current = walkthroughCoordinator.current.session;
    if (!current) return;
    if (current.phase === "paused") {
      const origin = runtimeRef.current.authorizedOrigin ?? "";
      const resumed = walkthroughCoordinator.current.resume(origin);
      setWalkthrough(resumed);
      if (!resumed) {
        setIssue({ kind: "page", message: "Use the toolbar icon once on the page you want to guide." });
        return;
      }
      if (resumed.phase === "paused") {
        setIssue({ kind: "page", message: pauseCopy(resumed.pauseReason ?? "limit") });
        await session.close();
        return;
      }
    }
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    const delay = Math.max(600, walkthroughCoordinator.current.refreshDelay());
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void advanceWalkthroughRef.current();
    }, delay);
  }, []);
  continueWalkthroughRef.current = continueWalkthrough;

  // --- Canned practice tour: same overlay, card, and coordinator as a real
  // walkthrough, but every step is resolved locally — no model, no helper. ---

  const presentDemoStep = useCallback(async (initialContext: PageContext, index: number): Promise<boolean> => {
    let context = initialContext;
    let command = resolveDemoStep(context, index);
    if (!command) {
      // One settle-and-retry: the page may still be laying out.
      await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 400));
      context = await capturePage();
      command = resolveDemoStep(context, index);
    }
    let shown = false;
    if (command) {
      const response = await runtimeSend<unknown>({
        type: "GUIDE_SHOW_GUIDANCE",
        snapshotId: context.snapshotId,
        command,
      });
      shown = isGuidanceResponse(response) && response.ok;
      if (!shown) {
        // The snapshot went stale between capture and show. Refs never survive
        // a recapture, so re-resolve the matcher against the fresh evidence.
        context = await capturePage();
        command = resolveDemoStep(context, index);
        if (command) {
          const retry = await runtimeSend<unknown>({
            type: "GUIDE_SHOW_GUIDANCE",
            snapshotId: context.snapshotId,
            command,
          });
          shown = isGuidanceResponse(retry) && retry.ok;
        }
      }
    }
    if (!command || !shown) {
      setWalkthrough(walkthroughCoordinator.current.pause("stale-evidence"));
      setIssue({ kind: "stale", message: "The practice page changed. Press Continue to retry this tour step." });
      return false;
    }
    demoStateRef.current = { stepIndex: index };
    setLastGuidance({ command, snapshotId: context.snapshotId, visible: true });
    setWalkthrough(walkthroughCoordinator.current.receiveGuidance(command));
    setLiveAnnouncement(`${command.title}. ${command.body}`);
    return true;
  }, [capturePage]);

  const startDemoTour = useCallback(async () => {
    if (submittingQuestion.current || startingVoice.current || continuingWalkthrough.current) return;
    if (session.busy) {
      setIssue({ kind: "page", message: "Finish or stop the current answer before starting the practice tour." });
      return;
    }
    if (runtimeRef.current.status !== "ready") {
      window.open(PRACTICE_URL);
      setIssue({ kind: "page", message: "The practice page just opened. Click the Browser Guide toolbar icon there, then press Practice tour again." });
      return;
    }
    await stopWalkthrough();
    continuingWalkthrough.current = true;
    try {
      const context = await capturePage();
      if (!isPracticePage(context)) {
        window.open(PRACTICE_URL);
        setIssue({ kind: "page", message: "The tour runs on the practice page — it just opened. Click the toolbar icon there, then press Practice tour again." });
        return;
      }
      demoStateRef.current = { stepIndex: 0 };
      setDemoActive(true);
      setIssue(null);
      setWalkthrough(walkthroughCoordinator.current.start(DEMO_TOUR_GOAL, context.origin));
      await presentDemoStep(context, 0);
    } catch (error) {
      demoStateRef.current = null;
      setDemoActive(false);
      setIssue({ kind: "page", message: errorMessage(error, "The practice page could not be read.") });
    } finally {
      continuingWalkthrough.current = false;
    }
  }, [capturePage, presentDemoStep, session, stopWalkthrough]);

  const advanceDemoTour = useCallback(async () => {
    const demo = demoStateRef.current;
    if (!demo || submittingQuestion.current || startingVoice.current || continuingWalkthrough.current) return;
    continuingWalkthrough.current = true;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    try {
      const active = walkthroughCoordinator.current.beginRefresh();
      if (!active) {
        setWalkthrough(walkthroughCoordinator.current.session);
        return;
      }
      setWalkthrough(active);
      const context = await capturePage();
      if (context.origin !== active.origin) {
        setWalkthrough(walkthroughCoordinator.current.pause("origin-changed"));
        return;
      }
      // The index only commits inside presentDemoStep on success, so a failed
      // present leaves Continue retrying the same step instead of skipping it.
      await presentDemoStep(context, demo.stepIndex + 1);
    } catch (error) {
      setIssue({ kind: "stale", message: errorMessage(error, "The fresh page view could not be read.") });
      setWalkthrough(walkthroughCoordinator.current.pause("stale-evidence"));
    } finally {
      continuingWalkthrough.current = false;
    }
  }, [capturePage, presentDemoStep]);

  // Every advance path (overlay Next, the card's Continue, the refs-invalidated
  // scheduler) funnels through this ref — route demo vs. model here, once.
  advanceWalkthroughRef.current = async () => {
    if (demoStateRef.current) await advanceDemoTour();
    else await advanceWalkthrough();
  };

  const clearConversation = useCallback(async () => {
    stopSpeaking();
    await stopWalkthrough();
    await runtimeSend({ type: "GUIDE_END_SESSION" });
    setEntries([]);
    assistantEntryId.current = null;
    activeTurnId.current = null;
    voiceEntryId.current = null;
    walkthroughEntryId.current = null;
    turnEntryIds.current.clear();
    activeEvidenceSnapshotId.current = null;
    setIssue(null);
    setLiveAnnouncement("");
  }, [stopWalkthrough]);

  const clearSiteMemory = useCallback(async () => {
    const origin = lastCaptureOrigin.current ?? runtimeRef.current.authorizedOrigin ?? undefined;
    if (!window.confirm(origin
      ? `Forget what Browser Guide remembers about ${origin}?`
      : "Forget what Browser Guide remembers about every site?")) return;
    try {
      const response = await runtimeSend<unknown>(
        origin ? { type: "GUIDE_HOST_MEMORY_CLEAR", origin } : { type: "GUIDE_HOST_MEMORY_CLEAR" },
      );
      if (!isHostMemoryClearResponse(response) || !response.ok) {
        setIssue({ kind: "helper", message: hostError(response, "Site memory could not be cleared.") });
        return;
      }
      session.setSiteMemory(null, []);
      setLiveAnnouncement("Site memory cleared.");
    } catch (error) {
      setIssue({ kind: "helper", message: errorMessage(error, "Site memory could not be cleared.") });
    }
  }, [session]);

  const forgetKey = useCallback(async () => {
    if (!window.confirm("Remove the stored OpenAI credential from this Mac?")) return;
    const response = await runtimeSend<unknown>({ type: "GUIDE_HOST_FORGET_KEY" });
    if (!isHostForgetResponse(response) || !response.ok) {
      setIssue({ kind: "key", message: hostError(response, "The credential could not be removed.") });
      return;
    }
    await clearConversation();
    setSetup("key-missing");
  }, [clearConversation]);

  // Keep the newest exchange in view as answers stream in.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace) workspace.scrollTop = workspace.scrollHeight;
  }, [entries, walkthrough]);

  const toolbarState: ToolbarState = setup === "demo"
    ? (demoActive && walkthrough?.phase !== "paused" ? "Guiding" : "Paused")
    : setup !== "ready"
      ? "Unavailable"
      : walkthrough?.phase === "paused" || runtime.status === "permission-paused"
        ? "Paused"
          : walkthrough && walkthrough.phase !== "complete" ? "Guiding"
          : voiceState === "listening" ? "Listening"
            : voiceState === "offline" ? "Unavailable" : "Ready";

  if (setup !== "ready" && setup !== "demo") {
    return (
      <main className="guide-shell setup-shell" data-setup={setup}>
        <SetupView
          state={setup}
          issue={issue}
          keyBusy={keyBusy}
          keyPresent={keyPresent}
          keyInput={transientKeyInput}
          onKeyPresent={setKeyPresent}
          onConfigureKey={configureApiKey}
          onImport={importCredentials}
          onPermission={requestNativePermission}
          onRetry={refreshHost}
          onDemo={() => {
            setSetup("demo");
            window.open(PRACTICE_URL);
          }}
        />
      </main>
    );
  }

  const pagePaused = runtime.status === "permission-paused";
  const inDemo = setup === "demo";
  const composerLocked = pagePaused || inDemo || demoActive;
  return (
    <main className="guide-shell" data-toolbar-state={toolbarState.toLowerCase()}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>
      <header className="instrument-bar">
        <div className="instrument-state" title={pageTitle ?? "Current tab"}>
          <span className="beacon-dot" aria-hidden="true" />
          <span>{toolbarState}</span>
          {walkthrough && <span className="step-count">{walkthrough.step}/12</span>}
          {agentEyes && <span className="eyes-indicator" role="status" title="Local coding agents can read the captured page snapshot">Eyes on</span>}
        </div>
        <div className="instrument-actions">
          <button type="button" className="icon-button" onClick={() => void clearConversation()} aria-label="Clear session" title="Clear session"><ToolbarIcon kind="reset" /></button>
          <button type="button" className="icon-button" onClick={() => void clearSiteMemory()} aria-label="Clear site memory" title="Clear site memory"><ToolbarIcon kind="memory" /></button>
          <button type="button" className="icon-button" onClick={() => void forgetKey()} aria-label="Forget API key" title="Forget API key"><ToolbarIcon kind="key" /></button>
        </div>
      </header>

      <div className="workspace" ref={workspaceRef}>
        {inDemo && (
          <section className="recovery-line demo-banner" role="status">
            <span>Demo mode — real questions need the local helper.</span>
            <button type="button" onClick={() => void startDemoTour()}>Practice tour</button>
            <button type="button" onClick={() => {
              setSetup("booting");
              void refreshHost();
            }}>Finish setup</button>
          </section>
        )}
        {pagePaused && (
          <section className="recovery-line" role="status">
            <span>{pageRecoveryCopy(runtime)}</span>
            {runtime.pauseReason !== "restricted-page" && <button type="button" onClick={() => void resumePage()}>Resume</button>}
          </section>
        )}

        {issue && (
          <section className={`issue-line ${issue.kind}`} role="status">
            <span>{issue.message}</span>
            {issue.kind === "microphone" && <button type="button" onClick={openMicrophoneGuide}>Enable microphone</button>}
            {issue.retryQuestion && <button type="button" onClick={() => void submitQuestion(issue.retryQuestion)}>Retry</button>}
          </section>
        )}

        {walkthrough && (
          <section className="guide-card" aria-label={`Walkthrough step ${walkthrough.step}`}>
            <div className="guide-card-head">
              <CompassMascot phase={walkthrough.phase} />
              <span className="guide-eyebrow">{walkthroughEyebrow(walkthrough)}</span>
            </div>
            <div className="guide-card-copy">
              <h2>{lastGuidance?.command.title ?? walkthrough.goal}</h2>
              {lastGuidance && <p>{lastGuidance.command.body}</p>}
            </div>
            <div className="guide-controls">
              {(walkthrough.phase === "awaiting-user" || walkthrough.phase === "awaiting-page-change" || walkthrough.phase === "paused") && (
                <button type="button" className="primary" onClick={() => void continueWalkthrough()}>Continue</button>
              )}
              {walkthrough.phase === "complete" && (
                <button type="button" className="primary" onClick={() => void stopWalkthrough()}>Done</button>
              )}
              {walkthrough.phase !== "paused" && walkthrough.phase !== "complete" && <button type="button" onClick={() => void pauseWalkthrough()}>Pause</button>}
              {lastGuidance && (lastGuidance.visible
                ? <button type="button" onClick={() => void clearGuidance()}>Hide pointer</button>
                : <button type="button" onClick={() => void showAgain()}>Show pointer</button>)}
              {walkthrough.phase !== "complete" && (
                <button type="button" className="quiet" onClick={() => void stopWalkthrough()}>Stop</button>
              )}
            </div>
          </section>
        )}

        <section className="conversation" aria-label="Conversation">
          {entries.length === 0 && !walkthrough && (
            <div className="empty-instrument">
              <span className="empty-beacon" aria-hidden="true"><i /></span>
              <h1>What do you need?</h1>
              <div className="intent-launcher" aria-label="Guide modes">
                {(["ask", "find", "walkthrough"] as const).map((value) => (
                  <button key={value} type="button" disabled={inDemo} onClick={() => {
                    setMode(value);
                    // A walkthrough needs no typed goal: selecting it starts a
                    // guided tour of the current page right away.
                    if (value === "walkthrough" && !pagePaused) {
                      void submitQuestion(TOUR_GOAL, "walkthrough");
                      return;
                    }
                    composerInput.current?.focus();
                  }}>
                    <ModeIcon mode={value} />
                    <span className="intent-copy">
                      <span className="intent-label">{MODE_LABELS[value]}</span>
                      <span className="intent-hint">{MODE_HINTS[value]}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" className="practice-link" onClick={() => void startDemoTour()}>
                Practice tour — a guided demo on a safe page
              </button>
              <p className="brand-line">
                <a href="https://www.crawlio.app" target="_blank" rel="noreferrer">by Crawlio</a>
              </p>
            </div>
          )}
          {entries.map((entry) => (
            <article className={`editorial-turn ${entry.status}`} key={entry.id}>
              <p className="user-question">
                <span className={`turn-chip ${entry.mode}`}>
                  <ModeIcon mode={entry.mode} />
                  {MODE_LABELS[entry.mode]}
                </span>
                <span className="user-question-text">{entry.question || "Listening…"}</span>
              </p>
              {entry.answer && <p className={`guide-answer${entry.answer.length > 180 ? " long" : ""}`}>{entry.answer}</p>}
              {entry.status === "pending" && !entry.answer && <span className="thinking-mark" aria-label="Thinking"><i /><i /><i /></span>}
              {entry.status === "failed" && (
                <div className="turn-failure">
                  <span>{entry.error ?? "This answer did not finish."}</span>
                  <button type="button" onClick={() => void submitQuestion(entry.question, entry.mode)}>Retry</button>
                </div>
              )}
            </article>
          ))}
        </section>
      </div>

      <footer className="composer-dock">
        <div className="mode-row" aria-label="Current guide mode">
          {(entries.length > 0 || walkthrough) && (["ask", "find", "walkthrough"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={mode === value ? "selected" : ""}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  if (value === "walkthrough" && !pagePaused && !walkthroughCoordinator.current.session) {
                    void submitQuestion(TOUR_GOAL, "walkthrough");
                  }
                }}
              >{MODE_LABELS[value]}</button>
            ))}
          <button
            type="button"
            className={`speak-toggle${speakAnswers ? " on" : ""}`}
            aria-pressed={speakAnswers}
            title={speakAnswers ? "Typed answers are spoken aloud on this device" : "Speak typed answers aloud on this device"}
            onClick={toggleSpeakAnswers}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 8v4h3l4 3.4V4.6L6.5 8h-3Z" />
              <path className="speak-wave" d="M13 7.2c1 .7 1.6 1.7 1.6 2.8s-.6 2.1-1.6 2.8" />
              <path className="speak-wave" d="M15 5.2c1.7 1.1 2.7 2.8 2.7 4.8s-1 3.7-2.7 4.8" />
            </svg>
            <span>Speak</span>
          </button>
          <label className="visual-toggle">
            <input type="checkbox" checked={shareVisual} onChange={(event) => setShareVisual(event.currentTarget.checked)} />
            <span>Visual</span>
          </label>
          <label className="visual-toggle eyes-toggle" title="Share the current page snapshot with local coding agents (Claude Code, Codex) through a private local file. Off deletes it.">
            <input type="checkbox" checked={agentEyes} onChange={toggleAgentEyes} />
            <span>Eyes</span>
          </label>
        </div>
        <form className="composer" onSubmit={(event) => {
          event.preventDefault();
          void submitQuestion();
        }}>
          <button
            className="voice-beacon"
            type="button"
            aria-label={voiceState === "listening" ? "Stop listening" : "Ask by voice"}
            aria-pressed={voiceState === "listening"}
            title="Voice · ⌘⇧G"
            disabled={composerLocked || voiceState === "thinking" || voiceState === "speaking" || voiceState === "pointing"}
            onClick={() => void toggleListening()}
          >
            <span aria-hidden="true"><i /><i /><i /></span>
          </button>
          <label className="sr-only" htmlFor="guide-question">{PLACEHOLDERS[mode]}</label>
          <textarea
            id="guide-question"
            ref={composerInput}
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitQuestion();
              }
            }}
            rows={1}
            aria-label={PLACEHOLDERS[mode]}
            placeholder={PLACEHOLDERS[mode]}
            disabled={composerLocked}
          />
          <button className="send-button" type="submit" aria-label={`Send ${MODE_LABELS[mode].toLowerCase()} request`} disabled={!question.trim() || pagePaused}>↑</button>
        </form>
      </footer>
    </main>
  );
}

interface SetupViewProps {
  state: SetupState;
  issue: UiIssue | null;
  keyBusy: boolean;
  keyPresent: boolean;
  keyInput: React.RefObject<HTMLInputElement | null>;
  onKeyPresent(value: boolean): void;
  onConfigureKey(): Promise<void>;
  onImport(provider: CredentialProvider): Promise<void>;
  onPermission(): Promise<void>;
  onRetry(showBoot?: boolean): Promise<void>;
  onDemo(): void;
}

const INSTALL_COMMAND = "npx crawlio-browser-guide init";

function InstallCommandRow(): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="install-command">
      <p>Install the local helper with one command, then press Check again:</p>
      <div className="command-row">
        <code>{INSTALL_COMMAND}</code>
        <button
          type="button"
          aria-label="Copy the install command"
          onClick={() => {
            void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            }).catch(() => undefined);
          }}
        >{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

function SetupView(props: SetupViewProps): React.ReactElement {
  const copy = setupCopy(props.state);
  return (
    <section className="setup-card" aria-labelledby="setup-title" aria-busy={props.state === "booting" || props.keyBusy}>
      <span className="setup-beacon" aria-hidden="true"><i /></span>
      <p className="setup-kicker">{copy.kicker}</p>
      <h1 id="setup-title">{copy.title}</h1>
      <p className="setup-line">{copy.line}</p>

      {props.state === "key-missing" ? (
        <form className="key-form" onSubmit={(event) => {
          event.preventDefault();
          void props.onConfigureKey();
        }}>
          <div className="signin-options">
            <button type="button" className="signin-button" disabled={props.keyBusy} onClick={() => void props.onImport("codex")}>
              Use my Codex sign-in
            </button>
            <button type="button" className="signin-button" disabled={props.keyBusy} onClick={() => void props.onImport("claude-code")}>
              Use my Claude Code sign-in
            </button>
          </div>
          <p className="signin-divider"><span>or paste an API key</span></p>
          <label htmlFor="platform-key">OpenAI API key</label>
          <input
            id="platform-key"
            ref={props.keyInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-proj-…"
            onChange={(event) => props.onKeyPresent(Boolean(event.currentTarget.value.trim()))}
            autoFocus
          />
          <button className="setup-action" type="submit" disabled={!props.keyPresent || props.keyBusy}>
            {props.keyBusy ? "Saving…" : "Save key"}
          </button>
        </form>
      ) : props.state === "permission-needed" ? (
        <button className="setup-action" type="button" onClick={() => void props.onPermission()}>Allow helper</button>
      ) : props.state === "helper-missing" ? (
        <>
          <InstallCommandRow />
          <button className="setup-action" type="button" onClick={() => void props.onRetry()}>Check again</button>
          <button className="setup-secondary" type="button" onClick={props.onDemo}>Try the demo first</button>
        </>
      ) : <span className="setup-loader" aria-hidden="true" />}

      {props.issue && <p className="setup-error" role="status">{props.issue.message}</p>}
      <p className="setup-privacy"><span aria-hidden="true" />{copy.privacy}</p>
    </section>
  );
}

function walkthroughEyebrow(walkthrough: WalkthroughSession): string {
  if (walkthrough.phase === "complete") return "All done — you did it!";
  if (walkthrough.phase === "paused") return `Step ${walkthrough.step} · taking a breather`;
  if (walkthrough.step <= 1) return "Step 1 · let's go";
  return `Step ${walkthrough.step} · nice pace`;
}

function CompassMascot({ phase }: { phase: WalkthroughSession["phase"] }): React.ReactElement {
  const variant = phase === "complete" ? "happy" : phase === "paused" ? "asleep" : "awake";
  return (
    <svg className={`walk-mascot ${variant}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="13" r="8.6" fill="var(--paper)" stroke="var(--emerald)" strokeWidth="1.6" />
      <path d="M12 1.6 L13.8 5.4 L10.2 5.4 Z" fill="var(--emerald)" />
      {variant === "asleep" ? (
        <>
          <path d="M8.2 11.9 H10.4" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M13.6 11.9 H15.8" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M9.8 15.4 Q12 16.2 14.2 15.4" fill="none" stroke="var(--ink)" strokeWidth="1.1" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle className="walk-mascot-eye" cx="9.3" cy="11.6" r="1.15" fill="var(--ink)" />
          <circle className="walk-mascot-eye" cx="14.7" cy="11.6" r="1.15" fill="var(--ink)" />
          <path
            d={variant === "happy" ? "M9 14.6 Q12 17.6 15 14.6" : "M9.5 15 Q12 17 14.5 15"}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function ModeIcon({ mode }: { mode: GuideMode }): React.ReactElement {
  if (mode === "ask") return <span className="mode-icon" aria-hidden="true">?</span>;
  if (mode === "find") return <span className="mode-icon lens" aria-hidden="true" />;
  return <span className="mode-icon steps" aria-hidden="true"><i /><i /></span>;
}

function ToolbarIcon({ kind }: { kind: "reset" | "key" | "memory" }): React.ReactElement {
  if (kind === "reset") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.6 6.2H2.8V3.4M3.1 6.1A7 7 0 1 1 3.7 15" />
      </svg>
    );
  }
  if (kind === "memory") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="6.6" />
        <path d="M10 6.4V10l2.6 1.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7" cy="10" r="3.2" />
      <path d="M10.1 10h7M14.1 10v2.2M16.7 10v1.4" />
    </svg>
  );
}

function setupCopy(state: SetupState): { kicker: string; title: string; line: string; privacy: string } {
  switch (state) {
    case "booting": return { kicker: "Local", title: "One moment", line: "Checking this Mac.", privacy: "Nothing leaves Chrome yet." };
    case "helper-missing": return { kicker: "One-time setup", title: "Open the helper", line: "Run Browser Guide Helper once, then return here.", privacy: "Local to this Mac." };
    case "permission-needed": return { kicker: "One-time setup", title: "Allow the helper", line: "Chrome needs permission to reach the local app.", privacy: "Exact extension only." };
    case "key-missing": return { kicker: "Final step", title: "Connect a credential", line: "Use an existing harness sign-in, or paste a key. Stored locally, never in Chrome.", privacy: "Saved to a private local file." };
    case "demo":
    case "ready": return { kicker: "", title: "", line: "", privacy: "" };
  }
}

function pageRecoveryCopy(runtime: ExtensionRuntimeState): string {
  switch (runtime.pauseReason) {
    case "restricted-page": return "Chrome does not allow guidance on this page.";
    case "origin-changed": return "This site changed. Share the new page to continue.";
    case "access-lost": return "Page access ended.";
    case "page-changed": return "The page changed. Refresh the view.";
    case "not-authorized":
    default: return "This tab isn't shared yet. Click the Browser Guide toolbar icon.";
  }
}

function pauseReasonForRuntime(runtime: ExtensionRuntimeState): WalkthroughPauseReason {
  switch (runtime.pauseReason) {
    case "origin-changed": return "origin-changed";
    case "restricted-page": return "restricted-page";
    case "access-lost": return "access-lost";
    default: return "tab-changed";
  }
}

function pauseCopy(reason: WalkthroughPauseReason): string {
  switch (reason) {
    case "page-churn": return "The page is changing too quickly. Walkthrough paused.";
    case "origin-changed": return "The site changed. Share the new page to continue.";
    case "limit": return "This walkthrough reached its safety limit.";
    case "restricted-page": return "Walkthroughs cannot continue on this Chrome page.";
    case "stale-evidence": return "The page evidence is stale. Continue for a fresh view.";
    default: return "Walkthrough paused.";
  }
}

function issueFromVoiceError(message: string, kind: VoiceErrorKind): UiIssue {
  if (kind === "microphone") return { kind: "microphone", message };
  if (kind === "host" || kind === "permission") return { kind: "helper", message };
  if (kind === "key") return { kind: "key", message };
  return { kind: "realtime", message };
}

function hostFailureKind(code: string): Exclude<VoiceErrorKind, "microphone" | "session"> {
  if (code === "PERMISSION_REQUIRED") return "permission";
  if (code === "NOT_CONFIGURED" || code === "INVALID_API_KEY" || code === "SECURE_STORAGE_ERROR") return "key";
  if (code === "RATE_LIMITED" || code === "UPSTREAM_ERROR") return "realtime";
  return "host";
}

function classifyQuestionError(message: string): UiIssue["kind"] {
  const lower = message.toLowerCase();
  if (lower.includes("helper") || lower.includes("native host")) return "helper";
  if (lower.includes("key")) return "key";
  if (lower.includes("page") || lower.includes("tab") || lower.includes("access")) return "page";
  return "realtime";
}

function hostError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  return typeof value.error === "string" && value.error.length <= 500 ? value.error : fallback;
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message.slice(0, 500) : fallback;
}

async function microphonePermissionState(): Promise<"granted" | "prompt" | "denied" | "unknown"> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
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

async function fetchSiteMemory(origin: string): Promise<SiteMemoryNote[]> {
  if (!isWebOrigin(origin)) return [];
  try {
    const response = await withDeadline(
      runtimeSend<unknown>({ type: "GUIDE_HOST_MEMORY_GET", origin }),
      2_000,
      "Site memory was not available in time.",
    );
    return isHostMemoryGetResponse(response) && response.ok ? response.notes : [];
  } catch {
    return [];
  }
}

function speakLocally(text: string): void {
  const clean = text.trim();
  if (!clean || typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 4_000));
  utterance.lang = "en-US";
  speechSynthesis.speak(utterance);
}

function stopSpeaking(): void {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

function publishAgentEyes(context: PageContext): void {
  const safe = sanitizePageContext(context);
  const evidence = JSON.stringify(contextForModel(safe)).slice(0, 200_000);
  if (!isWebOrigin(safe.origin) || !evidence) return;
  void runtimeSend({
    type: "GUIDE_HOST_PUBLISH_EVIDENCE",
    origin: safe.origin,
    title: safe.title.slice(0, 300),
    evidence,
  }).catch(() => undefined);
}

function rememberSiteExchange(origin: string, question: string, answer: string): void {
  const cleanQuestion = question.trim().slice(0, 2_000);
  const cleanAnswer = answer.trim().slice(0, 4_000);
  if (!isWebOrigin(origin) || !cleanQuestion || !cleanAnswer) return;
  void runtimeSend({
    type: "GUIDE_HOST_MEMORY_APPEND",
    origin,
    question: cleanQuestion,
    answer: cleanAnswer,
  }).catch(() => undefined);
}

function requestPermission(permission: "nativeMessaging"): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.request({ permissions: [permission] }, (granted) => {
      const error = chrome.runtime.lastError;
      resolve(error ? false : granted);
    });
  });
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
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

function makeId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Browser Guide root element is missing.");
createRoot(rootElement).render(<BrowserGuideApp />);
