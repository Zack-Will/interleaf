# Design: one-way GitHub backup (`modules/github-backup`)

Status: implemented (R6). User-facing documentation: `doc/github-backup.md`.

## 1. The decision: do not build a second history exporter

A backup needs the project as a git history. We already have one.

The official Java git-bridge container maintains a git repository per project:
one commit per saved version or label, the Overleaf user as the author, the
version comment as the message, and it refreshes that repository lazily whenever
a client fetches from it. Our `modules/git-bridge` serves it the snapshots it
needs (`/api/v0/docs/*`), which is live-tested.

So the backup is not a history exporter. It is git plumbing:

```
git-bridge  --(git fetch, Basic git:<olp_ token>)-->  bare mirror on the web host
bare mirror --(git push, Basic x-access-token:<GitHub token>)--> github.com
```

Rejected alternatives:

| Alternative | Why not |
|---|---|
| Walk project-history ourselves and build commits | Reimplements what git-bridge already does, including binary blobs and author mapping, and would drift from what `git clone` gives users |
| Use the GitHub Contents API to upload files | No history, one API call per file, rate limits |
| Run `git` inside the git-bridge container | Closed-ish upstream image, no extension point, and it would put a user's GitHub token inside it |
| Shell out to `gh` | Another binary in the web image for what two git commands do |

The cost of the decision: the backup can only be as good as git-bridge, and the
feature is useless when git-bridge is off. Both are acceptable — a fork that
wants GitHub backup wants Git anyway.

## 2. Data model

`githubBackupLinks`, one document per linked project (`projectId` unique).

| Field | Notes |
|---|---|
| `projectId` | unique index; the link is per project, not per user |
| `linkedBy` | the owner who connected it; the internal token belongs to them |
| `owner`, `repo`, `branch` | the GitHub target; `branch` defaults to `main` |
| `githubTokenEncrypted` | the user's fine-grained token |
| `bridgeTokenEncrypted` | an internal `olp_` token with the `git_bridge` scope |
| `bridgeTokenId` | so the internal token can be revoked on unlink |
| `enabled` | the scheduler only walks enabled links |
| `status` | `idle` \| `syncing` \| `ok` \| `error` \| `diverged` |
| `lastSyncedVersion` | the project-history version the last good push carried |
| `lastSyncedAt`, `lastPushedCommit` | for the editor card |
| `lastError` | `{code, message, at}`, scrubbed and truncated to 500 characters |
| `leaseUntil` | the sync lease (section 4) |

Both tokens go through `@overleaf/access-token-encryptor` with the label
`2026.1-v3` and the password from `GITHUB_BACKUP_CIPHER_PASSWORD`. Nothing else
in the document is a secret, so `getStatus` can return the whole document minus
the two encrypted fields.

The unique index is declared on the Mongoose schema, like
`personalAccessTokens.hashedToken` and `syncBranches.branchProjectId`. This fork
carries no `migrations/` directory, so there is nowhere to put a migration that
the CE image would run.

Two tokens instead of one is deliberate. The backup reads the project the same
way any other git client does, through git-bridge's token authentication, so it
gets the same permission checks with no new internal trust path. The internal
token is minted for the owner, labelled *GitHub backup (internal)* so that it is
recognisable in the settings page, and revoked when the link goes away.

## 3. The sync algorithm

`MirrorJob.run(link, {force})`:

1. `VersionService.getLatestVersion(projectId)` — this flushes document-updater
   and project-history first, so git-bridge will build a repository that
   includes the latest saved state.
2. If not forced, the status is `ok` and the version equals `lastSyncedVersion`,
   stop. Nothing has been saved since the last backup.
3. Ensure `<reposDir>/<projectId>.git` exists (`git init --bare`, mode 0700).
4. `git fetch --prune <gitBridgeUrl>/<projectId> +refs/heads/*:refs/remotes/overleaf/*`
   with `GIT_ASKPASS` answering `git` / the internal token. This is the step that
   makes git-bridge refresh the project.
5. Find the source branch by reading `refs/remotes/overleaf/*`, preferring
   `master` (what git-bridge produces today) then `main`, then whatever is
   there. No branch at all → `empty_history`.
6. `git push <https://github.com/owner/repo.git> refs/remotes/overleaf/<source>:refs/heads/<branch>`
   with `GIT_ASKPASS` answering `x-access-token` / the GitHub token. **No
   `--force`, ever.**
7. Classify a failed push from stderr: `[rejected]` / `non-fast-forward` /
   `fetch first` → `diverged`; authentication and permission messages →
   `github_auth_failed`; anything else → `git_push_failed`.
