import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const extensionDir = resolve(import.meta.dirname, "../dist/extension");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return nested.flat();
}

const manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
const requiredPermissions = manifest.permissions ?? [];
const optionalPermissions = manifest.optional_permissions ?? [];
const permissions = [...requiredPermissions, ...optionalPermissions];
const forbiddenPermissions = [
  "debugger",
  "cookies",
  "downloads",
  "history",
  "proxy",
  "tabs",
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
];
for (const permission of forbiddenPermissions) {
  if (permissions.includes(permission)) throw new Error(`Forbidden manifest permission: ${permission}`);
}
if (requiredPermissions.includes("nativeMessaging")) {
  throw new Error("nativeMessaging must remain an explicit optional permission.");
}
if (JSON.stringify(optionalPermissions) !== JSON.stringify(["nativeMessaging"])) {
  throw new Error("The only optional permission must be nativeMessaging.");
}
if ((manifest.host_permissions ?? []).length > 0 || (manifest.optional_host_permissions ?? []).length > 0) {
  throw new Error("Browser Guide must not request host permissions.");
}
const extensionCsp = manifest.content_security_policy?.extension_pages ?? "";
if (/https?:|wss?:/i.test(extensionCsp)) {
  throw new Error("Extension pages must not declare direct remote-network access.");
}

const forbidden = [
  ["chrome debugger", /chrome\s*\.\s*debugger/i],
  ["CDP input dispatch", /Input\s*\.\s*dispatch/i],
  ["runtime evaluation", /Runtime\s*\.\s*evaluate/i],
  ["generic eval", /\beval\s*\(/],
  ["dynamic function", /new\s+Function\s*\(/],
  ["tab creation", /tabs\s*\.\s*create\s*\(/],
  ["tab removal", /tabs\s*\.\s*remove\s*\(/],
  ["tab mutation", /tabs\s*\.\s*update\s*\(/],
  ["element click", /\.click\s*\(\s*\)/],
  ["programmatic scroll", /(?:scrollIntoView|scrollTo|scrollBy)\s*\(/],
  ["location assignment", /(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=(?!=)/],
  ["navigation method", /(?:window\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(/],
  ["history mutation", /history\s*\.\s*(?:pushState|replaceState)\s*\(/],
  ["extension local-storage persistence", /chrome\s*\.\s*storage\s*\.\s*local/i],
  ["direct HTTP request", /\bfetch\s*\(/],
  ["direct XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["direct WebSocket", /\bWebSocket\s*\(/],
  ["retired loopback transport", /(?:127\.0\.0\.1|localhost|43110)/i],
  ["retired pairing flow", /(?:browserGuidePairing|pairing code|pair token|\/pair\b)/i],
];

// The onboarding wizard may navigate ITSELF to the hosted guide after the
// permission grant. It is an extension page with no access to user pages, so
// self-navigation cannot violate the read-only boundary the ban protects.
const welcomeOnlyExemptions = new Set(["location assignment", "navigation method"]);
// The overlay's take-me-there arrow scrolls the guided target into view, only
// as the direct response to the user pressing that arrow. The unit purity test
// pins the single permitted scrollIntoView call to that button handler.
const contentOnlyExemptions = new Set(["programmatic scroll"]);

const violations = [];
for (const file of await filesUnder(extensionDir)) {
  if (!/\.(?:css|html|js|json|md|txt)$/i.test(file)) continue;
  const text = await readFile(file, "utf8");
  const isWelcomeBundle = /welcome\.js$/.test(file);
  const isContentBundle = /content\.js$/.test(file);
  for (const [label, pattern] of forbidden) {
    if (isWelcomeBundle && welcomeOnlyExemptions.has(label)) continue;
    if (isContentBundle && contentOnlyExemptions.has(label)) continue;
    if (pattern.test(text)) violations.push(`${label}: ${file}`);
  }
}

const contentBundle = await readFile(resolve(extensionDir, "content.js"), "utf8");
const pageActionPatterns = [
  ["page focus mutation", /\.focus\s*\(/],
  ["synthetic page event", /\.dispatchEvent\s*\(/],
  ["synthetic input event", /new\s+(?:KeyboardEvent|MouseEvent|PointerEvent|InputEvent|SubmitEvent)\b/],
  ["legacy page command", /document\s*\.\s*execCommand\s*\(/],
];
for (const [label, pattern] of pageActionPatterns) {
  if (pattern.test(contentBundle)) violations.push(`${label}: ${resolve(extensionDir, "content.js")}`);
}
if (violations.length > 0) throw new Error(`Forbidden extension capabilities found:\n${violations.join("\n")}`);
console.log("Forbidden-capability guard passed.");
