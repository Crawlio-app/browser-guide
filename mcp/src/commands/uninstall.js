import { uninstallHost } from "../host-install.js";

export function runUninstall(homeDir) {
  if (process.platform !== "darwin") {
    console.error("uninstall currently supports macOS only.");
    process.exitCode = 1;
    return;
  }
  uninstallHost(homeDir);
  console.error("Browser Guide native host registration removed for this user.");
  console.error("Any stored credential remains until Browser Guide forgets it (key button in the panel, or delete ~/.config/browser-guide/credentials.json).");
}
