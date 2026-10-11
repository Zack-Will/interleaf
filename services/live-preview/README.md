# Live preview service (P1/P2)

Run `node services/live-preview/app.js` from the repository after `corepack yarn
install` at the root. The service listens on `127.0.0.1:3060`. It is registered in
the root workspace list and CE service list so the image's production workspace
install includes its runtime dependencies. P2 wires the gated web module, nginx,
runit and pinned rtex image layer.

The service requires `LIVE_PREVIEW_TICKET_SECRET`, a working `rtex` and LuaLaTeX.
Set `RTEX_TEXDIR` to rtex's support directory, and put TeX Live binaries on `PATH`
(or use `RTEX_TEXLIVE_BIN` for rtex; `kpsewhich` must also be on `PATH`). The service
uses `prlimit --as` to impose an inherited per-process virtual memory limit,
equivalent to `ulimit -v`, without a shell. Default: 2048 MiB. This is a virtual
address space limit for each process, not a combined RSS limit for its process
tree. The session budget limits concurrent project engines; it defaults to two.
LuaLaTeX runs under the service account, without shell escape, with rtex's own
compile timeout. Configure `LIVE_PREVIEW_FONT_ROOTS` for your TeX installation.

Configuration is in `config/settings.defaults.mjs`. In addition to the settings
above: `LIVE_PREVIEW_RTEX_BINARY`, `LIVE_PREVIEW_DATA_DIR`,
`LIVE_PREVIEW_MAX_SESSIONS`, `LIVE_PREVIEW_MEMORY_MB`,
`LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS` (3000), `LIVE_PREVIEW_IDLE_MS` (300000),
`LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS` (30000),
`LIVE_PREVIEW_ACCESS_TTL_MS` (900000),
`LIVE_PREVIEW_HOST`, `LIVE_PREVIEW_PORT`, `LIVE_PREVIEW_WEB_URL`,
`LIVE_PREVIEW_WEB_USER`, `LIVE_PREVIEW_WEB_PASSWORD`,
`LIVE_PREVIEW_DOCUMENT_UPDATER_URL` and `LIVE_PREVIEW_REDIS_HOST/PORT/PASSWORD`.
Redis must point to the **pubsub** Redis, not document-updater's data Redis.
Never point acceptance tests at production Redis.

## P2 snapshot and tickets

`GET /internal/project/:projectId/live-preview/snapshot` uses private API Basic
auth. Its JSON contract is [docs/snapshot.schema.json](docs/snapshot.schema.json).
The web module implements this route; isolated P1 tests use a fake server. Paths are
relative POSIX paths, unique across documents and binary files. `build/` is
reserved for rtex; `.live-preview-pdfs/` is reserved for retained PDFs. Snapshots contain authoritative document text and versions,
including unsaved edits in document-updater. Blob URLs must change when their
content changes. Structure notifications are native web `editor-events` payloads;
the service refetches the snapshot to get complete folder paths. Rename, move,
delete and root changes restart the engine. Binary changes request a layout.

Tickets are `base64url(JSON).base64url(HMAC-SHA256)` without padding. JSON claims
are `{ "project": "24-hex-id", "user": "user-id", "kind": "open", "expiry": 1234567890000 }`.
Expiry is Unix milliseconds, at most 60 seconds in the future. The HMAC input is
the **encoded payload string**, signed with `LIVE_PREVIEW_TICKET_SECRET`.
`@overleaf/live-preview-protocol/Tickets.mjs` exports the shared issuer and verifier
helpers. The library's separate `Frames.mjs` and `DisplayList.mjs` entries work in Node
and browsers without importing Node crypto. Web mints
`kind: 'open'`; WS upgrades accept only that kind or legacy tickets without `kind`.
Existing sockets continue after opening-ticket expiry.
Authenticated viewers use their user id; anonymous link viewers who pass the
same read-authorization middleware use a hashed session identity. Raw session
ids never appear in tickets or access tokens.

After an authorized handshake, `hello` includes `access` and `access_expiry` (Unix
milliseconds). The access token uses the same HMAC format and secret, with project,
user, `kind: 'access'` and expiry claims. Its lifetime is 15 minutes by default
(`LIVE_PREVIEW_ACCESS_TTL_MS`). While the socket is open, the service sends a new
`access` frame at 80% of that lifetime, before expiry. Resync also sends fresh
credentials in `hello`. Clients retain the latest access token for HTTP requests;
renewal requires no web request. Access tokens cannot open a WebSocket, and opening
tickets cannot fetch PDFs or glyphs. Closing the socket stops renewal.

