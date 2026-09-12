# Overleaf CE 内建 MCP 与 git-bridge 共存架构设计

- 基线：`overleaf/overleaf@28ad3b0`（fork：`Zack-Will/overleaf`）
- 状态：v1.1（2026-09-12，按评审反馈修订）
- 范围：在 Community Edition 上，不依赖 Server Pro 闭源模块，同时提供
  1. 面向 AI agent 的内建 MCP（Model Context Protocol）端点
  2. 与官方 Java git-bridge 完全兼容的 Git 集成

  两者共享同一套令牌、版本与写入内核，改动出现在同一条历史时间线上。

### v1.1 相对 v1 的变化

| 变化 | 原因 |
|---|---|
| 明确设计原则：agent 易用性第一，可回滚修改树，可建临时分支，优先原生接口 | 项目负责人反馈 |
| 项目标识统一为 URL 中的 24 位十六进制 id，工具同时接受完整 URL | 复制项目链接给 agent 即可定位 |
| 去掉 Redis 变更集，改为 `write_files` 一次原子写入 + 一个 label | 减少往返与状态管理 |
| 修改树 = 历史 label + 最小分支链接记录，不再新建节点集合 | 原生接口优先；历史面板天然可视化 label 并支持一键回退 |
| 里程碑重排：MCP 读写与分支先于 git-bridge 适配器 | agent 侧收益最大，git 侧已有外置桥过渡 |
| Web UI 可视化列为增量目标 | 先铺基础能力 |

---

## 1. 设计原则

1. **agent 易用性第一**。工具少而正交，参数显式，无会话隐式状态，错误可执行。
2. **每次 agent 写入都是可回滚的一个节点**。写入必带 message，落地即打 label，人在历史面板里能看见、能一键恢复。
3. **临时分支是一等能力**。agent 可以在不打扰主线的副本上工作，再以可审阅的方式合回。
4. **原生接口优先**。复用 Overleaf 已有的 handler、history label、RestoreManager、ProjectDuplicator，不引入新的抽象层与存储，除非原生能力确实缺失。
5. **可视化增量交付**。历史面板已能展示 label 与来源；专门的树视图、设置页 UI 后续再补。
6. **改动集中在 `services/web/modules/` 下**，upstream 升级时 rebase 成本最小。

### 项目标识约定

所有工具的 `project` 参数接受两种形式，服务端统一解析：

- 24 位十六进制 id：`68c1f9a3e4b0c2d1a5f6e7b8`
- 完整 URL：`https://overleaf.example.com/project/68c1f9a3e4b0c2d1a5f6e7b8`（允许带尾部路径或查询串）

所有返回项目的地方同时给出 `project_id` 与 `url`，agent 回复用户时可直接贴链接。

---

## 2. 现状：CE 里有什么、缺什么

行号以 `28ad3b0` 为准。

### 2.1 已存在、可直接复用

