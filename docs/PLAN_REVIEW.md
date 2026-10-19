# Review of the initial build plan

Reviewed 20 October 2026. The product has a clear useful loop: deliberate capture, a real note, and timely recall. The revised media priorities and the shared mouse/gaze boundary are worth keeping. The remaining weakness is that the earlier brief combines many features without defining enough authority, lifecycle, or failure behavior between them.

The following findings are design risks, not findings from an implemented extension.

| Priority | Finding | Decision |
| --- | --- | --- |
| High | The first evening includes gestures, animation, vault setup, model loading, and retrieval. A three-hour estimate is not a verified delivery capacity. | Run short dependency probes first, then build one end-to-end text slice. Use explicit completion gates and preserve missing evidence if a gate slips. |
| High | A background worker can disappear while a save or cancellation is pending. In-memory state and an animation callback cannot establish success. | Use a durable operation journal, a single capture coordinator, versioned results, and reconciliation after uncertain writes. |
| High | IndexedDB and the vault are separate stores. Unclear authority can resurrect an archived capture or lose an edit during index rebuild. | Vault notes plus lifecycle metadata are the durable export; IndexedDB holds the local working state, pending journal, and rebuildable index. Resolve disagreement explicitly. |
| High | Downloading a page-supplied URL through a privileged extension can turn media capture into an unrestricted network proxy. | Separate validated media, loopback-vault, model-download, and provider clients. Reject redirects by default, bind requests to a capture, and never forward credentials between clients. |
| High | Keys in storage.local are not automatically hidden from content scripts. A content-script compromise would be especially serious. | Restrict storage access before reading/writing keys; use session-only keys by default and explicit local remembrance. Keep keys out of messages to pages. |
| High | Optional features can still become mandatory through imports, shared permissions, or ownership of saved data. | Use a closed compile-time registry and narrow ports. Core owns lifecycle and generic records. Each optional feature needs absent, disabled, failure, and cleanup behavior. |
| Medium | YouTube DOM extraction is an adapter to a changing UI, not a stable transcript API. A visible subset is not necessarily a full transcript. | Start with current watch pages, retain cue timestamps/provenance, report partial/unavailable/failed separately, and test navigation between videos. |
| Medium | Capturing media does not itself make its content searchable. A transcript arriving later changes the indexed text. | Use typed text sources and content hashes; index transcripts in timestamped chunks. Update only the relevant revision and retain raw evidence separately from generated descriptions. |
| Medium | Gaze calibration in one extension context may not map to the active page's viewport. Packaging the library also has license implications. | Keep gaze planned for the demo, prove the coordinate contract early, and make licensing a pre-dependency decision. Mouse confirmation remains available. |
| Medium | Feature flags alone do not stop an existing camera stream, timer, queued API call, or stale result. | Define disable as a lifecycle operation: revoke the feature epoch, cancel jobs, dispose resources, and prevent new privileged work. |

Chrome documents worker termination and loss of global variables, so restart recovery is a core requirement. [Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

Chrome also documents that storage.local is exposed to content scripts by default. The implementation must explicitly restrict access; this cannot remain a README promise. [Storage access](https://developer.chrome.com/docs/extensions/reference/api/storage)

The Obsidian plugin documents create-only writes using If-None-Match and conditional updates using If-Match. Verify those capabilities in the installed plugin before relying on them. A missing capability must produce a setup requirement or an explicit export fallback, not silent last-write-wins behavior. [Conditional writes](https://github.com/coddingtonbear/obsidian-local-rest-api#conditional-writes)

## Scope decisions

Keep the first-night text slice, locally preserved images, YouTube moments with available transcript excerpts, local retrieval, and basic haunting as the delivery priorities. Gaze stays a real demo goal with its own early probe; it does not block the mouse slice.

Short clip recording, additional video platforms, OCR/vision, chat, Jev gates, daily Resurrection, and graph linking are optional and can be removed independently. Full transcripts are useful when available, but a correct nearby excerpt takes priority over completeness work on a long video. No transcript is invented when extraction fails.

The recorded program dates remain unchanged. The milestone order replaces the old assumption that every calendar slot will finish everything assigned to it. First prove a working slice; then add modules without reopening its security boundaries.

## Open decisions with deadlines

- **M0:** distribution license compatible with the chosen gaze library and model; minimum supported Chrome version; selected embedding model/version; tested Obsidian plugin capabilities.
- **M0:** decide the inference host after a measured load/inference/restart probe. The port stays stable if its host changes.
- **Before M4:** confirm the gaze coordinate mapping and whether the camera uses a visible extension page or a correctly managed offscreen document.
- **Before release:** declare actual working features and tested media outcomes. Publish no success percentages inferred from a small sample.

See [the build plan](BUILD_PLAN.md) for the exit criteria and [security requirements](SECURITY.md) for controls that must be proved rather than deferred.
