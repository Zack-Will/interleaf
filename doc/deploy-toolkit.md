# Deploying Interleaf with the Overleaf Toolkit

This runbook replaces a running Overleaf Community Edition instance managed by
the [Overleaf Toolkit](https://github.com/overleaf/toolkit) with the Interleaf image, keeping the existing projects, users and history.

The fork is Community Edition plus six web modules: `project-sync` (personal
access tokens and the write path), `mcp` (the agent endpoint), `git-bridge` (the
web half of the official Java git-bridge), `review` (comments and tracked
changes in CE), `github-backup` (one-way backup of a project to GitHub), and
`live-preview` (opt-in LuaLaTeX preview service; the editor UI follows in P3).
See `doc/agent-sync-usage.md` and `doc/github-backup.md` for what they do.

## What is different from a stock toolkit install

| Item | Stock | Here |
|---|---|---|
| Image | `sharelatex/sharelatex:<version>` | `ghcr.io/<owner>/interleaf:<version>`, built by `.github/workflows/build-image.yml` |
| git-bridge | Server Pro only | Works on CE, but the toolkit refuses to start it unless one gate is patched |
| Image tag | An Overleaf release | Must still look like `X.Y.Z`: the toolkit validates it and derives the git-bridge tag from it |

The tag is therefore a deployment number, not an upstream version. This fork is
built from upstream `28ad3b0` (after the 6.1.2 hotfix, June 2026), and the
git-bridge image mirrored beside it is the official `6.2.0`.

## 1. Build the image

In the fork, run the **Build CE image** workflow (Actions tab, or
`gh workflow run build-image.yml --ref <branch> -f version=6.2.0`). It builds
`server-ce/Dockerfile` on the published `sharelatex/sharelatex-base:6.1.0` and
pushes two packages:

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

`config/version`: the tag you built, for example `6.2.0`.

`config/variables.env`, appended:

```
REVIEW_PANEL_ENABLED=true
GIT_BRIDGE_PUBLIC_BASE_URL=https://<your site>/git
GIT_BRIDGE_WEB_PUBLIC_URL=http://sharelatex
GITHUB_BACKUP_ENABLED=true
GITHUB_BACKUP_REPOS_DIR=/var/lib/overleaf/data/github-backup
GITHUB_BACKUP_CIPHER_PASSWORD=<48+ random characters>
LIVE_PREVIEW_ENABLED=true
LIVE_PREVIEW_TICKET_SECRET=<random shared HMAC secret>
LIVE_PREVIEW_MAX_SESSIONS=2
```

Generate the cipher password on the host so it never travels anywhere:
`printf 'GITHUB_BACKUP_CIPHER_PASSWORD=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> config/variables.env`.
If it is lost, every stored GitHub token becomes undecryptable and each project
has to be linked again; nothing else is affected.

Generate the preview secret separately:
`printf 'LIVE_PREVIEW_TICKET_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> config/variables.env`.
Web and the in-container service share this value. Keep it stable across restarts;
changing it invalidates current opening/access tokens. Enabling preview without
it fails container initialization. With `LIVE_PREVIEW_ENABLED` unset or anything
other than `true`, the runit entry waits without a restart loop. Enabling requires
a container recreate. Only projects with compiler `lualatex` can open a session.

The default `LIVE_PREVIEW_SERVICE_URL=http://127.0.0.1:3060` is the internal service
address. `LIVE_PREVIEW_DATA_DIR` defaults to `/var/lib/overleaf/data/live-preview`
and is created for `www-data`; it holds disposable session sources and PDFs.
`LIVE_PREVIEW_MEMORY_MB` defaults to 2048 (per-process virtual memory limit),
`LIVE_PREVIEW_IDLE_MS` to 300000, `LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS` to 3000,
`LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS` to 30000 and `LIVE_PREVIEW_ACCESS_TTL_MS`
to 900000. A session uses roughly 1.2 GB RSS; set `LIVE_PREVIEW_MAX_SESSIONS=1`
on small hosts when needed.

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
   `hello.access` credential, not the opening ticket. P2 has no preview toggle UI.

A reverse proxy in front of the stack must pass `/git/`, `/mcp` and `/live-preview/` through
untouched, and needs a `client_max_body_size` large enough for a git push.
Pass WebSocket upgrades at `/live-preview/ws` with a read timeout of at least
10 minutes, matching the image's socket.io settings.

## TeX Live

The published base image carries only `scheme-basic`, which is missing packages
that most conference templates need, so the workflow's `texlive_scheme` input
defaults to `scheme-full` and the install is the **first** layer of the image.
Two things follow from that:

- The TeX environment is part of the image, not state to be preserved. Rolling
  back to an older tag gives you exactly the TeX Live that tag was built with.
- Because the layer sits above the base image and below every source layer, a
  rebuild that only changes application code reuses it, and the host pulling the
  new tag downloads only the small layers.

Packages added by hand inside a running container are still lost on the next
recreate, as they always were. For those, keep a site-local tree on the host and
mount it at `TEXMFLOCAL`, using the toolkit's override file:

```yaml
# config/docker-compose.override.yml
services:
  sharelatex:
    volumes:
      - "/absolute/path/to/toolkit/data/texmf-local:/usr/local/texlive/texmf-local"
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
