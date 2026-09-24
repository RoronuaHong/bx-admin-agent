# 文档索引（docs/）

> 用途：说明每份文档的**定位 / 覆盖范围 / 现行代码落点 / 状态 / 阅读注意**，
> 避免「多份文档互相打架、不知道看哪份」。建立：2026-09-24。
>
> **效力约定**
> 1. **代码是唯一真相**：文档里的行号/片段都会漂移，核对时先搜函数名。
> 2. 同名主题以**现行**文档为准；留档/快照只用于理解决策背景。
> 3. 文档间冲突时：现行 > 留档/快照，并在冲突处回写指引（如 `mcp-connect-plan.md` 顶部已标注以 `mcp-guide.md` 为准）。
> 4. 「未逐条复核」= 本次只验证了文中声明的关键落点存在，**不代表逐句比对过**。

---

## 一、现行设计 / 方案文档

### [artifact-delivery-plan.md](./artifact-delivery-plan.md)
- **定位**：产物交付闭环（模型生成文件 → 用户真能拿到）的设计与落地记录；也是后续「命令执行治理」「配置缓存」修复的承载文档。
- **覆盖**：§1–2 断链核查 · §4 形态判定（内置/MCP/Skill/定时任务）· §10 v2 格式扩展 · §11 报告式导出 + 手写 HTML 零外链护栏 · §12 全对话审计与上下文工程全链路对照 · §13 `run_command` 治理 · §14 配置热重载缓存失效键。
- **现行落点**：`export_data`（8 种格式，`builtins.ts`）· 下载端点（`app.ts` `GET .../files/download`）· `artifact` 事件（`packages/shared`）· `fs_write` 写 `.html` 下发卡片 · `externalRefHint` · `wrapUpWith`（轮次耗尽补位收尾）· `repeatCallHint` + `executedSigRounds` · `appendRoundTrace` · `decodeShellBytes` / `truncateShellOutput`。
- **状态**：✅ 现行（2026-09-24 复核，顶部主状态表 13 项）。
- **注意**：第 4 项（`fs_delete` / 上传入工作区 / 定时任务工具化）**仍待实施**——以 `builtins.ts` 的 `BUILTIN_RISK` 登记表为准，内置工具共 **21** 个（19 个在 `execBuiltin` 分发，`task` / `search_tools` 在 `chat.ts` 循环内处理），**确无 `fs_delete`**；第 5 项 `run_script` / `image_gen` 维持暂缓（论证见 §6）。

### [mcp-guide.md](./mcp-guide.md)
- **定位**：MCP 连接与内置服务器的**权威口径**（其它 MCP 文档与它冲突时以本文为准）。
- **覆盖**：入口 UI（输入框「＋」工具菜单 → 连接器）· 传输（stdio / Streamable HTTP）· `MCP_BUILTIN_SERVERS` 配置 · `toolRisks` 工具级风险覆盖 · §11 验证脚本 → 现行回归入口总表。
- **现行落点**：`mcp/config.ts`（文件+内置服务器，`mtime+size` 失效）· `mcp/hub.ts` · `scripts/metabase-mcp.mjs` · `scripts/yapi-mcp.mjs`。
- **状态**：✅ 现行。
- **注意**：内置工具（fs_* / write_todos / task / read_skill / search_tools / render_chart 等）**始终注入**——「一个都不勾」只表示不接外部数据源，不是纯直连。

### [agent-infrastructure.md](./agent-infrastructure.md)
- **定位**：通用 Agent 基建检查表（M0–M4 成熟度模型 + 反模式），每章带「本项目对照」。
- **覆盖**：可观测（§10）· 安全与注入防护 · 评测门禁 · 成本归因（§12）· 发布灰度与回滚 · 调试。
- **现行落点**：`trace.ts`（`runs-<YYYYMM>.jsonl` + 逐轮 `rounds-<runId>.jsonl`）· `cost.ts` · `audit.ts` · `rate-limit.ts` · `untrusted.ts` · `roles.ts`。
- **状态**：✅ 现行（§10 已于 2026-09-24 补入逐轮 trace 说明）。
- **注意**：整体仍是「🟡 部分」——缺 llm/tool 分层 span、指标看板、按会话回放。