| 能力 | 位置 | 说明 |
|---|---|---|
| web 模块加载机制 | `services/web/app/src/infrastructure/Modules.mjs:43-91` | 按 `Settings.moduleImportSequence` 加载 `modules/<name>/index.mjs` |
| 无 CSRF 路由挂点 | `services/web/app/src/infrastructure/Server.mjs:231` | `applyNonCsrfRouter` 在 CSRF 之前执行，机器客户端端点走这里 |
| 项目级最新版本号 | project-history `GET /project/:id/version`（`services/project-history/app/js/Router.js:24`） | `{version, timestamp, v2Authors}` |
| 指定版本的全项目快照 | project-history `GET /project/:id/version/:version`（`Router.js:72`） | `SnapshotManager.js:115-116` 注释："Used by git bridge" |
| 历史 label | `HistoryManager.mjs` / project-history `Router.js:38-55` | 命名版本；前端历史面板可展示并"恢复到此版本" |
| 外部写入合并器 | `ThirdPartyDataStore/UpdateMerger.mjs:91` | `_mergeUpdate(userId, projectId, path, fsPath, source)`，注释 `// called by GitBridgeHandler` |
| 文档级设值 | `DocumentUpdaterHandler.mjs:117` `setDocument(...)` | document-updater 对新旧内容做 diff 生成 OT 操作，并发人工编辑不会被覆盖 |
| origin 透传到历史 | `project-history/app/js/UpdateTranslator.js:140-144` | `source` 传对象 `{kind:'git-bridge'}` 即成为 `change.origin`；前端 `origin.tsx:10` 已渲染 "(via Git)" |
| 项目复制 | `Project/ProjectDuplicator.mjs:37` | `duplicate(owner, projectId, name, tags, opts)` |
| 版本回退 | `History/RestoreManager.mjs`，路由 `HistoryRouter.mjs:82-92` | `revert_file` / `revert-project`，origin 为 `restore` 系列 |
| 权限判定 | `Authorization/AuthorizationManager.mjs:260-334` | `canUserReadProject` / `canUserWriteProjectContent`，不依赖 session |
| 项目锁 | `infrastructure/LockManager.mjs` | Redis 锁 |
| 前端挂点 | `settings.defaults.js:1029,1056,1101` | `overleafModuleImports.gitBridge / integrationLinkingWidgets / integrationPanelComponents` |
| 功能开关 | `Features.mjs:66-67` | `Settings.enableGitBridge`，CE 从未赋值 |
| Java git-bridge 源码与镜像 | `services/git-bridge/`，`quay.io/sharelatex/git-bridge` | MIT；`server-ce/test/docker-compose.yml:59-68` 展示接线 |

### 2.2 缺失、需要新建

| 缺口 | 影响 |
|---|---|
| 个人访问令牌模型、校验、管理接口 | 机器客户端无法按用户鉴权（**M1 已实现，见第 8 节**） |
| MCP 端点与工具 | 全仓库零引用 |
| 任何 compare-and-swap 写接口 | agent 写入没有基线校验 |
| 分支链接记录 | fork 出来的项目与父项目之间没有关系数据 |
| web 侧 `/api/v0/docs/*` 四个端点 | git-bridge 无法取版本、快照，无法推送 |
| `/oauth/token/info` | git-bridge 无法校验令牌（**M1 已实现**） |
| `enableGitBridge` 赋值、nginx `/git/` 路由、compose 服务 | git 功能开关永远关闭 |
| 编辑器 Git 模态框、设置页令牌 UI、修改树视图 | 可视化，增量交付 |

---

## 3. 总体架构

```mermaid
flowchart LR
  subgraph Clients
    H[人 · 浏览器编辑器]
    A[Agent · MCP 客户端]
    G[人 · git CLI]
  end

  subgraph Edge
    N[nginx]
  end

  subgraph "sharelatex 容器 · web"
    direction TB
    MCP[modules/mcp<br/>/mcp  Streamable HTTP]
    GB[modules/git-bridge<br/>/api/v0/docs/*]
    CORE[modules/project-sync<br/>Token · Version · Snapshot · Write · Branch]
    MCP --> CORE
    GB --> CORE
  end

  subgraph "git-bridge 容器"
    JB[Java git-bridge]
  end

  subgraph "现有内部服务"
    DU[document-updater]
    PH[project-history]
    M[(Mongo / Redis)]
  end

  H -->|socket.io| N
  A -->|HTTPS + Bearer olp_token| N
  G -->|/git/:id| N
  N --> MCP
  N --> GB
  N -->|去前缀| JB
  JB -->|Bearer token| GB
  GB -.postback.-> JB
  CORE --> DU
  CORE --> PH
  CORE --> M
  DU --> PH
```

三个模块，一个依赖方向：

```
modules/project-sync   核心库 + 令牌 + 分支链接          （无外部依赖）
modules/mcp            MCP 适配器                        dependencies: ['project-sync']
modules/git-bridge     HTTP 适配器 + nginx/compose 接线    dependencies: ['project-sync']
```

### 3.1 共存的关键约束

