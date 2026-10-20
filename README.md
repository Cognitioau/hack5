# Zombie Hand

A Chrome extension for Hackyard Yard 5. Hold Shift or Ctrl and circle a passage to capture it into Obsidian with its page title and source link. Search saved evidence locally and let related thoughts return as ghosts.

**Status: working development build, with automated browser tests and a separate live Obsidian integration check.** See [current evidence](docs/STATUS.md). Broad website coverage, human gaze accuracy, and an installed Chrome-to-Obsidian rehearsal are still unverified.

## Run it

Use Node **24.22.0** and npm **11.19.1**. From this repository:

```sh
npm ci
npm run model:fetch
npm run build
```

Model downloads happen during development, use pinned files and SHA-256 verification, and are bundled into the extension. Capturing and local inference need no AI provider key.

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository's `dist` directory.
2. Open a separate Obsidian test vault and enable the official [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api).
3. Open the extension's **Wake the hand** settings. Set the numeric loopback endpoint, application folder and plugin key. Keys use session storage by default; remembering a key is optional.
4. Set up the plugin's HTTPS certificate using its documented procedure. The extension does not bypass TLS checks. For a deliberate local demo, the plugin's HTTP listener and the extension's loopback HTTP option can both be enabled explicitly instead.
5. Choose **Test vault & sync queued captures**. The probe verifies conditional writes and attachment bytes, leaving small synthetic `_health` files under the selected application folder. A changed destination or key stays paused until this succeeds.
6. Pin Zombie Hand and click its toolbar button, or choose **Enable across tabs** in Settings. Approve Chrome's one-time site-access request. While the hand is active, **hold Shift or Ctrl and circle the passage** in either direction, without holding a mouse button. The highlighted sentence at the centre is captured when the circle closes; release the key early to cancel. Ordinary hovering does nothing. The idle overlay is a single 36px hand in the corner. **Select text and click the hand** (or the small hand chip that appears at the end of a selection) to grab it; **click the hand with nothing selected** to grab the page: its title, link and a bounded excerpt of visible reading text, skipping navigation, forms, editable and hidden content. The ⋯ beside the hand holds **Grab selection**, **Save page** and help. **Alt+Shift+Z** grabs selected text wherever the pointer is, otherwise the pointed target; **Escape** cancels an unfinished or pending capture. **Spit back** archives the latest capture without deleting it.

Activation persists across existing/new tabs, navigation and browser restart. Use the toolbar button, the pill's ×, or **Pause everywhere** in Settings to stop it globally. Excluded sites remain off. Chrome settings/store pages and editable fields are unsupported. For the first demo, use public text and a test vault.

## What works in this build

- **Text and links:** a durable local queue, acknowledged vault saves, visible failures, conflict-safe recovery, archive and Rebury. Spit-back retains vault files.
- **Images:** original raster bytes when the hosting origin is authorized; otherwise a verified visible crop, then a labelled link fallback. Settings includes an exact image-origin grant/removal control. Crops require the target to remain fully visible and unchanged.
- **YouTube moments:** confirmation-time video identity and timestamp, accessible native transcript cues, and search links back to cue times. Open YouTube's **Show transcript** panel before arming. Ads are rejected as video-clock sources. Successful native reads are labelled partial.
- **Transcript fallback:** the graveyard accepts WebVTT, SRT and timestamped lines, with explicit import provenance. Untimed text cannot create invented cue times. Retained transcript text is bounded; this is not full-video archiving.
- **Local recall:** packaged MiniLM embeddings, semantic or explicitly labelled keyword search, and related-note ghosts on pages where the hand is enabled.
- **Gaze lab:** a separate experimental page with explicit camera Start/Stop, nine calibration points with a settled, steadiness-checked capture per point, per-session model choice by leave-one-target-out cross-validation, five held-out targets, a smoothed live dot with a head-movement warning, and an explicit diagnostics download for offline tuning (`node scripts/gaze-eval.mjs`). Camera frames and calibration are not persisted. Gaze is not yet connected to page capture.

Video moments save references and transcript evidence, not downloaded streaming video. Direct PDF/file links are currently references. OCR, cloud providers, Jev, chat, recording, daily Resurrection and graph linking are not implemented.

## Verify and package

```sh
npm run check
npm run build:core
node scripts/check-package.mjs --core
npx playwright install chromium
npm run test:browser
npm run package
```

`npm run package` creates full/core zip archives with source and asset provenance in `.cache/packages`. Unzip and load the directory containing `manifest.json`; Chrome does not load the zip directly. `dist-core` omits image, YouTube and gaze runtime modules while retaining text capture, vault persistence and local search.

The browser suite uses isolated profiles, synthetic pages and a vault protocol fixture. A separate real-plugin probe, `node scripts/probe-live-vault.mjs`, is deliberately scoped to `.local/test-vault`; see [TESTING.md](docs/TESTING.md) before running it. Its secrets and synthetic vault contents are ignored by Git.

## Development map

- [Plan critique](docs/PLAN_REVIEW.md), [milestones](docs/BUILD_PLAN.md), and [current evidence](docs/STATUS.md).
- [Architecture](docs/ARCHITECTURE.md) and [implementation guide](docs/IMPLEMENTATION.md) explain module ownership and how to remove or replace a feature.
- [Security requirements](docs/SECURITY.md), [privacy and limitations](docs/PRIVACY.md), and [dependency decisions](docs/DEPENDENCIES.md).
- [Contributor instructions](AGENTS.md). Jev review is disabled for this build; independent review and executable checks are used instead.

Project source is **GPL-3.0-only**. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled dependencies and model licenses. Runtime models are pinned MiniLM and MediaPipe face-landmarker assets; no cloud model runs in the extension. Codex and explicitly authorized Codex subagents were used for development; an exact session model identifier is not available in the build evidence.

[Yard 5](https://hackyard.tech/yards/yard-5) closes on **24 October 2026 at 05:00 AEDT**. The target remains a rehearsed demo on Friday 23 October.
