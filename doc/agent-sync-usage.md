# Using agents and Git with this Overleaf fork

This fork of Overleaf Community Edition lets an AI agent and a Git client work
on the same projects as the people editing them in the browser, without Server
Pro. Everything lands on one history timeline, so a write made by an agent, a
`git push` and a person typing in the editor are all visible in the same
history panel.

What the fork adds:

- **A built-in MCP endpoint** (`POST /mcp`) that an agent connects to. It reads
  and writes project files, works with the history, creates branches, and takes
  part in the review panel: reading comments, replying to them, and offering
  edits as tracked changes.
- **Personal access tokens** (`olp_…`), managed on the account settings page,
  used both by the MCP endpoint and by Git.
- **The review panel in CE**, which upstream Community Edition hides.
- **The web side of the official Java git-bridge**, so `git clone` and
  `git push` work against a project.

For the design behind it, see `doc/design/agent-sync-architecture.md`.

## Enabling it

Two environment variables on the `web` service:

| Variable | Effect |
|---|---|
| `GIT_BRIDGE_ENABLED=true` | Shows the token and integration UI, and turns on the git-bridge routes |
| `REVIEW_PANEL_ENABLED=true` | Enables the review panel (comments and tracked changes) in CE |

The MCP endpoint itself is always mounted, but the settings page section that
issues tokens is behind `GIT_BRIDGE_ENABLED`, so in practice you want both.

For Git you also need the git-bridge container, pointed at your web service:

```yaml
git-bridge:
  image: quay.io/sharelatex/git-bridge:latest
  environment:
    GIT_BRIDGE_API_BASE_URL: "http://web:3000/api/v0/"
    GIT_BRIDGE_OAUTH2_SERVER: "http://web:3000"
    GIT_BRIDGE_POSTBACK_BASE_URL: "http://git-bridge:8000"
    GIT_BRIDGE_ROOT_DIR: "/data/git-bridge"
  volumes:
    - git-bridge-data:/data/git-bridge
```

and, on `web`, `GIT_BRIDGE_HOST=git-bridge`,
`GIT_BRIDGE_PUBLIC_BASE_URL=https://overleaf.example.com/git` and
`GIT_BRIDGE_WEB_PUBLIC_URL=http://web:3000`. The `develop/docker-compose.yml`
in this repository is a working example.

## Getting a token

Go to **Account settings → Personal access tokens**, give the token a label,
pick its scopes and create it. A token looks like `olp_AbCdEf0123456789` and is
shown **once**; after that only its label and last use are visible.

Two scopes:

- `mcp` — the `/mcp` endpoint.
- `git_bridge` — `git clone` and `git push`.

Give a token both if the same agent will use Git as well. A token inherits your
own permissions: it can reach exactly the projects you can, with the same read
or write access.

## Connecting a client

Claude Code:

```bash
claude mcp add --transport http overleaf https://overleaf.example.com/mcp \
  --header "Authorization: Bearer olp_AbCdEf0123456789"
```

Any client that speaks Streamable HTTP MCP works the same way: the endpoint is
`<siteUrl>/mcp` and the token goes in an `Authorization: Bearer` header. The
endpoint is stateless — no session, no cursor — so a client that reconnects
loses nothing. Clients that only support OAuth can be bridged with
`mcp-remote`.

Every tool takes `project` as either the 24-character project id or the full
project URL, so pasting a project link to an agent is enough to point it at the
right project.

## The tools

**Reading.** `list_projects` (what the token can reach), `get_project` (file
tree, root document, current `project_version`, permissions), `read_file` (with
an optional line range), `get_outline` (LaTeX sections, following `\input`),
`search` (plain text or regular expression, with line numbers).

**Writing.** `write_files` replaces or deletes whole files in one atomic batch.
`edit_file` applies structured edits to one document — a line range, a text
anchor, or a named section — and computes the new content on the server.
Both take `message` (why the change was made) and an optional `base_version`:
if the project has moved on since the agent read it, the write is refused with
`version_conflict` and the version to retry with.

