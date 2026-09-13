# 本地集成环境 runbook（M2.5）

目标：在本机跑一个可改代码即生效的 Overleaf CE，作为 `project-sync` / `mcp` / `git-bridge` 模块的端到端验证靶子。结论来自对 `develop/`、`server-ce/`、`services/web/test/acceptance` 的只读调研，**尚未实际构建过**，时间与体积是推断值。

## 路线选择

| 路线 | 适合 | 不适合的原因 |
|---|---|---|
| **`develop/` compose + dev overlay（推荐）** | 迭代模块代码：`services/web/modules` 热挂载，web 与 webpack 都 `--watch` | |
| 根目录 `docker-compose.yml` | 无 | 拉的是官方发布镜像，不含我们的模块 |
| `server-ce/` 自建镜像 | 最终验收、部署 | 从头编 TeX Live 和生产 webpack，3 核机器上极慢 |
| `server-ce/test/` Cypress 套件 | 无（本机） | 依赖 Overleaf 内部镜像仓库，测的是预构建镜像 |
| `services/web` acceptance 容器 | 模块 acceptance 测试 | 依赖 `saml-test` 私有镜像，需 override 去掉 |

## `develop/` 环境事实

- 14 个服务：`web`、`webpack`、`clsi`、`clsi-nginx`、`chat`、`docstore`、`document-updater`、`filestore`、`notifications`、`project-history`、`history-v1`、`real-time`、`mongo`、`redis`。`project-history` 与 `history-v1` 都在，是我们服务依赖的两个后端。
- 源码热挂载只在 `docker-compose.dev.yml` 里：`web` 挂 `app, app.mjs, config, locales, modules, public`；`webpack` 挂 `app, config, frontend, locales, modules, public, transform, types, webpack-plugins`。**两者都要用 dev overlay 起**。
- 唯一 HTTP 入口是 `webpack` 的 `127.0.0.1:80 → 3808`，它把 `/socket.io` 代理到 `real-time`，其余非静态请求代理到 `web:3000`。
- `develop/bin/dev` 依赖未安装的 `docker-compose` v1，`bin/logs` 依赖未安装的 `ggrep` 与 `bunyan`，两者在本机不可用，用展开命令代替。
- 首次初始化只有一步：打开 `http://localhost/launchpad` 创建管理员。Mongo 副本集由 `bin/shared/mongodb-init-replica-set.js` 自动初始化。
- 数据：`history-v1` 用 named volume `history-v1-buckets`，`PERSISTOR_BACKEND=fs`；`project-history` 状态在 mongo 与 redis。`develop/output/` 不存在，Docker 会以 root 创建。
- 未验证：`history-v1` 是否需要 `HISTORY_CONNECTION_STRING`（compose 里没有 Postgres）。启动后看日志。

## 本机现状

- Docker 29.2.1，compose 插件 v5.1.0，用户在 docker 组，3 核，7.7 GiB 内存，`/var/lib/docker` 所在盘剩 77 GB，Docker 内 12.5 GB 可回收。
- **6379 已被宿主机 Redis 占用**，其余 develop 发布的端口（80、27017、9229 至 9240）空闲。3000 与 3100 虽被占用，但 develop 不向宿主发布这两个端口。

## 推荐命令序列

```bash
cd /home/zack/overleaf-workspace/overleaf/develop

# 1. Redis 调试端口改映射，避免与宿主机 6379 冲突（应用走容器网络名，不受影响）
cat > docker-compose.override.yml <<'EOF'
services:
  redis:
    ports:
      - "127.0.0.1:6380:6379"
EOF

# 2. 3 核机器限制并行度
printf 'COMPOSE_PARALLEL_LIMIT=1\n' > .env

# 3. 只构建并启动不含 clsi 的 12 个服务（省掉 texlive 的 1 到 2 小时）
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.override.yml \
  up --build --detach \
  web webpack chat docstore document-updater filestore notifications project-history history-v1 real-time mongo redis

# 4. 看日志
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f web webpack project-history history-v1

# 5. 管理员：浏览器打开 http://localhost/launchpad

# 6. 进 web 容器
docker compose exec -it web /bin/bash

# 7. 停止（加 -v 清卷）
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

需要编译 PDF 时再补 `clsi clsi-nginx` 两个服务。

## 验证清单（首次起来后）

1. `/launchpad` 建管理员，登录，新建一个项目。
2. 设置页调用 `POST /user/personal-access-tokens` 拿令牌（M5 之前用 curl 带 session cookie 与 CSRF，或在浏览器控制台用 `fetch-json`）。
3. `curl -H "Authorization: Bearer olp_…" http://localhost/oauth/token/info` 期待 `200 {}`。
4. MCP：`claude mcp add --transport http overleaf http://localhost/mcp --header "Authorization: Bearer olp_…"`，依次 `list_projects` → `read_file` → `write_files` → 在编辑器历史面板确认 label 与 "(via Agent)"。
5. 冲突路径：编辑器里改一行，agent 用过期的 `base_version` 写入，应返回 `version_conflict`。

