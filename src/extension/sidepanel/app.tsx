import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GuidanceCommand, ShowGuidanceCommand } from "../../shared/assistant-contract.js";
import { contextForModel, isPageContext, type PageContext } from "../../shared/page-context.js";
import { sanitizePageContext } from "../../shared/sanitization.js";
import {
  isHostCompleteResponse,
  isHostConfigureResponse,
  isHostCreateSessionResponse,
  isHostCredentialSourcesResponse,
  isHostTranscribeResponse,
  isHostForgetResponse,
  isHostHealthResponse,
  isHostImportResponse,
  isHostMemoryClearResponse,
  isHostMemoryGetResponse,
  isWebOrigin,
  type CompletionMessage,
  type CredentialProvider,
  type NativeAccountIdentity,
  type NativeCredentialSource,
  type SiteMemoryNote,
} from "../../shared/native-protocol.js";
import {
  CompletionBrokerError,
  LocalClaudeSession,
  type CompletionBroker,
  type CompletionResponseBlock,
} from "./claude-session.js";
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
import { MAX_RECORDING_MS, SessionBrokerError, VoiceSession, type GuideUiState, type RealtimeMode, type SessionBroker, type VoiceErrorKind, type VoiceSessionCallbacks } from "./voice-session.js";
import { formatElapsed, startVoiceCapture, type VoiceCapture } from "./voice-capture.js";

/**
 * "helper-missing" means Chrome has no manifest for the helper, so installing
 * is the fix. "helper-unreachable" means it is installed and did not answer,
 * so retrying is. They were one state until a storage error and a timeout both
 * rendered "Connect a credential", which sends people to reconnect a sign-in
 * that was never the problem.
 */
type SetupState = "booting" | "helper-missing" | "helper-unreachable" | "permission-needed" | "key-missing" | "demo" | "ready";

/**
 * Which credential answers. "realtime" is OpenAI over WebRTC; "claude" is the
 * Anthropic sign-in this computer already holds, relayed by the helper. The
 * product is the same either way, and the panel never asks anyone to choose.
 */
type GuideEngine = "realtime" | "claude";
type ToolbarState = "Ready" | "Guiding" | "Listening" | "Paused" | "Not shared" | "Demo" | "Unavailable";

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
  /** A step forward rather than a failure. Rendered plainly, never in red. */
  tone?: "note";
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

/**
 * How long to wait before each silent re-check of a helper that did not
 * answer. Four attempts across roughly fourteen seconds covers the window
 * Chrome needs to settle after an install without leaving anyone watching a
 * spinner if the helper is truly gone.
 */
const UNREACHABLE_RETRY_DELAYS_MS = [500, 1_500, 4_000, 8_000];

const MODE_HINTS: Record<GuideMode, string> = {
  ask: "Explain what is on this page",
  find: "Point to the right control",
  walkthrough: "Step-by-step, one control at a time",
};

const PLACEHOLDERS: Record<GuideMode, string> = {
  ask: "Ask this page…",
  find: "What should I find?",
  walkthrough: "What do you want to do?",
};

const TOUR_GOAL = "Show me around this page";
const PRACTICE_URL = "https://docs.crawlio.app/browser-guide/practice";

/**
 * The Claude engine's transport. Both calls go to the local helper, which
 * holds the credential and relays them; the panel never sees a token, exactly
 * as with Realtime.
 */
class RuntimeCompletionBroker implements CompletionBroker {
  async complete(messages: CompletionMessage[]): Promise<{ content: CompletionResponseBlock[]; stopReason: string }> {
    const response = await runtimeSend<unknown>({ type: "GUIDE_HOST_COMPLETE", messages });
    if (!isHostCompleteResponse(response) || !response.ok) {
      const code = isRecord(response) && typeof response.code === "string" ? response.code : "INVALID_RESPONSE";
      throw new CompletionBrokerError(
        hostFailureKind(code),
        code,
        hostError(response, "The local helper could not reach Claude."),
      );
    }
    return { content: response.content as CompletionResponseBlock[], stopReason: response.stopReason };
  }