1. **单一真相源**：读一律经 project-history 快照，写一律经 `UpdateMerger` / `setDocument` 进入 document-updater。
2. **统一版本坐标**：`project_version`（project-history 单调递增版本号）是唯一的项目级基线。git-bridge 的 `latestVerId` 就是它；MCP 写入的 `base_version` 也是它。
3. **来源可辨**：写入 `source` 传对象，`{kind:'git-bridge'}` 或 `{kind:'mcp', agent, message}`。历史面板显示 "(via Git)" / "(via Agent)"。
4. **互相可见**：git push 产生新版本，agent 下一次读到的 `project_version` 就变了；agent 写入的版本，`git pull` 作为新 commit 拉下来。
5. **同一把锁**：`project-sync` 对每个项目一个写锁，覆盖"应用改动 + 打 label"这一小段。

---

## 4. 核心模块 `modules/project-sync`

```
services/web/modules/project-sync/
├── index.mjs
├── app/src/
│   ├── models/PersonalAccessToken.mjs    # 已实现
│   ├── models/SyncBranch.mjs             # 分支链接记录（M3）
│   ├── TokenService.mjs                  # 已实现
│   ├── TokenAuthMiddleware.mjs           # 已实现：requireAccessToken(scope)
│   ├── ProjectSyncRouter.mjs             # 已实现：/oauth/token/info、令牌管理 REST
│   ├── ProjectRef.mjs                    # 解析 id / URL，权限检查
│   ├── VersionService.mjs                # flush + 取 project_version
│   ├── SnapshotService.mjs               # 指定版本快照、二进制签名 URL
│   ├── WriteService.mjs                  # write_files 原子写入 + label
│   ├── BranchService.mjs                 # fork / diff / merge / archive
│   └── Errors.mjs                        # 已实现
└── test/unit/src/
```

### 4.1 个人访问令牌（已实现）

`personalAccessTokens` 集合：`user_id`、`tokenPrefix`（前 8 位）、`hashedToken`（sha256，唯一）、`scopes`（`git_bridge` | `mcp`）、`label`、`createdAt`、`expiresAt`、`lastUsedAt`。令牌格式 `olp_` + 16 位字母数字。`requireAccessToken(scope)` 接受 `Bearer <token>` 或 `Basic git:<token>`，成功后 `req.syncUser = {userId, scopes, tokenId}`；失败返回 `401 {error_code: token_malformed|token_invalid|token_expired}` 或 `403 insufficient_scope`。实现了 `listPersonalAccessTokens` / `cleanupPersonalAccessTokens` 两个 hook。

### 4.2 项目引用与权限

```js
// ProjectRef.resolve('https://host/project/68c1…/…') → { projectId: '68c1…', url }
// ProjectRef.requireAccess(userId, projectId, 'read' | 'write')
//   → AuthorizationManager.promises.canUserReadProject / canUserWriteProjectContent
```

### 4.3 版本服务

```js
async function getLatestVersion(projectId) {
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  await HistoryManager.promises.flushProject(projectId)
  return projectHistory.get(`/project/${projectId}/version`)   // {version, timestamp}
}
```

机器客户端没有"重新编译"来触发 flush，所以读版本前必须自己 flush 两层。

### 4.4 快照服务

`getSnapshot(projectId, version)` → project-history `GET /project/:id/version/:version`，返回 `{files: {path: {data:{content}} | {data:{hash}}}}`。文本直接给内容；二进制给 blob hash，对外经 web 提供 HMAC 签名的短时 URL（供 git-bridge 无鉴权头拉取，见 6.1）。对文件数与总字节设上限，超限返回 `413`。

### 4.5 写服务与修改树

**每次写入 = 锁内应用 + 一个 label。** label 的 comment 就是 agent 传入的 message，version 是写入后的 `project_version`。这样：

- 历史面板里每个 agent 写入都是一条命名版本，人一眼可见，且原生支持"恢复到此版本"。
- `list_history` 直接读 label 与 updates，不需要新的节点集合。
- 回滚 = `RestoreManager` 恢复到某个 label 的版本，origin 为 `project-restore`，本身又是一个新版本。线性历史下回滚是向前的，语义与 git revert 一致。

