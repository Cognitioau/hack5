# Verification guide

Run from the repository root with the pinned Node/npm versions. Keep keys, browser profiles, camera frames and vault data outside Git.

```sh
npm ci
npm run model:fetch
npm run check
npm run build:core
node scripts/check-package.mjs --core
npx playwright install chromium
npm run test:browser
npm run package
```

TypeScript is strict. Biome checks formatting/lint. AST checks enforce layer and capability boundaries. Package checks inspect emitted entrypoints, permissions, CSP, model hashes, WASM and public-file exclusions. Core compilation fails if removed feature runtime bytes remain.

## What the suites prove

| Suite | Evidence | Limit |
| --- | --- | --- |
| Unit | Gestures, extraction, captions/imports, queue/lifecycle races, model disposal, calibration math | Synthetic DOM, fake IndexedDB or injected ports |
| Vault contracts | Paths, malicious content, preconditions, conflicts, uncertain writes, attachments and recovery | Protocol fixture, not a running plugin |
| Security | Real background listener authorization and revocation interleavings; message/media policies | Synthetic Chrome and transport APIs |
| Capture browser | Bundled extension, trusted inputs, crop pixels, storage isolation, fixture captions, semantic retrieval, archive/restart and core | Synthetic sites/vault; scoped test-only pregrants |
| Inference browser | Real packaged model/WASM, semantic ordering, normalization, determinism and cold restart | Isolated model host |
| Gaze browser | Explicit startup, local model, no outgoing requests/persisted samples, actual camera track stop | Chromium fake camera; no human accuracy claim |

The capture harness separately tests denied host access with the unmodified production manifest. Most flows use a copied manifest with exact fixture/loopback grants. The universal-activation test uses a separate disposable copy with broad HTTP(S) grants because a headless browser cannot complete the native optional-permission dialog. Chromium's extension action debugging API grants activeTab, then the harness injects the production content entrypoint. Shipped code contains no testing backdoor. Native toolbar/permission approval remains a manual check.

## Live Obsidian probe

Open `.local/test-vault` as a separate Obsidian vault and enable the official Local REST API plugin. Do not use a personal vault for these synthetic conflict tests.

```sh
node scripts/probe-live-vault.mjs
```

The script reads only that vault's plugin configuration, never prints its key, and trusts its specific CA in one child process with NODE_EXTRA_CA_CERTS. TLS verification stays enabled; system and Chrome trust remain unchanged. Results go to ignored `.cache/live-vault-results.json`.

Synthetic files are retained under `Zombie Hand Live Verification`. Checks cover actual conditional writes, binary roundtrips, archive without raw-note changes, a dropped response after a real write, and preservation of a deliberately edited synthetic note. This proves the adapter/plugin path over HTTPS, not Chrome's certificate trust.

## Manual rehearsal

Load the packaged build in Chrome, grant its endpoint, configure TLS through the plugin's documented procedure, and capture three pieces of real public text. Verify notes in Obsidian, restart Chrome, re-enter the session key, retrieve a passage and surface a related ghost.

Try ten varied public image targets and five YouTube videos covering manual, automatic, absent, long and other-language captions. Record actual file/crop/link and transcript outcomes. Open an attachment offline and follow a search result to a cue timestamp. Fixture tests do not replace this sample.

Enable once, switch between existing/new tabs, navigate, restart, and confirm the hand persists. Pause it from Settings or the page pill and confirm it disappears everywhere. Revoke site access and confirm that it stays paused. Check Shift and Ctrl circles in both directions, early key release, ordinary circles without a modifier, typing/selection drags and focus changes. The centre sentence preview must match the saved quote and source. Check Escape and a held-modifier shake while saving, post-save Spit back, Rebury, permission removal and feature disabling. Inspect the compact idle pill, local dirt/hand animation, and reduced-motion presentation. In the gaze lab, permit the camera deliberately, measure held-out target deviations and verify Stop/hidden-page cleanup. Connect gaze to capture only after coordinate mapping is proven.
