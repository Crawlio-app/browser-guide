# Spike 3c — `inspect_site`: the Guide borrows Crawlio Browser's read-only instruments

**Status: proposal, awaiting decision. Nothing here is merged behavior.**

## The idea

Crawlio is a reverse-engineering product; Browser Guide is its eyes-without-hands sibling. Today the Guide answers from an accessibility snapshot. Crawlio Browser has ~30 purely observational tools the Guide could borrow — `detect_framework`, `detect_technologies` (~200 technologies), `inspect_datalayer`, `parse_tracking_pixels`, `seo_audit`, `get_performance_metrics`, `get_security_state`, `compare_raw_rendered`, `browser_snapshot` (ARIA), and friends — turning questions like "what is this site built with?", "what is tracking me here?", "why is this page slow?" from guesses into instrumented answers.

That reframes the product family: **Browser Guide becomes a perception runtime** — inward, an agent with pluggable read-only instruments; outward, an MCP server that lends its eyes (already shipped in Fase 2).

## Enforcement mechanism (confirmed in crawlio-browser source)

`CRAWLIO_ACTION_POLICY` accepts a policy file with glob matching (`action-policy.ts`):

```json
{ "default": "deny", "allow": ["get_*", "detect_*", "inspect_*", "parse_*", "seo_audit", "browser_snapshot", "compare_raw_rendered"] }
```

Browser Guide would launch crawlio-browser (only if the user has it installed) with a **hardcoded, deny-by-default policy** shipped inside our package — explicitly excluding `browser_evaluate` and `execute`, the escape hatches that would make "read-only" unverifiable. The policy file is not user-editable configuration; it is part of the product's claims.

## Honest claims cost

The model currently has **exactly two tools**, and README/AUDIT say so — it is the product's central guarantee. `inspect_site` makes it three. That is a deliberate, documented change:

- Claims update in README, AUDIT, SECURITY, and docs.crawlio.app: "three tools, all read-only; the third only exists when Crawlio Browser is installed and only behind a deny-by-default action policy".
- `guard-forbidden.mjs` grows a check that the shipped policy file never allows an actuation glob.
- The overlay-purity and zero-interference e2e counters are unaffected — `inspect_site` runs in a separate process against a separate browser profile, never the user's shared tab. That separation (Crawlio inspects its own instance of the site, not the user's live session) is both the privacy story and the current limitation: authenticated pages inspect as logged-out.

## Minimal v1

1. Detect crawlio-browser (staged install path, then PATH).
2. Third model tool `inspect_site {question}` → helper spawns crawlio-browser with the hardcoded policy → routes to the relevant read-only subset → bounded, sanitized result back as untrusted evidence.
3. Absent crawlio-browser, the tool is not registered at all — the two-tool contract holds verbatim for everyone else.

## Relationship to the "deep-dive with Crawlio" handoff (punto 5)

`inspect_site` answers medium questions inline and shrinks the handoff to what genuinely needs a full RE session (network capture over time, decompilation, authenticated flows). The handoff then becomes a deep link carrying URL + question — cheap to add once Crawlio exposes an entry endpoint, and worth deciding after v1 of this spike ships.

## Decision asked of the maintainer

Approve the claims change (two tools → up to three, conditionally) and the v1 above, sequenced after the 3a/3b decisions.
