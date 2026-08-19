#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const logPath = process.env.BROWSER_GUIDE_TEST_HOST_LOG;
if (logPath) appendFileSync(logPath, `start ${JSON.stringify(process.argv.slice(2))}\n`);

const maximumFrameBytes = 1_048_576;
let pending = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  if (logPath) appendFileSync(logPath, `data ${chunk.length}\n`);
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (length < 2 || length > maximumFrameBytes) process.exit(18);
    if (pending.length < length + 4) return;
    const payload = pending.subarray(4, length + 4);
    pending = pending.subarray(length + 4);
    let request;
    try {
      request = JSON.parse(payload.toString("utf8"));
    } catch {
      process.exit(19);
    }
    respond(request);
  }
});

process.stdin.on("end", () => {
  if (pending.length !== 0) process.exitCode = 20;
});

const memoryNotes = new Map();
let sourcePolls = 0;
let importedOpenAI = false;

function respond(request) {
  const base = { version: 1, requestId: request.requestId, ok: true };
  switch (request.type) {
    case "HOST_HEALTH": {
      // Legacy mode reproduces a helper installed before the claude flag
      // existed, which is the routine state whenever the extension is
      // rebuilt without reinstalling the helper.
      const health = {
        ready: true,
        configured: importedOpenAI || process.env.BROWSER_GUIDE_TEST_OPENAI !== "0",
        model: "gpt-realtime",
      };
      if (process.env.BROWSER_GUIDE_TEST_LEGACY_HEALTH !== "1") {
        health.claude = process.env.BROWSER_GUIDE_TEST_CLAUDE === "1";
        if (health.configured) health.account = { provider: "codex", label: "tester@example.test", plan: "plus" };
        else if (health.claude) health.account = { provider: "claude-code", plan: "max" };
      }
      write({ ...base, data: health });
      break;
    }
    case "HOST_IMPORT_CREDENTIALS": {
      // Importing a Codex sign-in yields a key, so the panel goes ready on the
      // Realtime engine; a Claude sign-in yields tokens and no OpenAI key.
      const provider = request.payload?.provider;
      importedOpenAI = importedOpenAI || provider === "codex";
      write({ ...base, data: {
        imported: true,
        provider,
        method: provider === "codex" ? "api_key" : "oauth",
        configured: importedOpenAI,
        account: provider === "codex"
          ? { provider: "codex", label: "tester@example.test", plan: "plus" }
          : { provider: "claude-code", plan: "max" },
      } });
      break;
    }
    case "HOST_CREDENTIAL_SOURCES":
      // A helper that predates this request answers INVALID_REQUEST, which the
      // panel has to survive; BROWSER_GUIDE_TEST_LEGACY_HEALTH reproduces it.
      if (process.env.BROWSER_GUIDE_TEST_LEGACY_HEALTH === "1") {
        write({
          version: 1,
          requestId: request.requestId,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "The native request type is unsupported.", retryable: false },
        });
        break;
      }
      {
        // BROWSER_GUIDE_TEST_SIGNIN_AFTER reproduces someone signing in
        // elsewhere: Codex is absent until that many polls have gone by, then
        // it appears, exactly as it would once a real login finished.
        const appearAfter = Number(process.env.BROWSER_GUIDE_TEST_SIGNIN_AFTER ?? "0");
        sourcePolls += 1;
        const codexPresent = appearAfter === 0 || sourcePolls > appearAfter;
        write({ ...base, data: { sources: [
          codexPresent
            ? { provider: "codex", available: true, label: "tester@example.test", plan: "plus" }
            : { provider: "codex", available: false, detail: "Run `codex login` to create one." },
          { provider: "claude-code", available: false, detail: "Sign in to Claude Code to create one." },
        ] } });
      }
      break;
    case "HOST_CREATE_SESSION":
      write({ ...base, data: { answerSdp: "v=0\r\ns=browser-guide-controlled-answer\r\n", upstreamRequestId: "req_e2e" } });
      break;
    case "HOST_CONFIGURE_KEY":
      write({ ...base, data: { configured: true } });
      break;
    case "HOST_FORGET_KEY":
      write({ ...base, data: { configured: false } });
      break;
    case "HOST_MEMORY_GET":
      write({ ...base, data: { notes: memoryNotes.get(request.payload?.origin) ?? [] } });
      break;
    case "HOST_MEMORY_APPEND": {
      const origin = request.payload?.origin;
      const notes = memoryNotes.get(origin) ?? [];
      notes.push({ q: String(request.payload?.question ?? "").slice(0, 300), a: String(request.payload?.answer ?? "").slice(0, 500), at: 0 });
      memoryNotes.set(origin, notes.slice(-10));
      write({ ...base, data: { stored: true } });
      break;
    }
    case "HOST_MEMORY_CLEAR":
      if (request.payload?.origin) memoryNotes.delete(request.payload.origin);
      else memoryNotes.clear();
      write({ ...base, data: { cleared: true } });
      break;
    case "HOST_PUBLISH_EVIDENCE":
      write({ ...base, data: { published: true } });
      break;
    case "HOST_CLEAR_EVIDENCE":
      write({ ...base, data: { cleared: true } });
      break;
    case "HOST_TRANSCRIBE":
      write({ ...base, data: { transcript: "Where is Review invoices?" } });
      break;
    case "HOST_COMPLETE": {
      const serialized = JSON.stringify(request.payload?.messages ?? []);
      const alreadyPointed = serialized.includes("tool_result");
      if (!alreadyPointed && /review invoices/i.test(serialized)) {
        write({ ...base, data: {
          content: [{
            type: "tool_use",
            id: "toolu_stub_1",
            name: "show_guidance",
            input: { refs: ["e2"], title: "Review invoices", body: "This button opens your invoices.", presentation: "point", waitFor: "none" },
          }],
          stopReason: "tool_use",
        } });
      } else {
        write({ ...base, data: {
          content: [{ type: "text", text: alreadyPointed ? "Review invoices is highlighted on the page." : "This page is a billing console." }],
          stopReason: "end_turn",
        } });
      }
      break;
    }
    default:
      write({
        version: 1,
        requestId: request.requestId,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Unsupported controlled test operation.", retryable: false },
      });
  }
}

function write(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}
