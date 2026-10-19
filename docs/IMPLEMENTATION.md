# Implementation guide

ARCHITECTURE.md remains the target design. This document maps the current code and its deliberate limits.

## Ownership

| Concern | Current owner | Replacement boundary |
| --- | --- | --- |
| Browser-wide activation | `adapters/browser/activation.ts` | Persisted intent, permission checks and revocable per-tab injection |
| Image download consent | `adapters/browser/media-access.ts` | Exact public-origin allowlist separate from browser page permission |
| Gesture interpretation | `core/domain/gestures.ts` | Pure points → confirm/cancel decisions |
| Page extraction and hand | `adapters/browser/extraction.ts`, `bootstrap/content.ts`, `ui/hand.ts` | Bounded candidate and versioned content commands |
| Identity, lifecycle, save queue, indexing | `application/coordinator.ts` | Repository, embedding and feature ports |
| Local durability | `adapters/persistence/indexed-db.ts` | Atomic record/journal changes; versioned records |
| Obsidian writes and recovery | `adapters/persistence/vault.ts` | Conditional save, lifecycle, probe and import |
| Image preservation | `features/image/preserve.ts` | Injected download and snapshot ports |
| Media transport | `adapters/browser/media.ts` | Origin/size/type checks; active-document crop |
| Native/imported captions | `features/youtube` | DOM reader and bounded import parser |
| Local semantic inference | `adapters/inference` | Embedder and prepare/dispose lifecycle |
| Gaze calibration | `features/gaze`, `adapters/gaze`, `bootstrap/gaze.ts` | In-memory samples and measured calibration diagnostics |
| Authority and composition | `bootstrap/background.ts` | Exact sender contexts, schemas, capabilities and serialized configuration writes |

Bootstrap wires implementations statically. There is no remote module loader or generic plugin framework. Feature checks and cancellation epochs are explicit; a general feature registry and offscreen host manager are deferred until needed.

## State and failure behavior

The content controller gates a bounded circle/oval recognizer behind trusted Shift or Control input. It previews the sentence at the lasso centre, then sends the existing ARM/CAPTURE commands only when the circle closes. A consumed hold cannot create a second capture, and modifier release after confirmation does not revoke accepted intent. Text extraction spans inline nodes and supplies matching highlight rectangles. The closed-shadow HandView owns only presentation, local grave animation and its cleanup; it never changes source text or decides persistence.

Capture and journal creation is one IndexedDB transaction. Image preparation gates the vault writer, so a note cannot be prematurely committed as link-only while an attachment is still being prepared. A worker restart during preparation recovers the source link with an explanatory status.

Vault writes are serialized per capture. Paths derive from UUIDs inside the configured folder. New files are create-only, metadata updates require a matching ETag, and read-back reconciles a lost response. Archive is a lifecycle revision, not deletion. Pending local revisions cannot be overwritten by an older imported record.

Settings changes invalidate page capabilities, abort supported work and discard late model results. Destination/credential changes persist a sync pause before the new configuration. Probe authorization and configuration commits are serialized and rechecked after asynchronous writes. An old probe cannot unpause a new destination.

Model work checks its epoch before work and inside the final storage mutation. Search joins vectors with active, vault-confirmed records. Disabling semantic search leaves explicitly labelled keyword retrieval. Running WASM inference cannot be interrupted safely; revoked results are discarded. An explicit Retry can reindex a previously failed record without making automatic alarms repeatedly load a broken model.

Recovery can quarantine positively identified missing/changed evidence and adopt a verified newer remote lifecycle only when the local saved snapshot remains unchanged. Partial scans, absent listings and unsupported schemas do not imply deletion. Unsupported local records and jobs remain retained; they do not block compatible work.

## Remove or replace a component

1. Keep shared records and ports stable; put a replacement behind the same injected interface where possible.
2. Wire it only in bootstrap. Features cannot read credentials, access IndexedDB or call unrestricted network APIs. `check:boundaries` checks these rules in the TypeScript AST.
3. Declare its setting, permitted contexts, resource ownership, failure outcome and cleanup. Validate new boundary data at runtime.
4. For removal, guard imports/calls with the core profile and remove exclusive assets and permissions. The build checks emitted bytes, not merely source imports. Core browser tests must still capture and retrieve text.
5. Retain generic saved data and export. Unknown JSON-compatible optional metadata survives; unsupported future record schemas remain exportable but are not editable or searchable in this version.
6. Exercise disabling during an outstanding operation and verify final result acceptance, not just request initiation.

The core build removes image, YouTube and gaze executable modules/assets (universal activation remains available through optional HTTP(S) site access). It still recognizes their saved data. Semantic search is replaceable and can be disabled at runtime; its model remains bundled in core.

## Gaze is a separate experiment

The tested WebGazer distribution required dynamic JavaScript evaluation under Manifest V3 and is not included. Local MediaPipe runs under the normal extension script policy; the gaze page's stricter connection policy blocks upstream telemetry.

Calibration and holdout results apply only to the lab's current window geometry. Moving/resizing invalidates calibration. Hiding/closing the lab or losing its track stops the camera and clears samples. No focus events reach capture yet. Human calibration and cross-window coordinate mapping must pass before that connection is enabled.
