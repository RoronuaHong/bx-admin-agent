# yapi-mcp —— PC 后台 MCP 集成规范

> 现行（live）集成规范。对应的历史设计快照见 `docs/agent/` 下标记为「历史」的 PC 后台文档；本文件描述的是当前仓库 `apps/agent-server/scripts/yapi-mcp.mjs` 的真实行为。

## 1. 概述

`scripts/yapi-mcp.mjs` 是一个 **stdio MCP server**（基于 `@modelcontextprotocol/sdk`），`server.name = "yapi-docs"`，版本 `1.0.0`。

职责：把 YApi 接口文档**暴露为 MCP 工具**，并支持**只读调用**真实接口，使领域无关的 deep-agent 框架能直接驱动 PC 后台（bx-film-admin-in2）而无需在 `apps/agent-server/src` 里写死任何该后台的逻辑。

- 文档侧鉴权走**登录态 cookie**：YApi 开放 token 需项目设置生成（普通账号拿不到），账号密码可 `POST /api/user/login` 换 `_yapi_token` / `_yapi_uid`，访问该账号可见的全部项目。
- 调用侧（`call_api`）鉴权由服务端配置（固定 token 或自动登录），模型不可传 token。

## 2. 接入方式

- 经 `.env` 的 `MCP_BUILTIN_SERVERS`（JSON 数组）声明，由 `mcp/config.ts` 在启动期加载；`mcp/hub.ts` 以 `StdioClientTransport`（command/args）拉起子进程并连接。
- 凭据不写进 `MCP_BUILTIN_SERVERS`：`YAPI_` 前缀会从进程环境传给 stdio 子进程（放 `.env` 即可）。其它变量名需要写进该服务器的 `env` 或 `MCP_ENV_PASSTHROUGH`。
- 对话级启用集 `conversation.mcpServers` 持久化本对话是否启用该服务器（`app.ts` 处理勾选/清理悬空引用）。
- 工具命名空间：`mcp__<serverId>__*`（serverId 取 `MCP_BUILTIN_SERVERS` 中该条目的 id）。

## 3. 工具清单（当前仓库版本）

全部工具均声明 `readOnlyHint: true, destructiveHint: false`。

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_projects` | `group_id?` | 列出账号可访问的 YApi 项目（分组 / 项目 id / 项目名） |
| `list_categories` | `project_id`, `include_apis?` | 列出某项目下的接口分类及各分类接口数量 |
| `search_apis` | `keyword`, `project_id?`, `limit?` | 按关键字（名称/路径/分类/标签，空格=同时包含）搜接口 |
| `get_api_desc` | `api_id` | 接口详情：方法/路径/参数（路径/query/body/header）/响应定义 |
| `call_api` | `project_id`, `path`, `query?`, `response_chars?` | **只读**调用：按文档路径发一个 **GET** 拿真实响应；文档里标注非 GET 的路径直接拒绝 |

> `call_api` 方法在 `run` 内被**硬编码为 GET**，且会先查 YApi 文档比对：若文档标注该接口为非 GET（POST/PUT/DELETE），直接拒绝，不执行写操作。唯一的非 GET 请求是适配器内部自动登录换 token，不暴露成工具。
>
> 注：`render_table` / `export_dataset` / `search_api_module` / `get_list_columns` 是**旧版 PC 后台 Agent 的内置工具**（见 `docs/agent/` 历史文档与 `docs/deep-agents-plan.md`：「原 call_api / search_api_module 等业务/领域能力已外置为 MCP 服务器 bi / yapi / movie / chart」）。它们在当前 `apps/agent-server/src` 已随「通用 deep-agent 框架」重构而移除；本 `yapi-docs` MCP server 是外置后的现实形态——只提供接口文档发现 + 只读 `call_api`，**不含**上述渲染/导出/模块检索类工具。这些旧工具名称仅在历史文档中保留作参考。

## 4. 只读安全模型

- 工具自述 `readOnlyHint: true` —— 这是**事实声明**而非放行：服务端风险闸门（`src/risk.ts` 第 4 条注解判定）据此把这些工具按只读处理，**不再对每个只读查询弹确认卡**。
- 若某服务存在非规范的 GET 写接口，可在服务器配置（`MCP_BUILTIN_SERVERS` 条目的 `toolRisks`）里覆盖该声明 —— **服务端策略优先级高于工具自述**。
- `call_api` 的 GET-only 是**代码层硬约束**（不仅是声明），写操作无法被模型触发。

## 5. 环境变量配置（由父进程继承 `.env`，本文件不落任何凭据）

| 变量 | 说明 |
|---|---|
| `YAPI_BASE_URL` | YApi 站点地址 |
| `YAPI_LOGIN_EMAIL` / `YAPI_LOGIN_PASSWORD` | YApi 登录邮箱/密码（换 cookie，访问该账号可见项目） |
| `YAPI_COOKIE` | 可选：现成 cookie 串（填了跳过登录，便于排障） |
| `YAPI_PROJECT_IDS` | 可选：限定搜索范围的项目 id（逗号分隔） |
| `YAPI_CACHE_TTL` | 接口元数据缓存分钟数（默认 10，0=不缓存） |
| `YAPI_CALL_BASES` | 调用真实接口的地址，`项目id=基地址` 逗号分隔 |
| `YAPI_CALL_HEADERS` / `YAPI_CALL_HEADERS_<id>` | 全局/项目级固定请求头（`名: 值`，逗号分隔） |
| `YAPI_CALL_QUERY_<id>` | 项目级固定 query（`键=值` 逗号分隔；某些服务缺了返回加密响应） |
| `YAPI_CALL_TOKEN` | 可选：固定 Bearer token（填了不再自动登录） |
| `YAPI_CALL_LOGIN_NAME` / `YAPI_CALL_LOGIN_PASSWORD` | 业务后台账号（自动登录换 token 用） |
| `YAPI_CALL_LOGIN_PATH_<id>` | 该项目的登录接口路径（POST，仅适配器内部调用） |
| `YAPI_CALL_AUTH_SCHEME` | `bearer` \| `raw`（默认先 Bearer，401 自动换裸 token 再试） |
| `YAPI_CALL_TIMEOUT_MS` | 调用超时（默认 15000） |

## 6. 结果截断与限流

- 单次工具结果上限 `MAX_TEXT = 8000` 字符；`call_api` 响应体上限 `MAX_CALL_CHARS = 30000`，默认 `response_chars = 4000`。
- 任何工具结果绝对上限 `MAX_RESULT_CHARS = 70000`（为转义膨胀留余量，保证外层 JSON 不被截断）。
- 搜索时一次最多扫描 `MAX_PROJECTS = 30` 个项目（防请求风暴）。

## 7. 与历史文档的关系

被标记为「历史快照」的 `docs/agent/` PC 后台文档（`PC_STRUCTURE_AND_OUTPUT_TYPES` / `WORKFLOW_CLARIFICATION_GATE` / `PORTAL_*` / `CHAT_FLOW` 等）描述的正是本集成暴露的接口契约/治理约定 —— **该能力当前仍活跃**，只是以 MCP server 形式存在、而非写死在 agent-server 源码里。标记「历史」是因为它们写的是该 MCP server 的契约，不属于 deep-agent 框架本身。
