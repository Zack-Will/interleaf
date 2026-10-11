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
`app/src/Tickets.mjs` exports the issuer helper for P2 and tests. Web mints
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
