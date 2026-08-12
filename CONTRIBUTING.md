# Contributing to Crawlio Browser Guide

Thanks for your interest. This project has one unusual constraint that shapes every contribution: **the read-only boundary is the product**. Changes that let the extension act on a page — clicks, typing, focus, navigation, scrolling beyond the documented take-me-there arrow, network access from extension pages — will not be accepted, no matter how useful.

## Development

```sh
npm install
npm run build          # extension + native helper
npm run verify:product # the full gate; must be green before any PR
```

Load `dist/extension` unpacked in Chrome (Developer mode). The native helper installs with `npm run install:helper` and removes cleanly with `npm run uninstall:helper`.

## Ground rules

- `npm run verify:product` must pass. It includes the forbidden-capability guard and the read-only end-to-end fixture; if your change trips them, the change is wrong, not the guard.
- The overlay may only grow interactive elements that message the extension itself. The purity test in `tests/unit/overlay-controller.test.ts` pins the exact allowed set — extend it deliberately and explain why in the PR.
- The assistant instructions live in **two byte-identical copies** (`src/shared/assistant-contract.ts` and `native/macos/Sources/BrowserGuideNativeCore/RealtimeClient.swift`). Change both.
- API keys must never appear in Chrome storage, source, logs, or command arguments. `npm run guard:secrets` enforces this on every build.
- New settings or permissions need a matching update to the onboarding wizard and the docs site.

## Reporting issues

Use GitHub issues for bugs and feature discussion. For anything security-sensitive, see [SECURITY.md](SECURITY.md).
