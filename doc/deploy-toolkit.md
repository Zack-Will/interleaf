# Deploying Interleaf with the Overleaf Toolkit

This runbook replaces a running Overleaf Community Edition instance managed by
the [Overleaf Toolkit](https://github.com/overleaf/toolkit) with the Interleaf image, keeping the existing projects, users and history.

The fork is Community Edition plus six web modules: `project-sync` (personal
access tokens and the write path), `mcp` (the agent endpoint), `git-bridge` (the
web half of the official Java git-bridge), `review` (comments and tracked
changes in CE), `github-backup` (one-way backup of a project to GitHub), and
`live-preview` (opt-in collaborative LuaLaTeX preview).
See `doc/agent-sync-usage.md`, `doc/github-backup.md` and `doc/live-preview.md`
for what they do. Interleaf 0.2.1 uses image tag **6.2.6** for both images.

## What is different from a stock toolkit install

| Item       | Stock                             | Here                                                                                          |
| ---------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| Image      | `sharelatex/sharelatex:<version>` | `ghcr.io/<owner>/interleaf:<version>`, built by `.github/workflows/build-image.yml`           |
| git-bridge | Server Pro only                   | Works on CE, but the toolkit refuses to start it unless one gate is patched                   |
| Image tag  | An Overleaf release               | Must still look like `X.Y.Z`: the toolkit validates it and derives the git-bridge tag from it |

The tag is therefore a deployment number, not an upstream version. This fork is
based on Community Edition 6.3.1 (upstream `e039ad26c5` plus the 6.3.1 hotfix
patches, see [upstream-sync.md](upstream-sync.md)).

## 1. Build the image

The image is built on `ghcr.io/<owner>/interleaf-base:<tag>`, which the
**Build Interleaf base image** workflow produces from upstream's
`server-ce/Dockerfile-base` plus the TeX Live collections
(`gh workflow run build-base.yml --ref <branch> -f tag=6.3.1`, or
`-f build_base=true` on the image workflow below, which also works from a
branch before `build-base.yml` is on the default branch). Upstream stopped
publishing its base image after 6.1.0, and 6.3 needs Node.js 24 and TeX Live
2026, so the base is built here. It only needs rebuilding when upstream changes
`Dockerfile-base` or TeX Live has a new release.

Then run the **Build Interleaf images** workflow (Actions tab, or
`gh workflow run build-image.yml --ref <branch> -f version=6.3.0`). It builds
`server-ce/Dockerfile` on that base and pushes two packages:

- `ghcr.io/<owner>/interleaf:<version>` — this fork
- `ghcr.io/<owner>/git-bridge:<version>` — the MIT-licensed Java bridge, built
  from `services/git-bridge` in this repository and tagged to match, because the
  toolkit derives the bridge tag from the same version string

Both packages must be **public**, or the NAS needs `docker login ghcr.io` with a
token that has `read:packages`.

## 2. Back up first

The switch runs database migrations that a downgrade will not undo, so take a
cold copy of the data while the stack is down.

```bash
cd ~/toolkit
bin/stop
cp config/version /tmp/overleaf-version-before
tar -czf ~/overleaf-backup-$(date +%Y%m%d).tar.gz -C ~/toolkit data config
```

The whole dataset on a small instance is a few hundred megabytes, so this takes
seconds. Keep the archive until the new stack has been exercised.

## 3. Let the toolkit run git-bridge on CE

The toolkit forces `GIT_BRIDGE_ENABLED=false` whenever `SERVER_PRO` is not
`true`. That gate exists because stock CE has no git-bridge routes; this fork
does. Add an explicit opt-in to `lib/shared-functions.sh`:

```bash
cd ~/toolkit
python3 - <<'PY'
p = 'lib/shared-functions.sh'
s = open(p).read()
old = '  if [[ $SERVER_PRO != "true" || $IMAGE_VERSION_MAJOR -lt 4 ]]; then'
new = ('  if [[ ${GIT_BRIDGE_ALLOW_CE:-false} != "true" ]] &&\n'
       '     [[ $SERVER_PRO != "true" || $IMAGE_VERSION_MAJOR -lt 4 ]]; then')
assert old in s, 'gate not found; check the toolkit version'
open(p, 'w').write(s.replace(old, new, 1))
print('patched')
PY
```

Re-apply it after every `bin/upgrade` of the toolkit itself.

## 4. Point the toolkit at the fork

`config/overleaf.rc`:

```
OVERLEAF_IMAGE_NAME=ghcr.io/<owner>/interleaf
GIT_BRIDGE_IMAGE=ghcr.io/<owner>/git-bridge
GIT_BRIDGE_ENABLED=true
GIT_BRIDGE_ALLOW_CE=true
GIT_BRIDGE_DATA_PATH=data/git-bridge
```

`config/version`: the tag you built; **6.2.6** for Interleaf 0.2.1.

After upgrading from 6.2.5, remove the temporary `OVERLEAF_REDIS_PASS=` line from
`config/variables.env` if Redis has no password. The env.sh fix handles unset
Redis/web API credentials under `set -u`.

`config/variables.env`, appended:

```
REVIEW_PANEL_ENABLED=true
GIT_BRIDGE_PUBLIC_BASE_URL=https://<your site>/git
GIT_BRIDGE_WEB_PUBLIC_URL=http://sharelatex
GITHUB_BACKUP_ENABLED=true
GITHUB_BACKUP_REPOS_DIR=/var/lib/overleaf/data/github-backup
GITHUB_BACKUP_CIPHER_PASSWORD=<48+ random characters>
LIVE_PREVIEW_ENABLED=true
LIVE_PREVIEW_MAX_SESSIONS=2
LIVE_PREVIEW_MEMORY_MB=2048
```

Generate the cipher password on the host so it never travels anywhere:
`printf 'GITHUB_BACKUP_CIPHER_PASSWORD=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> config/variables.env`.
If it is lost, every stored GitHub token becomes undecryptable and each project
has to be linked again; nothing else is affected.

Generate the preview secret **once, on the host**, with shell tracing disabled.
This appends directly to the configuration without displaying the secret:

```bash
set +x
umask 077
printf 'LIVE_PREVIEW_TICKET_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> config/variables.env
chmod 600 config/variables.env
```

Skip generation if the file already has a real `LIVE_PREVIEW_TICKET_SECRET`;
avoid duplicate entries. Do not paste the secret into chat, logs or command output.
Web and the in-container service share this value. Keep it stable across restarts;
changing it invalidates current opening/access tokens. Enabling preview without
it fails container initialization. With `LIVE_PREVIEW_ENABLED` unset or anything
other than `true`, the runit entry waits without a restart loop. Enabling requires
a container recreate. Only projects with compiler `lualatex` can open a session.

The default `LIVE_PREVIEW_SERVICE_URL=http://127.0.0.1:3060` is the internal service
address. `LIVE_PREVIEW_DATA_DIR` defaults to `/var/lib/overleaf/data/live-preview`
and is created for `www-data`; it holds disposable session sources and PDFs.
`LIVE_PREVIEW_MEMORY_MB` defaults to 2048 (per-process virtual memory limit),
`LIVE_PREVIEW_IDLE_MS` to 120000, `LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS` to 3000,
`LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS` to 30000 and `LIVE_PREVIEW_ACCESS_TTL_MS`
to 900000. The 2048 MiB limit is inherited by **each process**, rather than a
combined RSS quota. It remains compatible with LuaLaTeX's virtual reservations:
the full TeX Live 2025 release checks ran Cleave, migrated CrossMem and a four-page
Chinese `ctexbook` under this cap. Observed process-group RSS peaks were about
1.70 GiB for Cleave and 1.21 GiB for the Chinese document; end samples were about
0.64 GiB for each after the page passes settled. Allow **2 GiB per active project**, plus the
existing Overleaf services and operating-system headroom. Use
`LIVE_PREVIEW_MAX_SESSIONS=1` on smaller hosts; two sessions need at least 4 GiB
of available preview capacity. Raising the address-space cap does not add RAM.
See [the service README](../services/live-preview/README.md) for exact measurements.

`LIVE_PREVIEW_LAYOUT_MAX_WAIT_FACTOR` defaults to 2. The forced-layout deadline
is the larger of the configured max-wait and this factor times the last completed
pass duration. A five-second pass gives a ten-second deadline, reducing forced
work while allowing pagination and references to lag longer during continuous
collaboration. Paragraph updates remain live. Quiet-time rtex passes may run sooner.
`LIVE_PREVIEW_NICE` defaults to 10 and is inherited by rtex's LuaLaTeX children.
When `taskset` is installed, `LIVE_PREVIEW_CPUS` defaults to at most two CPUs from
the process's allowed set; set it to 0 to leave affinity unrestricted. The
existing prlimit and trusted LuaLaTeX wrapper remain active.

During typing, the browser keeps the current base PDF and newest live paragraphs,
prefetches the latest layout PDF, and switches after roughly one second of quiet.
Unrepresentable changes request an immediate switch to a layout containing them.
Visible page pixels remain until pdf.js renders their replacements. Missing font
glyphs appear in live logs and source gutters; install/configure a covering font
or an appropriate package such as ctex for Chinese.

The service-local LuaLaTeX wrapper enforces `openin_any=p`, `openout_any=p` and
`-no-shell-escape`, including after rtex's own environment overrides. Absolute
paths are permitted only under the session output root and installed TeX tree;
the TeX installation must remain read-only to `www-data`. Font caches live in
the disposable session directory. `LIVE_PREVIEW_TEXMF_ROOT` defaults to
`/usr/local/texlive`; set it to your actual installation when using another tree.
Never widen this setting to `/` or a directory containing credentials.

Connection defaults are 16 per project and eight per user, with a 30-second
ping/pong heartbeat. Two missed heartbeat checks close a dead viewer so its
session can become idle. Override with `LIVE_PREVIEW_MAX_PROJECT_CONNECTIONS`,
`LIVE_PREVIEW_MAX_USER_CONNECTIONS` and `LIVE_PREVIEW_HEARTBEAT_MS` if needed.
Browser upgrades require a matching Origin/Host, or an explicit comma-separated
`LIVE_PREVIEW_ALLOWED_ORIGINS` list of full site origins. CLI clients without
Origin still require a valid opening ticket.

CE's environment maps `LIVE_PREVIEW_WEB_URL` to the loopback private API on
port 3000, `LIVE_PREVIEW_WEB_USER/PASSWORD` to the generated `WEB_API_USER/PASSWORD`,
and `LIVE_PREVIEW_DOCUMENT_UPDATER_URL` to loopback port 3003. Preview's Redis must
be the same pubsub Redis as document-updater: `LIVE_PREVIEW_REDIS_HOST/PORT/PASSWORD`
default to the `PUBSUB_REDIS_*` overrides, then CE's `OVERLEAF_REDIS_HOST/PORT/PASS`.
The remaining service options are listed in `services/live-preview/README.md`.

`GIT_BRIDGE_WEB_PUBLIC_URL` is how the git-bridge container reaches web for the
signed blob URLs inside a snapshot, so it is the internal name, not the site
URL. `GIT_BRIDGE_PUBLIC_BASE_URL` is what users are shown to clone from, so it
is the public one.

The toolkit also decides where git-bridge calls the web API, and gets it wrong
on CE: for any image version 4.2 or later it uses `http://sharelatex:3000/api/v0/`,
the web-api process. On Server Pro that process serves the git-bridge API; here
it does not mount the modules' public API routes, so port 3000 answers every
API path with Express's `Cannot GET` page, git-bridge
fails to parse it, and every clone ends in `403`. Override the URL so the calls
go through the container's nginx on port 80, in `config/docker-compose.override.yml`:

```yaml
services:
  git-bridge:
    environment:
      GIT_BRIDGE_API_BASE_URL: 'http://sharelatex/api/v0/'
```

The override file is the toolkit's place for local settings and survives
toolkit upgrades. After changing it, `bin/docker-compose up -d --no-deps git-bridge`
recreates git-bridge alone.

## 5. Start and verify

```bash
cd ~/toolkit && bin/up -d
```

The first boot runs the pending migrations; watch `bin/logs -f sharelatex` until
the web service is listening. Then check, in order:

1. The site loads and an existing project still opens.
2. Account settings shows **Personal access tokens**; create one with both
   scopes.
3. `curl -H "Authorization: Bearer olp_…" https://<site>/oauth/token/info` → `200 {}`.
4. `git clone https://<site>/git/<project id>` with username `git` and the token
   as the password.
5. The editor's integrations rail shows **Git & agents** and **Back up to
   GitHub**.
6. Connect an agent: `claude mcp add --transport http overleaf https://<site>/mcp --header "Authorization: Bearer olp_…"`.
7. If preview is enabled, run `docker exec -u www-data sharelatex rtex doctor`
   (LuaLaTeX and support files must be found), then check
   `https://<site>/live-preview/health`. For a LuaLaTeX project, obtain an opening
   ticket from the session/CSRF-protected `POST /project/<id>/live-preview/ticket`,
   connect `services/live-preview/bin/test-client.mjs`, and check paragraph/layout
   frames after an editor or MCP edit. Fetch its layout PDF and glyphs with the
   `hello.access` credential, not the opening ticket. In the editor, select
   **Live preview** in the Recompile dropdown, edit an ordinary paragraph and
   confirm the PDF changes. Check a second collaborator and a detached preview,
   a Chinese document if used, source dots/log navigation after a TeX error, and
   normal Recompile/download. Confirm Retry after a failed session and ordinary
   compilation when the session budget is full.

A reverse proxy in front of the stack must pass `/git/`, `/mcp` and `/live-preview/` through
untouched, and needs a `client_max_body_size` large enough for a git push.
Pass WebSocket upgrades at `/live-preview/ws` with a read timeout of at least
10 minutes, matching the image's socket.io settings. Preserve the public Host and
Origin; do not cache PDF/glyph responses or log ticket/access query strings.
For an nginx proxy in front of the toolkit, the location needs equivalent settings:

```nginx
location /live-preview/ {
    proxy_pass http://toolkit_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 600s;
    proxy_buffering off;
    access_log off;
}
```

After recreating the container, verify the health endpoint, `rtex doctor`, the
editor checks above, and `/var/log/overleaf/live-preview.log`. Session sources,
font caches, two rotating rtex background build directories and the last three
PDFs are disposable. Stop/idle eviction removes them; startup removes project-id
directories left by an earlier run. Do not share `LIVE_PREVIEW_DATA_DIR` between
two service processes. Restarting the supervised Node process disconnects clients;
they fetch fresh opening tickets, reconnect and rebuild from current project text.

## TeX Live

Upstream's base carries only `scheme-basic`, which is missing packages that most
conference templates need, so the base workflow's `texlive_scheme` input
defaults to `scheme-full` and installs it into `interleaf-base`, from the same
TeX Live mirror the upstream stage used. Two things follow from that:

- The TeX environment is part of the image, not state to be preserved. Rolling
  back to an older tag gives you exactly the TeX Live that tag was built with.
- Because TeX Live lives in the base image, an application release reuses those
  layers unchanged, and the host pulling the new tag downloads only the small
  application layers.

Packages added by hand inside a running container are still lost on the next
recreate, as they always were. For those, keep a site-local tree on the host and
mount it at `TEXMFLOCAL`, using the toolkit's override file:

```yaml
# config/docker-compose.override.yml
services:
  sharelatex:
    volumes:
      - '/absolute/path/to/toolkit/data/texmf-local:/usr/local/texlive/texmf-local'
```

Drop `.cls` and `.sty` files under `data/texmf-local/tex/latex/<name>/`, then run
`docker exec sharelatex mktexlsr`. That tree is untouched by image updates.

The image downloads rtex release `interleaf-0.0.3-2` from the fork immediately
after the TeX Live layers, checks SHA-256
`3e56e697c93dbc1cd3df39ad49b16d31dc3efa31438c3edcfefaa1dcf084e6c3`, and installs
the executable at `/usr/local/bin/rtex`. Its matching support files live at
`/usr/local/share/rtex/tex` (`RTEX_TEXDIR`), outside operator-mounted `texmf-local`.
The workflow inputs `rtex_release` / `rtex_sha256` map to build arguments
`RTEX_RELEASE` / `RTEX_SHA256`; change both together when updating the fork.

## Things this rollout ran into

- The image generation after 6.1.2 requires `OVERLEAF_INVITE_TOKEN_SECRET`.
  Generate one and keep it stable; changing it invalidates issued share links.
- The backup cannot be taken as the login user: MongoDB's data files belong to
  the database container's user. Run `tar` inside a container that mounts the
  toolkit directory instead.
- The production image installs only `dependencies`, so anything imported at
  runtime must not sit in `devDependencies`.
- git-bridge was unusable in production for weeks while the web API worked when
  tested through the site: the toolkit pointed it at `sharelatex:3000` (see
  step 4). Test git access with a real `git clone`, not only with `curl`
  against the public URL, which takes a different path to web.
- Migrations run on the first boot of the new image, before the application is
  reachable. If that boot fails for another reason, the database has already
  moved forward; fixing the image is safer than starting the old one again.

## 6. Rolling back

```bash
cd ~/toolkit
bin/stop
rm -rf data && tar -xzf ~/overleaf-backup-<date>.tar.gz -C ~/toolkit
cp /tmp/overleaf-version-before config/version   # and restore overleaf.rc
bin/up -d
```

Restoring `data/` is what makes the rollback safe: the forward migrations are
already applied in the database you would otherwise keep.
