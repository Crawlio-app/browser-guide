import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const parent = resolve(import.meta.dirname, "../../crawlio-agent");
const expectedHead = "60400222415b7a2f287264a50edd9bdf6f966db9";
const expectedDirtyStateHash = "fd89a09090f3d0b4fb7974b845fb75f927b0149fb96c1ed8a40409b857a2e98a";
const initialWholeTreeHash = "e0dff2528e2fde3919ea9b72ad6bfd1edc76af84d5de1a0f6fa0a083dc73bff5";

const provenance = new Map([
  ["src/extension/injected/agent-cursor.ts", "c86e152bdc0046d72e283c787694778381c980de11a0d2867b0c72b0f2ef56a3"],
  ["src/extension/injected/dom-snapshot.ts", "605acdc3fb3266cceb2aff344f092c1324c30f1b69fdd616b42fd9216ca46786"],
  ["src/extension/background.ts", "37bf1ba9f5727a2b758a5d02c23735a23101e7c4cc4d7ac266eab47f9d2e83ae"],
  ["src/mcp-server/extraction-js.ts", "e633bb4c2bd4406637ca2fc27b5fe8568301fa4897a3af7e9c05e37350c9a447"],
  ["src/mcp-server/redact.ts", "75eb271becb4e4b541becab0e42250b4fe17e458844859abaf1d3d014024594a"],
  ["src/mcp-server/content-boundary.ts", "94a075552f193bbe086ab1bee5b988b11b9c61948593aee7c807744973e5ddc5"],
  ["src/shared/bridge-handshake.ts", "eafd92bab1e5cc27b2c3a310098165265a4c6968d7563c559a8300cb6aa6360b"],
  ["packages/semantic-grounding/contract/context.schema.json", "06a77c444438583b77328aece4ae873898666c954ca4302439a12c039f198a9f"],
  ["packages/semantic-grounding/contract/provider.schema.json", "122699b92d3501656c5bd1859a30c20ee3ba323b288937efdb97cdb2df50f4af"],
  ["packages/semantic-grounding/contract/result.schema.json", "d537ca1405ad543ea95389cdc7bfee091aec23fc26638aabceaf7844dff33b9d"],
  ["packages/semantic-grounding/src/types.ts", "ffbf33653d0d1813d962556afeee1e1fff7244ce1ce836f494d4a8878a2b0339"],
  ["packages/semantic-grounding/src/providers/heuristic.ts", "943a5c78535aa1c96fca4cdcfb075e6f5f1c92d9ca8ba61e93c2f65f545899f3"],
  ["tests/mocks/chrome.ts", "cdcdaa208d44c16dbe17d97e2318e146b06945ab1a26762db747420bd8fd95e5"],
  ["tests/unit/agent-cursor.test.ts", "a457066d72a52ad675695d16bb156bfccfb668cad9a9c3bf2e0895c28b58a8e6"],
  ["tests/unit/aria-snapshot.test.ts", "ff0719547daa6b3eede0a5baaf2c0d86a31bb6980721f3cf3d8ad4fc55165955"],
  ["tests/unit/semantic-grounding/contract.test.ts", "d688e0c29257448d3b8576a9f2d266c8436b14fc0baeb3f2cff38a9d72910d6c"],
  ["tests/unit/semantic-grounding/router.test.ts", "4530e93482f84ca5af4de5ea22364e877ff25a13f45ddf9dfa49c9ba7e105d79"],
  ["tests/unit/redact.test.ts", "13e86f7eefe190a0452ec97ddae6b6991e55d8d58fe066c5476f7a77f042bda2"],
  ["tests/unit/content-boundary.test.ts", "0314eafd5f466ed4d8bce0dd86fe478dd872b89542282c89f834d889658eabc0"],
  ["tests/unit/bridge-handshake.test.ts", "4e96ecb084dfa307c818582c0aa8f3fb28b3535adbf8da4a680edbedcced00ec"],
  ["LICENSE", "cb875aa83de2b8063222d5d6ccf9fd3d21d147d33453bfc6ce42002203670a7c"],
  ["NOTICE", "a2b0b34c77da0c5c0bc4c7484a1370ec62dcc835f19acf463fef587f4ad346de"],
]);

const failures = [];
const strictTree = process.argv.includes("--strict-tree");
const currentHead = git(["rev-parse", "HEAD"]).trim();
if (strictTree && currentHead !== expectedHead) failures.push("parent HEAD changed: " + currentHead);

for (const [relativePath, expectedHash] of provenance) {
  const currentHash = sha256(readFileSync(resolve(parent, relativePath)));
  if (currentHash !== expectedHash) failures.push(relativePath + " changed: " + currentHash);
}

if (strictTree) {
  const dirtyState = git(["status", "--porcelain=v2", "--untracked-files=all"]);
  const dirtyStateHash = sha256(dirtyState);
  if (dirtyStateHash !== expectedDirtyStateHash) failures.push("parent Git dirty-state shape changed: " + dirtyStateHash);
  const command = "find . -path './.git' -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256";
  const currentWholeTreeHash = execFileSync("/bin/zsh", ["-c", command], { cwd: parent, encoding: "utf8" }).trim().split(/\s+/)[0];
  if (currentWholeTreeHash !== initialWholeTreeHash) failures.push("parent whole-tree hash changed: " + currentWholeTreeHash);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write("Parent verification failed: " + failure + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write("All " + provenance.size + " parent provenance files match the recorded baseline.\n");
}

function git(args) {
  return execFileSync("git", args, { cwd: parent, encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
