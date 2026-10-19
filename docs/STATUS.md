# Current status and handoff

Updated 20 October 2026 AEDT. This is a working development build, not a completed production release or finished Yard submission.

## Implemented

- Version 0.2.0: universal browser activation with a one-time optional site-access grant, persistent tab/navigation/restart behavior, excluded sites and Pause everywhere. Chrome-protected pages remain unavailable.
- Trusted Shift/Control circle/oval capture, sentence/selection preview with exact text highlights, source title/URL, early-release/typing/drag/focus cancellation, accessible selection/page actions and recoverable Spit back. Hovering alone never captures.
- Compact idle pill and a local grave/hand animation that grasps a safe text copy. Reduced motion is supported; delayed saves clear the decoration within 2.2 seconds while preserving a truthful queued receipt.
- Atomic local capture/journal, serialized vault writes, create-only files, ETag metadata updates, attachment acknowledgements, lost-response reconciliation, visible failure states and bounded retries.
- Packaged local MiniLM inference, persisted vectors, semantic/keyword retrieval and related-note ghosts. No AI provider key is required.
- Image bytes → verified visible crop → labelled link; explicit exact-origin download consent separate from universal page access, immediate revocation, no credential forwarding, size/type/redirect restrictions.
- YouTube confirmation-time moments, ad-clock rejection, partial native transcript reader, manual WebVTT/SRT/timestamped import, provenance and cue-specific search links.
- Recovery preserves pending local lifecycle changes, quarantines positively observed missing/edited evidence, and adopts verified newer remote lifecycle only when the local saved snapshot has not changed.
- Isolated local gaze calibration lab with explicit camera control, held-out diagnostics, no sample persistence and blocked external connections. Gaze does not yet arm page captures.
- Full and core build profiles, strict contracts, AST boundaries, pinned dependencies, public-source exclusions, license notices, CI and validated archive generation.

## Verified evidence

All **335 automated tests** passed for the 0.2.0 update. Final local checks ran on Node 24.22.0/npm 11.19.1 and Playwright 1.64.1 Chromium 156.0.8078.4. The manifest declares Chrome 120 as a minimum; that older version was not separately exercised.

| Check | Result |
| --- | --- |
| TypeScript, Biome formatting/lint, import/capability boundaries | Passed; a deliberately forbidden core → adapter import was also rejected |
| Unit | 174 passed |
| Vault contracts | 47 passed |
| Security/background regressions | 107 passed |
| Final combined browser suite | 7 passed: default permissions, full/core capture, modifier false-activation guards/source accuracy, universal new-tab image crops/tab/restart/pause, gaze runtime, offline inference |
| Earlier 0.1.0 capture-browser repetition | 9/9 passes across three runs |
| Real Obsidian Local REST API 5.5.2 probe (previous adapter revision, unchanged by 0.2.0) | 13 assertions passed over verified HTTPS in the separate test vault |
| Full/core build and artifact checks | Passed; core contains no image/YouTube/gaze runtime and keeps HTTP(S)-only optional access; full uses optional all-sites for Chrome image crops |
| Dependency audit | Previous audit reported zero known advisories; dependencies are unchanged in 0.2.0 |
| Public-source scan | No test-vault key, private-key headers, common token patterns, private runtime directories or local machine paths found |
| Visual inspection | Compact idle/saved pills, local grave/reach/grasp, reduced-motion presentation, and synthetic page captures inspected |

The real-plugin probe verified note/attachment writes, conditional archive, raw-note preservation, lost-response reconciliation, recovery and conflicting-edit preservation. It trusts only the test vault's CA in a dedicated Node child process. It does not configure or prove Chrome's certificate trust.

Browser tests use the real built extension and trusted inputs against synthetic sites and a protocol fixture. They verify an exact 240×120 crop with zero overlay/altered pixels, semantic retrieval of imported captions linked to t=30, archive persistence after restart and credential isolation. Most test-only copied manifests pregrant exact fixture origins; the universal-activation fixture uses a separate disposable all-sites grant, proving image crops in a new tab without a per-tab toolbar action. The unmodified production manifest's initial denial is separately verified. Native optional-permission UI remains a manual gate.

