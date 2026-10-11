# Live-preview P2 verification (2026-10-11)

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