## 实测修正（2026-09-12 首次拉起）

以上 runbook 按调研写成，实际拉起时踩到六个坑，修正如下，命令序列以本节为准：

1. **镜像站极慢**：daemon 配置的 docker.1ms.run 等镜像站只有 60 KB/s，直连 Docker Hub 有 7 MB/s。用带完整主机名的地址绕过镜像站预拉基础镜像，再打回原名：
   `docker pull registry-1.docker.io/library/node:24.14.1 && docker tag registry-1.docker.io/library/node:24.14.1 node:24.14.1`（mongo、redis、nginx 同理）。
2. **并行构建打死机器**：`docker compose up --build` 会并行构建全部镜像，`COMPOSE_PARALLEL_LIMIT` 管不住 BuildKit，3 核 7.7 GiB 直接无响应重启。改为逐个 `nice -n 15 docker compose build <svc>`，10 个 Node 服务共约 15 分钟。
3. **`ports` 覆盖要用 `!override`**：compose 对列表是合并而非替换，否则 6379 仍会被绑定。
4. **MongoDB 8.0 / 8.3 在 6.19 以上内核拒绝启动**（SERVER-121912，tcmalloc rseq），本机 7.0 内核。`mongo:8.2` 与 `mongo:7` 可用，override 里固定 `image: mongo:8.2`。
5. **`web` 依赖 `clsi`**：不构建 clsi 时 `up` 要加 `--no-deps`，先起 mongo、redis，再起其余服务。
6. **`web-data` 卷是 root 属主而进程以 node 运行**：任何写 `data/dumpFolder` 的路径（上传、TPDS、我们的 `writeFiles`）都会 `EACCES`。首次启动后执行
   `docker compose exec -u root web chown -R node:node /overleaf/services/web/data`。

7. **单文件绑定挂载在 git 切换分支后会失效**：`document-updater/app.js`、`webpack.config.dev-env.js` 等以单文件挂载进容器；git checkout/merge 替换了宿主文件的 inode 后容器仍看到旧内容（表现为新路由 404、`node --watch` 也不会触发）。改动这些文件后必须 `docker compose up -d --no-deps --force-recreate <svc>`。目录挂载（`app/`、`modules/`）没有这个问题。
8. **`libraries/*` 没有挂载进任何容器**：改动 `overleaf-editor-core` 等共享库后需重建 web、project-history、history-v1 镜像（逐个 `nice` 构建约 3 分钟）。

当前 `develop/docker-compose.override.yml`（未入库）：

```yaml
services:
  redis:
    ports: !override
      - "127.0.0.1:6380:6379"
  mongo:
    image: mongo:8.2
```

**首次端到端结果**：`/oauth/token/info` 与 `/mcp` 无令牌均返回 401；用内部 API 建管理员、令牌与项目后，MCP 走通 `get_project → read_file → write_files(v2, label) → 过期 base_version 被拒(version_conflict, next_action) → edit_file(v3, diff) → revert_to(v4)`；project-history 里三次改动的 origin 均为 `{kind:'mcp'}` 并各带一个 label。暴露的协议缺陷：数组型 `structuredContent` 被 SDK 拒绝（`list_projects` / `list_history` / `get_outline` / `search`），需改为对象。

## 风险

- 并行度 1 会拉长构建时间，但避免 7.7 GiB 内存下的 OOM。
- 80 端口是特权端口，由 rootful Docker 绑定，无需 root 用户。
- `develop` 把宿主 Docker socket 挂进 `clsi`，跳过 clsi 也就避开了这一权限面。
- acceptance 测试容器依赖私有 `saml-test` 镜像，跑模块 acceptance 前需 override 去掉该依赖。
