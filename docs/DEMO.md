# Demo rehearsal

This is a recording script, not evidence that the live rehearsal has passed. Use the final package, a separate test vault and deliberate public or synthetic content. Keep keys and personal vault/browser data off screen.

## 80-second core story

| Time | Action | Evidence to show |
| --- | --- | --- |
| 0–12 s | Enable globally, switch to a public page, select a passage and click the hand chip; then hold Ctrl and circle another | The hand bursting through the page, grabbing the copy and burying it on the acknowledged save |
| 12–22 s | Show the new note in Obsidian | Real source text, URL and retained note |
| 22–34 s | Capture a fully visible image | Actual local attachment or clearly labelled crop; open it offline |
| 34–49 s | Capture a YouTube moment with loaded native cues, or explicitly show manual transcript import | Partial/provenance label and actual cue time |
| 49–61 s | Search for related meaning | Saved passage and return-to-source timestamp |
| 61–70 s | Shake/spit back the latest capture, then show the archive | Retained file and recoverable lifecycle |
| 70–80 s | In Claude Code, in the vault's capture folder, type `/ask How do octopuses and cuttlefish change colour, and why?`; cut through the wait to the answer's first paragraph, then to the filed page in Obsidian | An answer page under `wiki/answers/` that cites the capture behind every claim, compiled from the captures, not a scripted placeholder |

Gaze is not in the demo: one human session left a median check error of 96 px and a live dot that wandered ([STATUS](STATUS.md)). Nor is the related-note ghost: `/ask` shows the second brain instead. Cut optional scenes to keep the recording honest and legible; never substitute an animation for a successful vault write.

## Rehearsed picks (21 October, headless)

These came through a headless rehearsal of the build on real pages ([STATUS](STATUS.md)). Check each again in the recording browser, signed in, the day before.

| Scene | Pick | Why, and what to avoid |
| --- | --- | --- |
| Lasso, then spit back | Wikipedia's [Octopus](https://en.wikipedia.org/wiki/Octopus): circle the camouflage passage with Ctrl held, then shake with Ctrl still held | Archived 560 ms after the shake began; Rebury restores it. The passage keeps citation marks such as `[53]`. `/ingest` skips archived captures, so the `/ask` scene needs this paragraph captured again off camera (below). |
| Image | Simon Willison's [Things we learned about LLMs in 2024](https://simonwillison.net/2024/Dec/31/llms-in-2024/), the Chatbot Arena table | A clean crop (351 ms in one run); after granting `https://static.simonwillison.net` in Settings, the original 2266×1422 file. Avoid Guardian articles: a support banner can land in the crop. |
| YouTube moment | [vfbNzpd6cIw](https://www.youtube.com/watch?v=vfbNzpd6cIw) at 1:00 | Its cue at 0:54 ("So let's start at the beginning -- rules.") matches TED.com's transcript. Backup: [dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ) at 0:45, where an ad may play first. Headless, YouTube refused the panel for 20 of 32 videos, and on 22 October twice for this one: check it signed in. |
| Transcript import | [iG9CE55wbtY](https://www.youtube.com/watch?v=iG9CE55wbtY), whose panel YouTube refused, with an SRT made from the talk's public transcript | Imported 427 cues and saved the moment with `t=60s`. The imported timings come from the transcript, not YouTube, so expect a few seconds' skew. |
| Search | "education stifles children's natural talents" | Finds the imported talk first (0.62). Its link opens the matching passage at 1:37, not the moment grabbed; for a link that lands on the grab, search "a singer vows to stay faithful forever" (0:45). |

## Before the `/ask` scene (rehearsed 22 October, headless)

An agent rehearsed this on a copy of the kit with the demo's own captures plus three passages, through `claude -p`. After one `/ingest`, the question above answered directly in 105 s and 113 s ($0.63 and $0.45). Both times it filed the answer page by itself, because the answer drew on three captures, and cited a capture on every claim: 21 and 19 citations, none unresolved. The `/ingest` took about 8 minutes and $2.60 and wrote only inside `wiki/`. Not yet run: the interactive trust prompt, Obsidian's rendering of the page, and captures in the signed-in recording browser.

1. Install the kit into the test vault's capture folder: `node scripts/install-vault-kit.mjs "<test vault>/Zombie Brain"`. The folder must already hold `captures/` or be empty.
2. Off camera, capture three passages by selecting each and clicking the hand chip. Say in the video that they were captured beforehand.
   - [Octopus](https://en.wikipedia.org/wiki/Octopus), "Camouflage and colour change", first paragraph: from "Octopuses use camouflage to hunt and to avoid predators." to "…nearly matching the energy used at rest."
   - [Cuttlefish](https://en.wikipedia.org/wiki/Cuttlefish), "Chromatic cells": the sentence beginning "Cuttlefish change color and pattern (including the polarization of the reflected light waves)…".
   - [Chromatophore](https://en.wikipedia.org/wiki/Chromatophore), "Cephalopod chromatophores", first paragraph: from "Coleoid cephalopods (including octopuses, squids and cuttlefish) have complex multicellular organs…" to "…being nearly as much as all the energy used by an octopus at rest."
3. Record the capture scenes above.
4. Off camera, run `claude` in the capture folder, accept the trust prompt and type `/ingest`. The spat-back Octopus capture is skipped; that is expected.
5. Start a fresh session (`/clear`), then record typing the `/ask` line.

In the edit, show the typed line, cut to the answer's first paragraph, then to the page in Obsidian. Leave out the terminal's last lines: they carry absolute paths, `open` lines and capture IDs. The page's name carries the recording day's date. A good runner-up question, from the two TED talks, is "What helps creativity, and what kills it? Keep the answer." It took twice as long (201 s, $1.28) and its terminal ends noisier.

## Draft submission description

Zombie Brain turns deliberate browsing gestures into Obsidian captures. Select text and click the hand, click it to keep the whole page, or hold Ctrl and circle a passage. It keeps text, images or visible crops, and YouTube moments with timestamped captions. A bundled local model finds related notes without an AI API key, and a vault kit lets Claude Code compile the captures into a wiki you can question, every claim cited. Saves are recoverable.

This draft is under 500 characters. Recheck it against the final demonstrated behavior before submission. Do not mention gaze, and do not claim broad transcript coverage until its checks pass.
