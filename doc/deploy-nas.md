# Deploying this fork with the Overleaf Toolkit

This runbook replaces a running Overleaf Community Edition instance managed by
the [Overleaf Toolkit](https://github.com/overleaf/toolkit) with the image built
from this fork, keeping the existing projects, users and history.

The fork is Community Edition plus five web modules: `project-sync` (personal
access tokens and the write path), `mcp` (the agent endpoint), `git-bridge` (the
web half of the official Java git-bridge), `review` (comments and tracked
changes in CE) and `github-backup` (one-way backup of a project to GitHub).
See `doc/agent-sync-usage.md` and `doc/github-backup.md` for what they do.

## What is different from a stock toolkit install

| Item | Stock | Here |
|---|---|---|
| Image | `sharelatex/sharelatex:<version>` | `ghcr.io/<owner>/overleaf:<version>`, built by `.github/workflows/build-image.yml` |
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

- `ghcr.io/<owner>/overleaf:<version>` — this fork
- `ghcr.io/<owner>/git-bridge:<version>` — the official git-bridge, re-tagged so
  that the toolkit's `<image>:<version>` convention resolves

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
OVERLEAF_IMAGE_NAME=ghcr.io/<owner>/overleaf
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
```

Generate the cipher password on the host so it never travels anywhere:
`printf 'GITHUB_BACKUP_CIPHER_PASSWORD=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> config/variables.env`.
If it is lost, every stored GitHub token becomes undecryptable and each project
has to be linked again; nothing else is affected.

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

A reverse proxy in front of the stack must pass `/git/` and `/mcp` through
untouched, and needs a `client_max_body_size` large enough for a git push.

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
