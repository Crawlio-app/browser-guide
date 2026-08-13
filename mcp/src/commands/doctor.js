import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EXTENSION_ORIGIN, HOST_NAME, hostPaths, isMachO, sha256, vendorMetadata } from "../host-install.js";
import { pingHost } from "../native-ping.js";

export async function runDoctor(homeDir) {
  const paths = hostPaths(homeDir);
  let failed = false;
  const pass = (line) => console.error(`  ok    ${line}`);
  const warn = (line) => console.error(`  warn  ${line}`);
  const fail = (line) => {
    failed = true;
    console.error(`  FAIL  ${line}`);
  };

  console.error("Native messaging manifests:");
  const manifestHostPaths = new Set();
  for (const manifestPath of paths.manifestPaths) {
    if (!existsSync(manifestPath)) {
      fail(`${manifestPath} is missing; run \`crawlio-browser-guide init\`.`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      fail(`${manifestPath} is not valid JSON; run \`crawlio-browser-guide init\`.`);
      continue;
    }
    if (manifest.name !== HOST_NAME || manifest.type !== "stdio"
      || !Array.isArray(manifest.allowed_origins)
      || manifest.allowed_origins.length !== 1
      || manifest.allowed_origins[0] !== EXTENSION_ORIGIN
      || typeof manifest.path !== "string") {
      fail(`${manifestPath} has unexpected contents; run \`crawlio-browser-guide init\`.`);
      continue;
    }
    manifestHostPaths.add(manifest.path);
    pass(manifestPath);
  }
  if (manifestHostPaths.size > 1) warn("The manifests point at different host binaries; rerun init.");

  for (const key of paths.registryKeys) {
    try {
      execFileSync("reg.exe", ["query", key, "/ve"], { stdio: "pipe" });
      pass(`registry ${key}`);
    } catch {
      fail(`registry key ${key} is missing; run \`crawlio-browser-guide init\`.`);
    }
  }

  console.error("Host launcher:");
  const hostPath = [...manifestHostPaths][0] ?? paths.hostPath;
  if (!existsSync(hostPath)) {
    fail(`${hostPath} is missing; run \`crawlio-browser-guide init\`.`);
  } else {
    try {
      accessSync(hostPath, constants.X_OK);
    } catch {
      if (paths.platform !== "win32") fail(`${hostPath} is not executable; run \`crawlio-browser-guide init\`.`);
    }
    if (paths.platform === "darwin") {
      if (!isMachO(hostPath)) fail(`${hostPath} is not a valid Mach-O executable.`);
      else pass(hostPath);
      const metadata = vendorMetadata();
      if (metadata?.sha256 && existsSync(hostPath) && sha256(hostPath) !== metadata.sha256) {
        warn("The installed host differs from this package's binary; rerun init to update it.");
      }
    } else {
      const entry = join(paths.hostDirectory, "host-entry.js");
      if (!existsSync(entry)) fail(`${entry} is missing; run \`crawlio-browser-guide init\`.`);
      else pass(hostPath);
    }
  }

  console.error("Live host check:");
  const pingTarget = paths.platform === "darwin" ? hostPath : join(paths.hostDirectory, "host-entry.js");
  if (existsSync(pingTarget)) {
    try {
      const health = paths.platform === "darwin"
        ? await pingHost(hostPath)
        : await pingHost(process.execPath, 5_000, [pingTarget]);
      pass(`HOST_HEALTH answers; credential configured: ${health.configured ? "yes" : "no"}`);
      if (!health.configured) warn("No credential yet: voice needs one; connect it in the side panel.");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  } else {
    fail("Skipped: no host to ping.");
  }

  console.error("Agent eyes:");
  console.error(`  info  ${existsSync(paths.eyesPath) ? "eyes.json present: the Eyes toggle is on." : "eyes.json absent: the Eyes toggle is off (the normal default)."}`);

  console.error("Not checkable from this CLI (verify in Chrome):");
  console.error("  - The Browser Guide extension is installed and pinned.");
  console.error("  - The nativeMessaging permission was granted in the panel.");

  if (failed) process.exitCode = 1;
  else console.error("\nEverything this CLI can check looks good.");
}
