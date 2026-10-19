# Zombie Hand

A Chrome extension for Hackyard Yard 5. Hesitate over content to arm a zombie hand, circle to capture it into an Obsidian vault, and shake to cancel or spit back a capture. Related notes return as ghosts while you browse.

**Status: planning baseline.** This repository contains the reviewed specification, architecture, security requirements, and implementation sequence. The extension and the controls described here have not been implemented or verified yet.

## Start here

- [Plan critique](docs/PLAN_REVIEW.md): weaknesses in the original brief and the decisions that address them.
- [Architecture](docs/ARCHITECTURE.md): module ownership, contracts, persistence, and how to add or remove features.
- [Security requirements](docs/SECURITY.md): trust boundaries, permissions, data handling, and release gates.
- [Build plan](docs/BUILD_PLAN.md): ordered milestones with observable completion criteria.
- [Current status](docs/STATUS.md): resume point, decisions still to verify, and evidence.
- [Contributor instructions](AGENTS.md): rules for implementing this plan.

## Intended experience

1. Enable capture on a page. Pause over a phrase, image, link, or supported video player.
2. The hand rises and highlights a locked target. Circle to confirm; shake or Escape to cancel.
3. Content lands in a real vault note. A short undo opportunity makes the hand spit it back into a recoverable archive.
4. Search locally or discover a related capture through a quiet ghost with source links.

The first complete slice is text capture → confirmed vault save → local semantic retrieval → a related-note ghost. Media follows: local image attachments with screenshot/link fallbacks, and YouTube moments with accessible timestamped transcripts. Gaze remains a planned demo feature. Cloud summaries, Jev judgments, OCR, chat, daily Resurrection, graph linking, and short clip recording are independently optional.

Saving a video moment preserves a timestamped reference and available transcript/preview; it does not promise a downloaded copy of streaming video. Every capture reports its actual outcome. Optional features can be disabled without losing saved data or preventing the basic capture loop.

## Schedule

[Yard 5](https://hackyard.tech/yards/yard-5) opens for coding at **20 October 2026, 05:00 AEDT** and closes submissions at **24 October 2026, 05:00 AEDT**. Target a finished demo and submission materials on Friday 23 October. Milestone checks determine readiness; a date is not evidence that a feature works.

## Engineering approach

Use one small TypeScript extension, a pure domain layer, an explicit composition root, narrowly scoped adapters, and a closed feature registry. Durable capture state belongs to the core. Optional features consume versioned snapshots and return proposed enrichments; they cannot own the vault client or decide whether a user capture survives.

Security requirements become executable checks during implementation. Browser storage, page text, transcripts, model responses, and downloaded assets are not assumed safe merely because they are local or user-selected.

## Licensing and model declaration

Select a distribution license in milestone M0 before incorporating runtime dependencies. The planned [WebGazer dependency](https://webgazer.cs.brown.edu/) is GPLv3; an optional module boundary does not remove license obligations when code is distributed. Check the selected model weights and other dependencies at the same time. This public planning repository is not yet an open-source release with a selected license.

Record the development models actually used and the runtime model/version in the release materials. Earlier tool preferences are not evidence of what wrote the shipped implementation.