```js
async function writeFiles(projectId, userId, {baseVersion, message, agent, upserts, deletes}) {
  return LockManager.runWithLock(`sync:${projectId}`, async () => {
    const current = await getLatestVersion(projectId)
    if (baseVersion != null && current.version !== baseVersion)
      throw new VersionConflictError({expected: baseVersion, actual: current.version})
    const origin = {kind: 'mcp', agent, message}
    for (const {path, fsPath} of upserts)
      await UpdateMerger.promises._mergeUpdate(userId, projectId, path, fsPath, origin)
    for (const path of deletes)
      await UpdateMerger.promises.deleteUpdate(userId, projectId, path, origin)
    const after = await getLatestVersion(projectId)
    await LabelsService.create(projectId, userId, after.version, message)
    return {version: after.version, label}
  })
}
```

要点：

- `_mergeUpdate` 自动判 doc / file、自动建目录、自动广播实时事件，编辑器即时刷新。
- `setDocument` 在 document-updater 内做 diff 生成 OT 操作，锁外有人正在打字也不会被整段覆盖。`base_version` 校验解决的是"agent 基于过期内容做决策"的语义问题。
- `deleteUpdate` 目前吞错误只打 warn（`UpdateMerger.mjs:137-142`），封装层要显式收集失败并返回。
- 单文件写只是 `upserts` 长度为 1 的特例，不单独实现一套。

### 4.6 分支服务

Overleaf 的历史是单项目线性的，分支只能是**另一个项目**。原生的 `ProjectDuplicator.duplicate` 已经能复制全部内容，缺的只是"这个副本是谁的分支、基于哪个版本"这条关系。

`syncBranches` 集合（唯一新增的存储）：

```js
{ branchProjectId, parentProjectId, baseVersion, name, createdBy, createdAt,
  status: 'open' | 'merged' | 'archived', mergedVersion }
```

操作：

| 操作 | 实现 |
|---|---|
| `create_branch(project, name)` | `ProjectDuplicator.promises.duplicate(owner, id, "<原名> [branch: name]")`，记录 `baseVersion` = 父项目当前版本 |
| `list_branches(project)` | 查集合，附带每个分支的当前版本与 URL |
| `diff_branch(branch)` | 三方比较：父项目 `baseVersion` 快照、分支最新快照、父项目最新快照；输出每个文件的状态（仅分支改、仅主线改、双方改、冲突） |
| `merge_branch(branch, dry_run=true)` | 文本文件做三方合并（`diff3` 语义，用 `diff` 包或 `node-diff3`）；二进制以分支为准但双方都改则报冲突。`dry_run` 返回合并结果与冲突 hunk；确认后以 `writeFiles` 落到父项目，message 为 `merge branch <name>`，标记 `status: merged` |
| `archive_branch(branch)` | 项目归档（`ProjectDeleter.archiveProject`），状态置 `archived` |

冲突策略：**只返回冲突，不自动应用**。agent 拿到冲突 hunk 后在分支上解决再重新 merge，或让人在编辑器里处理。

分支项目会出现在用户项目列表里，名字带 `[branch: …]` 后缀。这是原生行为，也让人随时能打开分支看内容。后续 UI 可以把它们折叠到父项目下。

---

## 5. 适配器 `modules/mcp`

### 5.1 传输与鉴权

- `POST/GET/DELETE /mcp`，Streamable HTTP，`@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`，经 `nonCsrfRouter` 挂到 `publicApiRouter`。
- `requireAccessToken('mcp')`。Claude Code：`claude mcp add --transport http <url> --header "Authorization: Bearer olp_…"`；仅支持 OAuth 的客户端经 `mcp-remote`。
- **无状态**：每个请求独立，不用 session，不发 cursor；状态由 `project_version` 与显式参数表达。

### 5.2 工具面

所有工具 `project` 参数接受 id 或 URL。所有读返回 `project_version`；所有写要求 `message`，返回新的 `project_version` 与 label。

