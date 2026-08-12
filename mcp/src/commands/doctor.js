import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { EXTENSION_ORIGIN, HOST_NAME, hostPaths, isMachO, sha256, vendorMetadata } from "../host-install.js";
import { pingHost } from "../native-ping.js";

export async function runDoctor(homeDir) {
  if (process.platform !== "darwin") {
    console.error("doctor currently supports macOS only.");
    process.exitCode = 1;
    return;
  }
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
      fail(`${manifestPath} is missing — run \`crawlio-browser-guide init\`.`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      fail(`${manifestPath} is not valid JSON — run \`crawlio-browser-guide init\`.`);
      continue;
    }
    if (manifest.name !== HOST_NAME || manifest.type !== "stdio"
      || !Array.isArray(manifest.allowed_origins)
      || manifest.allowed_origins.length !== 1
      || manifest.allowed_origins[0] !== EXTENSION_ORIGIN
      || typeof manifest.path !== "string") {
      fail(`${manifestPath} has unexpected contents — run \`crawlio-browser-guide init\`.`);
      continue;
    }
    manifestHostPaths.add(manifest.path);
    pass(manifestPath);
  }
  if (manifestHostPaths.size > 1) warn("The two manifests point at different host binaries; rerun init.");

  console.error("Host binary:");
  const hostPath = [...manifestHostPaths][0] ?? paths.hostPath;
  if (!existsSync(hostPath)) {
    fail(`${hostPath} is missing — run \`crawlio-browser-guide init\`.`);
  } else {
    try {
      accessSync(hostPath, constants.X_OK);
    } catch {
      fail(`${hostPath} is not executable — run \`crawlio-browser-guide init\`.`);
    }
    if (!isMachO(hostPath)) fail(`${hostPath} is not a valid Mach-O executable.`);
    else pass(hostPath);
    const metadata = vendorMetadata();
    if (metadata?.sha256 && existsSync(hostPath) && sha256(hostPath) !== metadata.sha256) {
      warn("The installed host differs from this package's binary — rerun init to update it.");
    }
  }

  console.error("Live host check:");
  if (existsSync(hostPath)) {
    try {
      const health = await pingHost(hostPath);
      pass(`HOST_HEALTH answers; credential configured: ${health.configured ? "yes" : "no"}`);
      if (!health.configured) warn("No credential yet — voice needs one; connect it in the side panel.");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  } else {
    fail("Skipped — no host binary to ping.");
  }

  console.error("Agent eyes:");
  console.error(`  info  ${existsSync(paths.eyesPath) ? "eyes.json present — the Eyes toggle is on." : "eyes.json absent — the Eyes toggle is off (the normal default)."}`);

  console.error("Not checkable from this CLI (verify in Chrome):");
  console.error("  - The Browser Guide extension is installed and pinned.");
  console.error("  - The nativeMessaging permission was granted in the panel.");

  if (failed) process.exitCode = 1;
  else console.error("\nEverything this CLI can check looks good.");
}
