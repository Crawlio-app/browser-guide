import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("The live release smoke is macOS-only.");
if (process.env.BROWSER_GUIDE_LIVE_SMOKE !== "1") {
  throw new Error("Set BROWSER_GUIDE_LIVE_SMOKE=1 only when you are ready to run the manual live-key release gate.");
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("The live release smoke needs an interactive terminal; it cannot be silently attested in CI.");
}

const root = resolve(import.meta.dirname, "..");
const host = resolve(root, "dist/native/macos/com.crawlio.browser_guide");
await access(host).catch(() => {
  throw new Error("Build Browser Guide first with npm run build.");
});

const health = await nativeHealth(host);
if (health?.ok !== true || health.data?.ready !== true) {
  throw new Error("The native helper did not pass its health check. Run npm run install:helper, then retry.");
}
if (health.data.configured !== true) {
  throw new Error("No key is configured in Keychain. Add a newly issued key through Browser Guide; never paste it into this terminal.");
}

process.stdout.write([
  "",
  "Browser Guide live release gate",
  "",
  "Use the unpacked production build on a normal page. Keep DevTools open for the",
  "side panel and service worker. Use only a newly issued key; the key exposed during",
  "development must already be revoked.",
  "",
  "Run these four checks now:",
  "  1. Ask one typed question and wait for a final answer.",
  "  2. Feed one prerecorded spoken question through the microphone path.",
  "  3. Confirm one grounded pointer appears and the page remains untouched.",
  "  4. Start a walkthrough, perform the requested action yourself, and confirm one advancement.",
  "",
].join("\n"));

const prompts = [
  "Did key saving finish with success or an actionable error within eight seconds?",
  "Did the typed question receive a final answer?",
  "Did the prerecorded voice question receive a final answer?",
  "Did a grounded pointer appear without Browser Guide clicking, typing, focusing, scrolling, or navigating?",
  "Did the walkthrough advance exactly once after a meaningful page change?",
  "Were both consoles free of errors and every state free of an indefinite spinner?",
];

const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  for (const prompt of prompts) {
    const answer = (await terminal.question(`${prompt} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      process.stderr.write("Live release smoke did not pass. No completion claim should be made.\n");
      process.exitCode = 1;
      break;
    }
  }
} finally {
  terminal.close();
}

if (process.exitCode !== 1) process.stdout.write("Live release smoke passed.\n");

function nativeHealth(executable) {
  return new Promise((resolveHealth, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The native helper health check exceeded eight seconds."));
    }, 8_000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal || code !== 0) {
        reject(new Error(`The native helper exited with ${signal ?? code}.`));
        return;
      }
      try {
        const stream = Buffer.concat(chunks);
        if (stream.length < 5) throw new Error("The native helper returned no framed response.");
        const length = stream.readUInt32LE(0);
        if (length < 2 || length > 1_048_576 || stream.length !== length + 4) {
          throw new Error("The native helper returned an invalid frame.");
        }
        resolveHealth(JSON.parse(stream.subarray(4).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      requestId: randomUUID(),
      type: "HOST_HEALTH",
    }), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    child.stdin.end(frame);
  });
}