## Wire protocol

While a session is active, the service publishes `livePreview.active` on native
`editor-events` at startup and every `LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS`
(default 30000). Its event argument is `{ leaseMs: 75000 }` (the Redis envelope
contains `payload: [{ leaseMs: 75000 }]`). Every editor, including editors joining
later without a preview, lowers its flush delay until `leaseMs` after the last
`active`. Each refresh renews that lease. Expiry or `livePreview.inactive` restores
the default immediately; reconnecting clears the lease until a fresh `active`.
Refreshes stop when the session stops or its engine fails.

Connect to `/live-preview/ws?project=<id>&ticket=<ticket>`.
Every server message is a binary WebSocket message:

```
offset  bytes  meaning
0       1      type: hello=1, paragraph=2, layout=3, background=4,
               diagnostics=5, engine=6, busy=7, access=8
1       4      unsigned JSON header byte length, little-endian
5       N      UTF-8 JSON header, no terminator
5+N     rest   optional rtex display list (RTDL, revision 1)
```

Only paragraph frames have a body. Header fields follow design §3.3 and retain
rtex's `versions` and `edit_id`. Paragraphs also carry `user_id` (null for initial
or unattributed results) and `fonts`, mapping rtex font ids to
`{font_key, ids: 'glyph_index'|'char_code'}`. Layouts also carry `fonts` from changed
pages, a service-monotonic `layout_version` and `pdf_url` without a ticket query.
Append `?ticket=<access>` using the latest access token to fetch that URL.
Each layout placement also includes `row_rects`, an array of
`{page, x, y, w, h}` in page-origin sp (top-left, y down). These rectangles cover
the unit's rows in the pass PDF, including rows attributed to the same capture
unit. They are derived from page display lists, retained for unchanged pages and
included on resync. They let clients erase the base text before painting live rows;
fragment baselines alone do not contain widths or heights. An empty array means
there is no matching base geometry, so the client waits for a subsequent pass.
`hello` and `access` headers carry `{ access, access_expiry }`; access frames have
no body and are specific to each viewer's project and user.
Display-list font records and TeX positions
are unchanged. Size-independent font keys are server-derived SHA-256 hashes.
Clients cannot register fonts or request filenames. Glyph paths are SVG compact
path data in font units, **y up**, with `advance` and `unitsPerEm`. Type 1 requests
use character codes and honor pdftex.map encoding when needed. Outlines are cached
and responses use `Cache-Control: private, max-age=31536000, immutable`.

Client messages are text JSON, exclusively `{"cmd":"ping"}` or
`{"cmd":"resync"}`. Ping gets a WS pong. Resync sends hello, the last layout and
paragraph overlays newer than it; resync is rate limited to once per second.
This includes removal frames until a pass incorporates the removal. Error frames
are broadcast as notifications while resync retains the last good drawing.
Background and error-paragraph headers include `path`, `doc_id` and
`range: {start, end}` when the unit still exists. The range is half-open, in UTF-16
code units of the document, converted from rtex's per-file UTF-8 spans. Background
headers also include `versions.source_revision`, so an older layout cannot clear
a newer notice. A boundary-change event without a unit id has no source range.
Resync sends pending background/error notices after the last good drawings, plus
the latest diagnostics per rtex source. Diagnostic filenames inside the project
are relative paths, suitable for the editor's normal file/line navigation.
Text, edits and extra fields close the socket with 1008. Slow consumers exceeding
8 MiB of buffered output close with 1013. The dev client prints decoded frames:

```
node services/live-preview/bin/test-client.mjs 'ws://127.0.0.1:3060/live-preview/ws?project=...&ticket=...'
```

`GET /live-preview/pdf/:projectId/:layoutVersion?ticket=` returns one of the last
three layout PDFs. `GET /live-preview/glyphs/:fontKey?ids=1,2&ticket=` returns
`{font_key, unitsPerEm, glyphs: {"1": {path, advance}}}`. The `ticket` query parameter
on both routes accepts only project-bound access tokens, checked on every request.
`GET /live-preview/health` reports process readiness and session count.