| 工具 | 输入 | 输出 / 语义 |
|---|---|---|
| `list_projects` | | 可读项目：`project_id`、`url`、`name`、`permissions: read|write` |
| `get_project` | `project` | 文件树、根文档、`project_version`、`permissions`、分支信息 |
| `read_file` | `project`, `path`, `range?` | 内容、`sha256`、`project_version`；大文件按行范围分片 |
| `get_outline` | `project`, `path?` | LaTeX 章节结构，服务端解析 |
| `search` | `project`, `query`, `regex?` | 命中列表，含行号与上下文 |
| `write_files` | `project`, `base_version?`, `message`, `files[]`（`{path, content | content_base64 | delete:true}`） | 原子写入 + label。`base_version` 不符 → `conflict`，附当前版本与相关文件的 diff |
| `edit_file` | `project`, `path`, `base_version`, `edits[]`, `message` | `edits` 支持 `replace_range` / `replace_anchor`（文本锚点）/ `replace_section`（按标题）。服务端算出新内容后走 `write_files` |
| `list_history` | `project`, `limit?`, `before?` | label 列表 + updates，含 origin 与作者 |
| `diff` | `project`, `from_version`, `to_version`, `path?` | project-history diff |
| `revert_to` | `project`, `version`, `path?`, `message` | `RestoreManager`，返回新版本 |
| `create_branch` / `list_branches` / `diff_branch` / `merge_branch` / `archive_branch` | 见 4.6 | |

返回同时提供 `content`（人类可读文本）与 `structuredContent`（机器字段）。错误统一为 `{code, message, expected_version?, actual_version?, next_action}`：

```json
{
  "code": "version_conflict",
  "expected_version": 41,
  "actual_version": 42,
  "diff_since_expected": {"main.tex": "@@ -10,3 +10,4 @@ ..."},
  "next_action": "re-read the listed files, re-apply your change, retry with base_version=42"
}
```

### 5.3 归属与可见性

- origin `{kind:'mcp', agent:'<MCP client name>', message}`。
- 前端 `origin.tsx` 增加 `mcp` → "(via Agent)"；`editor-manager-context.tsx:238` 的 `source === 'git-bridge'` 判断扩展为包含 `mcp`。

---

## 6. 适配器 `modules/git-bridge`

契约细节来自 Java 源码，与 v1 相同，此处保留要点。

### 6.1 HTTP 契约

全部经 `nonCsrfRouter` 挂到 `publicApiRouter`，鉴权 `requireAccessToken('git_bridge')`：

| 端点 | 行为 | 依据 |
|---|---|---|
| `GET /oauth/token/info` | 有效 `200 {}`；过期 `401 {"error_code":"token_expired"}` | `Oauth2Filter.java:283-299`（已实现） |
| `GET /api/v0/docs/:id` | 无读权限 `403`；否则 `{latestVerId, latestVerAt, latestVerBy}`，空项目 `0` | `GetDocResult.java:68-105` |
| `GET /api/v0/docs/:id/saved_vers` | labels → `[{versionId, comment, user, createdAt}]` | `GetSavedVersResult.java:48-54` |
| `GET /api/v0/docs/:id/snapshots/:v` | `{srcs:[[content,path]], atts:[[signedUrl,path]]}` | `SnapshotData.java:52-56` |
| `POST /api/v0/docs/:id/snapshots` | 无写权限 `403`；版本不符 **HTTP 200** `{code:"outOfDate"}`；否则 `200 {code:"accepted"}` + 异步应用 | `Request.java:74-133`：非 2xx 都会被当成别的异常 |
| `GET /api/v0/docs/:id/blobs/:hash?token=&_path=` | HMAC 校验后流式返回 | git-bridge 取附件不带鉴权头 |

推送应用：下载 `files[].url`（`http://git-bridge:8000/api/<pid>/<uuid>?key=…`），删除 = 当前路径集减去 `files[].name`，经 `WriteService.writeFiles` 落地（origin `git-bridge`，message 取自 git commit），360 秒内 POST postback `{code:"upToDate", latestVerId}`。

### 6.2 接线

- `server-ce/config/settings.js`：`enableGitBridge = GIT_BRIDGE_ENABLED === 'true'`，`gitBridgePublicBaseUrl = siteUrl + '/git'`，`apis.gitBridge.url`。
- nginx：`location /git/ { proxy_pass http://git-bridge:8000/; }`（去前缀，`Oauth2Filter` 期望路径直接是 `/<projectId>`）。
- compose：照抄 `server-ce/test/docker-compose.yml:59-68`。
- 项目删除时通知 `DELETE /api/projects/:id`。
- `git-bridge.spec.ts:450-457` 断言"CE 设了变量也不能启用"，fork 里反转这一条。

