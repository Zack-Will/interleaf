# Design: live preview (`modules/live-preview`, `services/live-preview`)

Status: implemented through P5 on `feat/live-preview-hardening` (2026-10-12).
P1-P4 browser acceptance was completed by the orchestrator before this release pass.
Release and historical verification: [live-preview-verification.md](live-preview-verification.md).
Feasibility evidence:
`rtex-spike/REPORT.md` and `rtex-spike/REPORT-acmart.md` (local spike repo, not in
this repository); the numbers quoted below come from those runs on home-center.

Live preview shows the paragraph being edited re-typeset in the PDF pane a few
milliseconds after the edit reaches the server, while a background LuaLaTeX pass keeps
pages, floats, references and the bibliography correct. It embeds
[rtex](https://github.com/HenryXiaoYang/realtime-tex) (MIT), which keeps a LuaLaTeX
process with the preamble loaded and re-typesets one unit at a time. The output is
exactly LuaLaTeX's: same line breaks, same glyphs, same positions to 1 sp.

Scope: projects whose compiler is `lualatex`. Other projects keep today's compile flow
unchanged and see a one-line hint in the preview toolbar.

## 1. The decision: rtex in a separate in-container service, results on our own socket

```
 browser (editor window)            sharelatex container                           other
 ───────────────────────            ────────────────────────────────────────────   ─────
 CodeMirror ──ShareJS ops──▶ real-time ──▶ document-updater ──applied-ops──┐       redis
   (flush ~150 ms in live mode)                     ▲                      │      pubsub
                                                    │ GET doc / fromVersion │
 PDF pane                                           │                      ▼
   pdf.js base pages ◀──HTTP── nginx /live-preview/ ◀── live-preview service (node)
   canvas overlay   ◀──WS───── nginx /live-preview/ws ◀──┤  one rtex session per open project
   glyph paths      ◀──HTTP── nginx /live-preview/glyphs │    └─ `rtex serve` child process
                                                         │         ├─ live LuaLaTeX engine
 web module live-preview ──ticket, project snapshot──────┘         └─ background passes
   (auth, settings, meta flag, editor-events listener)
```

The text the engine sees comes from exactly one place: document-updater's applied-ops
stream, the same stream real-time uses to keep collaborators in sync. Edits by the
user, collaborators, MCP agents, git pushes and restores all arrive the same way and
appear live with no special casing. The browser never sends text to the engine.

The one obstacle is latency on the client side. ShareJS batches local ops and sends
them every 2000 ms when the user is alone, 500 ms with collaborators
(`frontend/js/features/ide-react/editor/share-js-doc.ts:34-35`). In live mode the
module lowers that delay to about 150 ms. That is the only change to the editing path.

Rejected alternatives:

| Alternative                                                 | Why not                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client sends its unsaved buffer to the engine directly      | Two sources of truth for document text. Every edit would have to be rebased against the OT stream, and collaborators would see each other's speculative text. Lowering the flush delay gets the same latency with no merge logic. |
| rtex inside the web process (napi binding to the C library) | A crashed or hung engine would take the web process with it, and rtex holds 1-1.5 GB per session. Web restarts would also kill every session.                                                                                     |
| Run rtex inside CLSI                                        | CLSI is a compile-and-exit service with per-compile directories it prunes and full syncs that delete unknown files. A long-lived engine fights all three.                                                                         |
| Separate sidecar container                                  | Needs its own TeX Live (5 GB) or a shared volume with the main image's. The engine must use the same TeX tree as the CLSI build or fonts and line breaks drift.                                                                   |
| Push results through real-time's socket.io                  | socket.io 0.9 has no binary frames, every message fans out to every socket in the room through Redis, and restricted users need a pass-list edit. Live results go only to clients that have the preview open.                     |
| Draw whole pages from display lists                         | A full page renderer (Type 1, OpenType, images, TikZ fallback) before the first useful result. pdf.js already renders the pages; we only paint what changed.                                                                      |

What it costs: one new runit service, one nginx location, a fork of rtex built in our
image workflow, and about 1.2 GB of memory per project with live preview open.

## 2. The rtex fork

The fork lives at `Zack-Will/realtime-tex`. Branch `interleaf` is upstream's latest
tag plus our patches, each patch on its own topic branch so it can be offered upstream
unchanged. The image pins a release and its archive SHA-256, never a moving branch.

Patches already written in the spike (branch `fix/acmart-heading-guard`, tex/ support
files only): acmart heading-guard resync, column packing and `balance` attribute leaks,
float column geometry replay, image resource index mapping, with regression tests.

Patches this design needs:

| Patch                                        | Why                                                                                                                            | Upstreamable          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Always report the pass PDF in `LayoutUpdate` | Today `pdf_fallback` is set only when a page is degraded (`session/passes.rs:781`). We draw every base page from the pass PDF. | Yes, as a config flag |
| Verifier: honour Form XObject `/BBox`        | `rtex verify` layer 2 fails on every PDF figure (`rtex-verify/src/pdftext.rs`). We use verify in CI.                           | Yes                   |
| `serve`: binary display lists                | JSON display lists are 3x the binary size. Length-prefixed binary frames on stdout, opt-in.                                    | Yes                   |

Building: the fork's own CI builds and tests rtex and publishes a release
(`interleaf-<upstream version>-<n>`, e.g. `interleaf-0.0.3-2`) with the Linux x86_64
archive and its SHA-256. `server-ce/Dockerfile` downloads the pinned release and checks
the hash. Building in the fork keeps a Rust toolchain and a cargo cache out of the image
build, whose GitHub Actions cache the TeX layers already nearly fill, and the fork's CI
already runs rtex's tests against a real TeX Live. The binary goes to
`/usr/local/bin/rtex`, the support files to `/usr/local/share/rtex/tex` (`RTEX_TEXDIR`),
not `texmf-local`, which operators mount over (`doc/deploy-toolkit.md`, TeX Live
section). The layer sits right after the TeX Live layers so application changes never
download it again.

## 3. The live-preview service

A node workspace `services/live-preview`, started by `server-ce/runit/live-preview-overleaf/run`
as `www-data`, listening on `127.0.0.1:3060`.

### 3.1 Sessions

One session per project, shared by every viewer of that project.

- **Start:** when the first client opens a live-preview socket for the project. Never
  on edits alone.
- **Materialise:** fetch the project snapshot from the web module's internal route
  (§4.2) into `/var/lib/overleaf/data/live-preview/<projectId>/`: docs as text, binary
  files from their filestore blob URLs. Then `rtex serve --project <dir> --main
<rootDoc>` with `RTEX_TEXDIR`, no `--shell-escape`, and the build directory inside
  the session directory.
- **Stop:** 2 minutes after the last socket closes. Also when the project's compiler
  leaves `lualatex`, the root doc changes (restart instead), or the project is deleted.
- **Budget:** at most `LIVE_PREVIEW_MAX_SESSIONS` sessions (default 2 on home-center).
  A new session beyond the budget evicts the least recently used one with no open
  socket; if every session has viewers, the new viewer gets `busy` and the normal
  compile flow.
- **Crash:** if `rtex serve` exits, restart it once from the files on disk. A second
  crash within a minute marks the session failed until the next open.

### 3.2 Keeping the files in step

- Subscribe to `applied-ops` and `editor-events` on the pubsub Redis (CE publishes every
  op on the one global `applied-ops` channel, `RealTimeRedisManager.js:113-130`).
  Keep only messages for projects with a session.
- For each op: skip `dup` and comment (`c`) components; check `op.v` against the
  session's version of that doc. In order: convert the UTF-16 offsets of `p`/`i`/`d`
  to UTF-8 byte offsets of the file and send `{"cmd":"edit"}` to rtex. Out of order or
  after a gap: `GET /project/:p/doc/:d?fromVersion=<v>` from document-updater and
  replay, or on failure `set_document` with the whole doc.
- Structure events on `editor-events` (`reciveNewDoc`, `reciveNewFile`,
  `reciveEntityRename`, `reciveEntityMove`, `removeEntity`, `rootDocUpdated`,
  `compilerUpdated`): apply to the session directory, then `set_document` or a session
  restart. A binary file change schedules a background pass (`request_layout`).
- Never call document-updater's `get_and_flush_if_old`: it rewrites the project state
  hash that CLSI's incremental compiles depend on.
- Pub/sub is lossy. A periodic check (every 30 s while a session is active) compares the
  session's doc versions with document-updater and resyncs any that drifted.
- Projects migrated to history-ot publish a different op shape
  (`HistoryOTUpdateManager.js:25`). The first version handles them with `set_document`
  per op; a proper converter comes later if any project uses it.

### 3.3 Client protocol (WebSocket, `/live-preview/ws`)

Wire codecs and signed tickets live in `libraries/live-preview-protocol`, shared
by web and the preview service. Browser consumers import the frame/display-list
entries separately from the Node-only ticket entry.

Server to client, binary frames with a one-byte type and a JSON header, then the
display list in rtex's binary format where there is one:

| Frame         | Header                                                                                                         | Body              |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| `hello`       | session state, `layout_version`, engine state, pages total, `access`, `access_expiry`                          |                   |
| `paragraph`   | `par_id`, `status`, `fragments`, `versions`, `pagination_stale`, `context_stale`, `timing`                     | unit display list |
| `layout`      | `layout_version`, `pages_total`, `pdf_url`, `placements`, `convergence`, `compile`, `snapshot_source_revision` |                   |
| `background`  | `par_id`, `reasons`, `path`, `doc_id`, UTF-16 `range: {start,end}`, `versions.source_revision`                 |                   |
| `diagnostics` | rtex's diagnostics items                                                                                       |                   |
| `engine`      | `Starting` / `Ready` / `Restarting` / `Failed`, reason                                                         |                   |
| `busy`        | why live preview is unavailable                                                                                |                   |
| `access`      | `access`, `access_expiry` (Unix milliseconds), fresh HTTP credentials for this viewer                          |                   |

Client to server: only `ping` and `resync`. The connection URL carries a ticket from
the web module (§4.1); the service checks its HMAC and expiry and that it names this
project. Web mints `kind: 'open'`; upgrades also accept legacy tickets without a
kind, and reject `kind: 'access'`. The `hello` frame includes an HMAC-signed access
token bound to the same project and user, with `kind: 'access'` and a 15-minute
expiry (`LIVE_PREVIEW_ACCESS_TTL_MS`, default 900000 ms). While the socket remains
open, the service sends a fresh token in an `access` frame at 80% of its lifetime,
before expiry. Resync also sends fresh credentials in `hello`. Clients use the
latest access token for PDF and glyph requests without returning to web for a new
ticket. Closing the socket stops renewal.

### 3.4 Collaboration

A collaborator's edit should reach every open preview as fast as the user's own. The
path is: collaborator's client flush, real-time, document-updater, applied-ops, the
session, rtex, the WebSocket fan-out. Three things on that path would make remote edits
slower than local ones, and each has a fix.

- **The collaborator's flush delay.** Lowering the delay only for the user who turned
  live preview on leaves everyone else at ShareJS's 500 ms. While a project has an
  active session, the service publishes `livePreview.active` on `editor-events` at
  startup and every `LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS` (default 30000 ms), with
  event argument `{ leaseMs: 75000 }` (native Redis `payload` is an argument array).
  This refresh lets editors joining later learn about the active session, and
  every editor client in the project lowers its flush delay to the live value whether
  or not it shows the preview. The low delay is a lease valid until `leaseMs` after
  the last `active`; each refresh renews it. Clients reset to the default on lease
  expiry, immediately when `livePreview.inactive` arrives, or on reconnect until a
  fresh `active`. The service stops refreshing when the session stops or fails.
- **Background passes starved by continuous typing.** rtex starts a pass after 300 ms
  of quiet. With two people typing, the quiet period may never come, and pagination,
  references and anything routed to the background stay stale. The session sends
  `request_layout` after an effective max-wait of
  `max(LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS, LIVE_PREVIEW_LAYOUT_MAX_WAIT_FACTOR × lastPassMs)`.
  The defaults are 3000 ms and factor 2. A five-second Cleave pass therefore gives
  a ten-second max-wait; small documents retain the three-second floor. A
  completed layout cancels the previous deadline and starts a fresh adaptive
  deadline if its snapshot is already stale. This reduces forced follow-up work
  on small hosts at the cost of slower pagination/reference updates during
  continuous collaboration. Live paragraph fan-out remains immediate. Max-wait
  bounds the service's forced request, not pass duration or rtex's own scheduling;
  quiet-time passes can arrive sooner.
- **Ordering across users.** Ops from all users are applied in document version order,
  so two people editing the same paragraph converge on the same text the editors show.
  rtex drops results for text that has changed since, so a burst never delivers stale
  paragraphs. Every viewer receives the same frames in the same order.

The `paragraph` frame carries the `user_id` of the last op that touched the unit.
The overlay briefly outlines a paragraph changed by someone else in that user's
cursor colour, so remote changes are visible as they happen.

Acceptance (P1 for the server path, P3 end to end): two clients on the develop stack,
one typing, the other measuring keystroke-to-paint for the remote edit. Target P95
under 300 ms with both editing the same document. Small-document acceptance
checks layouts within four seconds during continuous typing; long passes use
the adaptive deadline plus compilation time.

rtex and all LuaLaTeX descendants inherit `nice -n LIVE_PREVIEW_NICE` (default
10), an optional `taskset` affinity of at most `LIVE_PREVIEW_CPUS` allowed CPUs
(default 2, 0 disables affinity), and the existing per-process `prlimit --as`.
Missing taskset leaves affinity unchanged. CPU ids come from the service's
allowed set, so container/cgroup affinity is respected. The trusted LuaLaTeX
wrapper still enforces the TeX security policy.

### 3.5 HTTP

| Route                                                     | Notes                                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /live-preview/pdf/:projectId/:layoutVersion?ticket=` | The pass PDF. Kept for the last three layouts.                                                                                                                                                              |
| `GET /live-preview/glyphs/:fontKey?ids=1,2,3&ticket=`     | Glyph outlines as compact path data with advance and units-per-em. `fontKey` is a hash of rtex's font description (file, subfont, size-independent). Bounded in-memory cache; HTTP uses private `no-store`. |
| `GET /live-preview/health`                                | For the verify script.                                                                                                                                                                                      |

Glyph outlines come from the font files rtex names (OpenType/TrueType through a
font parser, Type 1 through a small charstring decoder as the VS Code extension does).
The browser downloads only the glyphs it draws: a Chinese paragraph needs a few hundred
glyphs. The P5 Chinese paragraph uses 55 unique FandolSong glyphs: 82,390 bytes
of JSON compared with its 4,947,904-byte OTF font (1.67%).

The `ticket` query parameter on PDF and glyph routes accepts only access tokens
(`kind: 'access'`). Each request checks the HMAC, project/user claims and expiry;
opening tickets are rejected. WS upgrades reject access tokens even when their
remaining lifetime is less than 60 seconds.

## 4. The web module (`services/web/modules/live-preview`)

Registered last in `moduleImportSequence`, gated by `livePreview.enabled`
(`LIVE_PREVIEW_ENABLED`) in `settings.defaults.js` and `server-ce/config/settings.js`.

### 4.1 Routes

| Route                                             | Access                     | Notes                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /project/:id/live-preview/ticket`           | read access to the project | Returns a ticket valid for 60 s: HMAC of project id, user id, `kind: 'open'`, expiry, with `LIVE_PREVIEW_TICKET_SECRET`. 404 `live_preview_disabled` when the flag is off, 409 `compiler_not_lualatex`. |
| `GET /internal/project/:id/live-preview/snapshot` | private API, basic auth    | File list for materialisation: docs/versions from document-updater, root doc path, and immutable binary URLs via `HistoryManager.getFilestoreBlobURL`, the same helper CLSI uses.                       |

### 4.2 Frontend

Implementation lives in the module, with small upstream viewer, compile-context,
ShareJS and dropdown hooks.

- `rootContextProviders`: `LivePreviewProvider` owns the socket, the paragraph state, the
  current layout and the toggle (`usePersistedState('live-preview:<projectId>')`). It
  runs in both the editor and the detached preview window. Each window opens its own
  socket, so detached mode needs no relay.
  Detached windows receive compiler eligibility through the existing detach-state
  channel because they do not join the editor socket; preview frames are never relayed.
- Overlay renderer: one canvas per page inside `.page`, sized with pdf.js's
  `--scale-factor`, re-attached on `pagerendered` because pdf.js removes foreign
  children when it resets a page. Coordinates: display-list sp to bp
  (`sp / 65536 * 72 / 72.27`) from the page's top-left corner, then the page viewport.
  For each `paragraph` frame: paint the unit's previous rows (from the layout's
  placements) with the page background, then draw the new rows from glyph paths.
  P3 extends placements with `row_rects: [{page,x,y,w,h}]`, derived from retained
  page display lists by matching baseline/x and capture-unit ownership. Units with
  missing geometry or degraded content wait for the next pass PDF.
  Living inside `.page` means dark mode's inversion applies to the overlay too.
