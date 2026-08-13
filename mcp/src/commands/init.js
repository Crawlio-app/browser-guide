import { join } from "node:path";
import { findHostBinary, hostPaths, installHost, isMachO } from "../host-install.js";
import { pingHost } from "../native-ping.js";

export async function runInit(homeDir) {
  // macOS installs the compiled Swift host shipped in this package; other
  // platforms stage the package's own Node helper. Same command everywhere.
  let source = null;
  if (process.platform === "darwin") {
    source = findHostBinary();
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
  }

  const report = installHost(source, homeDir);
  const paths = hostPaths(homeDir);
  console.error(`Host ${report.binary}: ${paths.hostPath}`);
  for (const manifest of report.manifests) {
    console.error(`Manifest ${manifest.state}: ${manifest.path}`);
  }
  for (const key of report.registry) {
    console.error(`Registry key set: ${key}`);
  }

  try {
    const health = process.platform === "darwin"
      ? await pingHost(paths.hostPath)
      : await pingHost(process.execPath, 5_000, [join(paths.hostDirectory, "host-entry.js")]);
    console.error(`Host answers: ready (credential configured: ${health.configured ? "yes" : "no; connect one in the side panel for voice"})`);
  } catch (error) {
    console.error(`Warning: ${error instanceof Error ? error.message : String(error)}`);
    console.error("The registration files are in place; run `crawlio-browser-guide doctor` after fixing the above.");
  }

  console.error("\nNext steps:");
  console.error("  1. Install the Browser Guide extension in Chrome (chrome://extensions, Load unpacked, dist/extension).");
  console.error("  2. Open any page, click the Browser Guide toolbar icon, and grant helper access when asked.");
  console.error("  3. Try it safely first: https://docs.crawlio.app/browser-guide/practice");
}
