# Design: live preview (`modules/live-preview`, `services/live-preview`)

Status: draft v0.1 (2026-10-11), not implemented. Feasibility evidence:
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

| Alternative | Why not |
|---|---|
| Client sends its unsaved buffer to the engine directly | Two sources of truth for document text. Every edit would have to be rebased against the OT stream, and collaborators would see each other's speculative text. Lowering the flush delay gets the same latency with no merge logic. |
| rtex inside the web process (napi binding to the C library) | A crashed or hung engine would take the web process with it, and rtex holds 1-1.5 GB per session. Web restarts would also kill every session. |
| Run rtex inside CLSI | CLSI is a compile-and-exit service with per-compile directories it prunes and full syncs that delete unknown files. A long-lived engine fights all three. |
| Separate sidecar container | Needs its own TeX Live (5 GB) or a shared volume with the main image's. The engine must use the same TeX tree as the CLSI build or fonts and line breaks drift. |
| Push results through real-time's socket.io | socket.io 0.9 has no binary frames, every message fans out to every socket in the room through Redis, and restricted users need a pass-list edit. Live results go only to clients that have the preview open. |
| Draw whole pages from display lists | A full page renderer (Type 1, OpenType, images, TikZ fallback) before the first useful result. pdf.js already renders the pages; we only paint what changed. |

What it costs: one new runit service, one nginx location, a fork of rtex built in our
image workflow, and about 1.2 GB of memory per project with live preview open.

## 2. The rtex fork

The fork lives at `Zack-Will/realtime-tex`. Branch `interleaf` is upstream's latest
tag plus our patches, each patch on its own topic branch so it can be offered upstream
unchanged. The image pins a commit of `interleaf`, never a moving branch.

Patches already written in the spike (branch `fix/acmart-heading-guard`, tex/ support
files only): acmart heading-guard resync, column packing and `balance` attribute leaks,
float column geometry replay, image resource index mapping, with regression tests.

Patches this design needs:

| Patch | Why | Upstreamable |
|---|---|---|
| Always report the pass PDF in `LayoutUpdate` | Today `pdf_fallback` is set only when a page is degraded (`session/passes.rs:781`). We draw every base page from the pass PDF. | Yes, as a config flag |
| Verifier: honour Form XObject `/BBox` | `rtex verify` layer 2 fails on every PDF figure (`rtex-verify/src/pdftext.rs`). We use verify in CI. | Yes |
| `serve`: binary display lists | JSON display lists are 3x the binary size. Length-prefixed binary frames on stdout, opt-in. | Yes |

Building: a `rust:<ver>-bookworm` stage in `server-ce/Dockerfile` builds the pinned
commit (precedent: git-bridge is built from source, `build-image.yml:96-109`). The
binary goes to `/usr/local/bin/rtex`, the support files to `/usr/local/share/rtex/tex`
(`RTEX_TEXDIR`), not `texmf-local`, which operators mount over
(`doc/deploy-toolkit.md`, TeX Live section). The stage sits right after the TeX Live
layers so application changes never rebuild it. It uses its own GitHub Actions cache
scope because the TeX layers already fill most of the 10 GB cache.

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
- **Stop:** 5 minutes after the last socket closes. Also when the project's compiler
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

Server to client, binary frames with a one-byte type and a JSON header, then the
display list in rtex's binary format where there is one:

| Frame | Header | Body |
|---|---|---|
| `hello` | session state, `layout_version`, engine state, pages total | |
| `paragraph` | `par_id`, `status`, `fragments`, `versions`, `pagination_stale`, `context_stale`, `timing` | unit display list |
| `layout` | `layout_version`, `pages_total`, `pdf_url`, `placements`, `convergence`, `compile` | |
| `background` | `par_id`, `reasons` | |
| `diagnostics` | rtex's diagnostics items | |
| `engine` | `Starting` / `Ready` / `Restarting` / `Failed`, reason | |
| `busy` | why live preview is unavailable | |

Client to server: only `ping` and `resync`. The connection URL carries a ticket from
the web module (§4.1); the service checks its HMAC and expiry and that it names this
project.

### 3.4 HTTP

| Route | Notes |
|---|---|
| `GET /live-preview/pdf/:projectId/:layoutVersion?ticket=` | The pass PDF. Kept for the last three layouts. |
| `GET /live-preview/glyphs/:fontKey?ids=1,2,3&ticket=` | Glyph outlines as compact path data with advance and units-per-em. `fontKey` is a hash of rtex's font description (file, subfont, size-independent). Cached in memory and with `Cache-Control: immutable`. |
| `GET /live-preview/health` | For the verify script. |

Glyph outlines come from the font files rtex names (OpenType/TrueType through a
font parser, Type 1 through a small charstring decoder as the VS Code extension does).
The browser downloads only the glyphs it draws: a Chinese paragraph needs a few hundred
glyphs, not Fandol's 19 MB.

## 4. The web module (`services/web/modules/live-preview`)

Registered last in `moduleImportSequence`, gated by `livePreview.enabled`
(`LIVE_PREVIEW_ENABLED`) in `settings.defaults.js` and `server-ce/config/settings.js`.

### 4.1 Routes

