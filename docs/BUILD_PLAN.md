# Implementation milestones

Start from [the critique](PLAN_REVIEW.md), [architecture](ARCHITECTURE.md), and [security requirements](SECURITY.md). Each milestone produces a usable increment and evidence. Feature completion is independent of whether the calendar slot has ended.

## Delivery priorities

| Priority | Features | Removal behavior |
| --- | --- | --- |
| Essential first slice | Deliberate text/link capture, simple hand, durable vault saving, recoverable spit-back, local embeddings/search, a basic ghost | A failure remains visible; it is not replaced with simulated saving or semantic results |
| Next delivery priorities | Local images with crop/link fallback; YouTube moments and available transcript excerpts | Disabling the adapter preserves saved notes and keeps text capture working |
| Planned demo track | Local gaze calibration and shared focus-point adapter | Gaze can be absent or disabled; camera stops and mouse confirmation remains functional |
| Optional | Cloud summaries/tags, OCR/vision, Jev, chat, daily Resurrection, full transcript archiving, graph links, recording, other video sites | Each feature has its own setting/capability, disposal, failure fallback and retained data |

Cut optional breadth in this order if time compresses: short clips/additional sites, OCR/vision, chat, Jev, daily Resurrection. Full long-video transcript archiving and graph links are time permitting; nearby transcript excerpts retain priority. Preserve the gaze demo attempt without making the mouse build wait for it.

## M0 Establish the engineering baseline

**First build session; dependency probes should be short and explicit.**

- Resolve the distribution license against the actual gaze dependency/model choices before incorporating runtime code. Record versions and supported minimum Chrome version.
- Scaffold one Manifest V3 TypeScript extension, using Vite and adding CRXJS only if useful. Pin a supported runtime/package manager and dependencies; commit the lockfile.
- Create the module layout and runtime schemas in ARCHITECTURE.md. Wire a static registry/composition root and a core-only profile. Add strict TypeScript, formatting/linting and import-boundary checks.
- Add a minimal frozen-lockfile CI workflow for the actual commands. Keep permissions read-only, pin third-party actions, and use no private secrets or privileged PR execution. Validate the built manifest/CSP and bundled executable assets.
- Probe the installed Obsidian plugin in a synthetic vault: connection, certificate setup, create-only rejection, ETag read, conditional-update conflict and attachment bytes. Report missing support as a setup requirement.
- Probe one small local embedding model: first download, cache reuse, one inference, worker restart and memory/runtime suitability. Record the host/model decision. Keep Embedder independent of that choice.
- Define the mouse/gaze coordinate contract and give gaze a small calibration prototype task. A separate session can implement the gaze adapter if explicitly assigned; ownership of shared contracts stays with the main build.

**Exit:** extension loads; concrete development/check commands work; boundary checks reject an intentional illegal import; safe vault and embedding capabilities have observed evidence; licensing is resolved. If an external prerequisite is absent, the scaffold can proceed, but the dependent gate remains incomplete.

## M1 Prove the full text loop

- Build a plain capture control first, then the arm/circle/shake input state machine over the same command path. Lock targets; include Escape and accessible actions. A simple hand is sufficient initially.
- Add durable capture records and an operation journal. Implement generated vault paths, create-only saves, conditional metadata updates, bounded retries and uncertain-write reconciliation.
- Implement archived lifecycle and explicit Rebury. Cancel pending jobs and suppress stale enrichment. Expose queued/uncertain/conflict/archive-sync states honestly.
- Persist local vectors and search results linked to source evidence. Show one real related-note ghost on an enabled page, with a cooldown and dismissal. The no-LLM-key path must work.
- Render source content safely and prove credential isolation before using real keys/content.

**Exit:** capture three pieces of real public text, find them in the test vault, restart the extension, retrieve them locally, and surface a relevant ghost. Shake cancels an armed capture without undoing an earlier one. Cancel a pending save and confirm a late remote success remains archived. Spit-back survives restart and index rebuild, including a pending archive sync. Simulate a delayed/uncertain write, a partial multi-file save and a conflicting user edit without loss or false success.

**First evening target:** complete M0 and M1, with basic art. If that does not fit the available session, record the exact blocker and next action; do not mark the loop complete on the strength of an animation.

## M2 Preserve images and YouTube moments

Begin this after the first slice is dependable. Run the YouTube transcript adapter probe early enough that a UI change cannot surprise the final day.

- Image adapter: loaded source/currentSrc → validated attachment bytes → cropped visible screenshot → labelled source link. Add origin grants, byte/dimension limits, no-redirect behavior and error cleanup. Use stable local embeds.
- File adapter: accessible direct PDFs/media within bounded download limits. Saving a file is separate from parsing its contents. No arbitrary streaming-video downloader.
- YouTube adapter: capture the confirmed video ID/time/title/preview, then read viewer-accessible native transcript segments. Preserve language, source and completeness; distinguish extraction failure from caption absence. Cache by track and reject stale navigation results.
- Include nearby cues around the captured time and links back to that point. Full transcript companions are optional. Different moments in one video remain distinct, sharing transcript evidence safely.
- Add a paste/import fallback with explicit provenance. No invented cue times for untimed text. Chunk transcript evidence for search; update embeddings only for changed text versions.

