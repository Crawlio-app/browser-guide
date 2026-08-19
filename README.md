<p align="center">
  <img src="assets/brand/crawlio-logo.svg" alt="Crawlio" width="88">
</p>

# Crawlio Browser Guide

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Crawlio-app/browser-guide/actions/workflows/ci.yml/badge.svg)](https://github.com/Crawlio-app/browser-guide/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-docs.crawlio.app%2Fbrowser--guide-5B9EFF)](https://docs.crawlio.app/browser-guide/overview)

A read-only Chrome side-panel guide that explains the page in front of you and visually points to the right control — over a private OpenAI Realtime connection brokered by a local macOS helper. It **never clicks, types, submits, navigates, or acts** on your behalf; the only thing it moves is the view, and only when you press its take-me-there arrow.

Built by the makers of [Crawlio](https://www.crawlio.app). Where [Crawlio Browser](https://github.com/Crawlio-app/crawlio-browser) gives an AI **full control** of a live browser, Browser Guide is the deliberate inverse: the same evidence infrastructure with the actuation layer structurally removed. The AI can look and point. You stay in charge of every action.

## Features

- **Ask** — explains the current page: what it is, what each section does, where to look next.
- **Find** — locates the best match for what you describe and places a pointer-transparent emerald beacon over it, with a dismissable on-page card.
- **Walkthrough** — select it and the tour starts by itself: a friendly compass companion walks you through the page one bounded step at a time, with progress and a **Next** button right on the page. **Done** closes the tour.
- **Voice** — press the beacon (or `⌘⇧G` / `⌘⇧Space`) and talk. With an OpenAI key the audio streams from your Mac to OpenAI over WebRTC; with a Claude sign-in it is transcribed on this computer by macOS and never leaves it. Either way you press once to start and once to send, so a pause never cuts you off, and questions are transcribed in the language you actually speak. A **Speak** toggle reads typed answers aloud with the system's own voice, locally on macOS and Windows, with no audio session and no extra cost.
- **Practice tour, model-free** — a canned walkthrough of the hosted practice page that runs entirely locally: no model, no network, no helper. It is the wizard's landing step and the panel's demo mode for users who have not installed the helper yet.
- **Visual sharing, fail-closed** — screenshots are opt-in and omitted entirely whenever a visible input, code block, or likely-sensitive content is present.
- **Harness-style credentials** — sign in by reusing your existing Codex or Claude Code login, or paste an OpenAI key. Credentials live in `~/.config/browser-guide/credentials.json` (0600) managed by the native helper — the same pattern Claude Code, Codex, and gh use. They never enter Chrome storage, source, logs, or command arguments. Imported sign-ins stay fresh by re-reading their source file (never by running OAuth flows of our own): a near-expiry Claude token re-syncs from `~/.claude/.credentials.json`, and a rejected Codex key re-reads `~/.codex/auth.json` once before failing.
- **Per-site memory, local and bounded** — the guide remembers the last few question/answer pairs per site in `~/.config/browser-guide/memory.json` (0600, at most 10 notes per site and 50 sites) so follow-up questions have context. It is injected into prompts as explicitly untrusted history, never as instructions, and the panel's clock button clears the current site (or everything) at any time.
- **Agent eyes (MCP), opt-in** — an **Eyes** toggle (off by default, with a visible "Eyes on" badge while active) shares the sanitized snapshot of the current page through `~/.config/browser-guide/eyes.json` (0600), so Claude Code, Codex, or any MCP client can *see* what you see via the bundled [`crawlio-browser-guide` MCP server](mcp/) — and still cannot act on anything. Toggling off deletes the file.
- **Guided onboarding** — a permissions-first setup wizard opens on install and hands you to the [hosted guide](https://docs.crawlio.app/browser-guide/overview) the moment the one required permission is granted.

## The read-only guarantee

The interesting part of this project is not what it does — it is what it provably cannot do:

- The extension holds no `debugger`, `tabs`, `cookies`, `history`, `webRequest`, or host permissions. Page access is a temporary [`activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) grant from your toolbar click, revoked on navigation.
- The model has exactly two tools — `show_guidance` and `clear_guidance` — and neither can act on the page.
- The on-page overlay is a closed shadow root with `pointer-events: none`. Its only interactive elements are three of its own controls (Next, the take-me-there arrow, and dismiss); it registers no listeners on page elements.
- Page evidence is a bounded, sanitized accessibility snapshot: input values, passwords, cookies, storage, network traffic, and hidden form values are always excluded.
- An automated **forbidden-capability guard** scans every build for banned APIs (event dispatch, focus, navigation, network clients, eval, tab mutation), and a Chrome end-to-end fixture proves that a full guided session leaves the page's click, input, key, submit, scroll, focus, history, and location counters at zero.

See [AUDIT.md](AUDIT.md) for the complete security assessment and [PROVENANCE.md](PROVENANCE.md) for the adaptation record from Crawlio Browser.

## Requirements

- Chrome 116+ and Node.js 20+ (macOS 13+, Windows, or Linux via `npx crawlio-browser-guide init`)
- Building the macOS helper from source additionally needs Xcode Command Line Tools with Swift 6
- A credential, and a sign-in you already have counts: a Claude Code sign-in runs the whole product on your Anthropic subscription with no API key at all. An OpenAI Platform API key enables Realtime voice instead and bills against that key. A Codex sign-in only helps if it was made in API-key mode, since a ChatGPT-plan sign-in carries no key to import.

## Quick start

```sh
git clone https://github.com/Crawlio-app/browser-guide.git
cd browser-guide
npm install
npm run build
npm run install:helper
```

Then load the extension:

1. Open `chrome://extensions`, enable Developer mode.
2. Choose **Load unpacked** and select `dist/extension`.
3. The onboarding wizard opens in a new tab — allow the helper, optionally allow the microphone, and land on the [practice page](https://docs.crawlio.app/browser-guide/practice), where the guide gives you a tour of itself before touching any real site.
4. Connect a credential in the side panel: reuse your Codex or Claude Code sign-in, or paste an OpenAI key.
5. Open any page, click the Browser Guide toolbar icon, and ask.

No helper installed yet? The panel still works: **Try the demo first** runs the same practice tour with no binary, no credential, and no network — the helper is an upgrade, not a prerequisite.

Prefer one command? The published npm package installs the helper without cloning anything:

```sh
npx crawlio-browser-guide init      # stage the bundled helper + register it with Chrome
npx crawlio-browser-guide doctor    # check every link, including a live host ping
npx crawlio-browser-guide uninstall # remove the registration
```

On macOS `init` stages the signed universal Swift helper; on Windows and Linux it stages the package's Node helper, which passes the same protocol conformance suite (`npm run test:native:node`). Realtime voice works wherever Chrome and Node do.

In a repo checkout, `npm run install:helper` registers the locally built host instead, and `npm run uninstall:helper` removes it. `scripts/package-mcp-host.mjs` vendors the universal helper binary into the npm package before each `npm publish`.

### Lend your coding agent the same eyes (optional)

Turn on the **Eyes** toggle in the panel, then register the read-only MCP server with your agent:

```sh
claude mcp add browser-guide -- npx -y crawlio-browser-guide mcp
```

Your agent gains one tool, `get_current_page`, that returns the shared snapshot with its capture time — nothing else. See [mcp/README.md](mcp/README.md).

## Architecture

```
┌─────────────────────────────── Chrome ───────────────────────────────┐
│  Side panel (React)      Content script (closed-shadow overlay)      │
│  Ask / Find / Walkthrough  beacons · step cards · Next/arrow/dismiss │
│        │  bounded, sanitized page snapshot (activeTab only)          │
└────────┼─────────────────────────────────────────────────────────────┘
         │ WebRTC SDP offer            native messaging (stdio frames)
         ▼                                        ▼
   OpenAI Realtime  ◄──── session brokered ──── macOS helper (Swift)
   (audio + text)          by the helper         credentials · memory ·
                                                 eyes snapshot (0600)
                                                        ▲ read-only
                                             crawlio-browser-guide MCP
                                             (Claude Code / Codex eyes)
```

Where your page goes depends on which credential you connected, and Browser Guide picks the engine for you rather than asking.

**With an OpenAI key (Realtime).** Page evidence and audio go directly from Chrome to OpenAI. The helper creates the session and stores the trimmed question and answer pairs that make up site memory, but never sees screenshots, page content, or the live conversation stream.

**With a Claude sign-in.** The helper is the relay, so it does see the sanitized page evidence on its way to Anthropic. In exchange, voice never leaves this computer at all: the recording is transcribed on-device by macOS, and only the resulting text is sent.

Either way there is no Crawlio server in the path. Nothing is sent anywhere until you ask a question, and the credential stays in a private file on your machine rather than in Chrome.

## Verification

```sh
npm run verify:product
```

Runs strict TypeScript checking, 86 unit/integration tests, a production build, native-helper validation, 35 Swift tests, native framing and MCP server process tests, secret and forbidden-capability guards, and 4 Chrome end-to-end tests covering typed questions, prerecorded voice, grounded pointing, and a three-step walkthrough driven by physical clicks on the overlay's own buttons.

`npm run verify` additionally runs the maintainer-only provenance sentinel, which requires a sibling checkout of the Crawlio Browser workspace.

Before calling a build release-ready, run the live smoke against a real key:

```sh
BROWSER_GUIDE_LIVE_SMOKE=1 npm run smoke:live
```

## Known limitations

- Chrome never grants access on internal pages (`chrome://`), the Chrome Web Store, or other restricted surfaces.
- Canvas-drawn and virtualized interfaces (spreadsheets, design tools, maps) do not expose their inner content to the accessibility snapshot; the guide says so plainly and works with what is visible.
- Voice requires a funded OpenAI Platform key and Realtime availability.
- The helper ships ad-hoc signed from source; a notarized Developer ID distribution is future work. Credentials use a 0600 file rather than the macOS Keychain, whose per-binary access control re-prompts on every local rebuild.

## License

[Apache 2.0](LICENSE). Contains adapted concepts and portions from [Crawlio Browser](https://github.com/Crawlio-app/crawlio-browser) (Apache 2.0) — see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