  async transcribe(wavBase64: string): Promise<string> {
    const response = await runtimeSend<unknown>({ type: "GUIDE_HOST_TRANSCRIBE", audio: wavBase64, format: "wav" });
    if (!isHostTranscribeResponse(response) || !response.ok) {
      const code = isRecord(response) && typeof response.code === "string" ? response.code : "INVALID_RESPONSE";
      throw new CompletionBrokerError(
        hostFailureKind(code),
        code,
        hostError(response, "Speech could not be transcribed on this computer."),
      );
    }
    return response.transcript;
  }
}

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
  const [recordingMs, setRecordingMs] = useState(0);
  const demoStateRef = useRef<{ stepIndex: number } | null>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [account, setAccount] = useState<NativeAccountIdentity | null>(null);
  /** Which engine answers. Chosen once per health check, never by the user. */
  const [engine, setEngine] = useState<GuideEngine>("realtime");
  /** Null until asked, and after a helper too old to answer: both mean "show every option". */
  const [sources, setSources] = useState<NativeCredentialSource[] | null>(null);
  /**
   * Bumped by sign-out. Anything that was already in flight compares the epoch
   * it started with before writing state, so a late answer cannot revive a
   * session the person just ended.
   */
  const authEpoch = useRef(0);
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
  const voiceStateRef = useRef<GuideUiState>("idle");
  const captureRef = useRef<VoiceCapture | null>(null);
  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  const transientKeyInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const walkthroughCoordinator = useRef(new WalkthroughCoordinator());
  const refreshTimer = useRef<number | null>(null);
  const walkthroughDeadlineTimer = useRef<number | null>(null);
  const advanceWalkthroughRef = useRef<() => Promise<void>>(async () => undefined);
  const lastVoiceContext = useRef<PageContext | null>(null);
  const submittingQuestion = useRef(false);
  const startingVoice = useRef(false);
  const continuingWalkthrough = useRef(false);
  runtimeRef.current = runtime;
  speakAnswersRef.current = speakAnswers;
  voiceStateRef.current = voiceState;

  const broker = useMemo(() => new RuntimeSessionBroker(), []);
  const completionBroker = useMemo(() => new RuntimeCompletionBroker(), []);

  const updateEntry = useCallback((id: string, updater: (entry: ConversationEntry) => ConversationEntry) => {
    setEntries((current) => current.map((entry) => entry.id === id ? updater(entry) : entry));
  }, []);

  const appendEntry = useCallback((entry: ConversationEntry) => {
    setEntries((current) => [...current, entry].slice(-30));
  }, []);

  const sessionCallbacks = useMemo<VoiceSessionCallbacks>(() => ({
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
  }), [appendEntry, updateEntry]);

  /**
   * One conversation, two engines. Realtime when an OpenAI credential is
   * configured; otherwise the Claude sign-in already on this computer, relayed
   * by the helper. Both implement the same turn contract, so everything below
   * this line is engine-agnostic.
   */
  const session = useMemo(
    () => engine === "claude"
      ? new LocalClaudeSession(completionBroker, sessionCallbacks)
      : new VoiceSession(broker, sessionCallbacks),
    [broker, completionBroker, engine, sessionCallbacks],
  );

  // Swapping engines must not leave the previous one holding a live session.
  useEffect(() => () => { void session.close(); }, [session]);

  const toggleSpeakAnswers = useCallback(() => {
    setSpeakAnswers((current) => {
      if (current) stopSpeaking();
      return !current;
    });
  }, []);

  const refreshHost = useCallback(async (showBoot = true) => {
    // A sign-out that lands while this is in flight must win. Without the
    // epoch, a health answer that was already on its way would put the panel
    // back to ready seconds after the credential was removed.
    const epoch = authEpoch.current;
    if (showBoot) setSetup("booting");
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_HEALTH" }),
        8_000,
        "The local helper did not answer within eight seconds.",
      );
      if (epoch !== authEpoch.current) return;
      if (!isHostHealthResponse(response) || !response.ok) {
        if (isHostHealthResponse(response) && !response.ok && response.code === "PERMISSION_REQUIRED") {
          setSetup("permission-needed");
          return;
        }
        // Only the helper saying so counts as "no credential". A store it
        // could not read, a timeout, or a dropped connection all mean the
        // answer is unknown, and answering "unknown" with "connect a
        // credential" is how a working sign-in gets thrown away.
        if (isHostHealthResponse(response) && !response.ok
          && (response.code === "NOT_CONFIGURED" || response.code === "INVALID_API_KEY")) {
          setAccount(null);
          setSetup("key-missing");
          setIssue({ kind: "key", message: response.error });
          return;
        }
        const code = isHostHealthResponse(response) && !response.ok ? response.code : "INVALID_RESPONSE";
        const notInstalled = code === "HOST_NOT_FOUND";
        setSetup(notInstalled ? "helper-missing" : "helper-unreachable");
        setIssue(notInstalled || !restatesTheHeadline(code)
          ? {
            kind: "helper",
            message: hostError(response, notInstalled
              ? "Open Browser Guide Helper once, then check again."
              : "The local helper did not answer. Try again."),
          }
          // A dropped port, a timeout, and an unavailable host all say the same
          // thing the card already says, in transport vocabulary. Repeating it
          // in red adds alarm, not information. Reasons that differ from the
          // headline, like a store that could not be read, still show.
          : null);
        return;
      }
      setAccount(response.health.account ?? null);
      // An OpenAI credential means Realtime. Otherwise a Claude sign-in is a
      // complete product on its own, the way a ChatGPT plan is for Codex and
      // a claude.ai account is for Claude in Chrome: the subscription answers,
      // and nobody is asked for an API key.
      if (response.health.configured === true) {
        setEngine("realtime");
        setSetup("ready");
      } else if (response.health.claude === true) {
        setEngine("claude");
        setSetup("ready");
      } else {
        setSetup("key-missing");
      }
    } catch (error) {
      if (epoch !== authEpoch.current) return;
      setSetup("helper-unreachable");
      setIssue({ kind: "helper", message: errorMessage(error, "The local helper is unavailable.") });
    }
  }, []);

  // Opening the panel during an install lands in a window where the helper is
  // briefly unreachable. Asking again a moment later resolves it, so the panel
  // does that itself rather than parking on a screen whose only move is a
  // button nobody was told to press. Bounded, because a helper that is
  // genuinely down should say so instead of spinning forever, and silent,
  // because a recovery the user never noticed needs no announcement.
  useEffect(() => {
    if (setup !== "helper-unreachable") return;
    let cancelled = false;
    let timer = 0;
    const attemptAfter = (attempt: number): void => {
      if (cancelled || attempt >= UNREACHABLE_RETRY_DELAYS_MS.length) return;
      timer = window.setTimeout(() => {
        void refreshHost(false)
          .catch(() => undefined)
          .then(() => {
            if (!cancelled) attemptAfter(attempt + 1);
          });
      }, UNREACHABLE_RETRY_DELAYS_MS[attempt]);
    };
    attemptAfter(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshHost, setup]);

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

  const endCapture = useCallback((discard: boolean) => {
    const capture = captureRef.current;
    captureRef.current = null;
    setRecordingMs(0);
    if (!capture) return;
    if (discard) capture.cancel();
    else void capture.stop().catch(() => undefined);
  }, []);

  const beginCapture = useCallback(async () => {
    setRecordingMs(0);
    // Realtime streams the microphone itself and lends us the stream to draw.
    // The Claude engine transcribes on this computer, so the panel opens the
    // microphone, keeps the samples, and owns closing it.
    const borrowed = session instanceof VoiceSession ? session.microphoneStream : null;
    if (session instanceof VoiceSession && !borrowed) return;
    try {
      const stream = borrowed ?? await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // The waveform reads the same stream the model hears, so a flat strip
      // always means the microphone, not the visualisation.
      captureRef.current = await startVoiceCapture(stream, {
        canvas: waveformRef.current,
        onSecond: setRecordingMs,
        recordPcm: borrowed === null,
        ownsStream: borrowed === null,
      });
    } catch {
      // A missing AudioContext only costs the waveform, never the recording.
    }
  }, [session]);

  const sendRecording = useCallback(() => {
    if (session instanceof LocalClaudeSession) {
      const capture = captureRef.current;
      const context = lastVoiceContext.current;
      captureRef.current = null;
      setRecordingMs(0);
      if (!capture || !context) {
        session.cancelListening();
        return;
      }
      void capture.stop().then(async (wav) => {
        if (!wav) {
          session.cancelListening();
          return;
        }
        await session.submitRecording(base64FromBytes(wav), context);
      }).catch(() => session.cancelListening());
      return;
    }
    endCapture(false);
    session.stopListening();
  }, [endCapture, session]);

  const cancelRecording = useCallback(() => {
    endCapture(true);
    session.cancelListening();
  }, [endCapture, session]);
  const cancelRecordingRef = useRef(cancelRecording);
  cancelRecordingRef.current = cancelRecording;

  const openMicrophoneGuide = useCallback(() => {
    window.open(chrome.runtime.getURL("welcome.html#microphone"));
  }, []);

  const toggleListening = useCallback(async () => {
    if (setup !== "ready" || demoStateRef.current) return;
    if (voiceState === "listening") {
      sendRecording();
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
      // The Claude engine answers after the recording ends, so the evidence
      // this turn opened with has to survive until then.
      lastVoiceContext.current = context;
      if (session instanceof LocalClaudeSession) {
        // Opening the microphone takes a moment, and on this engine the panel
        // is the recorder. Doing it after the panel says "listening" meant
        // the first word was spoken into a device that was not capturing yet,
        // so the microphone comes up first and the turn opens once it is live.
        await beginCapture();
        await session.startListening(context, mode);
      } else {
        await session.startListening(context, mode);
        await beginCapture();
      }
    } catch {
      // VoiceSession emits a cause-specific error and always closes partial media.
    } finally {
      startingVoice.current = false;
    }
  }, [beginCapture, capturePage, mode, openMicrophoneGuide, sendRecording, session, setup, voiceState]);

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
      if (document.visibilityState === "visible") {
        // Silent: it either restores a grant we still hold or leaves the
        // banner exactly as it was.
        if (runtimeRef.current.status === "permission-paused"
          && runtimeRef.current.pauseReason !== "restricted-page") {
          void runtimeSend<unknown>({ type: "GUIDE_RESUME_REQUEST" }).then((response) => {
            if (isRecord(response) && isExtensionRuntimeState(response.state)) setRuntime(response.state);
          }).catch(() => undefined);
        }
        return;
      }
      if (document.visibilityState !== "hidden") return;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      activeEvidenceSnapshotId.current = null;
      if (walkthroughCoordinator.current.session) setWalkthrough(walkthroughCoordinator.current.pause("user"));
      void runtimeSend({ type: "GUIDE_CLEAR_GUIDANCE" }).catch(() => undefined);
      // Switching windows must not cut an answer off mid-sentence: a session
      // that is still talking or working keeps running until it finishes.
      if (session.busy || voiceStateRef.current === "speaking") return;
      void session.close();
    };
    const escapeListener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || voiceStateRef.current !== "listening") return;
      event.preventDefault();
      event.stopPropagation();
      cancelRecordingRef.current();
    };
    document.addEventListener("keydown", escapeListener, true);
    document.addEventListener("visibilitychange", visibilityListener);
    return () => {
      mounted = false;
      if (transientKeyInput.current) transientKeyInput.current.value = "";
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (walkthroughDeadlineTimer.current !== null) window.clearTimeout(walkthroughDeadlineTimer.current);
      turnEntryIds.current.clear();
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener("keydown", escapeListener, true);
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

  /**
   * Which sign-ins this computer actually has. A helper installed before this
   * request existed answers with an error, and that is not a failure: the
   * setup screen simply falls back to offering every option it supports.
   */
  const loadCredentialSources = useCallback(async () => {
    const epoch = authEpoch.current;
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_CREDENTIAL_SOURCES" }),
        8_000,
        "The helper did not answer in time.",
      );
      if (epoch !== authEpoch.current) return;
      if (isHostCredentialSourcesResponse(response) && response.ok) setSources(response.sources);
      else setSources(null);
    } catch {
      setSources(null);
    }
  }, []);

  // Ask what is on this computer only when there is a sign-in to choose, so
  // the Keychain read this costs on macOS never runs on a normal panel open.
  useEffect(() => {
    if (setup !== "key-missing" || sources !== null) return;
    void loadCredentialSources();
  }, [loadCredentialSources, setup, sources]);

  const importCredentials = useCallback(async (provider: CredentialProvider) => {
    if (keyBusy) return;
    const epoch = authEpoch.current;
    setKeyBusy(true);
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_IMPORT_CREDENTIALS", provider }),
        10_000,
        "The sign-in import did not finish in time.",
      );
      if (epoch !== authEpoch.current) return;
      if (!isHostImportResponse(response) || !response.ok) {
        throw new Error(hostError(response, "The sign-in could not be imported."));
      }
      if (response.account) setAccount(response.account);
      if (response.configured) {
        setEngine("realtime");
        setSetup("ready");
      } else if (response.provider === "claude-code") {
        // The sign-in that just landed is enough to run the whole product.
        setEngine("claude");
        setSetup("ready");
      } else {
        // The import worked. Saying so in red taught people that a button that
        // did its job had failed, and left them clicking it again.
        const who = response.account?.plan
          ? `${providerName(response.provider)} (${response.account.plan})`
          : providerName(response.provider);
        setIssue({
          kind: "key",
          tone: "note",
          message: `${who} is connected and stored on this Mac. Answering still needs an OpenAI credential, so add a key below to finish.`,
        });
        // What is connected has changed, so what setup should offer has too.
        void loadCredentialSources();
      }
    } catch (error) {
      if (epoch !== authEpoch.current) return;
      setIssue({ kind: "key", message: errorMessage(error, "The sign-in could not be imported.") });
    } finally {
      setKeyBusy(false);
    }
  }, [keyBusy, loadCredentialSources]);

  const configureApiKey = useCallback(async () => {
    if (keyBusy) return;
    const input = transientKeyInput.current;
    const key = input?.value.trim() ?? "";
    if (key.length < 20 || key.length > 600) {
      setIssue({ kind: "key", message: "Paste a valid OpenAI Platform API key." });
      return;
    }
    if (input) input.value = "";
    const epoch = authEpoch.current;
    setKeyPresent(false);
    setKeyBusy(true);
    setIssue(null);
    try {
      const response = await withDeadline(
        runtimeSend<unknown>({ type: "GUIDE_HOST_CONFIGURE_KEY", key }),
        8_000,
        "Saving did not finish within eight seconds. Try again.",
      );
      if (epoch !== authEpoch.current) return;
      if (!isHostConfigureResponse(response) || !response.ok) {
        throw new Error(hostError(response, "The key could not be saved."));
      }
      setAccount(null);
      setSetup("ready");
    } catch (error) {
      if (epoch !== authEpoch.current) return;
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
        setIssue({ kind: "page", message: "The tour runs on the practice page, which just opened. Click the toolbar icon there, then press Practice tour again." });
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
    if (!window.confirm(account?.label
      ? `Disconnect ${account.label}? The credential is removed from this Mac. Your ${providerName(account.provider)} sign-in itself is untouched.`
      : "Disconnect the stored credential from this Mac? The harness sign-in it came from is untouched.")) return;
    // Bump first: from here on, any health or import answer still in flight
    // belongs to the session that just ended and must not be applied.
    authEpoch.current += 1;
    const response = await runtimeSend<unknown>({ type: "GUIDE_HOST_FORGET_KEY" });
    if (!isHostForgetResponse(response) || !response.ok) {
      setIssue({ kind: "key", message: hostError(response, "The credential could not be removed.") });
      return;
    }
    await clearConversation();
    setAccount(null);
    setSources(null);
    setSetup("key-missing");
  }, [account, clearConversation]);

  // Keep the newest exchange in view as answers stream in. With nothing to
  // follow there is nothing to scroll to, and scrolling anyway pushed the
  // banner that explains a paused tab out of sight.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace && entries.length > 0) workspace.scrollTop = workspace.scrollHeight;
  }, [entries, walkthrough]);

  const toolbarState: ToolbarState = setup === "demo"
    ? (demoActive && walkthrough?.phase !== "paused" ? "Guiding" : "Demo")
    : setup !== "ready"
      ? "Unavailable"
      // A tab that was never shared is not a paused session: naming it that
      // way is the whole reason "why is it paused?" has no answer on screen.
      : runtime.status === "permission-paused"
        ? "Not shared"
        : walkthrough?.phase === "paused"
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
          sources={sources}
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
  const isRecording = voiceState === "listening";
  const inDemo = setup === "demo";
  const composerLocked = pagePaused || inDemo || demoActive;
  // Warn while the sign-in still works. We cannot refresh it ourselves, so the
  // only useful moment to say anything is before it stops.
  const signInExpiry = expiryNotice(account);
  return (
    <main className="guide-shell" data-toolbar-state={toolbarState.toLowerCase().replace(" ", "-")}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>
      <header className="instrument-bar">
        <div className="instrument-state" title={pageTitle ?? "Current tab"}>
          <span className="beacon-dot" aria-hidden="true" />
          <span>{toolbarState}</span>
          {walkthrough && <span className="step-count">{walkthrough.step}/12</span>}
          {agentEyes && <span className="eyes-indicator" role="status" title="Local coding agents can read the captured page snapshot">Eyes on</span>}
          {/* Who is answering, and therefore where the page evidence goes.
              Both shipped assistants surface the account somewhere; leaving it
              invisible meant nobody could tell which credential was in use, or
              that it is the Mac's rather than this Chrome profile's. */}
          {!inDemo && account && (
            <span className="account-chip" title={connectedAsTitle(account, engine)}>
              {account.label ?? providerName(account.provider)}
            </span>
          )}
        </div>
        <div className="instrument-actions">
          <button type="button" className="icon-button" onClick={() => void clearConversation()} aria-label="Clear session" title="Clear session"><ToolbarIcon kind="reset" /></button>
          <button type="button" className="icon-button" onClick={() => void clearSiteMemory()} aria-label="Clear site memory" title="Clear site memory"><ToolbarIcon kind="memory" /></button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void forgetKey()}
            aria-label={account ? `Disconnect ${account.label ?? providerName(account.provider)}` : "Disconnect the stored credential"}
            title={account
              ? `Connected with ${providerName(account.provider)}${account.label ? ` as ${account.label}` : ""}${account.plan ? ` (${account.plan})` : ""}. Click to disconnect.`
              : "Disconnect the stored credential"}
          ><ToolbarIcon kind="key" /></button>
        </div>
      </header>

      <div className="workspace" ref={workspaceRef}>
        {inDemo && (
          <section className="recovery-line demo-banner" role="status">
            <span>Demo mode. Real questions need the local helper.</span>
            <button type="button" onClick={() => void startDemoTour()}>Practice tour</button>
            <button type="button" onClick={() => {
              setSetup("booting");
              void refreshHost();
            }}>Finish setup</button>
          </section>
        )}
        {signInExpiry && (
          <section className="recovery-line" role="status">
            <span>{signInExpiry}</span>
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
              <CrawlioMark className="brand-mark empty-mark" />
              <h1>{pagePaused ? "Share this tab to begin" : "Ask about this page"}</h1>
              <div className="intent-launcher" aria-label="Guide modes">
                {(["ask", "find", "walkthrough"] as const).map((value) => (
                  <button key={value} type="button" disabled={inDemo || pagePaused} onClick={() => {
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
                Take the guided tour on a practice page
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
              {entry.answer && <p className="guide-answer">{entry.answer}</p>}
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
          <button
            type="button"
            className={`chip-toggle visual-toggle${shareVisual ? " on" : ""}`}
            aria-pressed={shareVisual}
            title="Include a screenshot with the page evidence. Omitted whenever sensitive content is visible."
            onClick={() => setShareVisual((current) => !current)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.6" y="4.6" width="14.8" height="11" rx="2.4" />
              <circle cx="10" cy="10.1" r="2.9" />
            </svg>
            <span>Visual</span>
          </button>
          <button
            type="button"
            className={`chip-toggle eyes-toggle${agentEyes ? " on" : ""}`}
            aria-pressed={agentEyes}
            title="Share the current page snapshot with local coding agents (Claude Code, Codex) through a private local file. Off deletes it."
            onClick={toggleAgentEyes}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z" />
              <circle cx="10" cy="10" r="2.5" />
            </svg>
            <span>Eyes</span>
          </button>
        </div>
        {isRecording ? (
          <RecordingBar
            canvasRef={waveformRef}
            elapsedMs={recordingMs}
            onCancel={cancelRecording}
            onSend={sendRecording}
          />
        ) : (
        <form className="composer" onSubmit={(event) => {
          event.preventDefault();
          void submitQuestion();
        }}>
          <button
            className="voice-beacon"
            type="button"
            aria-label="Ask by voice"
            title="Ask by voice · ⌘⇧G"
            disabled={composerLocked || voiceState === "thinking" || voiceState === "speaking" || voiceState === "pointing"}
            onClick={() => void toggleListening()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="7.4" y="2.6" width="5.2" height="9.2" rx="2.6" />
              <path d="M4.8 9.4a5.2 5.2 0 0 0 10.4 0M10 14.6v2.8" />
            </svg>
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
        )}
      </footer>
    </main>
  );
}

interface SetupViewProps {
  state: SetupState;
  issue: UiIssue | null;
  keyBusy: boolean;
  keyPresent: boolean;
  sources: NativeCredentialSource[] | null;
  keyInput: React.RefObject<HTMLInputElement | null>;
  onKeyPresent(value: boolean): void;
  onConfigureKey(): Promise<void>;
  onImport(provider: CredentialProvider): Promise<void>;
  onPermission(): Promise<void>;
  onRetry(showBoot?: boolean): Promise<void>;
  onDemo(): void;
}

/** Transport codes whose message only repeats "the helper did not answer". */
function restatesTheHeadline(code: string): boolean {
  return code === "HOST_UNAVAILABLE" || code === "HOST_DISCONNECTED" || code === "TIMEOUT";
}

const PROVIDER_NAMES: Record<CredentialProvider, string> = {
  "codex": "Codex",
  "claude-code": "Claude Code",
};

function providerName(provider: CredentialProvider): string {
  return PROVIDER_NAMES[provider];
}

/**
 * The whole truth about the connection, in a tooltip: who, on what plan, which
 * model answers, and that the credential belongs to this Mac rather than to
 * this Chrome profile. That last part surprises people who open a second
 * profile and are never asked to sign in.
 */
function connectedAsTitle(account: NativeAccountIdentity, engine: GuideEngine): string {
  const who = account.label ? `${providerName(account.provider)} as ${account.label}` : providerName(account.provider);
  const plan = account.plan ? ` on ${account.plan}` : "";
  const answers = engine === "claude" ? "Claude answers." : "OpenAI Realtime answers.";
  return `Connected with ${who}${plan}. ${answers} The sign-in is stored on this Mac, so every Chrome profile here shares it.`;
}

/** A sign-in is close enough to expiry to be worth mentioning: two weeks. */
const EXPIRY_NOTICE_MS = 14 * 24 * 60 * 60 * 1_000;

function expiryNotice(account: NativeAccountIdentity | null): string | null {
  if (!account?.expiresAt) return null;
  const remaining = account.expiresAt - Date.now();
  if (remaining > EXPIRY_NOTICE_MS) return null;
  const source = providerName(account.provider);
  if (remaining <= 0) return `Your ${source} sign-in has expired. Open ${source} once to renew it, then reconnect here.`;
  const days = Math.max(1, Math.round(remaining / (24 * 60 * 60 * 1_000)));
  return `Your ${source} sign-in expires in ${days} ${days === 1 ? "day" : "days"}. Open ${source} once to renew it.`;
}

const INSTALL_COMMAND = "npx crawlio-browser-guide init";
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/** WAV bytes to base64, in chunks so a long recording cannot blow the stack. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

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

function CrawlioMark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 324 250" role="img" aria-label="Crawlio">
      <path d="M67.5441 55.8643C47.4515 61.2723 32.6209 46.2677 17 61.8887C1.379 77.5097 10.5521 93.6713 10.9755 112.433L130.415 234.573C142.709 246.867 161.65 237.78 177.271 222.159C192.892 206.539 195.589 183.909 183.295 171.615L67.5441 55.8643Z" fill="#FF5524" />
      <path d="M201.527 39.882C201.527 20.801 189.396 1.1473 161.18 0C141.632 0 123.896 13.6579 121.527 39.3971L120.818 199.161C120.752 214.037 124.964 229.255 136.849 238.2C143.761 243.402 152.354 247.851 161.527 247.851C177.231 247.851 185.084 240.612 192.391 229.162C198.846 219.046 201.527 206.998 201.527 194.998V39.882Z" fill="#8337FF" />
      <path d="M310.364 116.84C323.541 103.664 325.88 79.6389 308.354 62.1132C292.78 46.5387 268.037 46.0305 254.861 59.2068L132.235 181.832C119.059 195.008 121.003 218.316 136.578 233.89C152.152 249.465 175.459 251.409 188.636 238.232L310.364 116.84Z" fill="#2EB6FF" />
      <path d="M161.527 249.248C183.918 249.248 202.069 231.097 202.069 208.706C202.069 186.315 183.918 168.163 161.527 168.163C139.136 168.163 120.984 186.315 120.984 208.706C120.984 231.097 139.136 249.248 161.527 249.248Z" fill="#ABFF50" />
      <path d="M161.527 80C183.619 80 201.527 62.0914 201.527 40C201.527 17.9086 183.619 0 161.527 0C139.436 0 121.527 17.9086 121.527 40C121.527 62.0914 139.436 80 161.527 80Z" fill="#9C60FF" />
      <path d="M283.283 127.292C305.375 127.292 323.283 109.383 323.283 87.292C323.283 65.2006 305.375 47.292 283.283 47.292C261.192 47.292 243.283 65.2006 243.283 87.292C243.283 109.383 261.192 127.292 283.283 127.292Z" fill="#58C5FF" />
      <path d="M40 124.893C62.0914 124.893 80 106.984 80 84.8926C80 62.8012 62.0914 44.8926 40 44.8926C17.9086 44.8926 0 62.8012 0 84.8926C0 106.984 17.9086 124.893 40 124.893Z" fill="#FF7750" />
    </svg>
  );
}

function RecordingBar(props: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  elapsedMs: number;
  onCancel(): void;
  onSend(): void;
}): React.ReactElement {
  const remainingMs = Math.max(0, MAX_RECORDING_MS - props.elapsedMs);
  const endingSoon = remainingMs <= 10_000;
  return (
    <div className="recorder" role="group" aria-label="Recording">
      <p className="sr-only" role="status">Recording. Press send when you finish speaking, or Escape to discard.</p>
      <button
        type="button"
        className="recorder-cancel"
        onClick={props.onCancel}
        aria-label="Discard recording"
        title="Discard (Esc)"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
      </button>
      <canvas className="recorder-wave" ref={props.canvasRef} aria-hidden="true" />
      <span className={`recorder-time${endingSoon ? " ending" : ""}`}>
        {endingSoon ? `-${formatElapsed(remainingMs)}` : formatElapsed(props.elapsedMs)}
      </span>
      <button
        type="button"
        className="recorder-send"
        onClick={props.onSend}
        aria-label="Send recording"
        title="Send"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5V4.8M5.4 9.4 10 4.6l4.6 4.8" /></svg>
      </button>
    </div>
  );
}

/**
 * Sign-in leads with what this computer actually has. Both shipped assistants
 * do the same thing in their own way: neither offers a menu of every provider
 * it supports, and neither puts an API key beside the sign-in as an equal
 * choice. When the helper cannot tell us what is present, every option comes
 * back, because a wrong guess would hide the only route someone has.
 */
function SignInOptions(props: SetupViewProps): React.ReactElement {
  const [keyOpen, setKeyOpen] = useState(false);
  const known = props.sources !== null;
  const buttons: Array<{ provider: CredentialProvider; label?: string }> = known
    ? (props.sources ?? []).filter((source) => source.available)
      .map((source) => ({ provider: source.provider, label: source.label }))
    : [{ provider: "codex" }, { provider: "claude-code" }];
  const missing = known ? (props.sources ?? []).filter((source) => !source.available) : [];

  return (
    <form className="key-form" onSubmit={(event) => {
      event.preventDefault();
      void props.onConfigureKey();
    }}>
      {buttons.length > 0 && (
        <div className="signin-options">
          {buttons.map((source, index) => (
            <button
              key={source.provider}
              type="button"
              className={index === 0 ? "signin-button primary" : "signin-button"}
              disabled={props.keyBusy}
              onClick={() => void props.onImport(source.provider)}
            >
              <span>Continue with {providerName(source.provider)}</span>
              {source.label ? <small>{source.label}</small> : null}
            </button>
          ))}
        </div>
      )}

      {known && buttons.length === 0 && (
        <p className="signin-empty">
          No harness sign-in was found on this computer. Sign in to Codex or Claude Code, then check again, or paste a key below.
        </p>
      )}
      {missing.length > 0 && buttons.length > 0 && (
        <ul className="signin-absent">
          {missing.map((source) => (
            <li key={source.provider}>{providerName(source.provider)}: {source.detail ?? "not found on this computer"}</li>
          ))}
        </ul>
      )}

      {keyOpen ? (
        <>
          <label htmlFor="platform-key">OpenAI API key</label>
          {/* The one web sign-in we can honestly offer. Reading a key out of a
              harness only works when that harness holds one, and a ChatGPT
              plan sign-in does not: the key has to be minted here. */}
          <button
            type="button"
            className="signin-link"
            onClick={() => window.open(OPENAI_KEYS_URL, "_blank", "noopener")}
          >Get a key at platform.openai.com</button>
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
        </>
      ) : (
        <button className="setup-secondary" type="button" onClick={() => setKeyOpen(true)}>
          Paste an API key instead
        </button>
      )}
    </form>
  );
}

function SetupView(props: SetupViewProps): React.ReactElement {
  const copy = setupCopy(props.state);
  return (
    <section className="setup-card" aria-labelledby="setup-title" aria-busy={props.state === "booting" || props.keyBusy}>
      <CrawlioMark className="brand-mark setup-mark" />
      <p className="setup-kicker">{copy.kicker}</p>
      <h1 id="setup-title">{copy.title}</h1>
      <p className="setup-line">{copy.line}</p>

      {props.state === "key-missing" ? (
        <SignInOptions {...props} />
      ) : props.state === "permission-needed" ? (
        <button className="setup-action" type="button" onClick={() => void props.onPermission()}>Allow helper</button>
      ) : props.state === "helper-missing" ? (
        <>
          <InstallCommandRow />
          <button className="setup-action" type="button" onClick={() => void props.onRetry()}>Check again</button>
          <button className="setup-secondary" type="button" onClick={props.onDemo}>Try the demo first</button>
        </>
      ) : props.state === "helper-unreachable" ? (
        <>
          <button className="setup-action" type="button" onClick={() => void props.onRetry()}>Try again</button>
          <button className="setup-secondary" type="button" onClick={props.onDemo}>Try the demo instead</button>
        </>
      ) : <span className="setup-loader" aria-hidden="true" />}

      {props.issue && (
        <p className={props.issue.tone === "note" ? "setup-note" : "setup-error"} role="status">
          {props.issue.message}
        </p>
      )}
      <p className="setup-privacy"><span aria-hidden="true" />{copy.privacy}</p>
    </section>
  );
}

function walkthroughEyebrow(walkthrough: WalkthroughSession): string {
  if (walkthrough.phase === "complete") return "Walkthrough complete";
  if (walkthrough.phase === "paused") return `Step ${walkthrough.step} · paused`;
  if (walkthrough.step <= 1) return "Step 1";
  return `Step ${walkthrough.step}`;
}


function ModeIcon({ mode }: { mode: GuideMode }): React.ReactElement {
  if (mode === "ask") {
    return (
      <svg className="mode-glyph" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M16.6 12.2a1.9 1.9 0 0 1-1.9 1.9H6.9L3.4 17V5.7a1.9 1.9 0 0 1 1.9-1.9h9.4a1.9 1.9 0 0 1 1.9 1.9Z" />
      </svg>
    );
  }
  if (mode === "find") {
    return (
      <svg className="mode-glyph" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="9" cy="9" r="5.2" />
        <path d="M12.9 12.9 17 17" />
      </svg>
    );
  }
  return (
    <svg className="mode-glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 15.4h3.2M4 10h6.4M4 4.6h9.6" />
      <circle cx="15.6" cy="15.4" r="1.5" />
    </svg>
  );
}

function LegacyModeIcon({ mode }: { mode: GuideMode }): React.ReactElement {
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
    case "booting": return { kicker: "Local", title: "Checking setup", line: "Looking for the local helper on this computer.", privacy: "Nothing leaves Chrome yet." };
    case "helper-missing": return { kicker: "One-time setup", title: "Install the helper", line: "One command installs the local helper. Everything stays on this computer.", privacy: "Local to this computer." };
    case "helper-unreachable": return { kicker: "Local", title: "The helper did not answer", line: "It is installed but did not respond. Nothing was lost, and your sign-in is untouched.", privacy: "Nothing left this computer." };
    case "permission-needed": return { kicker: "One-time setup", title: "Allow the helper", line: "Chrome needs permission to reach the local helper.", privacy: "This extension only." };
    case "key-missing": return { kicker: "Final step", title: "Connect your sign-in", line: "Browser Guide uses a sign-in you already have. It is stored locally, never in Chrome.", privacy: "Saved to a private local file." };
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
