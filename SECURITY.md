# Security Policy

## Reporting a vulnerability

Please email **rashid.azarang.eg@gmail.com** with the details. Do not open a public issue for security reports. You should receive a response within a few days.

Reports we especially care about:

- Any way for the extension to act on a page: synthetic clicks, typing, focus, navigation, scrolling outside the documented take-me-there arrow, or form mutation.
- Any path that exposes stored credentials outside `~/.config/browser-guide/credentials.json` (Chrome storage, logs, argv, network requests other than the authenticated call to OpenAI).
- Escapes of the sanitization boundary: input values, passwords, cookies, or hidden form data reaching the model.
- Screenshot fail-closed bypasses: a capture succeeding while sensitive content is visible.
- Native messaging host impersonation or unauthorized extension origins reaching the helper.
- Site-memory boundary escapes: `~/.config/browser-guide/memory.json` accepting non-web origins or unbounded content, memory leaving the machine, or remembered history being treated as instructions rather than untrusted context.
- Agent-eyes consent bypasses: the evidence snapshot (`~/.config/browser-guide/eyes.json`) being written while the Eyes toggle is off, surviving toggle-off or uninstall, containing screenshots or unsanitized content, or the MCP server exposing anything beyond that single read-only snapshot.

## Threat model notes

- Credentials are stored in a user-only (0600) file, the same model Claude Code, Codex, gh, and gcloud use. Local malware running as your user is outside the threat model this project can defend against — the earlier macOS Keychain storage offered no real additional protection for ad-hoc-signed builds and re-prompted on every rebuild.
- Page content is treated as untrusted evidence everywhere, including in the model instructions; prompt-injection reports that cause the model to *act* are in scope by definition of the read-only boundary (there is no acting tool to hijack), but reports that degrade guidance quality are still welcome.
- Per-site memory is local-only and bounded (10 notes per site, 50 sites, trimmed text, 0600 file). It is labeled untrusted history when injected into prompts, the helper rejects any origin that is not plain `http(s)`, and the panel exposes one-click clearing. Imported harness tokens are refreshed only by re-reading their source files, never by calling OAuth endpoints with another product's client ID.
