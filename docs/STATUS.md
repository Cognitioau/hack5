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
- Isolated local gaze calibration lab with explicit camera control, settled and steadiness-checked capture per point, per-session model choice by leave-one-target-out cross-validation, held-out diagnostics, a One Euro–smoothed live dot with a head-movement warning, a click-only diagnostics download with an offline evaluator, no automatic persistence and blocked external connections. Gaze does not yet arm page captures. Its tuning constants are unfitted starting points; see Gaze tuning below.
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

Offline inference uses real packaged weights/WASM and verifies meaningful similarity ordering and cold restart. Gaze tests use a fake camera and separately observed public portrait landmarks; they do not measure a person's gaze accuracy. A test-only harness also drives the real lab controller with synthetic eye landmarks; that checks mechanisms, not accuracy. The gaze page blocks the upstream runtime's attempted telemetry with connect-src 'self'.

## Gaze tuning (branch `claude/gaze-tuning`)

**No human gaze accuracy has been measured.** This branch makes the lab better founded and makes one live session produce the data to tune it. All constants live in `src/features/gaze/tuning.ts`:

- Collection: drop the first 350 ms after a target appears; capture once 8 consecutive frames keep the binocular iris position within a 0.03 eye-width range and that position lies at least 0.02 eye widths from where the eyes were in the target's first 150 ms, so a person still looking at the previous point is not captured there; reject frames beyond 3.5 robust deviations and average the rest; after 2.5 s, points that never became steady or never moved are captured and flagged rather than blocking. A shrinking centre dot is the fixation point; Click (or Space, since the captured target takes focus) enables only after capture. Optional auto-advance (default off) moves on 300 ms after capture.
- Model: leave-one-target-out cross-validation over variants iris-only, iris + quadratic, iris + head-rotation and all ten features, each with λ ∈ {0.01, 0.1, 0.3, 1, 3, 10} (targets weighted equally), choosing the simplest candidate within 10% of the best mean error; standardised inputs clipped to ±4.
- Live dot: One Euro filter in CSS pixels, min cutoff 0.6 Hz, β 0.0005, derivative cutoff 1 Hz, restart after a 500 ms gap. On synthetic white noise this leaves 0.40–0.48 of 40–120 px jitter and reaches 90% of a 600 px jump in ~320 ms.
- Movement warning: inter-eye distance ±12% or eye-centre shift > 0.5 inter-eye distances, cleared below 80% of each limit. Both are measured in the camera's normalised image coordinates, so on a 4:3 camera the shift limit is about a quarter tighter for vertical movement, and head roll beyond roughly 35° can trip the distance limit.
- Export and evaluation: **Download session diagnostics** (contents listed in [PRIVACY](PRIVACY.md)); `node scripts/gaze-eval.mjs <file…>` reprints per-variant cross-validation and check errors, an approximate pre-tuning reference, how steady and how far moved the live captures were, and settling, window-length and steadiness-range sweeps.

Synthetic evidence only: unit tests show the selection picks the quadratic variant for a quadratic map, iris-only when head features are noise, and iris + head when head turns explain the gaze; with the eye arriving 250, 750 or 1200 ms after each target appears, the synthetic check median is 3–7 px across three seeds, and stays 3–7 px with settling removed, because the steadiness range alone keeps reaction-period frames out of these step-like synthetic saccades (real saccades overshoot and drift, which settling still covers). Regression tests cover late arrival and a person who never leaves the previous point. On synthetic eyes, which never glance away after capture, the approximate pre-tuning reference with 12 averaged frames can match or beat the 8-frame window; the window sweep on real data should decide that.

Live inspection of one public YouTube watch page found its native transcript panel stuck on a spinner with no exposed cues. That is an extraction/availability limitation, not a claim that captions are absent. No broad native-transcript success rate is established; manual import is implemented and browser-tested.

## Review and fixes

Three explicitly authorized subagents owned capture/UI, vault/security, and toolchain/inference work. Independent review produced executable regressions for old probe authorization, settings-read races, late arming after revocation, media/vector acceptance inside IndexedDB callbacks, stale semantic search, interrupted import, missing alarms, future journal isolation and failed-index retry. Those confirmed failures were fixed before this handoff. The 0.2.0 review additionally exercised modifier/lasso false activation, hidden DOM selection, late ARM/archive replies, delayed activation prompts after pause, injection/revocation races, separate image consent and stale media results. An extra new-tab image regression found Chrome requires all-sites permission for visible crops without activeTab; the full profile now requests that optional grant, while core stays HTTP(S)-only. Actual injection remains HTTP(S)-only in both profiles. Tab/window changes now abort unfinished view work even when the original page is restored before a screenshot returns; six regressions cover late crops and delayed arming while retaining already recorded evidence. Confirmed issues were fixed with executable regressions. No Jev review or advisory service was used.

## Remaining gates and next action

1. Reload the existing unpacked extension and verify version 0.2.0; refresh already-open pages. Enable across tabs once and approve Chrome site access. Approve the exact vault endpoint and complete certificate setup through the plugin's documented procedure. Perform the installed extension → actual Obsidian → restart → retrieval loop. The adapter and browser halves are tested separately; this combined manual run remains open.
2. Rehearse on three real public text targets, ten varied images and five YouTube caption categories. Record actual file/crop/link and transcript outcomes; no web-wide success percentage is claimed.
3. Run one live gaze session (about three minutes), download its diagnostics and run `node scripts/gaze-eval.mjs` on the file; tune settling, window length, λ grid and filter from that output. Then prove cross-window viewport mapping before connecting gaze to capture. Keep mouse confirmation usable independently.
4. Record the real 60–90 second demo, screenshot and final ≤500-character submission description after the remaining checks pass. Target Friday 23 October, before the 24 October 05:00 AEDT deadline.

Direct PDF/media file downloading, full transcript companions/cache, OCR, cloud summaries, Jev, chat, daily Resurrection, graph links and recording remain unimplemented. Recovery is bounded and does not continuously watch the vault; absent metadata listings remain unknown. Unsupported future records are exportable but not shown as editable cards. These gaps keep the broader M1/M2/gaze/M5 acceptance gates open despite the implemented paths passing their automated checks.

## Revision and reproducibility

The current runtime revision is development version **0.2.0**, following baseline `1e3b9abfad7081061fb3c27a9ea088fefa2d384a`. Universal activation and the new gesture/UI landed in `e25b22638c5b658a14234fe6ad00580e7e14b523`, whose [GitHub CI run](https://github.com/Cognitioau/hack5/actions/runs/39327214833) passed all checks. The current follow-up adds universally activated image crops and tab/window race guards; each archive's BUILD_INFO.json records its exact source commit. See the repository Actions page for that matching run.

Each generated archive includes BUILD_INFO.json with its exact source commit, dirty flag, source snapshot digest and per-file SHA-256 inventory; .cache/packages/SHA256SUMS identifies the archives. Regenerate with npm run package after committing for clean provenance. Latest CI status remains visible on the repository's Actions page.

See [README](../README.md), [TESTING](TESTING.md), [IMPLEMENTATION](IMPLEMENTATION.md) and [PRIVACY](PRIVACY.md) for runnable instructions and evidence boundaries. Development used Codex and authorized Codex subagents; the exact session model identifier was not exposed. Runtime models and licenses are pinned in [DEPENDENCIES](DEPENDENCIES.md) and [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
