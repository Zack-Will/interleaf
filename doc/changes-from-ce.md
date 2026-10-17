# What this fork changes in Community Edition

Baseline: `overleaf/overleaf@28ad3b0`, the state of the main branch shortly after
the 6.1.2 hotfix. Everything below is additive unless a row says otherwise.

Before the live-preview additions, measured against that baseline: 126 files
changed, about 19,300 lines added, of which 15,400 are the five original modules.
Thirty-two of those new files are tests.

## Six new web modules

Each lives under `services/web/modules/` and is loaded through upstream's own
`moduleImportSequence`, the extension point Overleaf already uses for its
closed-source modules. Feature logic lives in the modules; the small upstream
settings, metadata and deployment changes are listed below.

| Module          | Lines | What it is                                                                                                                   |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| `project-sync`  | 3,674 | Personal access tokens, the locked write path, versions, snapshots, labels, reverts and branches                             |
| `mcp`           | 4,624 | The Model Context Protocol endpoint and its 27 tools                                                                         |
| `github-backup` | 2,594 | One-way mirror of a project's git history to a GitHub repository                                                             |
| `review`        | 2,583 | The review panel enabled on CE, comment threads, tracked-change suggestions, the agent service account                       |
| `git-bridge`    | 1,879 | The web half of the official Java git-bridge                                                                                 |
| `live-preview`  | 3,433 | LuaLaTeX opening tickets/snapshots, collaborative PDF overlays, source markers, logs and detached preview UX; code and tests |

### project-sync

Personal access tokens (`olp_…`) stored as salted hashes with per-token scopes
(`mcp`, `git_bridge`) and optional expiry, an `/oauth/token/info` endpoint shaped
the way the Java git-bridge expects, and the write path everything else goes
through: a project lock, an optimistic `base_version` check that fails with a
structured conflict rather than clobbering, upstream's `UpdateMerger` for the
actual file changes, and a persisted origin recording which agent made the write
and why. Branches are real Overleaf projects created by upstream's project
duplicator and tracked in a small collection, merged back with a three-way diff
that reports conflicting hunks instead of guessing.

### mcp

One stateless Streamable HTTP endpoint at `POST /mcp`. A fresh server instance
is built per request and bound to the token's user, and every project-scoped tool
resolves access through upstream's `AuthorizationManager`, so an agent can reach
exactly what the person who issued the token can reach. The tools cover reading
(files, outline, search, history, diffs), writing (whole files, structured edits,
reverts, labels), branching, review (comments, replies, resolutions, suggestions
as tracked changes) and backup status.

### review

Upstream ships the review panel's frontend in CE but disables it: the editor is
told track changes is unavailable, the web routes the panel calls are in a
closed-source module, and comment threads have nowhere to go. This module turns
the capability on, adds the eleven routes the panel needs against the `chat` and
`document-updater` services, and gives the agent a passwordless service account
so its replies are attributable to a named participant rather than to the person
who issued the token. Comments are OT-transformed by upstream's ranges tracker,
so they follow the text they are anchored to through a rewrite.

### git-bridge

The Java bridge is upstream's own MIT-licensed service and is already in this
repository; what CE lacks is the web side it talks to. This module implements
that contract: the document and snapshot endpoints, signed unauthenticated blob
URLs for the bridge to fetch binaries with, and the push job that turns a
`git push` into a project version with a `git-bridge` origin, including the
out-of-date response and the asynchronous postback the bridge expects.

### github-backup

A project is linked to a repository with a fine-grained token. A scheduled job
and an on-demand button fetch the project's history from the git-bridge container
into a bare mirror and fast-forward push it to GitHub. Credentials are encrypted
with upstream's `access-token-encryptor` and passed to git through an askpass
helper, never in argv or a URL; anything git prints is scrubbed before it is
logged or stored. A divergent remote is reported, never overwritten.

### live-preview

An opt-in web module issues read-authorized, 60-second opening tickets using the
service's shared HMAC issuer. A private Basic-auth snapshot route reads live text
and versions from document-updater without flushing, and uses the same immutable
history/filestore blob URL helper as CLSI. The separate Node service subscribes to
applied operations, runs one rtex session per open project and supplies paragraph
frames, layout PDFs and glyph outlines with separate access credentials. P2 adds
the image, runit and nginx wiring. The editor UI includes the Recompile toggle,
paragraph overlay, collaborator outlines, source gutter markers, live diagnostics
and independent detached-window connections. Normal compilation/download remains
on CLSI. See [the user guide](live-preview.md).

`services/live-preview/` is a new Node workspace and runit service: materialization,
read-only applied-op consumption, session/resource controls, paranoid LuaLaTeX
wrapper, authenticated HTTP/WebSocket transport, font outlines and isolated real
engine acceptance (6,896 lines including tests/docs).
`libraries/live-preview-protocol/` is a new shared workspace
(579 lines including tests/docs) for browser-safe frame/display-list codecs and
Node-only signed tickets. Neither library nor service modifies project storage or
the OT pipeline. Module/service totals include their own tests and documentation.

## Changes to upstream files

Kept deliberately small. The only behavioural changes to core code are these.
[upstream-sync.md](upstream-sync.md) lists every upstream file the fork still
touches and how to handle each one when merging a new upstream release.