| Route | Access | Notes |
|---|---|---|
| `POST /project/:id/live-preview/ticket` | read access to the project | Returns a ticket valid for 60 s: HMAC of project id, user id, expiry, with `LIVE_PREVIEW_TICKET_SECRET`. 404 `live_preview_disabled` when the flag is off, 409 `compiler_not_lualatex`. |
| `GET /internal/project/:id/live-preview/snapshot` | private API, basic auth | The file list for materialisation: docs from document-updater, binary files as filestore blob URLs, root doc path. Reuses ClsiManager's resource building through a small exported helper. |

### 4.2 Frontend

Lives in the module except for three small upstream edits.

- `rootContextProviders`: `LivePreviewProvider` owns the socket, the paragraph state, the
  current layout and the toggle (`usePersistedState('live-preview:<projectId>')`). It
  runs in both the editor and the detached preview window. Each window opens its own
  socket, so detached mode needs no relay.
- Overlay renderer: one canvas per page inside `.page`, sized with pdf.js's
  `--scale-factor`, re-attached on `pagerendered` because pdf.js removes foreign
  children when it resets a page. Coordinates: display-list sp to bp
  (`sp / 65536 * 72 / 72.27`) from the page's top-left corner, then the page viewport.
  For each `paragraph` frame: paint the unit's previous rows (from the layout's
  placements) with the page background, then draw the new rows from glyph paths.
  Living inside `.page` means dark mode's inversion applies to the overlay too.
- Base pages: when a `layout` frame arrives, the PDF URL switches to the pass PDF and
  the overlay clears. pdf.js keeps the scroll position across documents already.
- Autocompile is turned off while live preview is on; the background pass replaces it.
  Recompile and download still use CLSI, so the downloaded PDF is the normal build.
- Status: engine state and convergence as a small badge in the preview toolbar;
  `background` reasons in a tooltip on the paragraph's gutter marker; rtex diagnostics
  merged into the logs pane.

Upstream edits, each a few lines:

| File | Change |
|---|---|
| `pdf-js-viewer.tsx` + `pdf-preview-provider.tsx` | Put the `PDFJSWrapper` instance and `initialised` into the preview context, so the module can reach the viewer. |
| `pdf-compile-button.tsx` | A **Live preview** item in the compile dropdown, shown when the meta flag is on and the compiler is `lualatex`. |
| `share-js-doc.ts` | Read the flush delay from a small store the module can set, instead of the two constants. |

Plus the usual flag plumbing (`ProjectController` locals, `_meta.pug`, `meta.ts`,
following `githubBackupEnabled`), the module paths in `overleafModuleImports`, and the
nginx location in `server-ce/nginx/overleaf.conf`.

## 5. Security

The engine runs LuaLaTeX as `www-data` without a sandbox, the same trust model as CE's
CLSI (`LocalCommandRunner`). We add what rtex allows: no shell escape, a session
directory outside the CLSI tree, `ulimit -v` per `rtex serve`, and rtex's own 5 s
compile timeout. Tickets are short-lived and bound to one project. The glyph and PDF
routes need a ticket too, so a project's fonts and pages are not readable by outsiders.

## 6. Milestones

| Stage | Deliverables | Status |
|---|---|---|
| **P0 rtex fork** | `Zack-Will/realtime-tex` with the four spike patches, the three patches in §2, CI building the binary; image stage in `server-ce/Dockerfile`; upstream PR for the acmart fixes | ⏳ |
| **P1 service** | `services/live-preview`: sessions, materialisation, applied-ops consumer with version checks, structure events, idle reaping, budget; WebSocket and HTTP routes; a test client that opens a session on the develop stack and prints frames | ⏳ |
| **P2 web module** | settings flag, ticket and snapshot routes, meta flag, nginx location, runit script | ⏳ |
| **P3 overlay** | viewer exposure, provider, overlay renderer with glyph paths, base pages from the pass PDF, flush-delay hook | ⏳ |
| **P4 editor integration** | toggle, autocompile handling, detached window, status badge, diagnostics in logs, background reasons | ⏳ |
| **P5 hardening and docs** | memory budget under load, crash handling, CJK check with the thesis template, `doc/live-preview.md`, `changes-from-ce.md`, `deploy-toolkit.md`, CHANGELOG | ⏳ |

Each stage ends with a live check on the develop stack. P1 and P3 also re-run Cleave
and CrossMem and compare against the spike numbers (Cleave: 12 of 14 edit targets live,
median 4.6 ms; CrossMem after its LuaLaTeX migration: 8 of 10).

## 7. Risks

| Risk | Mitigation |
|---|---|
| rtex is 0.0.x and one person's project; its API and display-list format may change | Pin a commit; keep rtex behind the service's own protocol (§3.3) so the browser never sees rtex's format directly except the display list, whose revision is checked. |
| 1.2-1.5 GB per session on a host with about 4 GB free | Session budget, idle reaping, LRU eviction; only `lualatex` projects with the preview open get a session. |
| Templates rtex refuses (run-in headings, `\maketitle`, buffered abstracts) | Those units fall back to the background pass and say why. Fixes go to the fork and upstream, as with acmart. |
| The 150 ms flush delay raises op traffic | Overleaf already uses 500 ms with collaborators; document-updater and project-history compress ops. Measure in P3; raise to 300 ms if needed. |
| Lost pub/sub messages leave the engine with stale text | Version check per op, `fromVersion` replay, periodic drift check (§3.2). |
| Pass PDF and overlay disagree for a moment after a layout | The overlay clears on every layout and results are ordered by rtex's revision counters. |
| ACM's camera-ready pipeline compiles the source itself | Accepted by the user: papers move to LuaLaTeX and follow its layout. |

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
