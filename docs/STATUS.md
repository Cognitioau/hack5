# Current status and handoff

Updated 20 October 2026 AEDT. This is a working development build, not a completed production release or finished Yard submission.

## Implemented

- Manifest V3 extension with explicit page activation, dwell/locked target, circle confirmation, shake/Escape cancellation, accessible capture, recoverable spit-back and Rebury.
- Atomic local capture/journal, serialized vault writes, create-only files, ETag metadata updates, attachment acknowledgements, lost-response reconciliation, visible failure states and bounded retries.
- Packaged local MiniLM inference, persisted vectors, semantic/keyword retrieval and related-note ghosts. No AI provider key is required.
- Image bytes → verified visible crop → labelled link; exact media-origin grant/removal UI, no credential forwarding, size/type/redirect restrictions.
- YouTube confirmation-time moments, ad-clock rejection, partial native transcript reader, manual WebVTT/SRT/timestamped import, provenance and cue-specific search links.
- Recovery preserves pending local lifecycle changes, quarantines positively observed missing/edited evidence, and adopts verified newer remote lifecycle only when the local saved snapshot has not changed.
- Isolated local gaze calibration lab with explicit camera control, held-out diagnostics, no sample persistence and blocked external connections. Gaze does not yet arm page captures.
- Full and core build profiles, strict contracts, AST boundaries, pinned dependencies, public-source exclusions, license notices, CI and validated archive generation.

## Verified evidence

Final local checks ran on Node 24.22.0/npm 11.19.1 and Playwright 1.64.1 Chromium 156.0.8078.4. The manifest declares Chrome 120 as a minimum; that older version was not separately exercised.

| Check | Result |
| --- | --- |
| TypeScript, Biome formatting/lint, import/capability boundaries | Passed; a deliberately forbidden core → adapter import was also rejected |
| Unit | 97 passed |
| Vault contracts | 47 passed |
| Security/background regressions | 65 passed |
| Final combined browser suite | 5 passed: default permissions, full flow, core flow, gaze runtime, offline inference |
| Earlier capture-browser repetition | 9/9 passes across three runs |
| Real Obsidian Local REST API 5.5.2 probe | 13 assertions passed over verified HTTPS in the separate test vault |
| Full/core build and artifact checks | Passed; core contains no image/YouTube/gaze runtime or broad media host declaration |
| Dependency audit | Zero known advisories at this check |
| Public-source scan | No test-vault key, private-key headers, common token patterns, private runtime directories or local machine paths found |
| Visual inspection | Synthetic hand, settings and graveyard screenshots inspected; no clipping found |

The real-plugin probe verified note/attachment writes, conditional archive, raw-note preservation, lost-response reconciliation, recovery and conflicting-edit preservation. It trusts only the test vault's CA in a dedicated Node child process. It does not configure or prove Chrome's certificate trust.

Browser tests use the real built extension and trusted inputs against synthetic sites and a protocol fixture. They verify an exact 240×120 crop with zero overlay/altered pixels, semantic retrieval of imported captions linked to t=30, archive persistence after restart and credential isolation. Test-only copied manifests pregrant exact fixture origins; the unmodified production manifest's initial denial is separately verified. Native optional-permission UI remains a manual gate.

Offline inference uses real packaged weights/WASM and verifies meaningful similarity ordering and cold restart. Gaze tests use a fake camera and separately observed public portrait landmarks; they do not measure a person's gaze accuracy. The gaze page blocks the upstream runtime's attempted telemetry with connect-src 'self'.

Live inspection of one public YouTube watch page found its native transcript panel stuck on a spinner with no exposed cues. That is an extraction/availability limitation, not a claim that captions are absent. No broad native-transcript success rate is established; manual import is implemented and browser-tested.

## Review and fixes

Three explicitly authorized subagents owned capture/UI, vault/security, and toolchain/inference work. Independent review produced executable regressions for old probe authorization, settings-read races, late arming after revocation, media/vector acceptance inside IndexedDB callbacks, stale semantic search, interrupted import, missing alarms, future journal isolation and failed-index retry. Those confirmed failures were fixed before this handoff. No Jev review or advisory service was used.

## Remaining gates and next action

1. Load the full unpacked build in Chrome, approve its exact vault endpoint and complete certificate setup through the plugin's documented procedure. Perform the installed extension → actual Obsidian → restart → retrieval loop. The adapter and browser halves are tested separately; this combined manual run remains open.
2. Rehearse on three real public text targets, ten varied images and five YouTube caption categories. Record actual file/crop/link and transcript outcomes; no web-wide success percentage is claimed.
3. Run human gaze calibration and held-out targets. Prove cross-window viewport mapping before connecting gaze to capture. Keep mouse confirmation usable independently.
4. Record the real 60–90 second demo, screenshot and final ≤500-character submission description after the remaining checks pass. Target Friday 23 October, before the 24 October 05:00 AEDT deadline.

Direct PDF/media file downloading, full transcript companions/cache, OCR, cloud summaries, Jev, chat, daily Resurrection, graph links and recording remain unimplemented. Recovery is bounded and does not continuously watch the vault; absent metadata listings remain unknown. Unsupported future records are exportable but not shown as editable cards. These gaps keep the broader M1/M2/gaze/M5 acceptance gates open despite the implemented paths passing their automated checks.

## Revision and reproducibility

The runtime implementation is commit 4a78b082cd8dfc6e0877ea002cf3f949c99cfd62, built on planning baseline 0e18f6c96b79468452ef9c946525a8bb3af40b35. Its [GitHub CI run](https://github.com/Cognitioau/hack5/actions/runs/39323224203) passed every check and uploaded both archives. A follow-up pins Ubuntu 24.04 and current Node-24-based official Actions to remove runner migration/deprecation warnings; it does not change application code.

Each generated archive includes BUILD_INFO.json with its exact source commit, dirty flag, source snapshot digest and per-file SHA-256 inventory; .cache/packages/SHA256SUMS identifies the archives. Regenerate with npm run package after committing for clean provenance. Latest CI status remains visible on the repository's Actions page.

See [README](../README.md), [TESTING](TESTING.md), [IMPLEMENTATION](IMPLEMENTATION.md) and [PRIVACY](PRIVACY.md) for runnable instructions and evidence boundaries. Development used Codex and authorized Codex subagents; the exact session model identifier was not exposed. Runtime models and licenses are pinned in [DEPENDENCIES](DEPENDENCIES.md) and [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
