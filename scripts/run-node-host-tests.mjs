// Runs the native-host conformance suite against the Node helper.
//
// Exists because `VAR=value node --test` is POSIX shell syntax: on Windows,
// npm scripts run under cmd.exe and that line is a parse error. Setting the
// variable here keeps one script that behaves identically on every platform
// the package claims to support.
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--test", "tests/native/native-host-process.test.mjs"],
  {
    stdio: "inherit",
    env: { ...process.env, BROWSER_GUIDE_NATIVE_HOST: "mcp/bin/host.js" },
  },
);
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
