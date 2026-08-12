import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EXTENSION_ORIGIN } from "./host-install.js";

/**
 * Speaks one framed HOST_HEALTH request to the native host exactly as Chrome
 * would: 4-byte little-endian length prefix + UTF-8 JSON, origin as argv.
 * Resolves with the host's health data or rejects with a reasoned error.
 */
export function pingHost(hostPath, timeoutMs = 5_000, extraArguments = []) {
  return new Promise((resolvePing, reject) => {
    const requestId = randomUUID();
    const child = spawn(hostPath, [...extraArguments, EXTENSION_ORIGIN], { stdio: ["pipe", "pipe", "pipe"] });
    let buffered = Buffer.alloc(0);
    let settled = false;

    const finish = (error, health) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      const grace = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("close", () => clearTimeout(grace));
      if (error) reject(error);
      else resolvePing(health);
    };

    const timeout = setTimeout(() => finish(new Error(`The host did not answer HOST_HEALTH within ${timeoutMs / 1_000}s.`)), timeoutMs);

    child.once("error", (error) => finish(new Error(`The host could not be started: ${error.message}`)));
    child.stdout.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      let message;
      try {
        message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      } catch {
        return finish(new Error("The host answered with an unparseable frame."));
      }
      if (message.requestId !== requestId) {
        return finish(new Error("The host answered with a mismatched request ID."));
      }
      if (message.ok !== true || message.data?.ready !== true) {
        const detail = message.error?.message ?? JSON.stringify(message);
        return finish(new Error(`The host answered but is not healthy: ${detail}`));
      }
      finish(null, message.data);
    });

    const payload = Buffer.from(JSON.stringify({ version: 1, requestId, type: "HOST_HEALTH" }), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    child.stdin.write(frame);
  });
}
