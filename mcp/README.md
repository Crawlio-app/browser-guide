# crawlio-browser-guide

The companion CLI and local MCP server for [Crawlio Browser Guide](https://github.com/Crawlio-app/browser-guide). It installs the native helper with one command and lets coding agents on your machine (Claude Code, Codex, or any MCP client) **see** the browser page you chose to share, without giving them any way to act on it.

## Install the helper (macOS)

```sh
npx crawlio-browser-guide init      # stage the helper + register it with Chrome
npx crawlio-browser-guide doctor    # check every link, including a live host ping
npx crawlio-browser-guide uninstall # remove the registration (credentials stay)
```

`init` ships the universal (arm64 + x86_64) helper binary inside this package, stages it to `~/Library/Application Support/Crawlio Browser Guide/`, and writes the Chrome native-messaging manifests byte-identically to the Swift installer. It is idempotent; rerun it anytime. Windows and Linux arrive with the cross-platform helper.

## How it works

While the **Eyes** toggle in the Browser Guide side panel is on, the extension publishes the sanitized snapshot of the shared tab (origin, title, bounded accessibility outline, never input values, passwords, or screenshots) to `~/.config/browser-guide/eyes.json` (user-only permissions) through the native helper. This server only reads that file:

- Toggle **off** (the default) deletes the file: an absent file is the fail-closed state, and this server reports "eyes are off".
- Every response carries `captured_at` so the agent knows how stale the view is.
- The server has no browser connection, no network access, and exactly one read-only tool.

## Register

```sh
claude mcp add browser-guide -- npx -y crawlio-browser-guide mcp
```

Or in any MCP client config: command `npx`, arguments `["-y", "crawlio-browser-guide", "mcp"]`.

## Tool

- **`get_current_page`**: returns the origin, title, capture time (with a staleness warning past two minutes), and the sanitized page evidence, wrapped in explicit untrusted-content markers.

## Privacy

Everything stays on your machine. See the [Browser Guide privacy policy](https://docs.crawlio.app/browser-guide/privacy).
