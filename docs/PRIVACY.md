# Privacy and supported behavior

Zombie Hand offers one browser-wide activation toggle. After you approve optional site access, it activates on eligible active tabs, new pages and browser restart; it does not read browsing history. Excluded sites remain off, and Pause everywhere removes the hand from open tabs and rejects new capture requests. A held Shift/Control circle previews visible text and sends the confirmed passage to the extension for capture and optional local related-note search. Ordinary hovering does not capture or search. No content is captured automatically just because global activation is on.

Captured text, URLs, timestamps, optional image bytes and embeddings stay in extension storage and the configured Obsidian vault. There is no cloud AI provider, analytics client or remote inference service. Original image downloads contact an approved hosting origin without cookies or authorization headers; denied downloads fall back to a visible crop or source link.

The full build requests all-sites access so Chrome permits visible image crops in newly activated tabs; the core build requests HTTP(S) only. Both builds inject and capture only on allowed HTTP(S) pages, excluding file URLs and Chrome-protected pages. [Chrome crop permission requirements](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)

Page-access permission does not itself authorize downloading original image bytes. Each public HTTPS image origin needs a separate explicit grant in Settings; without it, images use a verified visible crop or source link. Revoking an image grant invalidates in-flight media work.

The plugin key is available only to trusted extension contexts. Session storage is the default; browser restart requires re-entering it. Remembered keys are stored locally in the browser profile, not an encrypted password vault. Forget key stops further credential use without erasing captures. Chrome host permissions cover more than a URL's port; the vault client separately enforces the configured numeric loopback endpoint and port.

The gaze lab starts its camera only from Start, uses packaged local models, and blocks external connections. Camera frames are never stored. Samples and calibration live only in the page's memory and are never persisted automatically. Stop, hiding/closing the lab or track termination releases resources and clears calibration. Human accuracy and gaze capture integration remain unverified.

After the five checks, **Download session diagnostics** saves one JSON file to your downloads for offline tuning. The file is created only when you click that button; nothing is written otherwise, and the download makes no network request. It contains:

- its creation time, the extension version and the tuning constants in use;
- the window's size, screen position and device pixel ratio;
- the calibration and check target positions;
- for each processed camera frame while a target was shown (about 12 per second, at most 75 per target): the time since the target appeared and ten derived measurements — horizontal and vertical iris offset within each eye, the eye-centre position and inter-eye distance in the camera image, two nose-offset ratios and a depth-based head-turn ratio — or an empty marker when no face was found;
- which frames each target used, their averages and steadiness, and how far the head had moved during each check;
- the chosen model, its cross-validation error table, and each check's predicted point and error;
- counts and frame-to-frame movement statistics for the live dot.

It contains no camera images, video frames, face-mesh landmark arrays or page content. Treat it as private: the measurements describe your head position and eye movements during that session.

## Retention and recovery

- The journal retains unsuccessful saves. Removing the extension or clearing storage can lose unsynced evidence and pending archive changes.
- Vault-confirmed evidence can be recovered with **Recover from vault**. Each scan is bounded to 200 records and 64 MiB. Verified missing/changed notes or attachments quarantine matching saved captures; partial/failed scans and absent metadata listings never imply deletion.
- Spit-back archives; Rebury restores the active lifecycle. Neither deletes vault files. This is not secure erasure.
- **Export all capture data** includes original local records and attachments, including unsupported future JSON-compatible record versions. Treat exports as private when their captures are private.
- Connection probes retain small synthetic files under the application's `_health` folder. The extension has no vault DELETE operation.

## Current limits

Native YouTube transcripts require loaded, viewer-accessible cues. A stalled panel is not proof of absent captions. Reads are marked partial and retained text is bounded to 24,000 characters. Manual timestamped imports record provenance and never invent missing times.

YouTube moments preserve references and transcript evidence, not streaming video bytes. Ads are excluded as timestamp sources. Image outcomes are labelled as files, crops or links. Partly visible, moved or changed targets cannot be cropped safely. PDF/direct file links currently remain links.

Search uses cached evidence, not a continuous vault watcher. Recovery detects positively observed missing/changed evidence and newer verified lifecycle metadata; missing metadata itself remains unknown without a targeted check. Offline search cannot guarantee that every remote file still exists. Archived and locally known conflicted records are excluded.

No broad success percentage is claimed. Ten varied real image targets, five transcript categories, native permission prompts and an installed browser-to-plugin rehearsal remain manual gates until recorded in STATUS.md.
