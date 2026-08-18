// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LocalClaudeSession, type CompletionBroker, type CompletionResponseBlock } from "../../src/extension/sidepanel/claude-session.js";
import type { GuideUiState, VoiceSessionCallbacks } from "../../src/extension/sidepanel/voice-session.js";
import type { GuideTurn } from "../../src/shared/protocol.js";
import type { PageContext } from "../../src/shared/page-context.js";

function makeContext(snapshotId = "snapshot-claude-flow"): PageContext {
  return {
    snapshotId,
    capturedAt: "2026-08-18T00:00:00.000Z",
    title: "Invoices",
    url: "https://fixture.test/invoices",
    origin: "https://fixture.test",
    viewport: { width: 1_000, height: 700, devicePixelRatio: 1 },
    elements: [{
      ref: "e1",
      role: "button",
      name: "Review invoices",
      visibility: "visible",
      section: "main",
      rect: { x: 20, y: 30, width: 140, height: 40, top: 30, right: 160, bottom: 70, left: 20 },
    }],
    truncated: false,
    characterCount: 120,
  };
}

interface Harness {
  session: LocalClaudeSession;
  states: GuideUiState[];
  turns: GuideTurn[];
  answers: Array<{ text: string; final: boolean }>;
  questions: Array<{ text: string; final: boolean }>;
  errors: Array<{ message: string; kind: string }>;
  guidance: unknown[];
  requests: unknown[][];
  spoken: string[];
}

