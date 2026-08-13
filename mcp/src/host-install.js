import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.crawlio.browser_guide";
export const EXTENSION_ORIGIN = "chrome-extension://bjgpnncbnjeahgfljjegblhmiklkcpmg/";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hostPaths(homeDir = homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const applicationSupport = join(homeDir, "Library", "Application Support");
    const hostDirectory = join(applicationSupport, "Crawlio Browser Guide", "Native Host");
    return {
      platform,
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
      registryKeys: [],
      eyesPath: join(homeDir, ".config", "browser-guide", "eyes.json"),
    };
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
    const hostDirectory = join(localAppData, "Crawlio Browser Guide", "Native Host");
    return {
      platform,
      hostDirectory,
      hostPath: join(hostDirectory, `${HOST_NAME}.bat`),
      // On Windows, Chrome finds the manifest through the registry; the file
      // itself lives in our staging directory.
      manifestPaths: [join(hostDirectory, `${HOST_NAME}.json`)],
      obsoleteManifestPaths: [],
      registryKeys: [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`],
      eyesPath: join(homeDir, ".config", "browser-guide", "eyes.json"),
    };
  }
  const dataHome = env.XDG_DATA_HOME ?? join(homeDir, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  const hostDirectory = join(dataHome, "crawlio-browser-guide", "native-host");
  return {
    platform,
    hostDirectory,
    hostPath: join(hostDirectory, HOST_NAME),
    manifestPaths: [
      join(configHome, "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
      join(configHome, "chromium", "NativeMessagingHosts", `${HOST_NAME}.json`),
    ],
    obsoleteManifestPaths: [],
    registryKeys: [],
    eyesPath: join(configHome, "browser-guide", "eyes.json"),
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

function writeManifests(paths, report) {
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
}

/** Stages the host binary and writes both Chrome manifests. Idempotent: equal
 *  bytes are left untouched and reported as such. macOS ships the compiled
 *  Swift host; other platforms stage the Node helper from this package. */
export function installHost(sourceBinary, homeDir = homedir(), platform = process.platform, env = process.env) {
  const paths = hostPaths(homeDir, platform, env);
  const report = { binary: "installed", manifests: [], registry: [] };
  mkdirSync(paths.hostDirectory, { recursive: true, mode: 0o700 });

  if (platform === "darwin") {
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
  } else {
    report.binary = stageNodeHelper(paths) ? "installed" : "up to date";
  }

  writeManifests(paths, report);
  for (const key of paths.registryKeys) {
    // Chrome on Windows finds native hosts through the registry, not a
    // well-known directory.
    execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", paths.manifestPaths[0], "/f"], { stdio: "pipe" });
    report.registry.push(key);
  }
  return report;
}

/** Copies the self-contained Node helper (builtins only, no dependencies) to
 *  the durable host directory and writes an executable launcher for Chrome. */
function stageNodeHelper(paths) {
  const sourceDirectory = join(packageRoot, "src", "helper");
  const helperDirectory = join(paths.hostDirectory, "helper");
  mkdirSync(helperDirectory, { recursive: true, mode: 0o700 });
  let changed = false;
  for (const file of readdirSync(sourceDirectory)) {
    const source = join(sourceDirectory, file);
    const destination = join(helperDirectory, file);
    if (existsSync(destination) && sha256(destination) === sha256(source)) continue;
    copyFileSync(source, destination);
    changed = true;
  }
  // The staged tree has no parent package.json, so mark it ESM explicitly.
  const packageMarker = join(paths.hostDirectory, "package.json");
  const markerBytes = JSON.stringify({ type: "module" }) + "\n";
  if (!existsSync(packageMarker) || readFileSync(packageMarker, "utf8") !== markerBytes) {
    writeFileSync(packageMarker, markerBytes);
    changed = true;
  }
  const entry = join(paths.hostDirectory, "host-entry.js");
  const entryBytes = 'import { runHelper } from "./helper/host.js";\n\nrunHelper();\n';
  if (!existsSync(entry) || readFileSync(entry, "utf8") !== entryBytes) {
    writeFileSync(entry, entryBytes);
    changed = true;
  }
  // The manifest must point at an executable; a .js file is not one. Pin the
  // absolute Node that ran init: PATH lookups inside Chrome-spawned processes
  // are unreliable.
  const launcherBytes = paths.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`;
  if (!existsSync(paths.hostPath) || readFileSync(paths.hostPath, "utf8") !== launcherBytes) {
    writeFileSync(paths.hostPath, launcherBytes);
    changed = true;
  }
  chmodSync(paths.hostPath, 0o755);
  return changed;
}

/** Mirrors scripts/uninstall-helper.mjs: registration and the eyes snapshot go;
 *  credentials and site memory stay until Browser Guide forgets them. */
export function uninstallHost(homeDir = homedir(), platform = process.platform, env = process.env) {
  const paths = hostPaths(homeDir, platform, env);
  for (const path of [...paths.manifestPaths, ...paths.obsoleteManifestPaths, paths.hostPath, paths.eyesPath]) {
    rmSync(path, { force: true });
  }
  for (const key of paths.registryKeys) {
    try {
      execFileSync("reg.exe", ["delete", key, "/f"], { stdio: "pipe" });
    } catch {
      // An absent registry key needs no further cleanup.
    }
  }
  if (platform === "darwin") {
    try {
      if (readdirSync(paths.hostDirectory).length === 0) rmdirSync(paths.hostDirectory);
    } catch {
      // A missing or non-empty host directory needs no further cleanup.
    }
  } else {
    // Non-darwin staging is a dedicated directory this package owns entirely.
    rmSync(paths.hostDirectory, { recursive: true, force: true });
  }
}
