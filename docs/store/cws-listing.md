# Chrome Web Store listing for Crawlio Browser Guide

Everything below is ready to paste into the CWS Developer Dashboard. The zip
comes from `npm run package:cws`. Submission itself uses the owner's developer
account.

## Identity

- **Name:** Crawlio Browser Guide
- **Category:** Accessibility (alternative: Productivity > Tools)
- **Language:** English

## Summary (132-character limit)

> A read-only guide for the page you share. It explains and points with voice or text. It never clicks, types, or acts for you.

(129 characters.)

## Description

Browser Guide explains the page in front of you and points at the control you
are looking for. It is read-only by construction: it never clicks, types,
submits, navigates, or scrolls. It shows you where; you act.

**Three ways to ask.** Ask explains what is on the page. Find points at the
control that matches what you describe. Walkthrough guides a task one
read-only step at a time, waiting for you to act before it continues.

**Voice, both directions.** Press once to start talking and once to send, so a
pause never cuts you off. Questions are transcribed in the language you speak.
A Speak toggle reads answers aloud with the system voice.

**Your own sign-in answers.** Browser Guide brings no cloud of its own.
Connect the Claude Code sign-in or OpenAI credential you already have; a local
helper on your computer keeps it in a private file that never enters Chrome.
With an OpenAI key, voice streams to OpenAI in real time and screenshots can
be shared. With a Claude sign-in, your subscription answers and voice is
transcribed on your computer, never uploaded. With both, a click switches.

**Private by structure, not policy.** Nothing is read until you click the
toolbar icon on a tab, and the shared tab is marked with a named tab group so
you always know which one it is. Page evidence is sanitized before it leaves
Chrome: input values, passwords, and hidden fields never reach any model. No
Crawlio server is ever in the path, there are no analytics, and there is no
account with us to create.

**Try it before connecting anything.** A built-in demo runs a full guided tour
on a practice page with no helper, no credential, and no network.

## Single-purpose statement

> Browser Guide has one purpose: explaining and visually pointing at the
> contents of a page the user explicitly shares, on request. It performs no
> actions on pages, collects no analytics, and operates no server of its own.

## Permission justifications

- **activeTab** - The entire access model. A page can only be read after the
  user clicks the toolbar icon on that tab; there are no host permissions and
  no background access to any site.
- **scripting** - Injects the read-only snapshot and overlay code into the one
  tab the user shared, on demand. There are no content scripts registered on
  any site.
- **storage** - Session-scoped runtime state (which tab is shared, engine
  choice). Nothing written here survives a browser restart, and no credential
  or page content is ever stored in Chrome.
- **sidePanel** - The product surface is a side panel next to the page it
  explains.
- **tabGroups** - Puts the one shared tab into a named, coloured tab group so
  the user can always see which tab is being read, and removes it when
  sharing stops. It names a tab the user already shared; it grants no access
  to any page. The broader `tabs` permission is deliberately absent.
- **nativeMessaging (optional)** - Connects to the Browser Guide helper the
  user installs on their computer. The helper holds the user's credential in
  a private local file (never in Chrome) and relays model calls. Optional so
  the demo works with nothing installed; requested once, with an explanation,
  during setup.
- **commands** - Two keyboard shortcuts to open the panel and start or stop
  voice. No page interaction.

## Data-usage disclosures (Privacy tab)

- **Collected by the developer: nothing.** No analytics, no telemetry, no
  account, no Crawlio server in any request path.
- **Sent to third parties, only on an explicit user question, under the
  user's own credential:**
  - OpenAI (Realtime engine): sanitized page evidence, the question, and
    microphone audio while speaking; optional screenshot if Visual is on.
  - Anthropic (Claude engine): sanitized page evidence and the question,
    relayed by the local helper. Voice is transcribed on-device; audio never
    leaves the machine.
- Sanitization strips input values, passwords, emails, numbers that look like
  identifiers, and hidden fields before anything leaves Chrome.
- Site memory (past questions and answers per site) lives in a private local
  file on the user's computer and can be cleared from the panel.
- **Privacy policy URL:** https://docs.crawlio.app/browser-guide/privacy

## Screenshots (1280x800, shot list)

1. Practice page with the panel open, Find pointing at a control (arrow
   visible, page untouched).
2. Ask answer with the recording bar visible (waveform mid-recording).
3. Walkthrough mid-task: step card with the numbered beacon on the page.
4. Setup: "Connect your sign-in" leading with a detected sign-in.
5. Wizard connected view: account, plan, disconnect.

## Review notes (for the reviewer field)

The optional native messaging host is `com.crawlio.browser_guide`, installed
by the user with `npx crawlio-browser-guide init` (source: github.com/Crawlio-app/browser-guide).
The extension is fully reviewable without it: the demo tour exercises the
whole surface with no helper, no credential, and no network. The bundle
contains no synthetic click, type, focus, scroll, or navigation calls; a
build-time guard (`scripts/guard-forbidden.mjs`) fails the build if any are
introduced, and e2e tests assert zero page mutations during guidance.

## Submission checklist

- [ ] `npm run verify:product` green on the release commit
- [ ] `npm run package:cws` and upload the zip from `dist/`
- [ ] Paste summary, description, single-purpose statement, justifications
- [ ] Privacy tab: disclosures above, policy URL
- [ ] Upload 5 screenshots (shot list above)
- [ ] Reviewer notes pasted
- [ ] Submit for review with the owner's developer account
