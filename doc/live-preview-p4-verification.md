# P4 editor integration: browser handoff

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
