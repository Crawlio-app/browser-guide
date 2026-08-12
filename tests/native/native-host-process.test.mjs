import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const debugHost = resolve(root, "native/macos/.build/debug/BrowserGuideNativeHost");
const host = process.env.BROWSER_GUIDE_NATIVE_HOST
  ?? debugHost;

test("native host exchanges correlated little-endian framed messages without stderr output", async (context) => {
  if (!existsSync(host)) {
    context.skip("Run swift build --package-path native/macos first.");
    return;
  }

  const healthId = "550e8400-e29b-41d4-a716-446655440000";
  const invalidVersionId = "61f86ca8-dbf3-4beb-a3dc-24d8d723c27f";
  // The in-memory keychain keeps this framing test independent of the login
  // Keychain, where a real credential owned by the signed helper is unreadable
  // to this differently signed test binary.
  const { messages, stderr } = await exchange([
    { version: 1, requestId: healthId, type: "HOST_HEALTH" },
    { version: 2, requestId: invalidVersionId, type: "HOST_HEALTH" },
  ], host, {
    ...process.env,
    BROWSER_GUIDE_TEST_IN_MEMORY_KEYCHAIN: "1",
  });

  assert.equal(stderr, "");
  assert.equal(messages.length, 2);
  const health = messages.find(({ requestId }) => requestId === healthId);
  const invalidVersion = messages.find(({ requestId }) => requestId === invalidVersionId);
  assert.ok(health?.ok === true && health.data, `unexpected health response: ${JSON.stringify(health)}`);
  assert.deepEqual(health, {
    version: 1,
    requestId: healthId,
    ok: true,
    data: {
      ready: true,
      configured: health.data.configured,
      model: "gpt-realtime",
    },
  });
  assert.equal(typeof health.data.configured, "boolean");
  assert.deepEqual(invalidVersion, {
    version: 1,
    requestId: invalidVersionId,
    ok: false,
    error: {
      code: "UNSUPPORTED_VERSION",
      message: "Unsupported native messaging protocol version.",
      retryable: false,
    },
  });
});

test("configured key travels only in framed stdin and is absent from outputs, argv, logs, and release assets", async (context) => {
  if (!existsSync(debugHost)) {
    context.skip("Run swift build --package-path native/macos first.");
    return;
  }
  const fakeKey = ["sk-", "native", "leak", "check", "token", "0001"].join("");
  const requests = [
    { version: 1, requestId: "11111111-1111-4111-8111-111111111111", type: "HOST_HEALTH" },
    {
      version: 1,
      requestId: "22222222-2222-4222-8222-222222222222",
      type: "HOST_CONFIGURE_KEY",
      payload: { key: fakeKey },
    },
    { version: 1, requestId: "33333333-3333-4333-8333-333333333333", type: "HOST_HEALTH" },
    { version: 1, requestId: "44444444-4444-4444-8444-444444444444", type: "HOST_FORGET_KEY" },
    { version: 1, requestId: "55555555-5555-4555-8555-555555555555", type: "HOST_HEALTH" },
  ];
  const result = await exchange(requests, debugHost, {
    ...process.env,
    BROWSER_GUIDE_TEST_IN_MEMORY_KEYCHAIN: "1",
  });

  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0].data.configured, false);
  assert.deepEqual(result.messages[1].data, { configured: true });
  assert.equal(result.messages[2].data.configured, true);
  assert.deepEqual(result.messages[3].data, { configured: false });
  assert.equal(result.messages[4].data.configured, false);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(Buffer.from(fakeKey)), false);
  assert.equal(JSON.stringify(result.messages).includes(fakeKey), false);
  assert.equal(result.spawnArguments.join("\n").includes(fakeKey), false);

  const releaseAssets = [
    resolve(root, "dist/native/macos/com.crawlio.browser_guide"),
    resolve(root, "dist/native/macos/Browser Guide Helper.app/Contents/MacOS/BrowserGuideHelper"),
    resolve(root, "dist/native/macos/Browser Guide Helper.app/Contents/Resources/com.crawlio.browser_guide"),
  ];
  for (const asset of releaseAssets.filter(existsSync)) {
    assert.equal(readFileSync(asset).includes(Buffer.from(fakeKey)), false, `fake key leaked into ${asset}`);
  }
});

