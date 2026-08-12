import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../dist");
const extensionDir = resolve(distDir, "extension");
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return nested.flat();
}

const patterns = [
  ["OpenAI-style secret", /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
];
const violations = [];
for (const file of await filesUnder(distDir)) {
  const text = await readFile(file, "utf8");
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) violations.push(`${label}: ${file}`);
  }
}

for (const file of await filesUnder(extensionDir)) {
  if (!/\.(?:css|html|js|json|md|txt)$/i.test(file)) continue;
  const text = await readFile(file, "utf8");
  if (/OPENAI_API_KEY/.test(text)) violations.push(`OpenAI environment key name: ${file}`);
  if (/Authorization\s*:\s*Bearer/i.test(text)) violations.push(`authorization bearer: ${file}`);
}

if (violations.length > 0) throw new Error(`Secret material found in production output:\n${violations.join("\n")}`);
console.log("Production secret guard passed.");
