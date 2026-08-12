import { findHostBinary, hostPaths, installHost, isMachO } from "../host-install.js";
import { pingHost } from "../native-ping.js";

export async function runInit(homeDir) {
  if (process.platform !== "darwin") {
    console.error("init currently supports macOS only — the cross-platform helper is on its way. The `mcp` subcommand works everywhere.");
    process.exitCode = 1;
    return;
  }
  const source = findHostBinary();
  if (!source) {
    console.error("No native host binary was found. In a repo checkout run `npm run build:helper` first; from npm, reinstall the package.");
    process.exitCode = 1;
    return;
  }
  if (!isMachO(source)) {
    console.error(`The host binary at ${source} is not a valid Mach-O executable. Reinstall the package.`);
    process.exitCode = 1;
    return;
  }

  const report = installHost(source, homeDir);
  const paths = hostPaths(homeDir);
  console.error(`Host binary ${report.binary}: ${paths.hostPath}`);
  for (const manifest of report.manifests) {
    console.error(`Manifest ${manifest.state}: ${manifest.path}`);
  }

  try {
    const health = await pingHost(paths.hostPath);
    console.error(`Host answers: ready (credential configured: ${health.configured ? "yes" : "no — connect one in the side panel for voice"})`);
  } catch (error) {
    console.error(`Warning: ${error instanceof Error ? error.message : String(error)}`);
    console.error("The registration files are in place; run `crawlio-browser-guide doctor` after fixing the above.");
  }

  console.error("\nNext steps:");
  console.error("  1. Install the Browser Guide extension in Chrome (chrome://extensions, Load unpacked, dist/extension).");
  console.error("  2. Open any page, click the Browser Guide toolbar icon, and grant helper access when asked.");
  console.error("  3. Try it safely first: https://docs.crawlio.app/browser-guide/practice");
}