test("health completes while an earlier Realtime session request is still blocked", async (context) => {
  if (!existsSync(debugHost)) {
    context.skip("Run swift build --package-path native/macos first.");
    return;
  }

  const configureId = "66666666-6666-4666-8666-666666666666";
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const healthId = "88888888-8888-4888-8888-888888888888";
  const concurrencyKey = ["sk", "native", "concurrency", "test", "token", "0001"].join("-");
  const result = await exchangeInStages([
    [{
      version: 1,
      requestId: configureId,
      type: "HOST_CONFIGURE_KEY",
      payload: { key: concurrencyKey },
    }],
    [
      {
        version: 1,
        requestId: sessionId,
        type: "HOST_CREATE_SESSION",
        payload: {
          sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
          mode: "text",
        },
      },
      { version: 1, requestId: healthId, type: "HOST_HEALTH" },
    ],
  ], 3, debugHost, {
    ...process.env,
    BROWSER_GUIDE_TEST_IN_MEMORY_KEYCHAIN: "1",
    BROWSER_GUIDE_TEST_REALTIME_DELAY_MILLISECONDS: "750",
  });

  assert.equal(result.stderr, "");
  assert.equal(result.messages.length, 3);
  assert.ok(
    result.messages.findIndex(({ requestId }) => requestId === healthId)
      < result.messages.findIndex(({ requestId }) => requestId === sessionId),
    "the short health response must not wait behind Realtime session creation",
  );
  assert.equal(result.messages.find(({ requestId }) => requestId === healthId).ok, true);
  assert.equal(result.messages.find(({ requestId }) => requestId === sessionId).ok, true);
});

function exchange(requests, executable = host, environment = process.env) {
  return exchangeUntilMessageCount(requests, requests.length, executable, environment);
}

function exchangeUntilMessageCount(requests, expectedCount, executable = host, environment = process.env) {
  return exchangeInStages([requests], expectedCount, executable, environment);
}

function exchangeInStages(requestStages, expectedCount, executable = host, environment = process.env) {
  return new Promise((resolveExchange, reject) => {
    const child = spawn(executable, [], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let sentStageCount = 0;
    let currentResponseThreshold = 0;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out waiting for ${expectedCount} native responses.`));
    }, 5_000);

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (settled) return;
      try {
        const messages = decodeFramesIfComplete(Buffer.concat(stdout));
        if (!messages) return;
        if (messages.length === currentResponseThreshold && sentStageCount < requestStages.length) {
          sendNextStage();
        }
        if (messages.length === expectedCount) child.stdin.end();
      } catch (error) {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal || code !== 0) {
        reject(new Error(`Native host exited with ${signal ?? code}.`));
        return;
      }
      try {
        const combinedStdout = Buffer.concat(stdout);
        resolveExchange({
          messages: decodeFrames(combinedStdout),
          spawnArguments: child.spawnargs,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: combinedStdout,
        });
      } catch (error) {
        reject(error);
      }
    });

    function sendNextStage() {
      const stage = requestStages[sentStageCount];
      sentStageCount += 1;
      currentResponseThreshold += stage.length;
      for (const request of stage) child.stdin.write(encodeFrame(request));
    }

    sendNextStage();
  });
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrames(stream) {
  const messages = [];
  let offset = 0;
  while (offset < stream.length) {
    assert.ok(offset + 4 <= stream.length, "truncated native message header");
    const length = stream.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0 && offset + length <= stream.length, "truncated native message payload");
    messages.push(JSON.parse(stream.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return messages;
}

function decodeFramesIfComplete(stream) {
  const messages = [];
  let offset = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length) return null;
    const length = stream.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0, "empty native message payload");
    if (offset + length > stream.length) return null;
    messages.push(JSON.parse(stream.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return messages;
}
