# Backing a project up to GitHub

Overleaf can push a project's full history to a GitHub repository you own. It is
a **one-way mirror**: Overleaf → GitHub, never the other way round. Nothing you
commit on GitHub comes back into the project.

Use it to keep an off-site copy of a paper, to let CI build the PDF, or to give
readers a repository they can clone without an Overleaf account.

## What ends up in the repository

The commits come from the git-bridge container, which is the same history a
`git clone <site>/git/<project-id>` gives you:

| Overleaf | GitHub |
|---|---|
| a saved version / history label | a commit, with the label text as the message |
| the person who made the change | the commit author |
| the current state of the project | the tip of the backup branch |
| an agent or Git write (`(via Agent)`, `(via Git)`) | an ordinary commit like any other |

Overleaf keeps a bare mirror of each linked project on the server and pushes it
with `git push` — **fast-forward only, never `--force`**. If GitHub has commits
that Overleaf does not have, the backup stops and says so rather than
overwriting anything.

## Turning it on (administrators)

The feature is off unless these environment variables are set on the `web`
service:

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_BACKUP_ENABLED` | `false` | `true` turns the whole feature on |
| `GITHUB_BACKUP_CIPHER_PASSWORD` | — | **required**; encrypts the stored tokens, at least 16 characters |
| `GITHUB_BACKUP_INTERVAL_SECONDS` | `600` | how often the scheduler walks the linked projects |
| `GITHUB_BACKUP_REPOS_DIR` | `services/web/data/github-backup` | where the server-side bare mirrors live |
| `GITHUB_BACKUP_API_BASE_URL` | `https://api.github.com` | override for GitHub Enterprise |
| `GITHUB_BACKUP_GIT_TIMEOUT_MS` | `300000` | per-git-command timeout, and the length of the sync lease |

git-bridge must also be enabled (`GIT_BRIDGE_ENABLED=true`, the `git-bridge`
container running): the backup reads the project history from it.

The repositories directory must be writable by the `node` user and should
survive restarts. Losing it costs nothing but a slower first backup — the
mirror is rebuilt by fetching from git-bridge again.

`GITHUB_BACKUP_CIPHER_PASSWORD` is the key for every stored token. Changing it
makes existing links unusable; owners have to connect their repositories again.

`develop/docker-compose.yml` sets both variables for local development. The
password there is a placeholder in a public repository and is fine only because
the develop stack is a throwaway.

## Creating the GitHub token

1. Go to <https://github.com/settings/personal-access-tokens/new> (Settings →
   Developer settings → Personal access tokens → Fine-grained tokens).
2. Pick the owner of the repository, and under **Repository access** select the
   one repository you want the backup to write to.
3. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Nothing else is needed.
4. Choose an expiry you are happy to renew, and generate the token.

A classic token with the `repo` scope also works, but it grants far more than
the backup needs.

## Connecting a project

Only the project owner can connect a repository.

1. Open the project, then the **Integrations** panel in the right-hand rail.
2. Click **Back up to GitHub**.
3. Fill in the repository (`owner/repository`, or paste the repository URL), the
   branch to push to (`main` by default) and the token.
4. Tick **Create the repository if it does not exist** to have Overleaf create a
   private, empty repository for you.
5. **Connect**. Overleaf checks the token against the GitHub API, mints an
   internal token for reading the project history, and runs the first backup
   straight away.

From then on the project is backed up on the schedule, and anyone with write
access can press **Back up now**.

## Statuses

| Badge | Meaning |
|---|---|
| **Not run yet** | linked, but no backup has finished |
| **Backing up** | a backup is running; the panel polls until it ends |
| **Backed up** | the branch on GitHub matches the Overleaf history |
| **Failed** | something went wrong; the message says what |
| **Diverged** | GitHub has commits Overleaf does not have |

### Fixing `diverged`

The backup never rewrites GitHub history, so it stops as soon as the branch on
GitHub is not a descendant of the Overleaf history. That happens when somebody
commits directly to the backup branch. Pick one:

- **Keep the GitHub commits.** Push them to another branch, then reset the
  backup branch to the last commit Overleaf pushed. The next backup
  fast-forwards again.
- **Back up somewhere else.** Disconnect and reconnect with a different branch
  name; the diverged branch is left untouched.
- **Bring the changes back by hand.** Copy the edits into the project in the
  editor (or with `git push` through git-bridge), then reset the backup branch.

Pulling GitHub commits back into Overleaf automatically is not supported. See
`doc/design/github-backup.md` for what that would take.

## For agents (MCP)

Two tools, both read-mostly:

| Tool | Access | What it does |
|---|---|---|
| `get_backup_status(project)` | read | repository, branch, state, last backed-up version and time, last error |
| `backup_now(project)` | write | runs a backup now and returns the new status |

Neither can connect or disconnect a repository: that needs a GitHub token, which
stays in the browser form.

## Security notes

- **Stored per link**: the GitHub token and an internal Overleaf token, both
  encrypted with `@overleaf/access-token-encryptor` under
  `GITHUB_BACKUP_CIPHER_PASSWORD`; plus the repository, the branch and the
  status. The tokens are never returned by any endpoint, in any status payload,
  or to any MCP tool.
- **The internal token** is an ordinary personal access token with the
  `git_bridge` scope, created for the owner and labelled *GitHub backup
  (internal)*. It is what lets the backup read the project from git-bridge. It
  is revoked when the project is disconnected or deleted.
- **Tokens never reach a command line, a URL or a log.** git is given them
  through `GIT_ASKPASS`, and anything git prints is scrubbed of token-shaped
  strings before it is stored or logged.
- **github.com is the only external host** the feature talks to (or whatever
  `GITHUB_BACKUP_API_BASE_URL` points at). It makes no other outbound calls.
- Disconnecting revokes the internal token, deletes the server-side mirror and
  forgets the GitHub token. The GitHub repository and its commits are left
  alone.

## Limitations

- One-way only. GitHub is a mirror, not a second editor.
- Requires git-bridge; without it there is no history to read.
- One repository and one branch per project.
- The backup is as fresh as the last saved version: it pushes the history
  git-bridge produces, which is built from saved versions rather than from every
  keystroke.
- Very large binary files count against GitHub's file and repository size
  limits; a rejected push shows up as **Failed** with GitHub's own message.
