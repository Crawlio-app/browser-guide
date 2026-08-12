# Spike 3b — Cross-platform helper and real distribution

**Status: proposal, awaiting decision. Nothing here is merged behavior.**

## Problem

The helper is Swift and macOS-only, installed by cloning the repo and running `npm run install:helper`. That gates the whole product on macOS + Xcode. Any broader install story must be "compatible and accessible" before we ship it — distribution quality is the precondition, not an afterthought.

## Recommendation: port the helper to Node, distribute via the existing npm identity

The `mcp/` workspace already publishes `crawlio-browser-guide` to npm (the MCP eyes server). The same package grows two subcommands:

- `crawlio-browser-guide helper` — the native messaging host itself, a Node port speaking the exact same framed protocol.
- `npx crawlio-browser-guide init` — the installer: detects Chrome variants per OS, stages the host, writes the native messaging manifests atomically, and prints what it did.

Why Node over Rust/Go: crawlio-browser already ships this way; every Codex/Claude Code user has Node ≥20; a compiled language buys startup time we don't need (the helper's work is file I/O and one HTTPS call) at the cost of per-OS builds, code signing, and a toolchain the project doesn't otherwise use.

## Lessons inherited from crawlio-browser's `init.ts` (verified in its source)

- **Stage the host binary outside npx's cache** — macOS TCC blocks Chrome from executing hosts under `~/Desktop|Documents|Downloads`, and npx directories are ephemeral. Crawlio stages to `~/.crawlio/native-host/`; we already use `~/Library/Application Support/Crawlio Browser Guide/` on macOS and the port keeps a per-OS equivalent (`%LOCALAPPDATA%` on Windows, `~/.local/share` on Linux).
- **Command resolution ladder**: platform wrapper → absolute Node path → npx as last resort, so the manifest never points at a path that disappears.
- **Atomic config writes** with pre-write validation of existing JSON/TOML, never clobbering unknown keys.
- **`doctor` subcommand** that checks each link (manifest present, path executable, extension origin allowed) and says exactly which link is broken — this session's `HOST_NOT_FOUND` debugging is the argument for it.
- **Derive any "N tools/N steps" copy from the builders**, never hardcode counts.

## Parity gate

The protocol conformance suite is already host-agnostic: `tests/native/native-host-process.test.mjs` speaks raw frames to whatever `BROWSER_GUIDE_NATIVE_HOST` points at. The Node helper merges only when that suite passes unchanged against it — same frames, same strict rejections, same 0600 file behavior.

## What happens to the Swift helper

It remains the macOS implementation as long as spike 3a chooses `SFSpeechRecognizer` (Swift-only API). If 3a is rejected or goes whisper.cpp, the Swift helper can retire after the Node port reaches parity, leaving one codebase.

## Decision asked of the maintainer

Approve starting the Node port inside the existing `mcp/` package (shared identity, staged rollout: `init`+`doctor` first, helper parity second), or keep the product macOS-only for now.
