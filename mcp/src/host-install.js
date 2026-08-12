import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.crawlio.browser_guide";
export const EXTENSION_ORIGIN = "chrome-extension://bjgpnncbnjeahgfljjegblhmiklkcpmg/";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hostPaths(homeDir = homedir()) {
  const applicationSupport = join(homeDir, "Library", "Application Support");
  const hostDirectory = join(applicationSupport, "Crawlio Browser Guide", "Native Host");
  return {
    hostDirectory,
    hostPath: join(hostDirectory, HOST_NAME),
    manifestPaths: [
      join(applicationSupport, "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
      join(applicationSupport, "Google", "ChromeForTesting", "NativeMessagingHosts", `${HOST_NAME}.json`),
    ],
    // Registrations emitted by builds predating Chrome 146's documented path.
    obsoleteManifestPaths: [
      join(applicationSupport, "Google", "Chrome for Testing", "NativeMessagingHosts", `${HOST_NAME}.json`),
    ],
    eyesPath: join(homeDir, ".config", "browser-guide", "eyes.json"),
  };
}

/**
 * Byte-for-byte reproduction of Swift JSONSerialization's `.prettyPrinted,
 * .sortedKeys` output (2-space indent, " : " separators, escaped slashes).
 * The Helper.app compares installed manifests against those exact bytes, so a
 * Node-written manifest that differs would report "needs repair" forever.
 */
export function manifestBytes(hostPath) {
  const escape = (value) => JSON.stringify(value).slice(1, -1).replace(/\//g, "\\/");
  return [
    "{",
    '  "allowed_origins" : [',
    `    "${escape(EXTENSION_ORIGIN)}"`,
    "  ],",
    '  "description" : "Browser Guide secure Realtime session helper",',
    `  "name" : "${HOST_NAME}",`,
    `  "path" : "${escape(hostPath)}",`,
    '  "type" : "stdio"',
    "}",
  ].join("\n");
}

/** Mach-O magic check instead of `lipo`: Macs without the Xcode CLT ship a
 *  stub lipo that errors, while these four bytes never lie. */
export function isMachO(path) {
  let handle;
  try {
    handle = readFileSync(path);
  } catch {
    return false;
  }
  if (handle.length < 4) return false;
  const magic = handle.readUInt32BE(0);
  return magic === 0xCAFEBABE // fat
    || magic === 0xBEBAFECA // fat, swapped
    || magic === 0xFEEDFACF // 64-bit thin
    || magic === 0xCFFAEDFE; // 64-bit thin, swapped
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function findHostBinary(env = process.env) {
  const candidates = [
    env.BROWSER_GUIDE_HOST_BINARY,
    join(packageRoot, "vendor", "macos", HOST_NAME),
    resolve(packageRoot, "..", "dist", "native", "macos", HOST_NAME),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).size > 0) return candidate;
  }
  return null;
}

export function vendorMetadata() {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "vendor", "macos", "metadata.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Stages the host binary and writes both Chrome manifests. Idempotent: equal
 *  bytes are left untouched and reported as such. */
export function installHost(sourceBinary, homeDir = homedir()) {
  const paths = hostPaths(homeDir);
  const report = { binary: "installed", manifests: [] };

  mkdirSync(paths.hostDirectory, { recursive: true, mode: 0o700 });
  if (existsSync(paths.hostPath) && sha256(paths.hostPath) === sha256(sourceBinary)) {
    report.binary = "up to date";
  } else {
    // Rename over the top: Chrome may still hold the old binary open, and
    // unlink-then-write would race a concurrent spawn.
    const staging = join(paths.hostDirectory, `.staging-${process.pid}`);
    copyFileSync(sourceBinary, staging);
    chmodSync(staging, 0o700);
    renameSync(staging, paths.hostPath);
  }

  const expected = manifestBytes(paths.hostPath);
  for (const manifestPath of paths.manifestPaths) {
    let state = "written";
    if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") === expected) {
      state = "up to date";
    } else {
      mkdirSync(dirname(manifestPath), { recursive: true });
      const staging = `${manifestPath}.staging-${process.pid}`;
      writeFileSync(staging, expected, { mode: 0o644 });
      renameSync(staging, manifestPath);
      chmodSync(manifestPath, 0o644);
    }
    report.manifests.push({ path: manifestPath, state });
  }
  for (const obsolete of paths.obsoleteManifestPaths) {
    rmSync(obsolete, { force: true });
  }
  return report;
}

/** Mirrors scripts/uninstall-helper.mjs: registration and the eyes snapshot go;
 *  credentials and site memory stay until Browser Guide forgets them. */
export function uninstallHost(homeDir = homedir()) {
  const paths = hostPaths(homeDir);
  for (const path of [...paths.manifestPaths, ...paths.obsoleteManifestPaths, paths.hostPath, paths.eyesPath]) {
    rmSync(path, { force: true });
  }
  try {
    if (readdirSync(paths.hostDirectory).length === 0) rmdirSync(paths.hostDirectory);
  } catch {
    // A missing or non-empty host directory needs no further cleanup.
  }
}
