import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2] ?? "all";
const execFileAsync = promisify(execFile);

if (!new Set(["all", "extension", "helper"]).has(target)) {
  throw new Error(`Unknown build target: ${target}`);
}

async function buildExtension() {
  const outdir = resolve(root, "dist/extension");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const common = {
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome116",
    sourcemap: false,
    minify: true,
    legalComments: "none",
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
  };

  await Promise.all([
    build({ ...common, entryPoints: [resolve(root, "src/extension/service-worker.ts")], outfile: resolve(outdir, "service-worker.js") }),
    build({ ...common, entryPoints: [resolve(root, "src/extension/content/index.ts")], outfile: resolve(outdir, "content.js") }),
    build({ ...common, entryPoints: [resolve(root, "src/extension/sidepanel/app.tsx")], outfile: resolve(outdir, "sidepanel.js"), jsx: "automatic" }),
    build({ ...common, entryPoints: [resolve(root, "src/extension/welcome/welcome.ts")], outfile: resolve(outdir, "welcome.js") }),
  ]);

  await Promise.all([
    cp(resolve(root, "src/extension/manifest.json"), resolve(outdir, "manifest.json")),
    cp(resolve(root, "src/extension/sidepanel/sidepanel.html"), resolve(outdir, "sidepanel.html")),
    cp(resolve(root, "src/extension/sidepanel/styles.css"), resolve(outdir, "styles.css")),
    cp(resolve(root, "src/extension/welcome/welcome.html"), resolve(outdir, "welcome.html")),
    cp(resolve(root, "src/extension/welcome/welcome.css"), resolve(outdir, "welcome.css")),
    cp(resolve(root, "src/extension/assets/icons"), resolve(outdir, "icons"), { recursive: true }),
    cp(resolve(root, "NOTICE"), resolve(outdir, "NOTICE")),
    cp(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(outdir, "THIRD_PARTY_NOTICES.md")),
    cp(resolve(root, "licenses"), resolve(outdir, "licenses"), { recursive: true }),
  ]);
}

async function buildHelper() {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [resolve(root, "scripts/build-helper.mjs")],
    { cwd: root, maxBuffer: 8 * 1_024 * 1_024 },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

if (target === "all") {
  await rm(resolve(root, "dist"), { recursive: true, force: true });
}
if (target === "all" || target === "extension") await buildExtension();
if (target === "all" || target === "helper") await buildHelper();