## P3 browser frontend

The frontend is in `services/web/modules/live-preview/frontend/js`. Enable
`LIVE_PREVIEW_ENABLED=true` and use the same `LIVE_PREVIEW_TICKET_SECRET` in web
and the preview service. Select LuaLaTeX in the project settings, then select
**Live preview** in the Recompile dropdown. The preference is stored per project
and shared with detached windows. Every preview window fetches its own opening
ticket with CSRF and connects independently; the native detach channel supplies
only compiler eligibility to the detached window, which does not join the editor
socket. Keep real-time running for normal editor edits and lease notifications.

Layouts load the pass PDF in the existing pdf.js viewer and reset overlays.
The first live layout opens the PDF view even when a failed CLSI compile left
the pane on logs. The logs button still opens normal compile diagnostics; that
choice persists across live layouts in each window. Disabling live preview
restores the normal compile view.
The status badge reports Converged, Updating…, Stale or Pass limit reached from
the convergence object, and includes the compile error count for passes that
compiled with errors.
Paragraphs erase the previous/base row rectangles and draw glyph paths, rules
and colour stacks. Images, unsupported records, flags, literals and transformed
content wait for a pass PDF. Errors preserve the previous live drawing; removal
erases it. A remote edit briefly receives an outline in its author's cursor colour.
Zoom/DPR/rotation use the page viewport, and canvases reattach on `pagerendered`.
Autocompile is suspended while live mode is usable; busy/failed sessions restore
normal autocompile. Recompile, keyboard shortcuts and downloads continue to use
CLSI. The scroll restore remains the native `pdf-js-viewer` position/scale logic.

Browser acceptance is deferred to the orchestrator. Use a develop project, two
editor clients and a detached preview. Confirm private PDF/glyph requests use
`ticket=<access>`, overlays survive zoom and page resets, scroll remains steady
across layouts, remote keystroke-to-paint P95 is under 300 ms, and layouts arrive
within 4 s of continuous typing. Also check a collaborator with live preview off:
its ShareJS flush delay should be 150 ms until inactive, disconnect or lease expiry.
Confirm CLSI Recompile/download, toggle-off restoration, busy fallback, access
renewal, and reconnection/resync. These browser checks have not run on this host.

Focused frontend checks, from `services/web` (one process at a time):

```
../../node_modules/.bin/mocha --require test/frontend/bootstrap.js 'modules/live-preview/test/frontend/js/*.test.{mjs,tsx}'
node --max-old-space-size=1400 modules/live-preview/test/check-types.mjs
ESLINT_FAST=1 ../../node_modules/.bin/eslint --max-warnings 0 modules/live-preview
../../node_modules/.bin/prettier --check modules/live-preview
```

The TypeScript script uses the repository compiler options and resolves imports,
but reports diagnostics only for the touched TS/TSX source and component tests.
It does not check the entire monorepo. `ESLINT_FAST=1` skips the backend lint
configuration's full-program type-aware pass on memory-constrained hosts.

## Verification

Run from the service directory using root-installed executables:

```
../../node_modules/.bin/vitest run --config vitest.config.mjs --no-file-parallelism
../../node_modules/.bin/eslint --max-warnings 0 .
../../node_modules/.bin/prettier --config ../web/.prettierrc --check .
node test/acceptance/live-preview.mjs
```

Acceptance starts and stops its own uniquely named Redis 7.4 container on a free
loopback port and fake web/document-updater servers. It needs Docker and the real
rtex fork: set `RTEX_TEST_ROOT` (default
`/home/zack/overleaf-workspace/rtex-spike/realtime-tex`), source its
`build/texlive.env` first, and set `RTEX_TEXDIR`. It tests one rtex session at a time.
The collaboration result measures **op publish to WS paragraph**, excluding client
flush and paint (P3). It asserts P95 <300 ms and layout intervals ≤4 seconds under
continuous interleaved edits from two simulated editors, with two preview sockets.
To use the pinned release, set `LIVE_PREVIEW_RTEX_BINARY` to
`develop/.live-preview-rtex/bin/rtex` and `RTEX_TEXDIR` to its
`share/rtex/tex` directory (absolute paths). The same fork TeX Live environment
supplies LuaLaTeX and the font roots. Acceptance also checks a real background
notification with CJK/emoji source offsets.

## P4 editor integration

