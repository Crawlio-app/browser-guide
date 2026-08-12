# Browser Guide provenance

Browser Guide was created as a separate child product in its own repository. The source parent, the Crawlio Browser workspace (`crawlio-agent`), was read in place from a sibling checkout and was never used as a build or output directory for this product.

## Parent baseline

Recorded before child scaffolding on 2026-08-09:

| Field | Recorded value |
| --- | --- |
| Parent package | crawlio-browser |
| Parent Git HEAD | 60400222415b7a2f287264a50edd9bdf6f966db9 |
| Git porcelain-v2 SHA-256 | fd89a09090f3d0b4fb7974b845fb75f927b0149fb96c1ed8a40409b857a2e98a |
| Regular-file count, excluding root .git | 18,860 |
| Regular-file content aggregate SHA-256 | e0dff2528e2fde3919ea9b72ad6bfd1edc76af84d5de1a0f6fa0a083dc73bff5 |
| File/symlink path-set SHA-256 | ca6722b7269fa314de6e2f48acab1b8a915c82edc8f905d0832a580e52fbc1b2 |

The parent was already dirty. No clean, reset, checkout, reformat, build, install, or write operation against it is part of Browser Guide. The normal parent verifier checks every provenance file. Its optional --strict-tree mode also checks HEAD, the dirty-state path/shape, and the broad content aggregate; that mode detects unrelated writes to the rest of the parent tree.

During final verification, concurrent activity in the shared parent workspace changed package/version files, extension sources, generated output, test output, and documentation after this child’s baseline. That separate activity advanced the parent HEAD from the recorded commit and later changed the recorded `src/extension/background.ts` evidence file in the live worktree. Browser Guide did not create or revert those parent changes. The default provenance sentinel therefore remains intentionally nonzero, while `npm run verify:product` verifies the child independently. The sentinel is not weakened to hide the mismatch.

The externally produced commit observed at 2026-08-09 12:19:16 -06:00 was 1feb959f1e44edd73c341f5d929973fa9119eb8b, titled “feat(v1.11.0): make observation resident and release-ready.”

## Selective adaptation record

These are the complete parent inputs used for concepts, contracts, or test patterns. Hashes are SHA-256 of the parent file as read at the recorded HEAD/dirty state.

