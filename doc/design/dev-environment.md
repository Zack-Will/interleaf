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

## 风险

- 并行度 1 会拉长构建时间，但避免 7.7 GiB 内存下的 OOM。
- 80 端口是特权端口，由 rootful Docker 绑定，无需 root 用户。
- `develop` 把宿主 Docker socket 挂进 `clsi`，跳过 clsi 也就避开了这一权限面。
- acceptance 测试容器依赖私有 `saml-test` 镜像，跑模块 acceptance 前需 override 去掉该依赖。
