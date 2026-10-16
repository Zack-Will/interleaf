# Live-preview release and historical verification

P5 is the release-readiness pass on `feat/live-preview-hardening`, based on
`feat/live-preview-editor`. The orchestrator completed P1-P4 browser acceptance
before this pass. P5 uses host tests and throwaway containers only: no develop
stack, browser, webpack or production toolkit access. Release code is Interleaf
0.2.0, image tag 6.2.5, with rtex release `interleaf-0.0.3-2`.

## P5 commands and environment

Run service and protocol `corepack yarn test:unit` from their respective workspace
directories. Run web `corepack yarn test:unit --run modules/live-preview/test/unit/src`
from `services/web`. Frontend and bounded TypeScript commands:

```sh
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/helpers/**/*' modules/live-preview/test/frontend/js
node --max-old-space-size=1400 modules/live-preview/test/check-types.mjs
```

The original protocol acceptance sources the spike's minimal TeX Live environment,
uses `develop/.live-preview-rtex/bin/rtex` and matching support, and starts/stops
its own uniquely named Redis. Full-TeX hardening uses the service README's
read-only image command, two CPUs, 3 GiB container memory and `www-data`. Cleave
and CrossMem are copied from the spike projects into `/tmp`; only the CrossMem
copy removes T1 `fontenc` and `newtxtext,newtxmath` from the figures preamble.
Real-paper measurements wait for bibliography/layout convergence, then apply
ten alternating paragraph insertions/deletions and confirm incorporated source
revisions in clean complete pages. Chinese acceptance uses the committed
four-page thesis-like fixture (chapters, abstract, figure/table captions and refs).

