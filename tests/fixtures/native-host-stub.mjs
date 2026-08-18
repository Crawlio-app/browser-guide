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

function respond(request) {
  const base = { version: 1, requestId: request.requestId, ok: true };
  switch (request.type) {
    case "HOST_HEALTH":
      write({ ...base, data: {
        ready: true,
        configured: process.env.BROWSER_GUIDE_TEST_OPENAI !== "0",
        claude: process.env.BROWSER_GUIDE_TEST_CLAUDE === "1",
        model: "gpt-realtime",
      } });
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