### [write-op-safety-plan.md](./write-op-safety-plan.md)
- **定位**：写操作确认闸门设计（风险分级 + 会话级只读授权）。
- **现行落点**：`risk.ts`（`resolveToolRisk`，未声明工具按 `MCP_UNKNOWN_TOOLS` 口径）· `confirm.ts` · `sql-readonly.ts`（`isReadOnlySql`，服务端单一真相 fail-closed）· `audit.ts` · `builtins.ts` 的 `BUILTIN_RISK` 登记表。
- **回归**：`tests/write-gate.test.ts`、`tests/sql-readonly.test.ts`。
- **状态**：✅ 现行。
- **注意**：§5.9 自述「本期只解决一半」——第二个风险轴是**数据外发**；且 `isReadOnlySql` 降级属体验优化层，真正边界应由数据库只读角色提供（与 `text2sql-text2api-plan.md` 同口径）。

### [text2sql-text2api-plan.md](./text2sql-text2api-plan.md)
- **定位**：bi（text2sql）/ yapi（text2api）两类取数通道的最佳实践对齐。
- **现行落点**：`scripts/metabase-mcp.mjs`（8 工具 + MCP 侧 `isReadOnlySql`）· `scripts/yapi-mcp.mjs`（GET-only + 项目白名单）· `src/sql-readonly.ts`（服务端同口径，**双层必须同步改**）· `risk.ts` 的只读 SQL 降级。
- **状态**：✅ 现行（2026-09-24 核过落点存在，未逐句复核）。
- **注意**：文内 ❌（DB 层只读角色、行级权限/身份透传）指的是**安全边界**仍缺，不要因为看到 `sql-readonly.ts` 就以为已补齐。

### [conversation-state-plan.md](./conversation-state-plan.md)
- **定位**：会话状态与上下文/记忆层契约（thread / 并发 / 队列）。
- **现行落点**：`conversations.ts` · `history.ts`（四层上下文策略：prune → LLM 摘要）· `chat-tasks.ts`（异步任务 / 断线续传 / 结果回投）。
- **回归**：`tests/task-persistence.test.ts`、`tests/task-resume.test.ts`。
- **状态**：✅ 现行（未逐条复核）。
- **注意**：任务状态在进程内存（`project-review.html` 标为「有意偏离」），多实例部署需另做。

### [conversation-list-ux-plan.md](./conversation-list-ux-plan.md)
- **定位**：会话列表交互（右键菜单 / 内联重命名 / 删除撤销 / 置顶 / 拖拽排序 / 键盘可达）。
- **现行落点**：`pinnedAt`、`convSortMode`、`reorder` 在 `apps/web/src/api.ts`、`ChatPage.vue`、`conversations.ts`、`app.ts`、`session.ts` 中均有实现（2026-09-24 复核）。
- **状态**：✅ 现行。
- **注意**：**只保留右键入口**（用户明确要求）；键盘用 `Shift+F10` / 菜单键，触屏用长按。

### [web-search-guide.md](./web-search-guide.md)
- **定位**：联网检索与工具搜索 UI。
- **现行落点**：`web_search` / `fetch_url`（`builtins.ts`）· `src/web-search.ts` · 前端 `pinyin.ts` + `ToolsSearch`（`ChatPage.vue`）· `pinyin-pro` 依赖（按需加载，已拆出主 chunk）。
- **状态**：✅ 现行（2026-09-24 复核）。

### [movie-safety-policy.md](./movie-safety-policy.md)
- **定位**：`/movie` 角色（观影助手）的安全与限制策略。
- **现行落点**：`system-prompt.ts`（`SAFETY_GUARDRAIL`，注入稳定前缀最前）· `roles.ts`（`MOVIE_BASE_PROMPT` + `forceEagerTools` / `forceToolCall` / `enforceGrounding`）· `role-guard.ts`（确定性身份护栏）· `grounding.ts`（反编造接地护栏）。
- **回归**：`tests/grounding-guard.test.ts`、`tests/deep-agent-live.test.ts`。
- **状态**：✅ 现行。
- **注意**：原 `scripts/_movie-grounding-gate.mjs` 已随调试脚本清理移除，现行回归入口是 `pnpm test`。

### [domain-adaptation-guide.md](./domain-adaptation-guide.md)
- **定位**：规范性指南——如何在不动引擎的前提下把通用 Agent 改造成垂直领域 Agent（以观影助手为例）。
- **状态**：✅ 现行（弱代码耦合，属「怎么做」而非「现状记录」）。
- **注意**：§10 提到的 `scripts/_role-check.mjs` / `_movie-e2e.mjs` 等**大多已移除，不要照抄脚本命令**；替代回归总表见 `mcp-guide.md` §11。