P5 tests the actual LuaLaTeX child environment and inherited address-space limit,
not just the rtex spawn arguments: pinned rtex otherwise overwrites
`openout_any=a`. The trusted wrapper reasserts paranoid settings and disabled
shell escape at exec. Full TeX Live 2025 requires its installed tree to be allowed
for luaotfload's absolute data reads; that tree remains read-only to `www-data`.
kpathsea's filename checks follow its
[documented paranoid-path rules](https://tug.org/texinfohtml/kpathsea.html).
This provides TeX filename controls, not an operating-system sandbox.

## P5 results

```text
Service: Test Files  9 passed (9)
              Tests  95 passed (95)
Protocol: Test Files  1 passed (1)
               Tests  16 passed (16)
Web: Test Files  2 passed (2)
          Tests  16 passed (16)
Frontend: 43 passing (3s)
Touched-file TypeScript: 9 files, 0 diagnostics
```

The TypeScript heap limit is 1400 MiB. ESLint runs with `--max-warnings 0` on every
touched service JS/MJS source/test/config and `ESLINT_FAST=1` on touched web MJS.
Prettier uses `services/web/.prettierrc` and only touched, supported files. The TeX
fixture is validated by real compilation; the shell wrapper passes `sh -n`.

```text
Service ESLint: exit 0, no output
Web ESLint (ESLINT_FAST=1): exit 0, no output
Checking formatting...
All matched files use Prettier code style!
```

The final original protocol/collaboration acceptance transcript:

```text
PASS real rtex startup, LuaLaTeX layout and native active notice
service error: invalid_ticket Ticket is invalid or expired
PASS real Type 1 math glyph paths and advance metrics
service error: font_not_found Font not registered for this project
service error: invalid_ticket Ticket is invalid or expired
service error: invalid_ticket Ticket is invalid or expired
PASS PDF and glyphs using hello access token, project binding and opening-ticket rejection
PASS applied-ops paragraph binary frame and user attribution
PASS missing/out-of-order op recovery through document-updater GET
COLLABORATION samples=100/100 median=3.26ms P95=6.44ms layouts=17 max-layout-gap=2497.51ms duration=12159ms
PASS two-editor convergence, ordered fan-out, P95 latency and layout max-wait
PASS real background reasons and CJK/emoji UTF-16 source range
PASS native new-doc/file, rename, move, remove, root and compiler events
Acceptance: 8 passed (real rtex + isolated Redis + fake HTTP; collaboration and source ranges included)
CLEANUP stopped live-preview-test-271c0a15-77cc-498b-b829-50a9fd863335
```

The final full-TeX release transcript (temporary absolute directories omitted
from the resource table below; raw measurements use KiB):

```text
PASS ordinary project input and disabled immediate write18 (shell status 0; no sentinel)
PASS input /etc/passwd refused by kpathsea openin_any=p in a live session
PASS absolute output outside the session refused with openout_any=p
CHINESE pages=4 unique-glyphs=55 payload-bytes=82390 full-font-bytes=4947904 font=FandolSong-Regular.otf
PASS ctexbook thesis live paragraph, Fandol OTF glyph HTTP and directory cleanup
LOAD cleave edits=10 live-results=10 background-notices=0 pages=13
PASS real cleave session under prlimit --as and cleanup
LOAD crossmem edits=10 live-results=0 background-notices=10 pages=13
PASS real crossmem session under prlimit --as and cleanup
PASS real child kill: one restart, second crash Failed without crash loop
PASS service replacement, fresh socket/ticket, rebuilt session and stale startup cleanup
PASS maxSessions=2 third project busy, viewerless LRU eviction and idle reaping
PASS unavailable web snapshot and document-updater: clear error frames, no engine restart loop
PASS SIGKILL Node service, disconnected client, engine EOF exit, stale cleanup and rebuilt session
Hardening acceptance: 11 passed (real rtex, full TeX Live; sequential)
CLEANUP stopped service and removed all session/build directories
```

`node test/acceptance/proxy-origin.mjs` validates each actual WebSocket location
using a sequential throwaway nginx container and an isolated fake preview backend.
It forwards a nonstandard public port and checks a foreign origin is still refused:

```text
PASS nginx ../../../../server-ce/nginx/overleaf.conf: port-preserving same-origin WS and cross-origin 403
PASS nginx ../../../../develop/live-preview-nginx.conf: port-preserving same-origin WS and cross-origin 403
Proxy acceptance: 2 passed (real nginx; no production/develop services)
```

| Workload                    | RSS peak KiB | RSS end KiB | Virtual peak per process KiB | Session disk KiB | Build disk KiB |
| --------------------------- | -----------: | ----------: | ---------------------------: | ---------------: | -------------: |
| Cleave, 13 pages            |    1,779,084 |     672,308 |                      645,800 |           73,272 |         56,512 |
| Migrated CrossMem, 13 pages |    1,723,416 |     700,292 |                      650,728 |           74,416 |         57,136 |
| Chinese ctexbook, 4 pages   |    1,264,364 |     670,404 |                      452,196 |           60,176 |         45,200 |

RSS sums the rtex process group at 100 ms intervals, so shared memory can be
counted twice; Node is excluded. End samples are 15 seconds after an incorporated
paper layout and five seconds after the Chinese edit. The inherited cap is
**2048 MiB per process**, verified in `/proc` for actual LuaLaTeX children. These
workloads succeed without disabling that cap or increasing it for virtual
reservations. Recommend **2 GiB RAM/project**, at most two sessions where 4 GiB
plus existing-services/OS headroom is available; choose one on smaller hosts.

CJK payload is 1.67% of the full font for the chosen paragraph. Both papers start
with 11 provisional pages and converge to 13. The selected CrossMem paragraph
uses background updates despite convergence; all ten revisions reach clean
complete pages. This retains rtex's conservative eligibility and does not claim
universal real-time paragraph coverage. No new browser latency claim is made.

## Security findings and regression coverage

| Finding                                                                    | Fix                                                                                                                            | Test                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Linked source/parent/session paths could escape materialization            | Inspect every existing path component; exclusive temporary write and atomic replacement                                        | Materializer file/parent/root symlink cases; traversal cases; hard-link retention regression                  |
| Snapshot count, JSON and binary downloads were unbounded                   | 2,000 entities; 32 MiB/file; 256 MiB/project; 64 MiB JSON; bounded streams, no redirects; web-side early limits                | Materializer count/UTF-8/binary/aggregate cases; streamed response cases; web early entity/path/text cases    |
| rtex resets paranoid output configuration                                  | Trusted final-exec wrapper enforces input/output `p` and no shell escape; session-local support/cache                          | RtexProcess argv/env tests; real child environment/AS inspection; passwd/input/output/write18 acceptance      |
| Uploaded fonts could resolve into another project's directory              | Restrict resolved fonts to the token's project or installed roots, including cached fonts                                      | FontRegistry forged cross-project font case; HTTP access binding negatives                                    |
| A retained PDF could be replaced with a symlink                            | Check PDF source, retention directory and file, then check again at HTTP serve                                                 | SessionManager linked PDF cases; Server retained symlink test                                                 |
| Reused layout versions/font paths could serve stale or unauthorized caches | Private no-store on PDF/glyph responses and no-store on errors                                                                 | Server cache-header cases; real PDF/glyph acceptance                                                          |
| Socket counts, browser origins and dead viewers were unbounded             | Project/user admission limits, Origin/Host/allowlist validation, ping/pong reaping; retain 4 KiB input and 8 MiB output bounds | Server same/cross-origin, project/user slot release, oversize and no-pong cases; SessionManager slow consumer |
| Source failures only logged and initial failures retried indefinitely      | Clear Failed/busy frame, stop failed engine/lease, require explicit retry                                                      | OpsConsumer source/drift cases, SessionManager failure/retry, frontend terminal busy, real source outages     |
| Previous service session directories survived crashes                      | Startup cleans owned project-id directories; stop/LRU/idle cleanup                                                             | Materializer stale cleanup; unit budget/idle tests; real Node SIGKILL, rebuild and directory assertions       |

No production container or toolkit was entered, stopped, restarted or modified.
All throwaway Redis/TeX containers and session/build directories were removed.

The required final read-only container-status query:

```sh
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'sharelatex|mongo|redis|git-bridge'
```

```text
git-bridge Up 11 hours
sharelatex Up 3 days
redis Up 3 days
mongo Up 3 days (healthy)
sub2api-redis Up 3 days (healthy)
```

The requested filter also matches `sub2api-redis`; this task did not interact with it.

The proxy regression fixes `$host` dropping the public port: live-preview
WebSocket locations now forward `$http_host`. Actual nginx acceptance covers
both the port-preserving upgrade and cross-origin 403. This is P5's only changed
upstream directive and is justified in its focused commit message.

The historical records below preserve their original dates/outputs. P4's browser
handoff checklist was written before the orchestrator's subsequent acceptance;
its pending language describes that historical handoff.

## P2 historical verification (2026-10-11)

Branch: `feat/live-preview-wiring`, based on `feat/live-preview-service`.
The live run used only the dedicated develop stack, Redis on loopback 6380,
Mongo 8.2, one preview session, and the local CE 6.2.4 image's TeX Live 2025.
No webpack or CLSI build was needed. A new dev admin was created through the
server's `create-user.mjs` script and activated through the password-set route.
The test uses real login cookies, CSRF, a temporary PAT and the actual
`bin/test-client.mjs`. The PAT was revoked after verification.

## Unit checks

```
Web module: Test Files  2 passed (2)
                 Tests  14 passed (14)
P1 service: Test Files  8 passed (8)
                 Tests  68 passed (68)
```

Both suites used `--no-file-parallelism`. The web cases cover the enabled gate,
read/private-auth boundaries, hashed anonymous viewer identity, compiler conflict, the shared HMAC issuer with a
fixed vector, ticket expiry/project/secret binding, authoritative document text
and versions, nested root paths, binary hashes and missing projects/blobs.

## Pinned image layer

A throwaway Dockerfile started from the already-local
`ghcr.io/zack-will/interleaf:6.2.4` and copied the exact rtex install snippet from
`server-ce/Dockerfile`. The archive checksum was verified during the build.
Running `rtex doctor` as `www-data` reported:

```
rtex 0.0.3
support files: /usr/local/share/rtex/tex
lualatex: /usr/local/bin/lualatex (This is LuaHBTeX, Version 1.22.0 (TeX Live 2025))
```

Only the local tag `interleaf-p2-rtex-test:local` was built. No real image was
retagged or pushed. The throwaway image was removed after verification.

## Live transcript

Credential fields are omitted by the acceptance logger. The successful run:

```
POST /login HTTP 200; session cookie established
created project 6acb5534b035db6751bc4808
ticket before LuaLaTeX HTTP 409 compiler_not_lualatex
MCP get_project HTTP 200 project_version=1
applied-ops doc=6acb5534b035db6751bc480d version=0
MCP write_files HTTP 200 project_version=3
private snapshot HTTP 200 root=main.tex docs=1 files=1 versions=1; unauthenticated HTTP 401
editor meta ol-livePreviewEnabled=true
session-authenticated ticket HTTP 200 kind=open
editor-events livePreview.active [{"leaseMs":75000}]
frame hello state=Starting layout=0 pages=0 par_id=- user_id=- body=0
frame engine state=Starting layout=- pages=- par_id=- user_id=- body=0
frame engine state=Ready layout=- pages=- par_id=- user_id=- body=0
frame layout state=- layout=1 pages=1 par_id=- user_id=- body=0
applied-ops doc=6acb5534b035db6751bc480d version=1
frame paragraph state=- layout=- pages=- par_id=2 user_id=6acb528823e08c7661b42737 body=1526
MCP edit_file HTTP 200 project_version=4
frame layout state=- layout=2 pages=1 par_id=- user_id=- body=0
registered font modes=glyph_index,char_code,char_code,glyph_index,glyph_index,char_code,char_code
PDF HTTP 200; glyph HTTP 200; glyph path chars=170
PDF without access HTTP 401; PDF with opening ticket HTTP 401
PASS live web → ticket → snapshot → rtex → frames; real MCP edit; frames=6
test PAT revoked HTTP 204
```

The service fetched `assets/probe.bin` through the internal filestore blob URL;
the materialized file contained `00 01 02 03 ff`. Engine and LuaLaTeX processes
ran as `www-data`. Fonts can be advertised in paragraph frames as well as layouts;
the client keeps mappings from all received frames.

The develop overlay uses a separate history bucket with CE's nested blob keys,
preserving the original develop bucket's flat layout. All eleven develop
containers started for this check were stopped afterwards. Production
`sharelatex`, `mongo`, `redis` and `git-bridge` were left running untouched.

This verifies P2's server/protocol path. Browser overlay painting, flush-delay
changes and two-user keystroke-to-paint latency are P3 work.

## P4 historical editor integration: browser handoff

Implementation branch: `feat/live-preview-editor`, based on the browser-tested
`feat/live-preview-frontend`. Automated verification uses host processes and a
uniquely named throwaway Redis container. No develop services, webpack, browser
or production containers were started or changed for this milestone.

## Orchestrator browser checks

- In a LuaLaTeX project, trigger a background-only edit in an included `.tex`
  file. Confirm gutter dots appear on all affected lines, the tooltip explains
  the reasons, and switching files shows only that document's dots. Include CJK
  and emoji before the unit. Edit before a marked unit and confirm its marker
  follows the source. Confirm a subsequent live update or containing layout
  clears it; a layout older than the edit must retain it.
- Introduce a TeX paragraph error. The previous PDF drawing should remain and
  the source gutter should show the TeX message. Open logs and confirm the
  separately labelled live error/warning entries coexist with CLSI logs. Use
  their Go to code location button to jump to the included file and line.
  Correct the error and confirm stale diagnostics clear on a clean pass.
- Edit remotely as a registered collaborator and as an anonymous link viewer.
  Confirm registered outlines match cursor colours and anonymous outlines are
  neutral grey. Retain P3's remote paint P95 <300 ms and layout gap ≤4 s checks.
- Open `ide-react-detached`. Confirm its live PDF, overlay and status badge
  update, and the editor still flushes at 150 ms while the project lease is
  active. Close the detached window and continue editing; then repeat while
  closing the editor and leaving the detached window open. The surviving socket
  must remain connected and its HTTP access token must continue to renew.
- Fill the develop session budget and open another project. Confirm the busy
  badge/notice says live preview is unavailable right now and normal compilation
  still works. Verify CLSI Recompile/download and autocompile fallback.
- Fail the develop preview engine twice. Confirm the Failed message and Retry
  action. Dismiss the notice and confirm Retry is still available in the badge.
  Retry should fetch a new ticket and reopen the socket, then restore live PDF
  and overlays on recovery.
- Change the compiler away from LuaLaTeX with live mode on, including with a
  detached preview open. Confirm the dropdown item disappears, both sockets
  close, autocompile returns and the dismissible compiler-change notice appears.
  Switch back to LuaLaTeX: the item returns and live mode remains off until
  enabled again. Confirm notices and tooltip text are readable in dark mode.

The live diagnostics group uses the existing logs slot, so it appears in every
logs tab; native tab counters continue to count CLSI entries. Background boundary
changes without a rtex unit id have no source marker. Browser E2E scripts in
`rtex-spike/e2e` remain reference material for the orchestrator and were not run.

## Automated verification output

Frontend command, from `services/web`:

```sh
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/helpers/**/*' modules/live-preview/test/frontend/js
```

```text
41 passing (2s)
```

Service unit tests (`corepack yarn test:unit` from `services/live-preview`):

```text
Test Files  9 passed (9)
     Tests  76 passed (76)
```

Protocol tests (`corepack yarn test:unit` from
`libraries/live-preview-protocol`):

```text
Test Files  1 passed (1)
     Tests  16 passed (16)
```

Web unit tests (`corepack yarn test:unit --run modules/live-preview/test/unit/src`
from `services/web`):

```text
Test Files  2 passed (2)
     Tests  14 passed (14)
```

Acceptance command, from `services/live-preview`:

```sh
source /home/zack/overleaf-workspace/rtex-spike/realtime-tex/build/texlive.env
LIVE_PREVIEW_RTEX_BINARY=/home/zack/overleaf-workspace/overleaf/develop/.live-preview-rtex/bin/rtex RTEX_TEXDIR=/home/zack/overleaf-workspace/overleaf/develop/.live-preview-rtex/share/rtex/tex node test/acceptance/live-preview.mjs
```

```text
PASS real rtex startup, LuaLaTeX layout and native active notice
service error: invalid_ticket Ticket is invalid or expired
PASS real Type 1 math glyph paths and advance metrics
service error: font_not_found Font not registered for this project
service error: invalid_ticket Ticket is invalid or expired
service error: invalid_ticket Ticket is invalid or expired
PASS PDF and glyphs using hello access token, project binding and opening-ticket rejection
PASS applied-ops paragraph binary frame and user attribution
PASS missing/out-of-order op recovery through document-updater GET
COLLABORATION samples=100/100 median=3.26ms P95=5.76ms layouts=18 max-layout-gap=2548.26ms duration=12119ms
PASS two-editor convergence, ordered fan-out, P95 latency and layout max-wait
PASS real background reasons and CJK/emoji UTF-16 source range
PASS native new-doc/file, rename, move, remove, root and compiler events
Acceptance: 8 passed (real rtex + isolated Redis + fake HTTP; collaboration and source ranges included)
CLEANUP stopped live-preview-test-1d359ca7-950c-4379-8e78-793c6c9f7d8c
```

The authorization errors above are expected negative cases. The collaboration
numbers measure op publication to a WebSocket result, excluding browser flush and
paint. The P4 source-range case uses a run-in heading (`\paragraph`), which rtex
routes to the background. Preamble edits restart the engine and do not emit a
`BackgroundScheduled` event.

ESLint on changed service sources and tests, and
`ESLINT_FAST=1 ../../node_modules/.bin/eslint --max-warnings 0 modules/live-preview config/settings.defaults.js`
from `services/web`, both exited 0 without output. Prettier checks cover touched
service sources/tests, the module, settings, English locale and documentation:

```text
Checking formatting...
All matched files use Prettier code style!
```

The touched-file TypeScript command uses the real repository compiler options and
an old-space limit of 1400 MiB, below 1.5 GB:

```sh
node --max-old-space-size=1400 modules/live-preview/test/check-types.mjs
```

```text
Touched-file TypeScript: 9 files, 0 diagnostics
```

## 0.2.1 atomic PDF swaps (2026-10-16)

The module frontend suite, service unit suite, all web module unit suites and
touched-file TypeScript check passed. The final type check used
`node --max-old-space-size=1300 modules/live-preview/test/check-types.mjs`.
ESLint and Prettier checked touched files only. No service code changed, so no
service acceptance test was needed. Webpack reported compiled successfully.

```text
Module frontend: 54 passing (3s)
services/live-preview: Test Files 10 passed (10); Tests 100 passed (100)
All web modules: Test Files 29 passed (29); Tests 377 passed (377)
Touched-file TypeScript: 9 files, 0 diagnostics
```

The remaining white frame came from two module lifecycle races: capturing on
React layout delivery allowed an old-document pagerendered to release the copy;
reattaching it inside a new page on pagesinit exposed it to PDFPageView.reset
during scale restoration. PDFViewer.setDocument first dispatches pagesdestroy,
then cancels rendering and calls \_resetView, which clears the entire viewer.
The module now captures on that synchronous pagesdestroy boundary and keeps
copies outside .pdfViewer until a successful full render of the corresponding
new-document page, with a ten-second cleanup fallback.

Representable line-count changes wait for one second of quiet. pagination_stale
and approximate fragments alone no longer force a swap. Complete finite rows
must fit on existing PDF pages with captured base geometry; real PDF viewport
bounds also handle fast RTDL lists whose page dimensions are zero. Missing
geometry, overflow, degraded content and background-only edits remain urgent.

The original raw-canvas check is retained. Its white samples below are from the
new canvas underneath a freeze copy after the typing burst. Visible composite
samples include base pixels, live overlay and any freeze copy, and count missing
canvases as blank. The script also counts actual page-tree swaps independently
of prefetched PDF requests, checks freeze presence at each swap, checks geometry
through both DOM events and polling, and samples through the quiet-time swap.
All three consecutive final runs exited 0, with zero visible blank frames and
zero swaps during their 12-second bursts (10, 10 and 9 layouts respectively).

Each browser run used only the requested command, from rtex-spike/e2e:

```sh
systemd-run --user --scope -q -p MemoryMax=1500M env PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers timeout 400 node smoothness.mjs
```

Final run 1:

```text
MemoryCurrent=2717704192
4. dropdown first entries: ["Live preview","On","Offcheck","Auto compile"]
1. typed 184 chars in 12 s; samples 261; baseline ink 459; min ink 0; blank frames (<30% ink) 1; layouts during burst 11; pdf fetches total 14
   ink after 2.5 s quiet: 699
   blank at ms: [13080]
   layout frames at ms: [3389,4195,4810,5467,6234,6791,7514,8039,11303,11952,12471]
   pdf fetch start/end ms: [[3390,3405],[4197,4212],[4811,4822],[5468,5479],[6235,6249],[6792,6800],[7515,7524],[8040,8064],[11304,11313],[11953,11961],[12472,12480]]
   samples around blanks: [[12888,459],[12946,459],[13007,459],[13080,0],[13146,699],[13203,699],[13260,699],[13317,699]]
1b. visible composite: samples 261; baseline ink 459; min ink 156; blank frames (<30% ink, including missing canvas) 0; swaps during burst 0; layouts during burst 10
   composite blank at ms: []
   actual swaps at ms / held pages: [{"ms":13065,"held":1}]
   freeze pages after quiet: 0
   freeze alignment: 2 samples; max drift 0.61 px; outside viewer true
   frame types since burst: {"2":74,"3":11}
   overlay painted px: 0
   doc FAST para: FAST dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba
3a. gutter marker: Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them
3b. live log entries: ["Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them‪main.tex, 8‬my_locationdeleteClear cached files"]
```

Final run 2:

```text
MemoryCurrent=2615959552
4. dropdown first entries: ["Live preview","On","Offcheck","Auto compile"]
1. typed 185 chars in 12 s; samples 261; baseline ink 459; min ink 0; blank frames (<30% ink) 1; layouts during burst 11; pdf fetches total 13
   ink after 2.5 s quiet: 697
   blank at ms: [13189]
   layout frames at ms: [3482,4303,4838,5502,6050,6771,7284,8014,11256,11973,12479]
   pdf fetch start/end ms: [[3484,3493],[4304,4313],[4839,4849],[5503,5518],[6051,6061],[6773,6783],[7285,7292],[8015,8023],[11257,11264],[11974,11982],[12480,12489]]
   samples around blanks: [[12974,459],[13044,459],[13103,459],[13189,0],[13258,697],[13316,697],[13373,697],[13432,697]]
1b. visible composite: samples 261; baseline ink 459; min ink 155; blank frames (<30% ink, including missing canvas) 0; swaps during burst 0; layouts during burst 10
   composite blank at ms: []
   actual swaps at ms / held pages: [{"ms":13178,"held":1}]
   freeze pages after quiet: 0
   freeze alignment: 2 samples; max drift 0.61 px; outside viewer true
   frame types since burst: {"2":76,"3":11}
   overlay painted px: 0
   doc FAST para: FASTa dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba
3a. gutter marker: Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them
3b. live log entries: ["Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them‪main.tex, 8‬my_locationdeleteClear cached files"]
```

Final run 3:

```text
MemoryCurrent=2639237120
4. dropdown first entries: ["Live preview","On","Offcheck","Auto compile"]
1. typed 185 chars in 12 s; samples 257; baseline ink 459; min ink 0; blank frames (<30% ink) 1; layouts during burst 11; pdf fetches total 14
   ink after 2.5 s quiet: 697
   blank at ms: [13211]
   layout frames at ms: [3633,4410,4945,5587,6230,6801,7518,10752,11487,12030,12753]
   pdf fetch start/end ms: [[3636,3652],[4411,4417],[4946,4956],[5588,5599],[6231,6243],[6802,6810],[7519,7534],[10753,10762],[11488,11497],[12032,12043],[12754,12764]]
   samples around blanks: [[13004,459],[13082,459],[13140,459],[13211,0],[13311,697],[13383,697],[13448,697]]
1b. visible composite: samples 257; baseline ink 459; min ink 155; blank frames (<30% ink, including missing canvas) 0; swaps during burst 0; layouts during burst 9
   composite blank at ms: []
   actual swaps at ms / held pages: [{"ms":13193,"held":1}]
   freeze pages after quiet: 0
   freeze alignment: 2 samples; max drift 0.61 px; outside viewer true
   frame types since burst: {"2":76,"3":11}
   overlay painted px: 0
   doc FAST para: FASTa dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba dcba
3a. gutter marker: Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them
3b. live log entries: ["Live preview: Font [lmroman10-regular]:+tlig; has no glyphs for: 中文测试; the preamble may need a package such as ctex or fontspec with a font that covers them‪main.tex, 8‬my_locationdeleteClear cached files"]
```