The module uses the existing `sourceEditorExtensions` and
`pdfLogEntriesComponents` slots. Background reasons and TeX paragraph errors
appear as gutter dots on each affected source line of the open document. Tooltips
show the reasons/error messages. CodeMirror maps existing ranges through edits;
a live update clears its unit, and a layout clears only incorporated units whose
notice is no newer than the layout. Paragraph errors keep the previous drawing.
Live diagnostics form a separately labelled group in the existing logs pane,
alongside CLSI entries. They use native file/line navigation and disappear when
live mode is off. The native tab counts continue to count CLSI entries; the live
group is shown in each logs tab. A clean background pass clears old diagnostics;
fresh warnings remain visible.

Busy and failed sessions explain that normal compilation still works. Failure
has a Retry button that obtains a new opening ticket and reopens this window's
socket. The PDF-pane notice is dismissible; Retry remains in the status badge.
Changing away from LuaLaTeX turns off the persisted live preference and shows a
notice. Changing back exposes the dropdown item but requires enabling live mode
again. New UI strings use the same i18next English locale as github-backup.

Both roots keep independent preview sockets, PDFs, overlays, badges and access
credentials. The detached root receives compiler metadata through the native
detach channel. The editor provider remains mounted when its PDF is detached,
and still consumes the project's active lease to lower the ShareJS flush delay.
Unmounting either root closes only its own socket and leaves the preference
enabled. Remote registered users use the collaborator cursor colour helper;
`anonymous:<hash>` and `anonymous-user` use a neutral grey outline.

Browser checks for the orchestrator are in
[`doc/live-preview-p4-verification.md`](../../doc/live-preview-p4-verification.md).

Type 1 support is ported from Henry Yang's MIT-licensed
`realtime-tex-vsc-plugin/src/type1.ts`; [LICENSE.type1](LICENSE.type1) preserves
the license. The port adds advance metrics and bounds recursive composite glyphs.
OpenType/TrueType parsing uses [fontkit](https://github.com/foliojs/fontkit).

## Develop stack verification (P2)

See `doc/design/dev-environment.md` for the host override (Redis 6380, Mongo 8.2).
Run `develop/bin/setup-live-preview` after the root yarn install. It verifies the
pinned rtex archive and prepares a read-only mount. The dev preview container
reuses `ghcr.io/zack-will/interleaf:6.2.4` for LuaLaTeX and runs the mounted source
as `www-data`, with one session maximum. The normal webpack proxy forwards
`/live-preview/` and WebSocket upgrades. An optional `docker-compose.live-preview.yml`
overlay and `live-preview-proxy` gateway serve protocol acceptance on loopback
8088 using the local image's existing asset manifest, without compiling webpack.
Use this overlay for the fs-backed develop stack: it gives history-v1 and
filestore a dedicated `live-preview-history-buckets` volume with CE's nested
blob keys. The original develop history bucket uses flat keys and is preserved.
The acceptance projects' history stays in the dedicated volume.

Start the required services individually with `up -d --no-deps`; do not run a
parallel build. The required services are mongo, redis, docstore, document-updater,
filestore, history-v1, project-history, chat, web, live-preview and live-preview-proxy.
CLSI and real-time are unnecessary for the MCP-driven protocol check. Always
stop the develop containers you started afterwards.

The live check uses real session/CSRF login, creates a project, selects LuaLaTeX,
creates a PAT, writes through MCP, validates the private snapshot, starts
`bin/test-client.mjs`, edits through MCP and verifies paragraph/layout frames,
`livePreview.active`, access-token PDF/glyph fetches and rejection of opening
tickets on HTTP. The PAT is revoked on exit. Create a dev admin with the normal
`modules/server-ce-scripts/scripts/create-user.mjs --admin --email=...` script
if you do not have working credentials. Its activation link can be used by the
test config on the first run. Never use production credentials or Redis.

Put `{ "email": "...", "password": "...", "activationUrl": "..." }` in a
private untracked JSON file (`activationUrl` is optional after activation), then
run from the repository root:

```
LIVE_PREVIEW_TEST_CONFIG=/tmp/dev-preview-credentials.json \
  node services/live-preview/test/acceptance/web-wiring.mjs
```

The script fixes its HTTP target to loopback 8088 and Redis to loopback 6380.
It leaves the test project in the develop database and never prints credentials.
