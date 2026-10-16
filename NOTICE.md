# Notice

Interleaf is distributed under the GNU Affero General Public License, version 3
(see `LICENSE`). It is built on, and ships, the work of others under their own
licences. This file lists what this fork adds to upstream Overleaf Community
Edition, where each licence text can be found, and who to thank.

## Upstream

**Overleaf Community Edition** — Copyright (c) Overleaf, 2014-2025. AGPL-3.0.
<https://github.com/overleaf/overleaf>. Everything in this repository not listed
below is upstream's work or derived from it, under the same licence.

## Bundled in the images

| Component | Copyright | Licence | Licence text in the image |
|---|---|---|---|
| [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex) (`rtex`), the live preview engine, built from the fork [Zack-Will/realtime-tex](https://github.com/Zack-Will/realtime-tex) | Copyright (c) 2026 Henry Yang and the realtime-tex contributors | MIT | `/usr/local/share/doc/rtex/LICENSE` in the `interleaf` image |
| [git-bridge](services/git-bridge), the Java Git server | Copyright (c) 2014 Winston Li | MIT | `/usr/share/doc/git-bridge/LICENSE` in the `git-bridge` image; `services/git-bridge/LICENSE` here |
| [TeX Live](https://tug.org/texlive/) `scheme-full` | The TeX Live contributors; each package its own authors | Free software licences, per package (LPPL, GPL, OFL and others) | `/usr/local/texlive/2025/LICENSE.TL` and `LICENSE.CTAN` in the `interleaf` image |
| npm and Maven dependencies, among them the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Their respective authors | Their own licences (the MCP SDK is MIT) | In each package under `node_modules/`, and in the jar's dependency metadata |

## Prior art

These projects were studied before this fork was designed. No code was taken
from them, but they shaped what to build and which problems to expect.

- [OverleafMCP](https://github.com/mjyoo2/OverleafMCP) by mjyoo2: an MCP server
  for Overleaf projects.
- [olgitbridge](https://github.com/chazeon/olgitbridge) by chazeon: a Git bridge
  for Overleaf Community Edition outside the web service.