### [movie-mobile-ui-plan.md](./movie-mobile-ui-plan.md)
- **定位**：影视移动端 UI 方案。
- **状态**：✅ 现行（未复核）。

---

## 二、计划留档（决策背景；文内 ❌ 多为「改前现状」）

> 读这类文档**务必先看顶部修订说明**，否则容易把「改前缺口」误读成「现在还缺」。

### [chart-visualization-plan.md](./chart-visualization-plan.md)
- **定位**：图表可视化三路线选型记录。
- **现状**：**路线 3（本地渲染、零外链）已实施**——前端 `@antv/g2` + `@antv/g6`（`apps/web/package.json`）+ 内置 `render_chart`；`chart` 服务器已于 2026-09-21 从 `MCP_BUILTIN_SERVERS` 移除。
- **注意**：文首表格的 ❌「无」是**改前现状**快照。

### [movie-personalized-plan.md](./movie-personalized-plan.md)
- **定位**：个性化推荐方案——**推荐能力已下线**。
- **现状**：保留**观影口味画像**（`src/movie/profile.ts`，只留 history / feedback）+ 内置工具 `record_watched_movies`（`builtins.ts`）；影片数据源已由豆瓣换成 **TMDb**。
- **注意**：文内 ❌（相似电影 / 冷启动 / 反馈闭环）指**推荐能力**缺口，不是画像缺失。

### [deep-agents-plan.md](./deep-agents-plan.md)
- **定位**：Deep Agents 架构评估 → 实施记录（v4，2026-09-20）。
- **现状**：四项差距均已补齐——虚拟文件系统（`fs_*`）· 任务规划（`write_todos`）· 子代理（`task`，`chat.ts` 内 `SubagentHandle`）· 详细系统提示 + Skills（`read_skill`）。
- **注意**：§8 / §11 里的 `scripts/_*.mjs` 已清理，`apps/agent-server/scripts/` 现只留功能性脚本。

### [mcp-connect-plan.md](./mcp-connect-plan.md)
- **定位**：早期 MCP 连接方案。
- **注意**：**顶部已自行标注**「现状一律以 `docs/mcp-guide.md` 为准」；本文只作决策背景。

---

## 三、快照 / 复盘（对应固定代码版本，不随现状更新）

### [project-review.html](./project-review.html)
- **定位**：项目整体复盘（业界做法 → 本项目做法 → 是否最佳实践 → 偏离原因 → 何时改回）。
- **状态**：🗂 快照，**对应 master @ `cc6c7a6`**，行号与现状已漂移，仅作背景阅读。
- **注意**：其中「MCP 配置缓存：按 mtime 失效、4 例全绿」已过时——现为 `mtime + size`、5 例（见 `artifact-delivery-plan.md` §14）。

---

## 四、子目录

| 目录 | 内容 | 状态 |
|---|---|---|
| `docs/agent/` | `RAG_INGESTION_PLAN.md`：知识入库方案（2026-09-23 按 `src/rag/*` 重写对齐）。落点 `rag/parsers.ts`（md/txt/html/pdf/docx/xlsx）+ `store.ts`（词法 TF-IDF + 可选向量 RRF）+ `scripts/build-rag-index.mjs`；模型侧入口 `search_knowledge` / `knowledge_sources`。**不引入独立向量库**（有意偏离） | ✅ 现行 |
| `docs/knowledge/` | RAG 语料（人事 / 安全 / 财务 / 运维），**同时是知识库内容**，改目录即改检索结果 | ✅ 现行 |

---

## 五、已知文档缺口（挂账）

1. **仓库根无 `README.md`**：新人不了解工程结构、启动方式、环境变量入口。
2. 标「未复核 / 未逐条复核」的文档（`text2sql-text2api-plan.md`、`conversation-state-plan.md`、`movie-mobile-ui-plan.md`）本次只验证了关键落点存在，建议随后续改动顺手复核。
3. `project-review.html` 停在 `cc6c7a6`，与现状差距持续扩大（已越差越大）。
4. 多数计划文档里的**行号引用**会漂移，已在效力约定第 1 条统一说明（先搜函数名）。