**History and labels.** `list_history` (labels and updates, with their origin),
`diff` (between two versions, whole project or one file), `revert_to` (restore
a version; recorded as a new version going forward, so nothing is lost), and
`create_label`.

**The label rule.** An Overleaf label is a milestone — one of the "saved
versions" a human scans, and one of the commits the git-bridge exposes. Writes
therefore do **not** create a label. The `message` an agent passes travels with
the change itself, and the history panel prints it under the author line of
that entry — "Ada Lovelace (via Claude Code)" on the first line, "Rewrite the
abstract for clarity" underneath. When a piece of work is finished, the agent
calls `create_label` to mark it. `revert_to` and
`merge_branch` are milestones by definition and always label. Any write tool
can be asked for one directly with `label: true`.

**Branches.** Overleaf history is linear, so a branch is a copy of the project:
`create_branch`, `list_branches`, `diff_branch`, `merge_branch` (`dry_run: true`
by default, so conflicts are reported before anything is written) and
`archive_branch`.

**Comments.** `list_comments` and `get_review_queue` (unresolved comments
grouped by file, with the surrounding lines) read the panel; `reply_comment`,
`resolve_comment` and `reopen_comment` act on a thread; `add_comment` anchors a
new comment to a passage; `reanchor_comment` moves one that lost its text. By
default the agent speaks as its own service user, so its replies are
distinguishable from yours in the panel.

**Suggestions.** `suggest_edits` takes the same edits as `edit_file` but records
them as tracked changes, so nothing is applied until a human accepts them in the
review panel. `list_suggestions` shows what is pending; `accept_suggestions` and
`reject_suggestions` act on them as *you*, not as the agent, and only on ids the
agent has actually seen. A suggestion is marked as one in the history panel too:
its origin reads "(via Claude Code, suggestion)".

## A review round

The workflow the tools are shaped around:

1. You read the draft and leave comments in the editor, as you would for a
   co-author.
2. The agent calls `get_review_queue` — every unresolved comment, in context,
   plus a count of suggestions nobody has acted on yet.
3. For each comment it either makes the change with `edit_file`, or offers it
   with `suggest_edits` when the change is a judgement call.
4. It replies with `reply_comment` saying what it did, and calls
   `resolve_comment` on the threads it has settled.
5. When the round is done it calls `create_label` — "Review round 1 handled" —
   which is the entry you and `git log` will see.

You then read the diff for that label, accept or reject the suggestions, and
start the next round.

## Git

```bash
git clone https://overleaf.example.com/git/<project id>
```

Git asks for a username and password: the username is ignored, the password is
a `git_bridge` token. Pushing back writes through the same path as an agent
write, with origin `git-bridge`, so the history panel labels it "(via Git)" and
a push and an agent write can never interleave.

## Troubleshooting

**`version_conflict`** — somebody wrote to the project between the agent's read
and its write. The error carries `actual_version`; re-read the files that
changed and retry with `base_version` set to it. Writing without `base_version`
skips the check, which is fine for a file only the agent touches.

**`anchor_not_found` / `anchor_ambiguous`** — the text an edit or a comment was
anchored to is gone, or appears more than once. `anchor_ambiguous` lists the
candidate lines; re-read the file and either quote more of it or pass
`occurrence`.

**`text_mismatch`** — the document changed under a comment anchor. The error
carries `actual_text`, the text now at that position, so the call can be
retried without another read.

**Detached comments** — deleting the commented text does not delete the
comment; the thread survives with nothing to point at, and
`get_review_queue` lists it under `detached`. Put it back on the new text with
`reanchor_comment`. After a `replace_anchor` or `replace_section` edit the fork
re-anchors these automatically where it can, and reports what it moved.

**`ot_type_unsupported`** — the document cannot hold tracked changes, so
`suggest_edits` will not work on it. Write the change directly with `edit_file`.

**Nothing happened** — a write whose content matches what is already there is
reported as `unchanged` rather than written, so the history does not fill with
empty versions.
