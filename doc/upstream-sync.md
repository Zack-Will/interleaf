# Syncing with upstream Overleaf

Interleaf follows upstream **releases**, not upstream `main`. Each Interleaf
release is based on the public commit that an official Community Edition image
was built from, so the fork can be described as "CE x.y.z plus these patches".

## Finding the commit behind a CE release

The `com.overleaf.ce.revision` label on `sharelatex/sharelatex:<tag>` is a SHA
from Overleaf's internal monorepo and does not exist in the public repository.
Match by content instead:

1. Read the image manifest and config from Docker Hub and find the layer created
   by `COPY --parents libraries/ services/ tools/migrations/ /overleaf/`
   (about 45 MB).
2. Extract it into an empty directory and `git hash-object` every file under
   `libraries/` and `services/`.
3. Compare those hashes with `git ls-tree -r` of candidate commits on
   `upstream/main`. The release commit is the one with zero mismatching files
   (files only in the image are build files the public repository does not
   ship; files only in git are tests and stories excluded from the image).

Upstream publishes to the public repository in batches, so commit dates there
are mirror dates. Release hotfixes (`x.y.z` with `z > 0`) are patches applied on
top of the image and usually reach the public `main` later; the patch files can
be read from the image layers (`COPY issue_*.patch`).

| CE release | Public commit | Notes                                |
| ---------- | ------------- | ------------------------------------ |
| 6.3.0      | `e039ad26c5`  | Verified by content, 2026-10-17      |
| 6.3.1      | `e039ad26c5`  | Same source plus five hotfix patches |

## Where the fork touches upstream files

Fork features live in new files (web modules, `services/live-preview`,
`libraries/live-preview-protocol`, docs). Those never conflict. The upstream
files below are the only merge surface. Keep this list current: a change to an
upstream file that is not listed here should either move into a module or be
added with its reason.

### Hooks that have to stay in upstream files

| File                                                                                                                                        | Why                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `services/web/config/settings.defaults.js`                                                                                                  | One `require('./settings.interleaf').apply(...)` call at the end     |
| `server-ce/config/settings.js`                                                                                                              | CE overrides: ranges split test, git URL from `siteUrl`, backup dir  |
| `libraries/overleaf-editor-core/index.js`, `lib/origin/index.js`                                                                            | Register `McpOrigin` so the agent name and message survive `toRaw()` |
| `services/web/frontend/js/features/history/**` (4 files)                                                                                    | Show the agent origin and message in the history panel               |
| `services/web/frontend/js/features/ide-react/context/editor-manager-context.tsx`                                                            | Treat agent writes like git-bridge writes (no "overwritten" warning) |
| `services/web/frontend/js/features/ide-react/editor/share-js-doc.ts`                                                                        | Flush delay that live preview can shorten                            |
| `services/web/frontend/js/features/pdf-preview/**` (4 files)                                                                                | `compileDropdownItems` slot and viewer access for the live overlay   |
| `services/web/frontend/js/shared/context/{local,detach}-compile-context.tsx`                                                                | Live preview URL and detached-window hooks                           |
| `services/web/types/settings-page.ts`, `frontend/stories/settings/helpers/linking.js`                                                       | Types and story fixture for the access-token widget                  |
| `services/web/frontend/stylesheets/modules/all.scss`                                                                                        | Import `agent-sync.scss`                                             |
| `services/web/locales/en.json`, `frontend/extracted-translations.json`                                                                      | Module strings; upstream has no per-module locale files              |
| `server-ce/Dockerfile`, `server-ce/services.js`, `server-ce/config/env.sh`, `server-ce/nginx/overleaf.conf`, `server-ce/logrotate/overleaf` | Image wiring for live preview, TeX Live extras, `/git/` proxy        |
| `services/web/Dockerfile`, `services/web/Makefile`, `services/git-bridge/Dockerfile`                                                        | Copy the protocol library and licence files                          |
| `package.json`, `services/web/package.json`, `yarn.lock`                                                                                    | New workspaces and dependencies                                      |

### Patches to replace with upstream code

| File                                                                                                                                 | Plan                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/document-updater/app.js`, `app/js/HttpController.js`, `app/js/DocumentManager.js`, `app/js/Errors.js` and their unit tests | Upstream 6.3 added tracked-change `setDoc` (`trackChanges`, #35820) and comment endpoints (#35833, no create). Switch to those and keep only `addComment` and the returned change ids. |
| `server-ce/config/settings.js` invite-token fix                                                                                      | Fixed upstream in 6.2.2; take upstream's version                                                                                                                                       |

### Files upstream no longer publishes

Upstream commit `4622848a19` removed `develop/`, the per-service Dockerfiles
and Makefiles, `server-ce/test/` and the storybook stories from the public
repository. When a merge reports them as "deleted by them", keep ours: the
fork now owns its development environment and these build files. After that
merge they no longer conflict.

## Merge procedure

1. `git fetch upstream` and identify the release commit as above.
2. Merge it into a branch off `main`, never into `main` directly.
3. Resolve conflicts with the tables above. For `yarn.lock`, take upstream's
   file and run `corepack yarn install` to re-add the fork's entries rather
   than resolving hunks by hand.
4. Run the module unit tests, the document-updater unit tests and the frontend
   type check one at a time, then exercise MCP reads and writes, branches,
   comments and suggestions, git clone/push and live preview on the develop
   stack.
5. Apply the release's hotfix patches if upstream `main` does not have them yet.
6. Record the new base in the table at the top of this file and in
   `CHANGELOG.md`.
