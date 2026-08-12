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

function respond(request) {
  const base = { version: 1, requestId: request.requestId, ok: true };
  switch (request.type) {
    case "HOST_HEALTH":
      write({ ...base, data: { ready: true, configured: true, model: "gpt-realtime" } });
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
