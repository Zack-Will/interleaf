# Changelog

Changes to Interleaf's own modules (`project-sync`, `mcp`, `review`,
`git-bridge`, `github-backup`, `live-preview`). Upstream Overleaf changes are not listed here.

## 0.2.0 (2026-10-12)

Images: `ghcr.io/<owner>/interleaf:6.2.5`, `ghcr.io/<owner>/git-bridge:6.2.5`.

Opt-in LuaLaTeX live preview, with collaborative paragraph updates and complete
background page passes. rtex is pinned to release `interleaf-0.0.3-2`.

### Added

- Live preview in the Recompile menu, PDF paragraph overlays, source gutter
  markers, live diagnostics, collaborator outlines and independent detached
  preview connections. Normal Recompile and PDF downloads continue through CLSI.
- A gated web module, separate supervised rtex service and shared protocol
  library, with private project snapshots and project-bound opening/access tokens.
- Session budgets, viewerless LRU eviction, idle cleanup, crash recovery and Retry.
- Chinese `ctexbook`/Fandol acceptance, real-paper memory measurements and operator
  guidance in `doc/live-preview.md` and `doc/deploy-toolkit.md`.

### Fixed

- Snapshot materialization rejects unsafe paths and symbolic links, bounds file
  counts/downloads, and replaces source files without changing retained hard links.
- A trusted LuaLaTeX wrapper reasserts paranoid input/output and disabled shell
  escape after rtex's native environment overrides.
- Preview sockets enforce origin, connection, incoming-message and heartbeat
  limits; PDFs and glyphs require fresh authorized requests and prevent stale caches.
- Preview nginx preserves public Host ports for same-origin WebSocket connections
  through proxies using nonstandard ports.
- Source-service outages report Failed without restart loops, and startup removes
  disposable session directories left by an earlier service process.

## 0.1.1 (2026-10-01)

Images: `ghcr.io/<owner>/interleaf:6.2.4`, `ghcr.io/<owner>/git-bridge:6.2.4`.

MCP usability and safety fixes from an external evaluation of the tools
through the claude.ai connector (issue ids H1–H3, M1–M10, L1–L5 refer to that
evaluation).

### Breaking

- **`write_files` refuses to overwrite an existing file** unless the call
  passes `overwrite: true` (H3). New files and deletes need nothing;
  `base_version` keeps its conflict check. The error code is `file_exists`.
  `revert_to`, `merge_branch` and git pushes are not affected.
- **`read_file` leaves pending suggestions out by default** (M8). The text
  reads as if every pending tracked change were rejected; pass
  `include_suggestions: true` for the live text, which `edit_file` works on,
  and the list of pending suggestions.
- **`read_file` no longer returns `lines`** (L4); the numbered `content` string
  is the one content form.
- **`write_files` returns `project_version`**; `version` is kept as a deprecated
  alias and will be removed in the next release (M7).
- `diff` with a `path` returns a unified diff string instead of project-history's
  internal parts; without a path it lists only changed files (L1).
- `diff_branch` lists only changed files (`unchanged_count` counts the rest);
  `merge_branch` names the files it writes or deletes instead of returning
  their merged content (L3).
- `list_history` entries have a new shape shared by labels and updates (L2).
- `comments_affected` reports a comment shifted along its own line as
  `unchanged` rather than `moved` (L5).
- Error results have a multi-line text (`error: <code>` … `next_action: …`)
  instead of the bare message.
- `archive_branch` needs write access to the parent project, not just read.

### Fixed

- `replace_section` stops at the back matter: `\appendix`,
  `\bibliographystyle`, `\bibliography`, `\printbibliography`,
  `\begin{thebibliography}`, an appendix `\input` and `\end{document}` are no
  longer replaced with the last section (H1). Every edit reports
  `replaced_lines`; a replacement that removes at least 5 more lines than it
  adds, and at least twice as many, carries a `warning`.
- `list_history` returned updates without versions, time or users, because it
  read the wrong field names from project-history (L2).
- A read-only collaborator could archive another user's branch.

### Added

- The `edits` schema of `edit_file` and `suggest_edits` is a union on `type`,
  one variant per edit type with its own described fields, and the tool
  descriptions carry an example of each (H2).
- New edit type `insert_at_anchor` with `side: "before" | "after"` (H2).
- Edits are validated before any runs; an unknown type lists the valid ones,
  a missing field is named, and every error names the failing `edits[i]`
  (`edit_index`) (M1, M4). An out-of-range `occurrence` says how many matches
  exist.
- `replace_section` without `level` matches any heading level; several matches
  are an error listing each heading's level and line (M2). `new_text` must
  start with the heading line, as documented (M3).
- Version conflicts carry `current_version` and `changed_paths`, the files that
  changed since `base_version` (M5).
- Every write tool returns `project_version`, including the comment and
  suggestion tools (M7).
- `add_comment` and `reanchor_comment` take `occurrence` (from 1) and use
  `start_line` / `end_line` next to `exact` or `start_with_ellipsis` to narrow
  the search (M9).
- Branch tools take a branch name together with `project`; a project name
  where an id belongs lists same-named projects as `candidates` (M10).
- `list_projects` returns `last_updated` and sorts newest first.
- Every error's text carries its code, message, details and `next_action`,
  because some clients show the model only the text of a tool result.
- Every timestamp in a tool result is ISO 8601 (L4).
- Every tool description says what it returns; `agent` and `act_as_agent` are
  described.

### Not changed

- The write lock stays per project (M6); conflicts now name the changed files
  instead.
