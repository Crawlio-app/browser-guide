import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packagePath = resolve(root, "native/macos");
const outputRoot = resolve(root, "dist/native/macos");
const appRoot = resolve(outputRoot, "Browser Guide Helper.app");
const appContents = resolve(appRoot, "Contents");
const appExecutable = resolve(appContents, "MacOS/BrowserGuideHelper");
const appHost = resolve(appContents, "Resources/com.crawlio.browser_guide");
const standaloneHost = resolve(outputRoot, "com.crawlio.browser_guide");
const releaseArchitectures = ["arm64", "x86_64"];

const allowedOrigin = await parseAllowedOrigin(process.argv.slice(2));

await execFileAsync("/usr/bin/swift", [
  "build",
  "--package-path", packagePath,
  "--configuration", "release",
  ...releaseArchitectures.flatMap((architecture) => ["--arch", architecture]),
], { maxBuffer: 8 * 1_024 * 1_024 });

const { stdout: binaryPathOutput } = await execFileAsync("/usr/bin/swift", [
  "build",
  "--package-path", packagePath,
  "--configuration", "release",
  ...releaseArchitectures.flatMap((architecture) => ["--arch", architecture]),
  "--show-bin-path",
]);
const binaryPath = binaryPathOutput.trim();
const builtHost = resolve(binaryPath, "BrowserGuideNativeHost");
const builtHelper = resolve(binaryPath, "BrowserGuideHelper");
await Promise.all([
  verifyUniversalBinary(builtHost),
  verifyUniversalBinary(builtHelper),
]);

await rm(outputRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(appContents, "MacOS"), { recursive: true }),
  mkdir(resolve(appContents, "Resources"), { recursive: true }),
]);
await Promise.all([
  copyFile(builtHelper, appExecutable),
  copyFile(builtHost, appHost),
  copyFile(builtHost, standaloneHost),
]);
await Promise.all([
  chmod(appExecutable, 0o755),
  chmod(appHost, 0o755),
  chmod(standaloneHost, 0o755),
]);
await Promise.all([
  verifyUniversalBinary(appExecutable),
  verifyUniversalBinary(appHost),
  verifyUniversalBinary(standaloneHost),
]);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Browser Guide Helper</string>
  <key>CFBundleExecutable</key><string>BrowserGuideHelper</string>
  <key>CFBundleIdentifier</key><string>com.crawlio.browser-guide.helper</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Browser Guide Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>BrowserGuideAllowedOrigin</key><string>${escapeXML(allowedOrigin)}</string>
</dict>
</plist>
`;
await writeFile(resolve(appContents, "Info.plist"), infoPlist, { encoding: "utf8", mode: 0o644 });

// The host embedded under Resources is copied out of the app bundle during
// installation. Sign it as an independent executable before sealing the app;
// an app resource seal alone does not survive that copy.
await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", appHost]);
await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", standaloneHost]);
await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appRoot]);

console.log(`Built native host: ${standaloneHost}`);
console.log(`Built one-click helper: ${appRoot}`);
console.log(`Universal architectures: ${releaseArchitectures.join(", ")}`);
console.log(`Allowed extension origin: ${allowedOrigin}`);

async function verifyUniversalBinary(path) {
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", path]);
  const architectures = new Set(stdout.trim().split(/\s+/).filter(Boolean));
  const missing = releaseArchitectures.filter((architecture) => !architectures.has(architecture));
  if (missing.length > 0) {
    throw new Error(`Native binary is missing ${missing.join(", ")}: ${path}`);
  }
}

async function parseAllowedOrigin(argumentsList) {
  let origin;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--extension-id") {
      const extensionId = argumentsList[index + 1];
      if (!extensionId) throw new Error("--extension-id requires a value.");
      origin = `chrome-extension://${extensionId}/`;
      index += 1;
    } else if (argument === "--extension-origin") {
      origin = argumentsList[index + 1];
      if (!origin) throw new Error("--extension-origin requires a value.");
      index += 1;
    } else {
      throw new Error(`Unknown helper build argument: ${argument}`);
    }
  }
  if (!origin) {
    const manifestPath = resolve(root, "src/extension/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof manifest.key !== "string" || manifest.key.length === 0) {
      throw new Error("The extension manifest has no stable public key; provide --extension-id explicitly.");
    }
    const publicKey = Buffer.from(manifest.key, "base64");
    const normalizedInput = manifest.key.replace(/=+$/, "");
    if (publicKey.length < 64 || publicKey.toString("base64").replace(/=+$/, "") !== normalizedInput) {
      throw new Error("The extension manifest public key is not valid base64 DER.");
    }
    const digest = createHash("sha256").update(publicKey).digest();
    const alphabet = "abcdefghijklmnop";
    let extensionId = "";
    for (const byte of digest.subarray(0, 16)) {
      extensionId += alphabet[byte >> 4] + alphabet[byte & 0x0f];
    }
    origin = `chrome-extension://${extensionId}/`;
  }
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
    throw new Error("The allowed origin must contain exactly one valid Chrome extension ID.");
  }
  return origin;
}

function escapeXML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