- Base pages: retain results whose source revision exceeds the layout's
  `snapshot_source_revision`, and move them to its placements. Pinned rtex reports
  delivery-time source revisions; a stale layout's actual snapshot is
  `convergence.pending_since - 1`. Prefetch the latest PDF into a blob URL and
  defer applying it until one second after the last paragraph/local edit. Stale
  pagination, approximate/unplaced fragments, removed units and degraded content
  bypass the delay once a layout incorporates the change. Capture visible page
  and overlay pixels through the P3 viewer exposure before the swap; retain them
  through pagesinit until each new page emits pagerendered. All implementation
  lives in the module, preserving native pdf.js scale/scroll restoration.
- Autocompile is turned off while live preview is on; the background pass replaces it.
  Recompile and download still use CLSI, so the downloaded PDF is the normal build.
- Status: engine state and convergence as a small badge in the preview toolbar;
  `background` reasons in a tooltip on the paragraph's gutter marker; rtex diagnostics
  merged into the logs pane.
  Missing font glyphs are aggregated from the pass log once per font/pass with
  current source locations, ctex/fontspec guidance and P4 gutter markers.

P4 uses the existing `sourceEditorExtensions` and `pdfLogEntriesComponents`
slots, without editor/logs component edits. Background and error-paragraph
frames attach source ranges converted from rtex's UTF-8 spans; the open document
gets mapped gutter markers until a live result or a containing layout catches up.
Logs keep CLSI entries and a separate live group with native file/line links.
Session failures offer Retry, budget exhaustion explains the normal-compile
fallback, and a compiler change disables the persisted preference with a notice.
Both editor and detached roots retain independent sockets; see
[live-preview-verification.md](live-preview-verification.md).

