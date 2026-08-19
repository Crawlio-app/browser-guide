# Browser Guide selective-fork audit

## Bottom line

Crawlio Browser is a valuable source of observation, grounding, sanitization, and test patterns, but it is not an appropriate runtime base for Browser Guide. Crawlio intentionally exposes an agentic browser control plane. Browser Guide’s product promise is narrower: temporarily observe, explain, and point, while being structurally unable to click, type, submit, navigate, scroll, focus, or mutate the page.

The child is therefore an independent MV3 extension and macOS native host. It adapts bounded snapshot/ref concepts and discards CDP, MCP, action tools, broad inspection, remote relays, and resident monitoring.

## Architecture after the apex upgrade

1. A toolbar or keyboard gesture grants `activeTab` authority for one tab and origin.
2. A static, on-demand content runtime produces a bounded accessible snapshot with opaque refs, semantic grouping, ARIA state, geometry, and read-only occlusion confidence.
3. The side panel owns Ask, Find, Walkthrough, voice state, turn IDs, snapshot freshness, and recovery.
4. A closed-shadow, pointer-transparent overlay presents one primary beacon or at most three numbered comparison targets. Walkthrough step cards additionally carry one interactive Next button inside the extension's own shadow UI; it only messages the extension to continue and registers no listeners on page elements.
5. Chrome Native Messaging connects the service worker to `com.crawlio.browser_guide` over framed stdio. Exact extension-origin registration replaces host permissions, localhost networking, pairing codes, HMAC tokens, and ports.
6. The native host holds the credential in a private 0600 file and speaks to whichever provider that credential names. On the Realtime engine it creates OpenAI WebRTC sessions and receives only a credential operation or SDP plus mode, never page evidence, screenshots, transcripts, or walkthrough state. On the Claude engine it is the relay, so it does receive the sanitized evidence it forwards to Anthropic, and it transcribes voice on-device so no audio leaves the machine. Neither engine involves a Crawlio-operated server.
7. The Realtime application surface contains exactly `show_guidance` and `clear_guidance`.

## What was worth adapting

| Parent or reference strength | Child use |
| --- | --- |
| Compact ARIA/page snapshots | Bounded accessible candidates in `observer.ts` |
| Snapshot-scoped opaque refs | `ElementRegistry` with meaningful-mutation invalidation |
| Agent-cursor geometry | New DPR-aware closed-shadow guide overlay |
| Page-section inference | Semantic grouping for clearer evidence |
| Grounding contracts and heuristics | Deterministic test oracle and fallback ranking |
| Redaction and content boundaries | Browser-side sanitization plus nonce-delimited untrusted evidence |
| Strict bridge contracts | Versioned native envelopes, exact schemas, request IDs, byte caps, and deadlines |
| Lifecycle patterns | Single-flight connection, one reconnect, idle teardown, and superseded-turn rejection |
| Compact developer-tool affordances | Explicit activation, focused states, cleanup, and keyboard parity |

## What was deliberately rejected

- Chrome debugger/CDP, WebMCP, generic evaluation, and MAIN-world globals.
- Input dispatch, click, type, drag, form fill, submit, navigation, tab mutation, or focus. Programmatic scrolling is limited to one path: scrolling the guided target into view when the user presses the overlay's direction arrow.
- Cookies, browser storage, network/request bodies, IndexedDB, component state, or framework-store inspection.
- Interactive pickers that intercept page hover or click behavior.
- Cloud relays, localhost servers, WebSockets, pairing tokens, port permissions, or offscreen keepalive pages.
- Recording, extraction workbenches, dashboards, freemium funnels, analytics, telemetry, and permanent browsing history.
- Broad host access, `<all_urls>`, `webRequest`, hidden wake words, and always-on microphone capture.

## Walkthrough safety analysis

A walkthrough starts only from an explicit user goal. Model guidance declares whether it is waiting for a page change, manual confirmation, or nothing. Automatic recapture is possible only while waiting for a meaningful page change, after DOM quiescence, and no more than once every two seconds. The session stops advancing at 12 steps or 30 minutes and pauses on churn, stale refs, a restricted page, tab change, origin change, or lost access.

The observer does not watch page clicks or keyboard events. That avoids turning guidance into behavioral surveillance. The tradeoff is that some user actions produce no detectable mutation; the panel exposes a manual Continue path for those cases.

## Residual risks

| Risk | Mitigation | Residual reality |
| --- | --- | --- |
| Wrong model target | Current opaque refs, exact tool schema, stale/superseded rejection, maximum three targets | A valid ref can still be semantically wrong; the user decides |
| Prompt injection | Explicit untrusted boundary, redaction, read-only system contract | Model resistance is not a formal sandbox |
| Sensitive pixels | Visual off by default; known-risk views fail closed; pre/post capture-guard verification; byte-budget omission | Arbitrary sensitive imagery cannot be perfectly recognized |
| Incomplete understanding | ARIA/name/text/state/group evidence and optional current viewport | Canvas, cross-origin frames, closed shadow roots, and poor accessibility remain sparse |
| Overlay conflict | Closed Shadow DOM, maximum z-index, pointer transparency, teardown | Hostile pages can cover or remove extension DOM |
| Local credential boundary | Security.framework, exact native origin, no Chrome persistence/logging/argv | A compromised local account can attack local processes or Keychain access |
| Transient key entry | Password input, immediate clearing, native-only persistence, eight-second deadline | The key briefly exists in side-panel memory during setup |
| Realtime availability/cost | Explicit user turns, teardown, typed retry, cause-specific recovery | A valid paid key and OpenAI network availability are required |
| Unpacked installation | Stable project-owned identity and one-time helper | Developer mode and local installation remain manual |

## Verification boundary

The automated gate covers strict typing; exact assistant/native protocols; timeout, crash, reconnect, and malformed-message behavior; real temporary Keychain write/read/replace/forget cleanup; production bundle secret scans; forbidden page-action and network guards; stable extension identity; setup responsiveness; grounded overlay output; walkthrough quiescence, rate, churn, origin, step, and duration limits; and a page fixture whose action counters must all remain zero.

The browser fixture deliberately uses controlled page/model-equivalent inputs. It does not spend against a paid OpenAI account. The required `npm run smoke:live` gate is separate, interactive, and uses a newly issued key already in Keychain. It covers a typed turn, prerecorded voice turn, pointer, walkthrough advancement, the eight-second setup deadline, and console/stuck-state inspection. A release is not live-verified until that gate passes.

## Unbiased assessment

The native-host design is a material improvement over the retired localhost companion: it removes a network listener, CORS/origin logic, pairing secrets, replay state, port configuration, and the hanging `/usr/bin/security -w` subprocess. It also adds macOS packaging and registration complexity, and remains unsuitable for cross-platform distribution without equivalent Windows and Linux hosts.

The new interface is materially clearer because it centers three user intents and one beacon, eliminates duplicated branding and dashboard furniture, and makes Guiding/Listening/Paused states explicit. Its quality still depends on real-page testing across accessibility-poor applications and on continued discipline against adding “helpful” action capabilities later. The forbidden-capability guard exists to make that product boundary executable rather than aspirational.
