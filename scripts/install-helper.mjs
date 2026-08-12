import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, "dist/native/macos/Browser Guide Helper.app/Contents/MacOS/BrowserGuideHelper");
await access(executable, constants.X_OK).catch(() => {
  throw new Error("Build the helper first with scripts/build-helper.mjs and the exact extension ID.");
});

const helperArguments = ["--install"];
const origin = parseOptionalOrigin(process.argv.slice(2));
if (origin) helperArguments.push("--origin", origin);

const status = await run(executable, helperArguments);
if (status !== 0) process.exitCode = status;

function parseOptionalOrigin(argumentsList) {
  if (argumentsList.length === 0) return undefined;
  if (argumentsList.length !== 2) throw new Error("Use --extension-id ID or --extension-origin ORIGIN.");
  const [flag, value] = argumentsList;
  const origin = flag === "--extension-id"
    ? `chrome-extension://${value}/`
    : flag === "--extension-origin" ? value : undefined;
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
    throw new Error("The allowed origin must contain exactly one valid Chrome extension ID.");
  }
  return origin;
}

function run(command, argumentsList) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, argumentsList, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Helper terminated by signal ${signal}.`));
      else resolveStatus(code ?? 1);
    });
  });
}