| File                                                                              | Size   | Why                                                                                                    |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `services/document-updater/app/js/DocumentManager.js`                             | +197   | Add a comment to a document's ranges, and apply a whole-document update as tracked changes             |
| `services/document-updater/app/js/HttpController.js`                              | +103   | The routes for the above                                                                               |
| `libraries/overleaf-editor-core/lib/origin/mcp_origin.js`                         | new    | `Origin.toRaw()` only kept the kind, which dropped the agent name, its message and the suggestion flag |
| `services/web/config/settings.defaults.js`                                        | +4     | One call into `settings.interleaf.js`, which holds the module settings, import order and slots         |
| `server-ce/config/settings.js`                                                    | +20/-1 | The three values the production image overrides, and the invite-token fix                              |
| `server-ce/nginx/overleaf.conf`                                                   | +42    | Proxy `/git/` and preview routes; preserve the public WebSocket Host port                              |
| `server-ce/Dockerfile`                                                            | +57    | Optional TeX Live scheme and checksum-pinned rtex installation                                         |
| History panel: `origin.tsx`, `history-version.tsx`, `history-version-message.tsx` | +51    | Render the agent's name and the message it sent under the author line                                  |
| `services/web/package.json`                                                       | +4/-2  | Runtime `diff` and shared protocol dependency                                                          |

### Live-preview upstream integration, exact line counts

The table below measures only live-preview work against the commit immediately
before P1 (`ce6c93d82b^`), including P1-P5. This avoids counting unrelated earlier
fork changes in the same files. New module/service/library files are listed above.
Since then the module settings moved to `settings.interleaf.js`.
P5 changes one upstream nginx directive to preserve the public Host port for
WebSocket Origin checks; the fork's development gateway receives the same fix.

| File                                                                                | Added/deleted lines | Purpose                                                  |
| ----------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `.github/workflows/build-image.yml`                                                 | +10/-0              | Pin rtex release/hash build inputs                       |
| `package.json`                                                                      | +2/-0               | Register service and protocol workspaces                 |
| `yarn.lock`                                                                         | +90/-2              | Resolve workspace/runtime dependencies                   |
| `server-ce/Dockerfile`                                                              | +17/-0              | Download and verify the rtex archive                     |
| `server-ce/config/env.sh`                                                           | +9/-0               | Private web/document-updater and pubsub Redis wiring     |
| `server-ce/config/settings.js`                                                      | +12/-3              | Gated module settings                                    |
| `server-ce/init_scripts/100_make_live_preview_data_dir.sh`                          | +9/-0               | Service-owned session storage and required secret        |
| `server-ce/runit/live-preview-overleaf/run`                                         | +14/-0              | Supervised www-data service                              |
| `server-ce/logrotate/overleaf`                                                      | +1/-0               | Preview log rotation                                     |
| `server-ce/nginx/overleaf.conf`                                                     | +19/-0              | Loopback PDF/glyph/WebSocket proxy, preserving Host port |
| `server-ce/services.js`                                                             | +3/-0               | Production dependency installation                       |
| `services/web/Dockerfile`                                                           | +3/-0               | Copy protocol workspace for development builds           |
| `services/web/package.json`                                                         | +1/-0               | Shared protocol dependency                               |
| `services/web/config/settings.defaults.js`                                          | +36/-4              | Module order, settings and frontend slots                |
| `services/web/frontend/js/features/ide-react/editor/share-js-doc.ts`                | +12/-2              | Configurable collaborative flush delay                   |
| `services/web/frontend/js/shared/flush-delay.mjs`                                   | +17/-0              | Optional-module delay store                              |
| `services/web/frontend/js/features/pdf-preview/components/pdf-compile-button.tsx`   | +12/-1              | Module dropdown slot                                     |
| `services/web/frontend/js/features/pdf-preview/components/pdf-js-viewer.tsx`        | +13/-10             | Expose viewer instance and lifecycle                     |
| `services/web/frontend/js/features/pdf-preview/components/pdf-preview-provider.tsx` | +16/-2              | Viewer context bridge                                    |
| `services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts`              | +14/-8              | Plain private PDF loading                                |
| `services/web/frontend/js/shared/context/local-compile-context.tsx`                 | +5/-1               | Preview URL and autocompile hook                         |
| `services/web/frontend/js/shared/context/detach-compile-context.tsx`                | +34/-7              | Detached metadata and independent preview hooks          |
| `services/web/frontend/extracted-translations.json`                                 | +7/-0               | Module translations                                      |
| `services/web/locales/en.json`                                                      | +7/-0               | Module translations                                      |
| `develop/.gitignore`                                                                | +2/-1               | Ignore downloaded rtex                                   |
| `develop/bin/setup-live-preview`                                                    | +21/-0              | Verify and unpack pinned archive                         |
| `develop/docker-compose.yml`                                                        | +47/-0              | Source-mounted service and protocol mounts               |
| `develop/docker-compose.live-preview.yml`                                           | +20/-0              | Isolated protocol gateway overlay                        |
| `develop/live-preview-nginx.conf`                                                   | +25/-0              | Optional development proxy                               |
| `develop/webpack.config.dev-env.js`                                                 | +5/-0               | Preview HTTP/WebSocket proxy                             |

Two upstream bugs are fixed along the way: the invite-token encryptor options
were assigned onto `module.exports` before the settings file replaces it, so
`OVERLEAF_INVITE_TOKEN_SECRET` never took effect; and the same production-only
dependency pruning that hid the `diff` problem.

## What is deliberately not changed

Authorization is upstream's. Project storage, history storage, the OT pipeline
and the editor are upstream's. No feature flag that gates a paid product is
flipped except the review panel, whose frontend is already open source in this
repository. No Server Pro code was consulted, and none of it is present here.