Upstream edits, each a few lines:

| File                                                       | Change                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pdf-js-viewer.tsx` + `pdf-preview-provider.tsx`           | Put the `PDFJSWrapper` instance and `initialised` into the preview context, so the module can reach the viewer. |
| `pdf-compile-button.tsx`                                   | A **Live preview** item in the compile dropdown, shown when the meta flag is on and the compiler is `lualatex`. |
| `share-js-doc.ts`                                          | Read the flush delay from a small store the module can set, instead of the two constants.                       |
| `pdf-js-wrapper.ts`                                        | Allow a plain HTTP PDF without CLSI range/cache metadata.                                                       |
| `local-compile-context.tsx` + `detach-compile-context.tsx` | Suspend only autocompile and override only the pane's URL; keep manual builds and download URLs on CLSI.        |

Plus the usual flag plumbing (`ProjectController` locals, `_meta.pug`, `meta.ts`,
following `githubBackupEnabled`), the module paths in `overleafModuleImports`, and the
nginx location in `server-ce/nginx/overleaf.conf`.

## 5. Security

The engine runs as `www-data`, outside the CLSI tree. A trusted LuaLaTeX wrapper
reasserts `openin_any=p`, `openout_any=p` and `-no-shell-escape` at the final exec
boundary because pinned rtex resets `openout_any=a` internally. kpathsea permits
absolute input under the installed, service-read-only TeX tree and the session
output root. Font caches and a copy of trusted rtex support live inside that
session. Full TeX Live 2025 acceptance checks the actual child environment, refuses
`/etc/passwd` input and output outside the session, and confirms normal project
input and disabled `write18`. These TeX filename controls do not provide an OS
sandbox; keep the service account's access and writable directories narrow.

Snapshots reject traversal, absolute paths, reserved paths and on-disk symbolic
links. Atomic replacement preserves rtex's hard-linked build snapshots. Budgets
are 2,000 entities, 32 MiB/file, 256 MiB/project, and 64 MiB/read of internal JSON;
downloads are bounded while streaming and do not follow redirects. Web checks
entity/path/text budgets before returning snapshots. The inherited `prlimit --as`
default remains 2048 MiB per process, verified with full TeX Live and real papers.
The project session budget, viewerless LRU eviction, two-minute idle reaping,
stop cleanup and stale-directory cleanup on start bound retained resources.

Opening tickets are short-lived and project-bound; HTTP requires separate access
tokens. Fonts must be registered for the token's project, and an uploaded font
must resolve inside that project's own directory or an installed font root.
PDF retention and serving reject linked paths. Both HTTP routes use private
`no-store` because layout versions and font paths can be reused after restarting.
Glyph lists allow at most 1,024 integer IDs. Sockets accept at most 4 KiB/message,
16 connections/project and eight/user, check browser Origin against Host or an
explicit allowlist, and terminate clients missing ping/pong heartbeats. Slow
consumers with more than 8 MiB queued are closed. CLI sockets without Origin still
require tickets. Snapshot/document-updater outages produce clear Failed/busy
frames and require explicit Retry, without an automatic session creation loop.

## 6. Milestones

| Stage                     | Deliverables                                                                                                                                                                                                                                                                             | Status                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 rtex fork**          | Pinned fork/support patches, pass PDFs, binary display lists, checksum-pinned image layer                                                                                                                                                                                                | ✅ external `interleaf` / `fix/acmart-heading-guard`, release `interleaf-0.0.3-2`; historical spike: 10 Lua + 3 acmart checks                 |
| **P1 service**            | `services/live-preview`: sessions, materialisation, applied-ops consumer with version checks, structure events, idle reaping, budget, layout max-wait, `livePreview.active` events; WebSocket and HTTP routes; a test client that opens a session on the develop stack and prints frames | ✅ `feat/live-preview-service`; 68 unit tests                                                                                                 |
| **P2 web module**         | pinned rtex image layer, workspace install, settings flag, shared opening-ticket issuer, private live snapshot, meta flag, nginx/runit/init wiring, source-mounted develop stack                                                                                                         | ✅ `feat/live-preview-wiring`; 14 historical web tests; real MCP → paragraph/layout and PDF/glyph HTTP 200                                    |
| **P3 overlay**            | viewer exposure, provider, overlays, glyphs, base geometry, project-wide flush delay and collaborator outline                                                                                                                                                                            | ✅ `feat/live-preview-frontend`; browser-tested; P3/P4 frontend suite now 43 tests                                                            |
| **P4 editor integration** | source markers, diagnostics, independent detached windows, toggle and Retry/fallback UX                                                                                                                                                                                                  | ✅ `feat/live-preview-editor`; browser-tested; 76 service + 16 protocol + 14 web + 41 frontend tests at handoff                               |
| **P5 hardening and docs** | security regressions, resource measurements, crash/outage/restart acceptance, Chinese thesis fixture, user/operator/release docs                                                                                                                                                         | ✅ `feat/live-preview-hardening`; 95 service + 16 protocol + 16 web + 43 frontend tests; 8 protocol acceptance + 11 full-TeX + 2 nginx checks |

Historical P2 used the develop stack; P5 used isolated host processes and throwaway
containers, with no develop services, browser or webpack. P1/P3 feasibility baselines
remain Cleave 12/14 edit targets live (median 4.6 ms) and migrated CrossMem 8/10.
The full-TeX release pass measures both real papers and Chinese paragraphs under
production resource controls. Counts above distinguish historical handoff checks
from the final release suites; evidence is consolidated in
[live-preview-verification.md](live-preview-verification.md).

## 7. Risks

| Risk                                                                               | Mitigation                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rtex is 0.0.x and one person's project; its API and display-list format may change | Pin a commit; keep rtex behind the service's own protocol (§3.3) so the browser never sees rtex's format directly except the display list, whose revision is checked. |
| About 1.75 GiB peak RSS per real-paper session                                     | Budget about 2 GiB/project plus existing services and OS headroom; use one session on small hosts, idle reaping and viewerless LRU eviction.                          |
| Templates rtex refuses (run-in headings, `\maketitle`, buffered abstracts)         | Those units fall back to the background pass and say why. Fixes go to the fork and upstream, as with acmart.                                                          |
| The 150 ms flush delay raises op traffic                                           | Overleaf already uses 500 ms with collaborators; document-updater and project-history compress ops. Measure in P3; raise to 300 ms if needed.                         |
| Collaborators' edits appear later than the user's own                              | Project-wide flush delay while a session is active, layout max-wait, two-client latency test (§3.4).                                                                  |
| Lost pub/sub messages leave the engine with stale text                             | Version check per op, `fromVersion` replay, periodic drift check (§3.2).                                                                                              |
| Pass PDF and overlay disagree for a moment after a layout                          | Retain newer revisions against the pass snapshot, re-anchor to placements and retain page pixels through rendering.                                                   |
| ACM's camera-ready pipeline compiles the source itself                             | Accepted by the user: papers move to LuaLaTeX and follow its layout.                                                                                                  |

## 8. Decision log

1. Scope is `lualatex` projects only; papers move to LuaLaTeX rather than keeping a
   pdfLaTeX final build next to a LuaLaTeX preview. (2026-10-11, user)
2. The document text reaches the engine only through document-updater's op stream; the
   client lowers its ShareJS flush delay instead of sending text. (2026-10-11)
3. rtex runs in its own in-container service, one `rtex serve` child per project.
   (2026-10-11)
4. Results go over a dedicated WebSocket, not real-time's socket.io. (2026-10-11)
5. Base pages come from rtex's pass PDF through pdf.js; display lists are drawn only
   for live paragraphs. (2026-10-11)
6. We maintain a fork of rtex with upstreamable topic branches and contribute fixes
   back. (2026-10-11, user)
7. rtex is built and released by the fork's CI; the image downloads a pinned,
   checksummed release instead of compiling Rust. (2026-10-11)
8. Remote edits must render as promptly as local ones: the low flush delay applies to
   every editor in a project with an active session, background passes have a 3 s
   max-wait, and the two-client latency test is an acceptance criterion. (2026-10-11,
   user)
