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
| Unit | Gestures, extraction, captions/imports, queue/lifecycle races, model disposal, calibration math, grave-hand packs, timing and placement (the hole on screen and the fist on the passage for every hand), the heal that mends the hole (its frames packed after each take's and matching scripts/hand/takes.json, every one played in order once the hand is gone), playback quickened to keep the grab under 1.8 s and the bury under 2 s, each packed frame closed once after its hand and wall are split, the wall tinted to a dark page's colour under an untinted hand, with only the torn rim around the hole lifted so it shows, and the paper copy's crumple (flat at the take, a sheet that folds without splitting, shrinking as it balls up and creased into facets facing the light at different angles); a passage's heading (skipping page chrome, hidden text and self-link marks, keeping the space a line break makes), paragraph, byline and text-fragment link; the article reader's plain text (headings, lists, quotations, a word-boundary cut marked as cut and never past its limit, nothing run or loaded, hidden text left out, the live page unchanged), the copy it is handed (no script, and linked data without its article body), pages over 25,000 elements and copies that do not match the page left to the excerpt, the reader found only as its own function, a page grab reading the page that is there once the reader has loaded, and publication dates kept to the page's own day in three time zones; what open shadow roots show in that copy (slotted, fallback and re-projected text, hidden and unslotted text left out, a closed root unread, the element limit counting shadow elements), and a quotation marked when it holds its words directly; a whole-page grab held in flight while the page is read (a second grab from the keyboard, hand, toolbar or a lasso waits, Spit back is refused, and Escape or a settings change drops it at once: the old read's late answer clears no newer grab, a dropped grab never runs the reader, and the toolbar is told nothing new was captured); the sentence and paragraph at the pointer in a block too large to read whole (an essay in one table cell, a run with no blank lines, one row of thousands of `div` rows read without walking the cell, one line of a code block of thousands of short spans), a source line break read as a space unless the text keeps its lines, and an image found under up to four layers hidden from readers that draw nothing, but not under a layer readers see, the hand's own, a fill, background image, shadow, blur, `::after` scrim, text, media, frame, SVG or MathML (a play icon's `<path>` too), field or a fifth layer, with a link stretched over a thumbnail kept as the link; YouTube's transcript panel as served on 21 October 2026 (`transcript-segment-view-model`, with or without a panel id, past an open panel without cues), a cue pointed at taken only by YouTube's reader, and every moment link written as `t=<n>s` | Synthetic DOM, fake IndexedDB or injected ports; jsdom cannot run Defuddle's removal of navigation |
| Vault contracts | Paths, malicious content, preconditions, conflicts, uncertain writes, attachments and recovery; a note without the newer fields byte for byte as main wrote it at 78f5c0e, a passage's context, deep link and credit escaped outside text fences, and those fields surviving import; Obsidian's comment, maths, highlight and block marks escaped there too, and a note saved before they were still imported and archived byte for byte | Protocol fixture, not a running plugin |
| Security | Real background listener authorization and revocation interleavings; message/media policies; the wiki kit's hook run as Claude Code runs it (the tool call as JSON on stdin, exit 2 to block) against real symlinks and links to nowhere, and refusing any change that would leave a wiki page holding HTML, `%%` comments, web images or embeds, Templater commands, Dataview inline queries (across a line break too) or plugin-named fences, in code too and honouring backslash escapes, judged on the whole page an edit leaves (with and without the line breaks an emptied edit may take), and any edit whose old text is not in the page word for word, its settings (read fence, deny rules, blocking when the hook cannot run) and its installer (refusing symlinks, failing when the folder's own settings or hook differ) | Synthetic Chrome and transport APIs; the kit's tests do not run Claude Code, so its confinement was also probed live (STATUS) |
| Capture browser | Bundled extension, trusted inputs, crop pixels, storage isolation, fixture captions (in YouTube's current transcript markup, the moment linked as `t=45s`), semantic retrieval, archive/restart and core | Synthetic sites/vault; scoped test-only pregrants |
| Grab browser | Trusted drag selection, hand click keeps the selection, collapsed dock does not shift under the pointer, whole-page grab excerpt, a whole-page grab of a long essay that keeps its article and byline but not its navigation, sidebar, footer, hidden note or the article body planted in its linked data (the live page unchanged, and the note's frontmatter and credit line written) and what an open shadow root on that page shows (a slotted caption, code including an HTTP header highlighted as Prism marks it, and an empty inline tag between two words, without its unslotted or hidden text, the text of a hidden slot or its fallback, or a hidden element without a box), selection chip, the footage hand's skin pixels on a page whose CSP forbids every image and again with no vault connected (the settings page then opened by a message sent from the page's content-script world; the button click itself is a unit test), and none of the page's selection highlight left around the taken words, whether one line, two paragraphs or inside a translucent callout | Synthetic site/vault; a colour predicate, not a visual judgement, read with text drawn in greyscale (`--disable-lcd-text`) because Linux's subpixel fringes match both colours |
| Inference browser | Real packaged model/WASM, semantic ordering, normalization, determinism and cold restart | Isolated model host |
| Gaze browser | Explicit startup, local model, no outgoing requests/persisted samples, actual camera track stop. A test-only harness composes the real lab controller with synthetic eye landmarks to exercise settling before Click enables, keyboard and auto-advance, One Euro smoothing of the live dot, the head-movement warning, and the diagnostics download's contents and evaluator round trip | Chromium fake camera and synthetic eyes; no human accuracy claim |

The capture harness separately tests denied host access with the unmodified production manifest. Most flows use a copied manifest with exact fixture/loopback grants. Chromium's extension action debugging API grants activeTab for those flows, then the harness injects the production content entrypoint. The universal-activation test instead uses a separate disposable full-profile copy with an all-sites grant, turns the hand on and pauses it from the real toolbar popup, and exercises automatic injection and visible image crops in a new tab without a toolbar action. The popup is driven over the Chrome DevTools Protocol: `Extensions.triggerAction` opens it, and its buttons are clicked by script with a user gesture, because Playwright does not list the real popup as a page. A separate test reloads the extension under an open page and checks that one working hand remains. Headless tests cannot complete the native optional-permission dialog, so the grant is made in advance; approving it from the popup, and the background finishing the activation when the prompt closes the popup, remain manual checks (the latter is covered by unit tests only). Shipped code contains no testing backdoor.

Background regressions hold image/arming operations open while switching tabs or window focus away and back. They verify stale bytes are discarded, delayed arms are rejected, and already recorded source-link captures remain active and sync.

## Gaze session evaluation

The gaze lab's **Download session diagnostics** file (contents in [PRIVACY](PRIVACY.md)) can be re-evaluated offline with the lab's own TypeScript, bundled in memory:

```sh
node scripts/gaze-eval.mjs ~/Downloads/zombie-*-gaze-diagnostics-*.json
```

For each file it prints, per model variant, leave-one-target-out error on the nine calibration targets and error on the five checks, an approximate pre-tuning reference, how steady and how far moved the live captures were, and settling-time, window-length and steadiness-range sweeps replayed from the recorded frames. `--json` prints the raw report. Keep these files out of Git; `.gitignore` excludes the default file name.

## Live Obsidian probe

Open `.local/test-vault` as a separate Obsidian vault and enable the official Local REST API plugin. Do not use a personal vault for these synthetic conflict tests.

```sh
node scripts/probe-live-vault.mjs
```

The script reads only that vault's plugin configuration, never prints its key, and trusts its specific CA in one child process with NODE_EXTRA_CA_CERTS. TLS verification stays enabled; system and Chrome trust remain unchanged. Results go to ignored `.cache/live-vault-results.json`.

Synthetic files are retained under `Zombie Hand Live Verification`. Checks cover actual conditional writes, binary roundtrips, archive without raw-note changes, a dropped response after a real write, and preservation of a deliberately edited synthetic note. This proves the adapter/plugin path over HTTPS, not Chrome's certificate trust.

## Graveyard wiki kit

Test the kit on a copy of a capture folder, never on a vault you rely on. Install it with `node scripts/install-vault-kit.mjs "<folder>"`, record a SHA-256 of every file outside `wiki/`, and run `claude -p "/ingest" --output-format stream-json --verbose > ingest.jsonl` from that folder. Afterwards the hashes must be unchanged, nothing new may exist outside `wiki/`, and every `[[…]]` in `wiki/` must resolve to a capture id or a page name or alias. Try a capture that addresses the agent with instructions, an archived capture and two that disagree.

Probe the confinement under your own Claude Code settings, not with `--setting-sources project`: a person's own allow rules are what the kit has to hold against. Ask the agent to write `../outside.md` and `./root.md`, edit a capture, write `wiki/../captures/new.md`, change `.claude/settings.local.json`, and Read, Grep and Glob a file beside the folder; every one must be refused and only a write inside `wiki/` may succeed. Then take `node` off the PATH and confirm an edit is blocked.

A headless run in a folder Claude Code has never trusted ignores the kit's `allow` rules (it says so on stderr); the skills' own `allowed-tools` carry the wiki edits, and the hook, the read fence and the `deny` rules still apply. To test the settings as a person meets them, run `claude` interactively there once and accept the trust prompt. The 21 October runs in [STATUS](STATUS.md) used synthetic captures and real notes the extension wrote from six public pages; neither vault is committed, and the synthetic one held a working prompt injection that does not belong where coding agents read the repository.

## Manual rehearsal

Load the packaged build in Chrome, grant its endpoint, configure TLS through the plugin's documented procedure, and capture three pieces of real public text. Verify notes in Obsidian, restart Chrome, re-enter the session key, retrieve a passage and surface a related ghost.

Try ten varied public image targets and five YouTube videos covering manual, automatic, absent, long and other-language captions. Record actual file/crop/link and transcript outcomes. Open an attachment offline and follow a search result to a cue timestamp. Fixture tests do not replace this sample.

Enable once, switch between existing/new tabs, navigate, restart, and confirm the hand persists. Pause it from the toolbar popup or Settings and confirm it disappears everywhere. From the popup, grab a selection and a whole page, and turn the hand on from a fresh profile so Chrome's own site-access prompt appears. Revoke site access and confirm that it stays paused. Check Shift and Ctrl circles in both directions, loops that stop short of closing or wobble, early key release, ordinary circles without a modifier, typing/selection drags and focus changes. The centre sentence preview must match the saved quote and source. Check Escape and a held-modifier shake while saving, post-save Spit back, Rebury, permission removal and feature disabling. Inspect the bare idle hand, the selection chip, selection and page grabs on light and dark real pages, the grave bury on save and the let-go on failure, and reduced-motion presentation. In the gaze lab, permit the camera deliberately, measure held-out target deviations and verify Stop/hidden-page cleanup. Connect gaze to capture only after coordinate mapping is proven.
