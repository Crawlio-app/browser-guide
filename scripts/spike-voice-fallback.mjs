// Spike 3a probe: speak (fixture) → SFSpeechRecognizer → Claude (your own
// imported token) → AVSpeechSynthesizer, measuring each stage against the real
// debug helper. Manual-run only: `npm run spike:voice`. Requires:
//   - swift build --package-path native/macos (debug helper present)
//   - a Claude Code sign-in on this Mac (~/.claude/.credentials.json)
//   - Speech Recognition permission for your terminal (macOS will prompt once)
// The final answer is spoken aloud on this Mac.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const host = resolve(root, "native/macos/.build/debug/BrowserGuideNativeHost");
if (!existsSync(host)) {
  console.error("Build the helper first: swift build --package-path native/macos");
  process.exit(1);
}

const SPOKEN_QUESTION = "What is this page about and where should I look first?";

// 1. Produce a spoken fixture with the system voice, converted to the WAV
//    profile the transcriber expects (16 kHz mono 16-bit).
const aiffPath = join(tmpdir(), `browser-guide-spike-${process.pid}.aiff`);
const wavPath = join(tmpdir(), `browser-guide-spike-${process.pid}.wav`);
execFileSync("say", ["-o", aiffPath, SPOKEN_QUESTION]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiffPath, wavPath]);
const wav = readFileSync(wavPath);
rmSync(aiffPath, { force: true });
rmSync(wavPath, { force: true });
console.log(`Fixture: "${SPOKEN_QUESTION}" (${(wav.length / 1024).toFixed(0)} KiB WAV)`);

// 2. Talk raw native-messaging frames to the helper.
const child = spawn(host, [], { stdio: ["pipe", "pipe", "inherit"] });
let buffered = Buffer.alloc(0);
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < length + 4) return;
    const message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    const waiter = pending.get(message.requestId);
    if (waiter) {
      pending.delete(message.requestId);
      waiter(message);
    }
  }
});

function send(type, payload) {
  const requestId = randomUUID();
  const body = { version: 1, requestId, type, ...(payload ? { payload } : {}) };
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  const frame = Buffer.allocUnsafe(encoded.length + 4);
  frame.writeUInt32LE(encoded.length, 0);
  encoded.copy(frame, 4);
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${type} timed out after 60s`)), 60_000);
    pending.set(requestId, (message) => {
      clearTimeout(timeout);
      resolvePromise(message);
    });
    child.stdin.write(frame);
  });
}

function fail(stage, message) {
  console.error(`\n${stage} failed: ${message.error?.message ?? JSON.stringify(message)}`);
  child.kill();
  process.exit(1);
}

const timings = [];
async function timed(label, type, payload) {
  const start = performance.now();
  const message = await send(type, payload);
  const elapsed = Math.round(performance.now() - start);
  if (!message.ok) fail(label, message);
  timings.push([label, elapsed]);
  return message.data;
}

// 3. The measured loop.
const imported = await timed("import claude-code sign-in", "HOST_IMPORT_CREDENTIALS", { provider: "claude-code" });
console.log(`Imported: ${imported.provider} (${imported.method})`);

const { transcript } = await timed("transcribe (SFSpeech, on-device)", "HOST_TRANSCRIBE", {
  audio: wav.toString("base64"),
  format: "wav",
});
console.log(`Transcript: "${transcript}"`);

const { text } = await timed("complete (Claude, your token)", "HOST_COMPLETE", {
  prompt: `The user asked, by voice: "${transcript}". There is no page evidence in this probe; answer in one short sentence that the voice loop works.`,
});
console.log(`Answer: "${text}"`);

// In the product, the panel speaks the answer with speechSynthesis (the same
// local system voice `say` uses) — so the demo and the latency proxy are `say`.
const speakStart = performance.now();
execFileSync("say", [text.slice(0, 400)]);
timings.push(["speak (local system voice, full utterance)", Math.round(performance.now() - speakStart)]);

console.log("\nStage timings:");
for (const [label, elapsed] of timings) console.log(`  ${String(elapsed).padStart(6)} ms  ${label}`);
const loop = timings.filter(([label]) => !label.startsWith("import")).reduce((sum, [, ms]) => sum + ms, 0);
console.log(`  ${String(loop).padStart(6)} ms  end-to-end (stop speaking -> speech starts)`);

child.stdin.end();
process.exit(0);
