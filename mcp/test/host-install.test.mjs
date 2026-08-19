import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findHostBinary, hostPaths, installHost, isMachO, manifestBytes, uninstallHost } from "../src/host-install.js";

const darwinOnly = { skip: process.platform !== "darwin" ? "macOS-only behavior" : false };
// The linux staging test writes a #!/bin/sh launcher and asserts its
// executable bit: things NTFS cannot represent and cmd cannot run. Windows
// has its own layout, covered by the LOCALAPPDATA/.bat/registry test below.
const posixOnly = { skip: process.platform === "win32" ? "POSIX-only launcher and file modes" : false };

function makeHome() {
  return mkdtempSync(join(tmpdir(), "browser-guide-init-test-"));
}

function fakeBinary(home, content = "#!/bin/sh\nexit 0\n") {
  const path = join(home, "fake-host");
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

test("manifest bytes reproduce Swift JSONSerialization's exact format", () => {
  const bytes = manifestBytes("/Users/example/Library/Application Support/Crawlio Browser Guide/Native Host/com.crawlio.browser_guide");
  // Golden output captured from Swift: .prettyPrinted + .sortedKeys, " : "
  // separators, escaped forward slashes. Byte parity keeps the Helper.app's
  // --status check from reporting a cosmetic "needs repair".
  assert.equal(bytes, [
    "{",
    '  "allowed_origins" : [',
    '    "chrome-extension:\\/\\/bjgpnncbnjeahgfljjegblhmiklkcpmg\\/"',
    "  ],",
    '  "description" : "Browser Guide secure Realtime session helper",',
    '  "name" : "com.crawlio.browser_guide",',
    '  "path" : "\\/Users\\/example\\/Library\\/Application Support\\/Crawlio Browser Guide\\/Native Host\\/com.crawlio.browser_guide",',
    '  "type" : "stdio"',
    "}",
  ].join("\n"));
});

test("install stages the binary, writes both manifests, and is idempotent", darwinOnly, (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = fakeBinary(home);

  const first = installHost(source, home);
  const paths = hostPaths(home);
  assert.equal(first.binary, "installed");
  assert.equal(statSync(paths.hostPath).mode & 0o777, 0o700);
  for (const manifest of first.manifests) {
    assert.equal(manifest.state, "written");
    assert.equal(readFileSync(manifest.path, "utf8"), manifestBytes(paths.hostPath));
    assert.equal(statSync(manifest.path).mode & 0o777, 0o644);
  }

  const second = installHost(source, home);
  assert.equal(second.binary, "up to date");
  assert.ok(second.manifests.every((manifest) => manifest.state === "up to date"));

  // A rotated source binary replaces the staged copy.
  const rotated = fakeBinary(home, "#!/bin/sh\nexit 1\n");
  assert.equal(installHost(rotated, home).binary, "installed");
});

test("uninstall removes registration and eyes snapshot, leaves nothing, and is idempotent", darwinOnly, (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installHost(fakeBinary(home), home);
  const paths = hostPaths(home);
  mkdirSync(join(home, ".config", "browser-guide"), { recursive: true });
  writeFileSync(paths.eyesPath, "{}");

  uninstallHost(home);
  for (const path of [paths.hostPath, ...paths.manifestPaths, paths.eyesPath]) {
    assert.equal(existsSync(path), false, `${path} must be removed`);
  }
  assert.equal(existsSync(paths.hostDirectory), false, "empty host directory is removed");
  uninstallHost(home); // second run stays silent
});

test("findHostBinary prefers the env override, then vendor, then the repo dist build", (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const override = fakeBinary(home);
  assert.equal(findHostBinary({ BROWSER_GUIDE_HOST_BINARY: override }), override);
  const fallback = findHostBinary({});
  // In a repo checkout with a built helper this resolves to vendor/ or ../dist;
  // either way it must never be the (nonexistent) override path.
  if (fallback !== null) assert.notEqual(fallback, override);
});

test("linux install stages the self-contained Node helper and answers a real ping", posixOnly, async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const report = installHost(null, home, "linux", {});
  const paths = hostPaths(home, "linux", {});
  assert.equal(report.binary, "installed");
  assert.ok(existsSync(join(paths.hostDirectory, "helper", "host.js")));
  assert.ok(existsSync(join(paths.hostDirectory, "host-entry.js")));
  assert.match(readFileSync(paths.hostPath, "utf8"), /^#!\/bin\/sh\nexec /);
  assert.equal(statSync(paths.hostPath).mode & 0o777, 0o755);
  for (const manifestPath of paths.manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.path, paths.hostPath);
    assert.equal(manifest.name, "com.crawlio.browser_guide");
  }
  assert.ok(installHost(null, home, "linux", {}).binary === "up to date");

  // The staged tree is self-contained: ping it exactly as Chrome would spawn it.
  const { pingHost } = await import("../src/native-ping.js");
  const health = await pingHost(paths.hostPath);
  assert.equal(health.ready, true);

  uninstallHost(home, "linux", {});
  assert.equal(existsSync(paths.hostDirectory), false);
  for (const manifestPath of paths.manifestPaths) assert.equal(existsSync(manifestPath), false);
});

test("windows paths use LOCALAPPDATA, a .bat launcher, and the Chrome registry key", () => {
  const paths = hostPaths("C:\\Users\\test", "win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
  assert.ok(paths.hostPath.endsWith("com.crawlio.browser_guide.bat"));
  assert.ok(paths.hostDirectory.includes("Crawlio Browser Guide"));
  assert.deepEqual(paths.registryKeys, ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.crawlio.browser_guide"]);
  assert.equal(paths.manifestPaths.length, 1);
});

test("isMachO accepts real fat binaries and rejects scripts", darwinOnly, (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(isMachO(fakeBinary(home)), false);
  const realBinary = findHostBinary({});
  if (realBinary) assert.equal(isMachO(realBinary), true);
});
