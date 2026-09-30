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
For the optional one-way backup of a project to a GitHub repository, see
`doc/github-backup.md`.

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
right project. A project name is not accepted: the error says to pass an id or
URL and lists the projects of that name as `candidates`.

## The tools

**Reading.** `list_projects` (what the token can reach, newest first, with
`last_updated`), `get_project` (file tree, root document, current
`project_version`, permissions), `read_file` (numbered lines, with an optional
line range), `get_outline` (LaTeX sections, following `\input`), `search`
(plain text or regular expression, with line numbers).

`read_file` does not show pending suggestions as if they were accepted text.
By default the document reads as it would if every pending suggestion were
rejected: suggested insertions are left out and suggested deletions are still
there, and `pending_suggestions` says how many there are. Pass
`include_suggestions: true` to read the live text instead — the text `edit_file`
and `suggest_edits` work on — with every pending suggestion listed by id, type
(`insert` or `delete`), text, line and column. While suggestions are pending,
line numbers and anchors taken from the default view can differ from the live
text, and the result says so.

**Writing.** `write_files` creates, replaces or deletes whole files in one
atomic batch. A path that already exists is refused with `file_exists` unless
the call passes `overwrite: true`; new files and deletes need nothing. When
overwriting, pass `base_version` too, so a collaborator's edit made since the
agent read the file is refused instead of lost. `edit_file` applies structured
edits to one document and computes the new content on the server (see below).
Every write takes `message` (why the change was made) and returns the new
`project_version`, the value to pass as the next `base_version`. If the project
has moved on since the agent read it, the write is refused with
`version_conflict`, the `current_version` to retry with, and `changed_paths`,
the files that changed in between. `write_files` still returns the same number
as `version` too; that name is deprecated and will go in the next release.

**Edit types.** `edit_file` and `suggest_edits` take the same `edits`, applied
in order and all or nothing. Line numbers are 1-based, as `read_file` shows
them; `occurrence` counts matches from 1. Deleting is replacing with
`new_text: ""`.

| `type` | Fields | Does |
|---|---|---|
| `replace_range` | `start_line`, `end_line?`, `new_text` | Replaces lines `start_line`..`end_line` (default: just `start_line`). `end_line = start_line - 1` inserts before `start_line`. |
| `replace_anchor` | `anchor`, `new_text`, `occurrence?` | Replaces the exact text `anchor`. If it occurs more than once, `occurrence` picks one. |
| `insert_at_anchor` | `anchor`, `side`, `new_text`, `occurrence?` | Inserts `new_text` right `before` or `after` the anchor; nothing is removed. |
| `replace_section` | `title`, `level?`, `new_text` | Replaces a whole section, heading included, so `new_text` starts with the heading line. Without `level` any heading level matches; several headings with that title are an error listing each one's level and line. The section ends before the next heading of the same or a higher level, `\appendix`, `\bibliographystyle`, `\bibliography`, `\printbibliography`, `\begin{thebibliography}`, an appendix `\input`, or `\end{document}`, so the back matter is never replaced with it. |

```json
{"type": "replace_range", "start_line": 12, "end_line": 14, "new_text": "new line 12\nnew line 13"}
{"type": "replace_anchor", "anchor": "old sentence.", "new_text": "new sentence."}
{"type": "insert_at_anchor", "anchor": "\\end{abstract}", "side": "after", "new_text": "\n\\section{Introduction}\nText."}
{"type": "replace_section", "title": "Results", "level": "section", "new_text": "\\section{Results}\nNew body."}
```

Every edit is checked before any runs, and an error names the edit:
`edits[1]: anchor not found`, `edits[0]: replace_anchor requires anchor and
new_text; missing or invalid: anchor`, or, for a type that does not exist, the
list of valid ones. The result reports the lines each edit replaced
(`replaced_lines`, 1-based, inclusive) and adds a `warning` when a
`replace_section` removes at least 5 more lines than it adds and at least twice
as many.

**History and labels.** `list_history` returns labels and updates in one
shape, newest first: `from_version`, `to_version`, `created_at` (ISO 8601),
`authors`, and the `agent` and `message` a write recorded, so any entry can go
straight to `diff` or `revert_to`. `diff` compares two versions: with `path` it
returns a unified diff with 3 lines of context, without it the files that were
added, edited, renamed or removed. `revert_to` restores a version (recorded as
a new version going forward, so nothing is lost), and `create_label` marks a
milestone.

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
`create_branch`, `list_branches`, `diff_branch` (a unified diff per changed
file), `merge_branch` (`dry_run: true` by default, so the files it would write
and any conflicts are reported before anything is written) and
`archive_branch` (needs write access to the parent project). The branch tools
take `branch` as the branch's own project id or URL — `branch_project_id` from
`create_branch` or `list_branches` — or as the branch name together with
`project`, the parent project:

```json
{"branch": "6abc8ba3429e163f82a11ac9"}
{"branch": "mcp-probe", "project": "6a7c0fc6165368fa6900b9b7"}
```

**Comments.** `list_comments` and `get_review_queue` (unresolved comments
grouped by file, with the surrounding lines) read the panel; `reply_comment`,
`resolve_comment` and `reopen_comment` act on a thread; `add_comment` anchors a
new comment to a passage; `reanchor_comment` moves one that lost its text. The
anchor is `exact` text or a `start_with_ellipsis` passage ("first
words...last words"), optionally narrowed by `occurrence` (from 1) and by
`start_line`/`end_line`, or a line range on its own. By default
(`act_as_agent: true`) the agent speaks as its own service user, so its replies
are distinguishable from yours in the panel.

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

**Errors** carry their facts in the text as well as in `structuredContent`,
one `key: value` per line: `error: <code>`, `message`, the details, and
`next_action` last. Some clients show the model only the text.

**`version_conflict`** — somebody wrote to the project between the agent's read
and its write. The error carries `current_version` and `changed_paths`; re-read
those files and retry with `base_version` set to it. The lock is per project,
so a change to another file also moves the version; `changed_paths` shows
whether the clash is real. Writing without `base_version` skips the check,
which is fine for a file only the agent touches.

**`file_exists`** — `write_files` was about to replace an existing file. Pass
`overwrite: true` (with `base_version`), or use `edit_file` for part of it.

**`anchor_not_found` / `anchor_ambiguous`** — the text an edit or a comment was
anchored to is gone, or appears more than once. `anchor_ambiguous` lists the
candidate lines; re-read the file and either quote more of it or pass
`occurrence` (counted from 1). An `occurrence` past the last match says how
many there are.

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