function createHarness(
  replies: Array<{ content: CompletionResponseBlock[]; stopReason: string } | Error>,
  guidanceResult: { ok: boolean; error?: string } = { ok: true },
  transcript = "Where is Review invoices?",
): Harness {
  const requests: unknown[][] = [];
  const broker: CompletionBroker = {
    async complete(messages) {
      requests.push(messages as unknown[]);
      const reply = replies.shift();
      if (!reply) throw new Error("The test ran out of canned replies.");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async transcribe() {
      return transcript;
    },
  };

  const harness: Partial<Harness> = {
    states: [], turns: [], answers: [], questions: [], errors: [], guidance: [], requests, spoken: [],
  };
  const callbacks: VoiceSessionCallbacks = {
    onState: (state) => harness.states?.push(state),
    onUserTranscript: (text, final) => harness.questions?.push({ text, final }),
    onAssistantTranscript: (text, final) => harness.answers?.push({ text, final }),
    async onGuidance(command) {
      harness.guidance?.push(command);
      return guidanceResult;
    },
    onError: (message, kind) => harness.errors?.push({ message, kind }),
    onTurn: (turn) => harness.turns?.push({ ...turn }),
  };
  harness.session = new LocalClaudeSession(broker, callbacks, (text, onDone) => {
    harness.spoken?.push(text);
    onDone();
    return {} as SpeechSynthesisUtterance;
  });
  return harness as Harness;
}

const text = (value: string): CompletionResponseBlock => ({ type: "text", text: value });
const pointAt = (ref: string): CompletionResponseBlock => ({
  type: "tool_use",
  id: "toolu_1",
  name: "show_guidance",
  input: { refs: [ref], title: "Review invoices", body: "This button opens your invoices.", presentation: "point", waitFor: "none" },
});

describe("LocalClaudeSession", () => {
  it("answers a typed question with the Claude sign-in and nothing else", async () => {
    const harness = createHarness([{ content: [text("The invoices live under Billing.")], stopReason: "end_turn" }]);
    await harness.session.sendTyped("Where are invoices?", makeContext());
    await vi.waitFor(() => expect(harness.answers.some((a) => a.final)).toBe(true));

    expect(harness.answers.at(-1)).toEqual({ text: "The invoices live under Billing.", final: true });
    expect(harness.states).toEqual(["thinking", "idle"]);
    expect(harness.turns.map((turn) => turn.status)).toEqual(["responding", "complete"]);
    expect(harness.errors).toEqual([]);

    // The turn opens with the same evidence boundary Realtime sends, and the
    // question is the last block.
    const [firstRequest] = harness.requests;
    expect(firstRequest).toHaveLength(1);
    const opening = firstRequest?.[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(opening.role).toBe("user");
    expect(opening.content[0]?.text).toContain("BROWSER_GUIDE_PAGE_EVIDENCE");
    expect(opening.content.at(-1)?.text).toContain("Where are invoices?");
  });

  it("points at the page and then speaks, in one turn, with the result fed back", async () => {
    const harness = createHarness([
      { content: [pointAt("e1")], stopReason: "tool_use" },
      { content: [text("It is highlighted now.")], stopReason: "end_turn" },
    ]);
    await harness.session.sendTyped("Find review invoices", makeContext(), "find");
    await vi.waitFor(() => expect(harness.answers.some((a) => a.final)).toBe(true));

    expect(harness.guidance).toHaveLength(1);
    expect(harness.states).toContain("pointing");
    expect(harness.turns.map((turn) => turn.status)).toEqual(["responding", "pointing", "responding", "complete"]);

    // Second round carries the assistant's tool_use and our tool_result.
    const second = harness.requests[1] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second).toHaveLength(3);
    expect(second[1]?.role).toBe("assistant");
    expect(second[2]?.content[0]?.type).toBe("tool_result");
    expect(second[2]?.content[0]?.tool_use_id).toBe("toolu_1");
    expect(JSON.parse(String(second[2]?.content[0]?.content))).toEqual({ ok: true });
  });

  it("refuses a tool call the read-only contract does not recognise", async () => {
    const harness = createHarness([
      { content: [{ type: "tool_use", id: "toolu_x", name: "click_button", input: { ref: "e1" } }], stopReason: "tool_use" },
      { content: [text("I cannot click for you.")], stopReason: "end_turn" },
    ]);
    await harness.session.sendTyped("Click it", makeContext());
    await vi.waitFor(() => expect(harness.answers.some((a) => a.final)).toBe(true));

    // The page was never touched, and the model was told why.
    expect(harness.guidance).toEqual([]);
    const second = harness.requests[1] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(JSON.parse(String(second[2]?.content[0]?.content))).toEqual({
      ok: false,
      error: "Tool call rejected by the read-only contract.",
    });
  });

  it("transcribes a recording on this computer and answers it aloud", async () => {
    const harness = createHarness([{ content: [text("It is in the top right.")], stopReason: "end_turn" }]);
    const context = makeContext();
    await harness.session.startListening(context, "ask");
    expect(harness.states).toEqual(["listening"]);

    await harness.session.submitRecording("UklGRiQAAABXQVZF", context);
    expect(harness.questions.at(-1)).toEqual({ text: "Where is Review invoices?", final: true });
    expect(harness.spoken).toEqual(["It is in the top right."]);
    expect(harness.states).toEqual(["listening", "thinking", "speaking", "idle"]);
  });

  it("drops a recording that captured no speech without asking anything", async () => {
    const harness = createHarness([], { ok: true }, "   ");
    const context = makeContext();
    await harness.session.startListening(context, "ask");
    await harness.session.submitRecording("UklGRiQAAABXQVZF", context);

    expect(harness.requests).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(harness.turns.at(-1)?.status).toBe("superseded");
    expect(harness.session.busy).toBe(false);
  });

  it("surfaces a helper failure as a failed turn the user can retry", async () => {
    const harness = createHarness([new Error("Your Claude sign-in expired. Open Claude Code once to refresh it.")]);
    await harness.session.sendTyped("Where are invoices?", makeContext());
    await vi.waitFor(() => expect(harness.errors).toHaveLength(1));

    expect(harness.errors[0]?.message).toContain("Claude sign-in expired");
    expect(harness.turns.at(-1)?.status).toBe("failed");
    expect(harness.session.busy).toBe(false);
    expect(harness.states.at(-1)).toBe("idle");
  });

  it("never points at the page for a turn that was abandoned first", async () => {
    // The answer is held until the turn has already been superseded, which is
    // the ordering that matters: guidance must be checked against the live
    // turn, not the one that asked.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const broker: CompletionBroker = {
      async complete() {
        await held;
        return { content: [pointAt("e1")], stopReason: "tool_use" };
      },
      async transcribe() { return ""; },
    };
    const guidance: unknown[] = [];
    const session = new LocalClaudeSession(broker, {
      onState: () => undefined,
      onUserTranscript: () => undefined,
      onAssistantTranscript: () => undefined,
      async onGuidance(command) {
        guidance.push(command);
        return { ok: true };
      },
      onError: () => undefined,
    });

    await session.sendTyped("Find it", makeContext(), "find");
    await session.supersedeActiveTurn();
    release();
    await new Promise((settle) => setTimeout(settle, 20));

    expect(guidance).toEqual([]);
    expect(session.busy).toBe(false);
  });
});
