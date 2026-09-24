# bx-admin-agent

自研 **Agent harness**：Node/TS 服务端（Hono）+ Vue 前端，可接多家模型与 MCP 数据源，
自带工具循环、上下文治理、写操作闸门、反编造接地护栏、产物交付与运行追踪。

> 设计 / 方案文档见 [`docs/README.md`](./docs/README.md)（含每份文档的定位、代码落点与状态）。
> 本文只回答「怎么跑起来」与「工程由什么组成」。

---

## 1. 工程结构

pnpm workspace（`pnpm-workspace.yaml`：`apps/*` + `packages/*`）。

| 路径 | 说明 |
|---|---|
| `apps/agent-server` | 服务端：Agent 引擎核心。工具循环、上下文治理（压缩 / 卸载 / 句柄）、风险闸门、接地护栏、`export_data` 产物生成、`run_command` 命令执行、trace / 审计 / 成本 |
| `apps/web` | 前端：Vue 3 + Vite 单页。对话流、工具步骤、图表本地渲染（`@antv/g2` / `@antv/g6`）、下载卡片 |
| `packages/shared` | 前后端共享契约（`ChatEvent` 等类型），**改这里等于改协议** |
| `apps/agent-server/scripts` | 功能性脚本：`metabase-mcp.mjs`（BI / text2sql）、`yapi-mcp.mjs`（text2api）、`build-rag-index.mjs`（知识库入库） |
| `apps/agent-server/skills` | 技能库（`.codebuddy/skills/` 同源），模型经 `read_skill` 按需取用 |
| `docs` | 设计 / 方案文档；`docs/knowledge/` 同时是 RAG 语料 |
| `apps/agent-server/.data` | 运行时数据（会话文件、trace、审计、上传）；可用 `AGENT_DATA_DIR` 覆盖 |

## 2. 快速开始

**前置**：pnpm（仓库锁定 `pnpm@11.7.0`）、Node 22+（`@types/node` 为 24.x，开发机 v22 实测可用）、MongoDB。

```bash
pnpm install

# 配置（.env 不入库，从示例复制）
cp apps/agent-server/.env.example apps/agent-server/.env

pnpm dev          # 同时起 server(8787) + web(5173)
# 或分开起
pnpm dev:server
pnpm dev:web
```

常用命令：

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行起前后端 |
| `pnpm test` | 跑 `apps/agent-server` 的 vitest（**零外部依赖**，Mongo 不可用会自动降级内存存储） |
| `pnpm type-check` | web `vue-tsc` + server `tsc --noEmit` |
| `pnpm build` | 构建前端 |

> 仓库内另有 `ecosystem.dev.config.cjs`，用于 pm2 起 dev 服务（`agent-server-dev` / web）。

## 3. 端口与关键环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 服务端端口 |
| `WEB_ORIGIN` | `http://localhost:5173` | 前端来源（CORS） |
| `MONGO_URI` | `mongodb://127.0.0.1:27017` | Mongo 连接；**连不上会降级内存存储**，不会起不来 |
| `MONGO_DB_NAME` | `bx_agent` | 库名（`chat_conversations` / `chat_tasks` / `chat_schedules` / `movie_profiles`） |
| `MODEL_PROVIDERS` | —— | 逗号分隔的模型 id 列表，模型参数见各 `MODEL_<ID>_*` 变量 |
| `MCP_BUILTIN_SERVERS` | —— | 内置 MCP 服务器 JSON 数组（不落盘、前端不可删） |
| `AGENT_DATA_DIR` | 仓库内 `.data` | 仅测试 / 特殊部署覆盖 |

完整清单与注释见 `apps/agent-server/.env.example`。

## 4. 内置工具（21 个，恒注入，与是否勾选 MCP 无关）

`builtins.ts` 的 `BUILTIN_RISK` 登记表是唯一口径：

- **工作区文件**：`fs_read` `fs_ls` `fs_glob` `fs_grep` `fs_write` `fs_edit`
- **产物交付**：`export_data`（xlsx / csv / json / md / docx / pdf / html / txt）
- **图表**：`render_chart`（前端本地渲染，数据不出本机）
- **规划与委派**：`write_todos` `task`（子代理，独立上下文、只回摘要）
- **知识与检索**：`read_skill` `search_tools` `search_knowledge` `knowledge_sources` `web_search` `fetch_url`
- **记忆**：`save_memory` `recall_memory` `record_watched_movies`
- **交互与执行**：`request_clarification` `run_command`（destructive / external，走确认闸门）

> 缺 `fs_delete`：工作区只增不删，属已知待办（见 `docs/artifact-delivery-plan.md` 第 4 项）。

## 5. 几条项目红线

1. **语义判断交给模型，服务端只做护栏**——不在引擎里写业务 if/else。
2. **内置工具恒注入**：勾选 MCP 只表示「接哪些外部数据源」，不决定本机能力。
3. **写操作必须过闸门**（`risk.ts` + 确认卡）；免确认仅限工作区写等零外部副作用动作。
4. **交付物自包含、零外链**：图表烘焙成内联 SVG，不引用 CDN（`externalRefHint` 会对手写 HTML 的外链回灌提示）。
5. **凭据不入日志、不入 trace**；对外接口只返回凭据键名。

## 6. 相关文档

- [`docs/README.md`](./docs/README.md) —— 文档索引（**先看这份**）
- [`docs/agent-infrastructure.md`](./docs/agent-infrastructure.md) —— 通用 Agent 基建检查表（M0–M4）
- [`docs/artifact-delivery-plan.md`](./docs/artifact-delivery-plan.md) —— 产物交付与命令执行治理
- [`docs/mcp-guide.md`](./docs/mcp-guide.md) —— MCP 连接与内置服务器（MCP 主题权威口径）
