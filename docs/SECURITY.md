# Security requirements and verification

These are requirements for implementation and release, not a claim of current protection. The application handles browsing content, vault access, camera data, and optional provider keys. A small demo still needs clear authority boundaries and failure behavior.

## Trust boundaries

Untrusted inputs include the page DOM, selected URLs, image bytes, captions, imported transcripts, vault files that a user can edit, and model responses. The content script is less trusted than the background coordinator; Shadow DOM isolates presentation, not security. Trusted settings establish the vault endpoint, provider, consent and allowed origins. Features receive bounded capabilities, not a universal HTTP client or credentials.

Chrome recommends minimizing permissions and treating content-script input carefully. [Extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

## Permissions and messages

- Keep site access optional at install time. The full profile requests `<all_urls>` because Chrome requires it for visible image crops on a new tab without a toolbar-provided activeTab grant; core requests only HTTP(S). Both profiles restrict injection and capture sources to HTTP(S), even when a broader permission is granted. Universal activation requests access once through a trusted user action, stores activation intent independently of vault settings, and injects only into active, allowed top-level web tabs. Pause gates requests immediately and deactivates existing pages; every asynchronous injection rechecks intent, origin and current permission. activeTab alone remains temporary. [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
- Original image downloads require an exact explicit origin allowlist as well as Chrome host permission; universal page access cannot satisfy that separate consent. Request relevant media-host, loopback and provider access from trusted UI when needed. No required all-sites permission for the base install. Camera, recording and other optional APIs belong to their declared capabilities.
- Validate every message's version, shape, length, sender extension ID, tab/frame/document identity and navigation generation. Read sender metadata from Chrome. Require the current arm/capture capability for side effects; reject replayed or stale operations.
- Tab activation and window focus changes synchronously invalidate unfinished view capabilities, including a switch away and back during a visible crop. Delayed arming and media results cannot revive that capability. Already recorded evidence remains active and syncs; an interrupted image uses its source-link fallback.
- Register no external-message handlers for this release. Never accept vault paths, provider keys, arbitrary headers, shell commands or arbitrary request destinations from page messages.
- A trusted pointer event is a useful input filter, not proof that all content-script data is safe. The background boundary still applies. Deny editable fields and disabled/excluded sites at extraction and execution time.
- Handle permission removal immediately: invalidate capability epochs, unregister automatic listeners/injection where appropriate, stop new work, and suppress stale results. Re-enabling requires a new capability.

## Credentials and settings

Restrict storage areas to TRUSTED_CONTEXTS before key access. Use session-only keys by default; an explicit Remember on this device setting can use trusted local storage. Never sync keys or transmit them to content scripts. If required access control cannot be established, do not persist the key.

Local storage is not a secret vault or a guarantee of encryption against a compromised browser profile. Redact diagnostic output, show keys masked, and provide Forget key. Test that a content script cannot read stored keys. [Chrome storage access controls](https://developer.chrome.com/docs/extensions/reference/api/storage)

Separate vault and provider keys. A settings change clears obsolete authorization state and invalidates jobs using the old configuration. Build artifacts, fixtures and Git history must contain no real credentials.

## Network clients

Use separate clients with separate policies:

| Client | Allowed destination | Required restrictions |
| --- | --- | --- |
| Vault | Exact numeric loopback endpoint and port configured in trusted settings | Only documented scoped vault operations; vault bearer key only here; no redirects |
| Media | Exact user-approved public HTTPS origins for the confirmed target | No authorization/cookie forwarding; credentials omitted; reject redirects and disallowed schemes; size/type/time limits |
| Provider | The selected adapter's approved HTTPS origin | Its own key only; bounded consented payloads; no arbitrary page-selected base URL; no redirects |
| Model assets | Pinned model/version from a declared approved source | Data assets only, integrity/version checks where available, bounded storage; no remotely fetched executable JS/WASM |

Reject URL userinfo, loopback/private IP literals, local hostnames and ambiguous URL forms in the media path. A page URL cannot select the vault client. Fail closed on redirect rather than following it into another origin or local service. Signed/blocked media may fall back to a crop or link.

A browser extension cannot reliably inspect every hostname's DNS resolution. Exact origin grants, no credentials, browser network protections and blocked redirects are the controls here; do not claim complete DNS-level isolation. The media client is not a general fetch proxy. [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

Use HTTPS for the local plugin with a trusted certificate. HTTP is an explicit loopback-only option; never add a global certificate-validation bypass. Feature disabling stops future requests but cannot recall content already transmitted.

## Vault integrity

- Generate capture IDs and paths inside the configured application folder. Normalize and validate path segments; reject traversal, encoded separators, absolute paths, control characters and configuration-directory targets.
- New files use If-None-Match: *. Updates use a matching ETag and touch only application-owned metadata or enrichment sections. The raw capture body is preserved. Conflicts are visible and recoverable.
- Probe conditional-write support on synthetic files in a dedicated test vault before enabling the normal writer. Do not silently use an older unconditional-write path. [Plugin write preconditions](https://github.com/coddingtonbear/obsidian-local-rest-api#conditional-writes)
- Distinguish locally queued, remote uncertain, remotely acknowledged and conflicted writes. Reconcile timeouts by reading the intended record; never blindly overwrite.
- Spit-back archives and retains content. It has no vault DELETE operation. Shared transcript/attachment data is not removed when one moment is archived.
- Serialize YAML through a library and render captured text as safely escaped content. Page text must not introduce extra frontmatter fields, executable HTML, remote image embeds or application commands.

## Rendering and downloaded media

Render page/model strings as text. If formatted Markdown is needed, use a restricted renderer/sanitizer with raw HTML disabled. Permit only validated link schemes. Generate Obsidian-open actions from trusted stored paths, never page-supplied commands. Open external links without giving them access to the extension window.

Apply MIME checks, file signatures where practical, response byte limits, decoded image dimension limits and cancellation. Do not save an HTML login/error response as an image. Default preview support is raster images; SVG/HTML or unknown formats use a raster snapshot or link. Attachments remain inert unless deliberately opened by the user.

Screenshots must match the same authorized active tab/document/target before and after capture. Store only the selected crop, omit the overlay, and label partial crops. Never retain a full viewport as an accidental fallback. Unsupported/restricted pages receive an explicit unavailable result.

## Optional AI and camera

Cloud features are separately enabled from local capture. Explain each egress category in settings: capture text for tagging, matching notes/page context for summaries, selected image for optional vision/OCR, question and retrieved passages for chat, and excerpts for Jev judgments. Keys alone are not blanket consent for every feature. Keep per-site exclusions effective at the final network boundary.

Bound payloads and call counts. Use short timeouts and limited retries. A late result cannot change capture lifecycle or initiate a tool action. Prompt-injection instructions in pages, captions or model output remain inert data; providers receive no vault key and no write/network tools. Validate structured outputs and citations against the retrieved records. No available evidence means no invented transcript, score or answer.

Gaze is local, explicitly started, visibly indicated, and easy to stop. Disable camera-frame retention and verify the library's training-data persistence settings. Dispose camera tracks when gaze is disabled, its owner closes, or permission is revoked. Optional tab recording has explicit start/stop controls, bounded size/duration, and a visible indicator. Failure cleanup is part of each feature contract.

## Dependencies and release

Pin the package manager, runtime and direct dependencies, commit the lockfile, and use a supported patched runtime during implementation. Review the actual chosen versions and licenses, including gaze code and model weights. Resolve the distribution license before incorporating runtime libraries.

Bundle executable JS/WASM; do not depend on CDN executable loading or eval to make local inference work. Keep CSP and web-accessible resources narrow. Chrome treats remotely loaded JS and WASM as executable remote code. [Remote-code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

CI added in M0 must use least-privilege tokens, pinned actions, a frozen lockfile, no production keys, and no execution of untrusted PR code with privileged credentials. Audit dependency advisories and triage relevant findings rather than silently accepting them. Inspect the built extension's manifest and artifacts, not only source configuration.

## Release-blocking evidence

The following must pass for the corresponding implemented paths: hostile/stale/oversized message rejection; credential isolation; media-origin/redirect denial; path traversal rejection; create-only and conflict-safe writes; restart/cancel/late-result recovery; safe rendering of malicious text; no provider calls when disabled or excluded; camera/recording cleanup; accurate media outcomes; and the core-only profile.

Use synthetic hostile fixtures and a dedicated test vault. Never put private browsing data, raw keys, real camera frames or private captions in CI logs or the public repository. Record actual checks in STATUS.md and the release notes. Missing evidence is a remaining gate, not a passed control.
