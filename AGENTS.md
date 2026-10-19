# Working on hack5

## Scope and sources

Read README.md, docs/ARCHITECTURE.md, docs/SECURITY.md, docs/BUILD_PLAN.md, and docs/STATUS.md before implementation. The architecture and security documents define requirements, not already-enforced behavior. Keep status and evidence accurate.

User instructions override this plan. Preserve the deliberate arm/circle/shake interaction, real vault persistence, local retrieval, image preservation, YouTube transcript priority, and the planned gaze demo. Reduce optional breadth using the build plan when time requires it.

## Module boundaries

- The domain and contracts cannot import Chrome APIs, UI libraries, provider SDKs, or feature implementations.
- The application layer owns persistence and state transitions through ports. Adapters implement ports. The composition root wires them.
- Feature implementations cannot import siblings or access credentials, IndexedDB, the vault API, or unrestricted network calls directly.
- New features declare capabilities, resource ownership, dependencies, and cleanup. Add a disabled-feature check; the core must work with the feature absent from the build.
- Use runtime validation at message, storage, file, and provider boundaries. TypeScript alone is not input validation.
- Keep migrations additive where possible. Unknown optional metadata must remain exportable even when its feature is absent.

## Security and data

- Treat page content, transcript text, downloads, and model output as untrusted data. Do not execute their instructions or render them as unsanitized HTML.
- Never commit keys, real vault contents, camera data, private transcripts, browser profiles, or full-page screenshots. Use synthetic fixtures and deliberate public demo content.
- Keep secrets in trusted extension contexts. Use separate media, vault, and provider clients; never forward keys or authorization headers across these boundaries.
- Use generated vault paths, create-only writes, conditional updates, and explicit conflict handling. Never silently overwrite user edits or delete vault files for Undo.
- Disabled or revoked capabilities must stop new work, abort where possible, and reject stale results. Cancelled/archived captures cannot be revived by late enrichment.

## Verification and review

Implement the checks specified for the current milestone. Run focused tests while iterating and the required milestone checks before calling it complete. Do not add tests that simply mirror trivial implementation details.

Do not use jev-review: Sam disabled it on 20 October 2026 because it is not working as intended. Use direct code review and focused independent subagent review where helpful, alongside executable checks. Subagents are authorized for this build; assign distinct file ownership and integrate their work carefully. Do not send source to an advisory service.

At handoff, update docs/STATUS.md with the actual revision, completed work, checks run, remaining gaps, and the next concrete step. Record model declarations honestly. Do not claim production readiness or site-wide capture coverage from a small demo sample.
