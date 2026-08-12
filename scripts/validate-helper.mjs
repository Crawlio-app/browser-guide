import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const outputRoot = resolve(root, "dist/native/macos");
const app = resolve(outputRoot, "Browser Guide Helper.app");
const executables = [
  resolve(app, "Contents/MacOS/BrowserGuideHelper"),
  resolve(app, "Contents/Resources/com.crawlio.browser_guide"),
  resolve(outputRoot, "com.crawlio.browser_guide"),
];

const manifest = JSON.parse(await readFile(resolve(root, "dist/extension/manifest.json"), "utf8"));
if (typeof manifest.key !== "string") throw new Error("The production extension is missing its stable public key.");
const allowedOrigin = `chrome-extension://${extensionIdForKey(manifest.key)}/`;

for (const executable of executables) {
  await access(executable, constants.X_OK);
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", executable]);
  const architectures = new Set(stdout.trim().split(/\s+/));
  for (const expected of ["arm64", "x86_64"]) {
    if (!architectures.has(expected)) throw new Error(`${executable} is missing ${expected}.`);
  }
}

for (const executable of executables) {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", executable]);
}
await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const { stdout: configuredOrigin } = await execFileAsync("/usr/bin/plutil", [
  "-extract", "BrowserGuideAllowedOrigin", "raw", resolve(app, "Contents/Info.plist"),
]);
if (configuredOrigin.trim() !== allowedOrigin) {
  throw new Error(`Helper origin mismatch: expected ${allowedOrigin}, received ${configuredOrigin.trim()}.`);
}

console.log(`Native helper validation passed for ${allowedOrigin}`);

function extensionIdForKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return [...digest].map((byte) => alphabet.charAt(byte >> 4) + alphabet.charAt(byte & 15)).join("");
}