| Parent file | SHA-256 | Adaptation in Browser Guide |
| --- | --- | --- |
| src/extension/injected/agent-cursor.ts | c86e152bdc0046d72e283c787694778381c980de11a0d2867b0c72b0f2ef56a3 | Geometry and luminous guidance concepts; replaced with a new pointer-transparent overlay |
| src/extension/injected/dom-snapshot.ts | 605acdc3fb3266cceb2aff344f092c1324c30f1b69fdd616b42fd9216ca46786 | Compact accessible candidate concepts |
| src/extension/background.ts | 37bf1ba9f5727a2b758a5d02c23735a23101e7c4cc4d7ac266eab47f9d2e83ae | ARIA role/name, bounded snapshot, and snapshot-ref concepts only; not copied wholesale |
| src/mcp-server/extraction-js.ts | e633bb4c2bd4406637ca2fc27b5fe8568301fa4897a3af7e9c05e37350c9a447 | Page-section inference concepts |
| src/mcp-server/redact.ts | 75eb271becb4e4b541becab0e42250b4fe17e458844859abaf1d3d014024594a | Browser-safe secret-pattern redaction concepts |
| src/mcp-server/content-boundary.ts | 94a075552f193bbe086ab1bee5b988b11b9c61948593aee7c807744973e5ddc5 | Nonce-delimited untrusted-evidence boundary |
| src/shared/bridge-handshake.ts | eafd92bab1e5cc27b2c3a310098165265a4c6968d7563c559a8300cb6aa6360b | Versioned, fail-closed validation approach; implemented as a new native-messaging protocol rather than the parent bridge |
| packages/semantic-grounding/contract/context.schema.json | 06a77c444438583b77328aece4ae873898666c954ca4302439a12c039f198a9f | Grounding input contract concepts |
| packages/semantic-grounding/contract/provider.schema.json | 122699b92d3501656c5bd1859a30c20ee3ba323b288937efdb97cdb2df50f4af | Provider contract concepts |
| packages/semantic-grounding/contract/result.schema.json | d537ca1405ad543ea95389cdc7bfee091aec23fc26638aabceaf7844dff33b9d | Scored grounding-result concepts |
| packages/semantic-grounding/src/types.ts | ffbf33653d0d1813d962556afeee1e1fff7244ce1ce836f494d4a8878a2b0339 | Grounding terminology and typed result shape |
| packages/semantic-grounding/src/providers/heuristic.ts | 943a5c78535aa1c96fca4cdcfb075e6f5f1c92d9ca8ba61e93c2f65f545899f3 | Role/name/text token scoring concepts |
| tests/mocks/chrome.ts | cdcdaa208d44c16dbe17d97e2318e146b06945ab1a26762db747420bd8fd95e5 | Chrome API mock conventions |
| tests/unit/agent-cursor.test.ts | a457066d72a52ad675695d16bb156bfccfb668cad9a9c3bf2e0895c28b58a8e6 | Overlay geometry test patterns |
| tests/unit/aria-snapshot.test.ts | ff0719547daa6b3eede0a5baaf2c0d86a31bb6980721f3cf3d8ad4fc55165955 | Accessible snapshot test patterns |
| tests/unit/semantic-grounding/contract.test.ts | d688e0c29257448d3b8576a9f2d266c8436b14fc0baeb3f2cff38a9d72910d6c | Grounding contract test patterns |
| tests/unit/semantic-grounding/router.test.ts | 4530e93482f84ca5af4de5ea22364e877ff25a13f45ddf9dfa49c9ba7e105d79 | Grounding selection test patterns |
| tests/unit/redact.test.ts | 13e86f7eefe190a0452ec97ddae6b6991e55d8d58fe066c5476f7a77f042bda2 | Redaction edge-case patterns |
| tests/unit/content-boundary.test.ts | 0314eafd5f466ed4d8bce0dd86fe478dd872b89542282c89f834d889658eabc0 | Injection-boundary test patterns |
| tests/unit/bridge-handshake.test.ts | 4e96ecb084dfa307c818582c0aa8f3fb28b3535adbf8da4a680edbedcced00ec | Fail-closed message-contract test patterns |
| LICENSE | cb875aa83de2b8063222d5d6ccf9fd3d21d147d33453bfc6ce42002203670a7c | Apache License 2.0 text preserved under licenses |
| NOTICE | a2b0b34c77da0c5c0bc4c7484a1370ec62dcc835f19acf463fef587f4ad346de | Crawlio attribution preserved in NOTICE and third-party notices |

## Child mapping

| Parent concept | New child implementation |
| --- | --- |
| Compact snapshot and ARIA extraction | src/extension/content/observer.ts and src/shared/page-context.ts |
| Snapshot-scoped opaque refs | src/extension/content/element-registry.ts |
| Agent cursor geometry | src/extension/content/overlay-controller.ts and overlay.css |
| Section detection | observer.ts |
| Semantic grounding | src/shared/semantic-grounding.ts |
| Redaction | src/shared/sanitization.ts |
| Untrusted content boundary | src/shared/content-boundary.ts |
| Boundary validation | src/shared/native-protocol.ts, src/extension/native-host-client.ts, and native/macos/Sources/BrowserGuideNativeCore |
| Chrome test patterns | tests/unit, tests/integration, and tests/e2e |

The macOS helper, Security.framework storage, native-host installer, stdio framing, Realtime relay, and one-click Helper app are new child implementations. No parent background runtime, MCP registration, browser-tool catalog, Chrome debugger/CDP automation, interactive picker, recording, monitoring, networking inspection, cookie/storage inspection, stealth logic, or browser-action implementation was copied into the child.

## Verification

Run:

~~~sh
npm run verify:parent
~~~

To compare the entire parent tree, including generated and ignored files, to the original broad baseline:

~~~sh
node scripts/verify-parent.mjs --strict-tree
~~~

Any mismatch is reported without changing either repository.