8. On success record `lastSyncedVersion` (the number read in step 1, not a
   re-read), `lastSyncedAt`, `lastPushedCommit` and clear `lastError`.

`run` returns the fields the caller should persist rather than writing them
itself, and never throws. That keeps Mongo out of it, which is what lets the
unit tests drive it against real git repositories in temporary directories:
a bare "git-bridge" repository, a bare "GitHub" repository, and assertions on
the commit that actually arrives.

### Credential handling

`GitCommands.runGit` is the only place that starts a process:

- `execFile`, never a shell.
- A per-invocation temporary directory (mode 0700) holding a small `askpass.sh`
  that answers the `Username` prompt from `OL_BACKUP_GIT_USERNAME` and anything
  else from `OL_BACKUP_GIT_PASSWORD`. So neither half of the credential is in
  argv, and the remote URL stays free of userinfo.
- `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `HOME` pointed at the temporary directory, and a timeout.
- Every byte of stderr goes through `scrubSecrets`, which replaces the exact
  token values used by that command and, as a second net, anything shaped like
  `olp_…`, `ghp_…`/`gho_`/`ghs_`/`ghu_`/`ghr_`, `github_pat_…`, or userinfo in a
  URL. A unit test drives a git failure whose output contains both tokens and
  asserts neither survives into `lastError`.

## 4. The lease

Two things can start a backup: the scheduler tick and a user pressing **Back up
now** (or an agent calling `backup_now`). Two `git push` runs against the same
bare mirror would race.

`GithubBackupService.syncNow` claims the link with one atomic
`findOneAndUpdate`:

```
{ projectId, enabled: true, $or: [ {leaseUntil: null}, {leaseUntil: {$lte: now}} ] }
→ $set: { leaseUntil: now + gitTimeoutMs, status: 'syncing' }
```

No document came back and the link exists → someone else holds the lease, so
return the current status with `inProgress: true`. The lease is released in a
`finally`, and it expires by itself if the process dies mid-push, because
`leaseUntil` is a deadline rather than a flag.

Mongo, not the Redis `LockManager`: the lease has to outlive a process restart
and is checked by a scheduler that is already reading these documents.

## 5. Scheduler

`setTimeout` 60 s after boot, then `setInterval(intervalSeconds)`, both
`unref`ed so they never hold the process open. One tick walks the enabled links
**sequentially** — each one forks git, and a server with many linked projects
should not fork one per project at once. A tick that is still running skips the
next one. Every failure is logged and swallowed; nothing escapes the timer.

Step 2 of the algorithm means a quiet project costs one `getLatestVersion` per
tick and no git at all.

## 6. Routes and access

| Route | Access | Notes |
|---|---|---|
| `GET /project/:Project_id/github-backup` | read | status; collaborators can see where the project is backed up |
| `POST /project/:Project_id/github-backup` | admin (owner) | link; body `{repository, branch?, token, createIfMissing?}` |
| `DELETE /project/:Project_id/github-backup` | admin (owner) | unlink |
| `POST /project/:Project_id/github-backup/sync` | write | back up now |

All four answer `404 {code: 'backup_disabled'}` when the feature is off, and all
errors are `{code, message, details?}` with the code mapped to a status
(`github_repo_not_found` → 404, `github_no_push_permission` → 403,
`invalid_repository` → 400, `github_api_error` → 502, …).

The token is write-only: it is accepted on `POST` and never appears in any
response.

## 7. What a two-way version would need

`git push` to git-bridge is the obvious next step, and git-bridge already
accepts pushes (that is what `PushJob` in `modules/git-bridge` handles). A
GitHub → Overleaf direction would be:

1. Detect that the GitHub branch has commits the mirror does not have — already
   detected today, as `diverged`.
2. `git fetch` from GitHub into the mirror.
3. `git push` the merged result to `<gitBridgeUrl>/<projectId>` with the
   internal token, which lands in the project through `PushJob` →
   `WriteService.writeFiles` with origin `{kind: 'git-bridge'}`.

The hard part is not the plumbing, it is the policy: what happens when both
sides changed. Options, roughly in order of effort: refuse and keep reporting
`diverged` (today); fast-forward only in the reverse direction too; attempt a
three-way merge and surface conflicts the way `merge_branch` does in
`modules/project-sync`. Until there is a real use case for it, `diverged` with
an explanation is the honest answer.

A second, smaller extension: a webhook or a GitHub App instead of a personal
access token, so that tokens expire on their own and the server can ask for the
narrow `contents:write` permission explicitly. That is worth doing before this
feature is offered to a large user base.
