# AGENTS.md — guidance for coding agents working in this fork

This is Interleaf, a fork of the Overleaf monorepo (upstream `overleaf/overleaf`).
The fork adds web modules that make Overleaf Community Edition usable by AI agents and
by Git without Server Pro, plus a live-preview service. Design: `doc/design/agent-sync-architecture.md`. Read it before
touching these modules. `doc/agent-sync-usage.md` is the user-facing guide to the same
features — how to enable them, get a token, connect a client, and what every tool does; keep
it in step when you change a tool.

## Where our code lives

| Module                  | Path                                                           | Purpose                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-sync`          | `services/web/modules/project-sync/`                           | Personal access tokens, token auth middleware, project reference parsing, version / snapshot / label / write services                                                                   |
| `mcp`                   | `services/web/modules/mcp/`                                    | Streamable HTTP MCP endpoint (`/mcp`) and its tools; depends on `project-sync`                                                                                                          |
| `review`                | `services/web/modules/review/`                                 | Enables the native review panel (comments) in CE: thread/ranges routes, realtime events, `ReviewService`, Agent service user                                                            |
| `git-bridge`            | `services/web/modules/git-bridge/` (planned)                   | Web side of the official Java git-bridge contract                                                                                                                                       |
| `github-backup`         | `services/web/modules/github-backup/`                          | One-way mirror of a project's git history to a GitHub repository: fetch from git-bridge, fast-forward push to GitHub. Design: `doc/design/github-backup.md`                             |
| `live-preview`          | `services/web/modules/live-preview/`, `services/live-preview/` | Gated LuaLaTeX preview: read-authorized opening tickets, private snapshots, rtex sessions and dedicated WebSocket/PDF/glyph endpoints. Design: `doc/design/live-preview.md`             |
| `live-preview-protocol` | `libraries/live-preview-protocol/`                             | Shared browser/Node frame and display-list codecs, project-bound opening/access tickets. User guide: `doc/live-preview.md`; release evidence: `doc/design/live-preview-verification.md` |

Everything new goes under these directories. Edits to upstream files must be minimal and justified
in the commit message, and listed in `doc/upstream-sync.md`. Modules, their
frontend slots and settings are registered in
`services/web/config/settings.interleaf.js`, not in `settings.defaults.js`.

## Conventions (non-negotiable)

- ESM `.mjs`, one statement per line, named helpers instead of dense inline expressions. Match the
  style of `services/web/modules/launchpad/` and `services/web/app/src/Features/History/`.
- Format with Prettier and lint with ESLint before every commit. The source of truth is `services/web/.prettierrc`, with `semi: false`, `singleQuote: true`, `arrowParens: "avoid"`, and `trailingComma: "es5"`. From `services/web`:

  ```bash
  corepack yarn run -T prettier --write "modules/<name>/**/*.mjs"
  corepack yarn eslint modules/<name>
  ```

- Async Express handlers are wrapped with `expressify` from `@overleaf/promise-utils`.
- Errors extend `OError` (`@overleaf/o-error`) and carry a stable `code`.
- Route paths are kebab-case.
- Anything that talks to Mongo, Redis or other services must be injectable so unit tests and the
  smoke script can run without a database. Keep heavy imports out of pure tool / service files.
- MCP tool contract: every tool accepts `project` as a 24-hex id or a full `/project/<id>` URL;
  responses carry both `content` (short human text) and `structuredContent` (full data); errors
  carry `code`, `message`, `expected_version` / `actual_version` when relevant, and `next_action`.
- Writes go through `WriteService.writeFiles` (project lock, `base_version` check, origin
  `{kind:'mcp'|'git-bridge', agent, message, suggestion?}`). Never bypass it. A label is a
  milestone, not a per-write receipt: `writeFiles` only creates one when the caller passes
  `label: true`, and the per-change intent lives in the origin, which the history panel shows.

## Tests and verification

- Unit tests: Vitest, in `modules/<name>/test/unit/src/*.test.mjs`, sinon for stubs. Run from
  `services/web`:

  ```bash
  corepack yarn test:unit --run modules/<name>/test/unit/src
  ```

- MCP wiring smoke check (no database needed):

  ```bash
  corepack yarn node modules/mcp/test/smoke/mcp-smoke.mjs
  ```

- Report real command output. Never claim tests pass without pasting the summary line.

## Environment notes

- Dependencies are installed at the repo root with `corepack yarn install` (yarn 4.18, Yarn PnP,
  so there is no `node_modules`; run tools through `corepack yarn`, e.g. `corepack yarn eslint`).
  The image runs node 24. `yarn install` prunes lockfile entries that only upstream's private
  modules use; that noise in `yarn.lock` is accepted.
- No Docker services run here by default; anything needing a live Overleaf is an integration
  test and must say so.

## Git rules for agents

- Work on the feature branch you were given. Small, descriptive commits.
- Never `git push`. Never rewrite history, force anything, or delete branches.
- Do not delegate code writing to sub-agents; sub-agents may only explore read-only or run tests.
  Code written through heredocs or string replacement tends to collapse into unreadable
  one-liners; write files directly and format them.
