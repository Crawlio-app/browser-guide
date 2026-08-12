import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { findHostBinary } from "../src/host-install.js";
import { pingHost } from "../src/native-ping.js";

const repoStub = resolve(import.meta.dirname, "../../tests/fixtures/native-host-stub.mjs");

test("pingHost exchanges a framed HOST_HEALTH with a real process", { skip: !existsSync(repoStub) ? "repo stub unavailable" : false }, async () => {
  // The Node stub speaks the identical framing the Swift host does.
  const health = await pingHost(process.execPath, 5_000, [repoStub]);
  assert.equal(health.ready, true);
  assert.equal(typeof health.configured, "boolean");
});

test("pingHost reaches the built Swift helper when present", { skip: process.platform !== "darwin" ? "macOS only" : false }, async (t) => {
  const binary = findHostBinary({});
  if (!binary) {
    t.skip("no built helper in this checkout");
    return;
  }
  const health = await pingHost(binary);
  assert.equal(health.ready, true);
});
