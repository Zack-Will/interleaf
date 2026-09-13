# What this fork changes in Community Edition

Baseline: `overleaf/overleaf@28ad3b0`, the state of the main branch shortly after
the 6.1.2 hotfix. Everything below is additive unless a row says otherwise.

Measured against that baseline: 126 files changed, about 19,300 lines added, of
which 15,400 are the five new modules. Thirty-two of the new files are tests.

## Five new web modules

Each lives under `services/web/modules/` and is loaded through upstream's own
`moduleImportSequence`, the extension point Overleaf already uses for its
closed-source modules. None of them patches a core file to do their work.

| Module | Lines | What it is |
|---|---|---|
| `project-sync` | 3,674 | Personal access tokens, the locked write path, versions, snapshots, labels, reverts and branches |
| `mcp` | 4,624 | The Model Context Protocol endpoint and its 27 tools |
| `github-backup` | 2,594 | One-way mirror of a project's git history to a GitHub repository |
| `review` | 2,583 | The review panel enabled on CE, comment threads, tracked-change suggestions, the agent service account |
| `git-bridge` | 1,879 | The web half of the official Java git-bridge |

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

## Changes to upstream files

Kept deliberately small. The only behavioural changes to core code are these.

| File | Size | Why |
|---|---|---|
| `services/document-updater/app/js/DocumentManager.js` | +197 | Add a comment to a document's ranges, and apply a whole-document update as tracked changes |
| `services/document-updater/app/js/HttpController.js` | +103 | The routes for the above |
| `libraries/overleaf-editor-core/lib/origin/mcp_origin.js` | new | `Origin.toRaw()` only kept the kind, which dropped the agent name, its message and the suggestion flag |
| `services/web/config/settings.defaults.js` | +63 | Settings for the new modules, their module import order and their frontend slots |
| `server-ce/config/settings.js` | +52 | The same settings for the production image |
| `services/web/app/src/Features/Project/ProjectOptionsHandler.mjs` | +24 | Set a project's track-changes state, which the review panel needs |
| `server-ce/nginx/overleaf.conf` | +23 | Proxy `/git/` to the git-bridge container, resolved at runtime so the container still starts without it |
| `server-ce/Dockerfile` | +30 | Optional TeX Live scheme, installed in groups as the first layers |
| History panel: `origin.tsx`, `history-version.tsx`, `history-version-message.tsx` | +51 | Render the agent's name and the message it sent under the author line |
| `services/web/package.json` | +1/-1 | `diff` moved to runtime dependencies; the production image installs only those |

Two upstream bugs are fixed along the way: the invite-token encryptor options
were assigned onto `module.exports` before the settings file replaces it, so
`OVERLEAF_INVITE_TOKEN_SECRET` never took effect; and the same production-only
dependency pruning that hid the `diff` problem.

## What is deliberately not changed

Authorization is upstream's. Project storage, history storage, the OT pipeline
and the editor are upstream's. No feature flag that gates a paid product is
flipped except the review panel, whose frontend is already open source in this
repository. No Server Pro code was consulted, and none of it is present here.