---

## 7. 数据流示例

### 7.1 agent 写入与 git push 交错

```
t0  project_version = 10
t1  agent: read_file main.tex                      → project_version 10
t2  人:   git push（latestVerId 10）                → accepted，应用中
t3  agent: write_files base_version=10             → 取锁等待 → 版本已是 11 → conflict，附 diff
t4  agent: 基于 diff 重做 → base_version=11        → 成功，version 12，label "tighten intro"
t5  人:   历史面板看到 v11 (via Git)、v12 (via Agent, label)，可一键恢复到 v11
t6  人:   git pull → 两次 commit
```

### 7.2 分支

```
agent: create_branch P "exp-figures"   → 分支项目 D，baseVersion 12，URL 可直接给人
agent: 在 D 上多次 write_files，每次一个 label
agent: diff_branch D                   → 文件级状态 + 冲突预告
agent: merge_branch D dry_run=true     → 合并结果与冲突 hunk
人 / agent: 确认 → merge_branch D dry_run=false → P 上一个 label "merge branch exp-figures"
agent: archive_branch D
```

---

## 8. 实施里程碑

| 阶段 | 交付 | 状态 |
|---|---|---|
| **M1 令牌与鉴权** | PAT 模型与服务、`requireAccessToken`、`/oauth/token/info`、令牌管理 REST、单元测试 | 代码已在分支 `feat/project-sync-tokens`（8 个提交），待跑测试与评审修正 |
| **M2 MCP 读写** | `ProjectRef`、`VersionService`、`SnapshotService`、`WriteService`（含 label）、MCP 传输、工具 `list_projects` / `get_project` / `read_file` / `get_outline` / `search` / `write_files` / `edit_file` / `list_history` / `diff` / `revert_to`、"(via Agent)" 前端标签 | 下一步 |
| **M3 分支** | `SyncBranch` 模型、`BranchService`、五个分支工具、三方合并 | |
| **M4 git-bridge 适配器** | 四个只读端点、签名 blob URL、推送与 postback、settings / nginx / compose、删除通知 | |
| **M5 可视化** | 设置页令牌区块、编辑器 Git 模态框、分支折叠与修改树视图 | 增量 |
| **M6 加固** | 速率限制、大项目上限、指标、最小 OAuth（如有客户端需要） | |

M2 完成即可端到端使用：拿令牌、把项目链接贴给 agent、agent 读写并留下可回滚的 label。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| upstream 每月发版，内部函数签名变化 | 核心只依赖少数内部函数，集中在 `project-sync` 内；CI 跑单元与 acceptance 测试 |
| 大项目快照内存 | 文件数 / 字节上限；MCP 读取始终分片 |
| 三方合并对 LaTeX 的语义盲区 | 只做行级合并并如实报冲突；不自动解决 |
| 分支项目污染项目列表 | 命名约定 + 后续 UI 折叠；`archive_branch` 及时归档 |
| 令牌泄露即项目读写权 | scope、过期、可撤销；所有写入带 origin 与 label 可审计 |
| CE 无 OAuth 服务器，部分 MCP 客户端连不上 | 先 Bearer；M6 视需要做最小 OAuth 2.1 |
| AGPL 义务 | fork 公开 |

---

## 10. 决策记录

1. **不复用 `TpdsController` 私有 API**：共享密钥鉴权、无用户归属。
2. **CAS 粒度用项目版本**：写入锁内校验，简单且与 git 一致；文档级版本不再单独暴露。
3. **去掉变更集**：`write_files` 数组即事务。
4. **修改树用 label 表达，不新建节点集合**：原生、可视、可恢复。
5. **分支 = fork 项目 + 一条链接记录**：唯一新增存储。
6. **冲突只报不合**。
7. **不实现 OAuth2 授权服务器**：git-bridge 的 `Oauth2Filter` 实际只做 bearer 校验。
8. **模块三分**：便于按需启用与向 upstream 贡献。
