import { spawn } from "node:child_process";
import { access, readdir, rm, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, "dist/native/macos/Browser Guide Helper.app/Contents/MacOS/BrowserGuideHelper");

try {
  await access(executable, constants.X_OK);
  const status = await run(executable, ["--remove"]);
  if (status !== 0) process.exitCode = status;
} catch {
  await removeKnownRegistrationFiles();
  console.log("Browser Guide native host registration removed for this user.");
}

async function removeKnownRegistrationFiles() {
  const userHome = homedir();
  const hostDirectory = resolve(userHome, "Library/Application Support/Crawlio Browser Guide/Native Host");
  const paths = [
    resolve(userHome, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.crawlio.browser_guide.json"),
    resolve(userHome, "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/com.crawlio.browser_guide.json"),
    // Remove registrations emitted by Browser Guide builds predating Chrome 146's documented path.
    resolve(userHome, "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.crawlio.browser_guide.json"),
    resolve(hostDirectory, "com.crawlio.browser_guide"),
  ];
  await Promise.all(paths.map((path) => rm(path, { force: true })));
  try {
    if ((await readdir(hostDirectory)).length === 0) await rmdir(hostDirectory);
  } catch {
    // A missing or non-empty dedicated directory needs no further cleanup.
  }
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
