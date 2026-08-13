import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hostPaths } from "../src/host-install.js";

const execFileAsync = promisify(execFile);
const binPath = resolve(import.meta.dirname, "../bin/crawlio-browser-guide.js");

test("bare invocation and unknown commands print usage with a non-zero exit", async () => {
  const bare = await execFileAsync(process.execPath, [binPath]).catch((error) => error);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /Usage:/);

  const unknown = await execFileAsync(process.execPath, [binPath, "frobnicate"]).catch((error) => error);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "frobnicate"/);

  const help = await execFileAsync(process.execPath, [binPath, "help"]);
  assert.match(help.stderr, /crawlio-browser-guide init/);
});

test("init + doctor + uninstall run a full cycle against a temp home", { skip: process.platform !== "darwin" ? "macOS only" : false }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "browser-guide-cli-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A tiny executable stub keeps this test independent of the Swift build;
  // doctor's ping is expected to fail against it and exit non-zero.
  const stubBinary = join(home, "stub-host");
  writeFileSync(stubBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, BROWSER_GUIDE_HOST_BINARY: stubBinary };

  const init = await execFileAsync(process.execPath, [binPath, "init", "--home", home], { env }).catch((error) => error);
  assert.match(init.stderr ?? "", /is not a valid Mach-O executable/);

  // With the real helper (when built), init succeeds end to end.
  const repoDist = resolve(import.meta.dirname, "../../dist/native/macos/com.crawlio.browser_guide");
  if (existsSync(repoDist)) {
    const realEnv = { ...process.env, BROWSER_GUIDE_HOST_BINARY: repoDist };
    const realInit = await execFileAsync(process.execPath, [binPath, "init", "--home", home], { env: realEnv });
    assert.match(realInit.stderr, /Host installed/);
    assert.match(realInit.stderr, /Host answers: ready/);

    const doctor = await execFileAsync(process.execPath, [binPath, "doctor", "--home", home], { env: realEnv });
    assert.match(doctor.stderr, /Everything this CLI can check looks good/);

    const uninstall = await execFileAsync(process.execPath, [binPath, "uninstall", "--home", home], { env: realEnv });
    assert.match(uninstall.stderr, /registration removed/);
    const paths = hostPaths(home);
    assert.equal(existsSync(paths.hostPath), false);
  }
});