Offline inference uses real packaged weights/WASM and verifies meaningful similarity ordering and cold restart. Gaze tests use a fake camera and separately observed public portrait landmarks; they do not measure a person's gaze accuracy. The gaze page blocks the upstream runtime's attempted telemetry with connect-src 'self'.

Live inspection of one public YouTube watch page found its native transcript panel stuck on a spinner with no exposed cues. That is an extraction/availability limitation, not a claim that captions are absent. No broad native-transcript success rate is established; manual import is implemented and browser-tested.

## Review and fixes

Three explicitly authorized subagents owned capture/UI, vault/security, and toolchain/inference work. Independent review produced executable regressions for old probe authorization, settings-read races, late arming after revocation, media/vector acceptance inside IndexedDB callbacks, stale semantic search, interrupted import, missing alarms, future journal isolation and failed-index retry. Those confirmed failures were fixed before this handoff. The 0.2.0 review additionally exercised modifier/lasso false activation, hidden DOM selection, late ARM/archive replies, delayed activation prompts after pause, injection/revocation races, separate image consent and stale media results. An extra new-tab image regression found Chrome requires all-sites permission for visible crops without activeTab; the full profile now requests that optional grant, while core stays HTTP(S)-only. Actual injection remains HTTP(S)-only in both profiles. Tab/window changes now abort unfinished view work even when the original page is restored before a screenshot returns; six regressions cover late crops and delayed arming while retaining already recorded evidence. Confirmed issues were fixed with executable regressions. No Jev review or advisory service was used.

## Remaining gates and next action

1. Reload the existing unpacked extension and verify version 0.2.0; refresh already-open pages. Enable across tabs once and approve Chrome site access. Approve the exact vault endpoint and complete certificate setup through the plugin's documented procedure. Perform the installed extension → actual Obsidian → restart → retrieval loop. The adapter and browser halves are tested separately; this combined manual run remains open.
2. Rehearse on three real public text targets, ten varied images and five YouTube caption categories. Record actual file/crop/link and transcript outcomes; no web-wide success percentage is claimed.
3. Run human gaze calibration and held-out targets. Prove cross-window viewport mapping before connecting gaze to capture. Keep mouse confirmation usable independently.
4. Record the real 60–90 second demo, screenshot and final ≤500-character submission description after the remaining checks pass. Target Friday 23 October, before the 24 October 05:00 AEDT deadline.

Direct PDF/media file downloading, full transcript companions/cache, OCR, cloud summaries, Jev, chat, daily Resurrection, graph links and recording remain unimplemented. Recovery is bounded and does not continuously watch the vault; absent metadata listings remain unknown. Unsupported future records are exportable but not shown as editable cards. These gaps keep the broader M1/M2/gaze/M5 acceptance gates open despite the implemented paths passing their automated checks.

## Revision and reproducibility

The current runtime revision is development version **0.2.0**, following baseline `1e3b9abfad7081061fb3c27a9ea088fefa2d384a`. Universal activation and the new gesture/UI landed in `e25b22638c5b658a14234fe6ad00580e7e14b523`, whose [GitHub CI run](https://github.com/Cognitioau/hack5/actions/runs/39327214833) passed all checks. The current follow-up adds universally activated image crops and tab/window race guards; each archive's BUILD_INFO.json records its exact source commit. See the repository Actions page for that matching run.

Each generated archive includes BUILD_INFO.json with its exact source commit, dirty flag, source snapshot digest and per-file SHA-256 inventory; .cache/packages/SHA256SUMS identifies the archives. Regenerate with npm run package after committing for clean provenance. Latest CI status remains visible on the repository's Actions page.

See [README](../README.md), [TESTING](TESTING.md), [IMPLEMENTATION](IMPLEMENTATION.md) and [PRIVACY](PRIVACY.md) for runnable instructions and evidence boundaries. Development used Codex and authorized Codex subagents; the exact session model identifier was not exposed. Runtime models and licenses are pinned in [DEPENDENCIES](DEPENDENCIES.md) and [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