**Exit:** try at least ten real image targets across several sites and five YouTube videos spanning manual captions, automatic captions, no captions, a long transcript and another language. Record actual file/crop/link and transcript outcomes. Local attachments open offline. Crops omit the hand and do not save another tab. Search returns a real transcript passage linked to its timestamp. Partial extraction is labelled partial.

These samples demonstrate the tested cases; they are not a measured web-wide success rate.

## M3 Polish the reusable capture experience

- Add clear onboarding for the test connection, supported sites, permissions, no-key operation and failed jobs.
- Polish hand states, dedupe moods and graveyard search. Exact duplicate detection must include type-specific identity; semantic similarity never silently rejects a deliberate capture.
- Verify that archived/missing/conflicted records are excluded at query time. Make recovered and partial data understandable.
- Improve the ghost's relevance/cooldown with real browsing. Optional summaries use retrieved evidence and cite saved notes; local titles/snippets remain available.
- Run the core-only build/profile and each optional-feature-disabled scenario. Confirm resources and permissions behave as the UI claims.

**Exit:** repeat the first slice and media demonstration after reload, permission revocation, failed network operations and feature disabling. Complete the relevant release-blocking security tests. No core capture operation needs an optional AI service.

## Gaze track

Start its coordinate/calibration probe in M0 and integrate through FocusPoint during M1/M2. Prefer a visible extension calibration page first. Prove mapping into the active content viewport under the demo's zoom/window conditions, including navigation and stale-event rejection.

The demonstration may use known conditions; production-grade gaze accuracy is not required. Gaze selects/arms the highlighted content, the circle confirms, and shake cancels. Confirm camera tracks and persistence stop as specified. If an offscreen host is required, use the shared host manager rather than creating another competing document.

**Exit:** a real gaze-driven selection results in a real vault capture, and disabling gaze leaves mouse capture operational with the camera off. Record the actual conditions, not an unsupported accuracy claim.

## M4 Add optional capabilities independently

Add only while the previous gates remain green. Use the feature contract and require a no-feature fallback for each addition.

| Module | Capability and fallback | Specific check |
| --- | --- | --- |
| Cloud tags/summaries | Selected provider and feature consent; local tags/titles when absent | No request before consent, after disable, or on an excluded site; validated bounded output |
| OCR/vision | Selected image and declared local/cloud processor; alt/caption/context fallback | Image egress only when enabled; generated text distinguished from original evidence |
| Jev | Separate key/opt-in; heuristic moods and cooldown fallback | Timeout/invalid-key fallback; a score never discards a confirmed capture |
| Resurrection | Scheduled selection of active saved records | Real captured age; Archive/Rebury use the same lifecycle coordinator |
| Chat | Question plus retrieved active evidence | Sources match retrieved chunks; no-evidence response and no tool side effects |
| Graph links | Explicit user-visible related-note links | Conditional updates preserve edits and no fabricated backlink promise |
| Recording | Explicit Record/Stop and bounded tab capture | Indicator, audio behavior, size limit, track disposal and local playable output |

For every module, test absence from the bundle, runtime disabling, permission removal where applicable, failure, and late results. Retain generic readers/export for earlier data if its module is removed later.

## M5 Rehearse and release

Target Friday 23 October for completion, leaving margin before the Saturday 05:00 AEDT deadline.

- Freeze scope before recording. Repeat the core and media checks in a fresh extension profile with a dedicated test vault. Verify cached local inference separately from first download.
- Run the established type/lint/import, unit/contract, focused browser/security and packaging checks. Review dependency findings, the actual manifest/CSP, secret exclusions, licenses and packaged model/runtime assets.
- Run the installed Jev advisory review on the intended code diff, read its evidence/coverage/limitations, and independently inspect important boundaries and failures. Record unavailable evidence; do not treat an advisory score as merge approval.
- Produce an unpacked extension/release zip, truthful setup/privacy documentation, actual model declaration and known supported conditions.
- Record a 60–90 second real demonstration: deliberate grab, note in Obsidian, local image, YouTube transcript moment, retrieval back to the timestamp, cancel/spit-back, haunting and gaze if working. Use genuine current captures.
- Prepare a screenshot and a writeup of at most 500 characters describing only shipped behavior. Provide submission materials for the builder.

**Exit:** the install and demo work from the documented steps, all implemented release gates have evidence, and unresolved limitations are plainly stated.

## Check commands to establish in M0

Create the following scripts only when they run real checks: check:types, check:lint, check:boundaries, test:unit, test:contracts, test:browser, test:security, build, and check:package. Do not add placeholder scripts that exit successfully. Local iteration can run focused suites; milestone completion runs the checks applicable to that milestone, and release runs the full established suite.

Browser checks should use a documented Chromium build that supports extension testing. Pin the actual tested version; mocks alone do not prove Chrome permissions, worker restart, camera shutdown or screenshot behavior.
