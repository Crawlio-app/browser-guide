// Populates mcp/vendor/macos with the release host binary so the npm package
// can install it via `npx crawlio-browser-guide init`. Run before `npm publish`
// in mcp/ (its prepublishOnly guard refuses to publish without this output).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "dist/native/macos/com.crawlio.browser_guide");
const vendorDirectory = resolve(root, "mcp/vendor/macos");
const destination = resolve(vendorDirectory, "com.crawlio.browser_guide");

if (!existsSync(source)) {
  console.error("dist/native/macos is missing — run `npm run build:helper` first.");
  process.exit(1);
}

// Release machines have the CLT, so lipo/codesign checks are appropriate here
// (unlike at init time on end-user Macs, where we parse Mach-O magic instead).
const { stdout: archs } = await execFileAsync("/usr/bin/lipo", ["-archs", source]);
for (const arch of ["arm64", "x86_64"]) {
  if (!archs.includes(arch)) {
    console.error(`The helper binary is missing the ${arch} slice (found: ${archs.trim()}). Rebuild with npm run build:helper.`);
    process.exit(1);
  }
}
await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", source]);

const manifest = JSON.parse(readFileSync(resolve(root, "dist/extension/manifest.json"), "utf8"));
const origin = `chrome-extension://${extensionIdForKey(manifest.key)}/`;
const expectedOrigin = "chrome-extension://bjgpnncbnjeahgfljjegblhmiklkcpmg/";
if (origin !== expectedOrigin) {
  console.error(`Extension origin drifted: derived ${origin}, the installer pins ${expectedOrigin}.`);
  process.exit(1);
}

mkdirSync(vendorDirectory, { recursive: true });
cpSync(source, destination);
chmodSync(destination, 0o755);
writeFileSync(resolve(vendorDirectory, "metadata.json"), JSON.stringify({
  sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
  origin,
  builtAt: new Date().toISOString(),
  sourceVersion: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version,
}, null, 2) + "\n");

console.log(`Vendored ${archs.trim()} host into mcp/vendor/macos (${readFileSync(destination).length} bytes).`);

function extensionIdForKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return [...digest].map((byte) => alphabet.charAt(byte >> 4) + alphabet.charAt(byte & 15)).join("");
}
