// Produces the Chrome Web Store upload artifact from the production build.
// The zip must contain the extension files at its root (not a wrapping dir).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const extensionDirectory = resolve(root, "dist/extension");
const artifact = resolve(root, "dist/browser-guide-cws.zip");

if (!existsSync(extensionDirectory)) {
  console.error("dist/extension is missing; run `npm run build:extension` first.");
  process.exit(1);
}

rmSync(artifact, { force: true });
execFileSync("zip", ["-r", "-X", artifact, "."], { cwd: extensionDirectory, stdio: "pipe" });
const size = statSync(artifact).size;
console.log(`Store artifact ready: ${artifact} (${Math.round(size / 1024)}KB)`);
console.log("Upload at https://chrome.google.com/webstore/devconsole (requires the developer account).");
