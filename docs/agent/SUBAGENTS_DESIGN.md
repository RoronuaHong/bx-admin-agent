# 具名子代理（Subagent Types）设计稿

> **状态**：设计稿，未实施。本文只描述目标方案，不代表当前代码行为。
> **日期**：2026-11-26
> **关联**：[当前架构](./CURRENT_ARCHITECTURE.md)（唯一权威，D4 = 通用型 `task`）、[deep-agents-plan](../deep-agents-plan.md) §11.2-E 与 §11.6「`task` 无 `subagent_type`」、[子代理事故复盘](../agent-stall-incident-20261014.md)
> **范围**：进程内、同一次运行里的上下文隔离与能力收窄；不做多进程 Agent 集群、不接 A2A。

## 1. 背景与要解决的问题

当前 D4 只有一个**通用型**子代理：

- `task` 参数只有 `description` 和 `servers`（`apps/agent-server/src/builtins.ts:721-742`）。
- 子代理提示硬编码为 `SUBAGENT_PROMPT`（`apps/agent-server/src/system-prompt.ts:158-173`），不区分类型。
- 工具白名单只按 MCP server 收窄；内置工具用一段硬编码 filter 排除递归/提问工具（`apps/agent-server/src/chat.ts:4107-4132`）。
- 设计文档早已把「专业化子代理」列为 P1，但尚未落地（`docs/deep-agents-plan.md:305-309`、`:362`）。

实际暴露的问题：模型想委派联网检索，但 `task` 只有 `servers` 一个表达能力的口子，于是把 `web` 当成 MCP server 填进去。trace `apps/agent-server/.data/traces/spans-run_21841e10-d959-4b68-9115-67b630a09cd1.jsonl` 第 5–7 行：

```text
子代理未完成（失败或被中止）（工具调用 0 次）
原因：task 的 servers 没有可用工具：web。当前可用服务器：（无）
```

子代理根本没启动（16ms、0 次工具调用）。`web_search` / `fetch_url` 是内置工具，不是 MCP server；父轮随后自己直接调用它们完成了任务。也就是说：**能力边界目前只能靠模型猜 `servers` 表达，这是设计缺口，不是模型偶发犯错。**

## 2. 目标 / 非目标

**目标**

1. 让子代理成为**具名、可声明、可复用**的类型，模型通过 `subagent_type` 选择，而不是猜工具参数。
2. 每类子代理拥有自己的 system prompt、工具白名单、模型、轮次上限、只读开关。
3. 父代理只看到 `name + description` 的路由索引，不把全部子代理 prompt 塞进主上下文。
4. 完全保留现有不变量：取消级联、`subagent_*` 事件、四态 handoff、span、接地证据规则、不可信内容定界、风险闸门、审计。
5. 向后兼容：不传 `subagent_type` 时，子代理执行路径与今天一致。

**非目标（本期）**

- 子代理 resume / 续跑。
- 独立工作区（git worktree / 云环境）隔离。
- 子代理再派子代理（嵌套）；继续强制 `allowTask: false`。
- `responseSchema` 结构化回传。
- 前端 `@名字` / `/名字` 显式调用语法。
- 管理页热更新子代理定义；首版只在启动加载。

## 3. 参考做法

### 3.1 LangChain Deep Agents

- 创建 agent 时声明 `subagents: [{ name, description, system_prompt, tools, model }]`。
- 调用 `task({ description, subagentType, label?, responseSchema? })`，`subagentType` 必填，`description` 必须自包含、无状态；多个 `task` 可并行 fan-out。
- 每类子代理带窄工具集与自己的 prompt；父代理靠子代理描述决定派给谁。
- 来源：`https://github.com/langchain-ai/deepagents`、`https://github.com/langchain-ai/deepagentsjs`

### 3.2 Claude Code

- 文件式定义：`.claude/agents/*.md`，YAML frontmatter + Markdown 正文，正文即 system prompt。
- 关键字段：`name`、`description`、`tools`（allowlist）、`disallowedTools`（denylist）、`model`、`maxTurns`、`skills`、`mcpServers`、`permissionMode`、`memory` 等。
- 内置 `Explore` / `Plan` / `general-purpose` / `web-fetch`；按 `description` 自动委派，描述里写 "use proactively" 可触发主动委派。
- 父代理只消费 `name + description` 路由索引；非内置子代理描述总量超 15k token 会告警，详细行为写进正文而不是描述。
- 全新上下文、只看委派消息；工具过滤是「允许列表 ∩ 可用工具 → 应用 denylist → 强制移除 `AskUserQuestion` 类工具」。
- 来源：`https://code.claude.com/docs/en/sub-agents`

### 3.3 Cursor

- 文件式定义：`.cursor/agents/*.md`（另有 `~/.cursor/agents/`），frontmatter 字段 `name` / `description` / `model` / `readonly` / `is_background`，正文即 system prompt。
- 内置 `Explore`（代码库搜索）和 `Browser`（MCP 浏览器自动化）；自动委派或 `/名字`、`@名字` 显式指定；一次多个 Task 调用即并行。
- 项目级 `.cursor/agents/` 优先于用户级；`readonly` 直接收紧写权限；子代理不能再派孙代理；可按 agent id resume。
- 建议先做 2–3 个职责单一的子代理，避免泛泛的 "helper"，描述要短而具体。
- 来源：`https://cursor.com/docs/subagents`

### 3.4 共同结论

| 维度 | 三家共识 |
|---|---|
| 定义 | 声明式、具名、文件化；`description` 是路由信号，正文是完整 prompt |
| 能力边界 | 类型级工具 allowlist / denylist，最小权限 |
| 上下文 | 全新 context，只看委派任务，不继承主对话；只回摘要 |
| 调度 | 父代理按 description 自动选择；并行 fan-out；有上限 |
| 安全 | 强制移除递归/提问类工具；未知/越权 fail-closed |

## 4. 方案

### 4.1 定义文件与目录

新增：

```text
apps/agent-server/subagents/<id>.md        # 内置、随代码发布、进版本库
apps/agent-server/.data/subagents/<id>.md  # 本地覆盖（可选，运维自定义）
```

格式对齐 Claude Code / Cursor：

```markdown
---
name: web-researcher
description: 联网查资料并回摘要。需要搜索网页、抓取页面、整理结论时优先使用。
tools: web_search, fetch_url, fs_read, fs_write
model: inherit
maxTurns: 10
readonly: false
skills: web-research
mcpServers:
---

你是资料研究员。只输出结论、关键数字、来源链接，不贴原始网页全文……
```

**约束**：文件名必须与 `name` 一致；身份以 frontmatter `name` 为准。同名定义跨目录时后者覆盖前者。`.data/subagents/` 与本地 skills 目录同信任模型：只接受服务端本地文件，不做上传接口；加载时按 `skills.ts` 的 `isInside` 同款校验拒绝符号链接与路径穿越。

**字段表**

| 字段 | 必填 | 默认 | 语义 |
|---|---|---|---|
| `name` | 是 | — | 唯一 id，小写连字符；父代理用 `subagent_type` 指向它 |
| `description` | 是 | — | 路由信号，短而具体；希望主动委派时写「优先/主动」 |
| `tools` | 否 | 继承全部可用内置工具 | **仅内置工具名**，逗号分隔；MCP 能力请用 `mcpServers`，首版不支持 `mcp__<server>__<tool>` 模式 |
| `disallowedTools` | 否 | 空 | 在 allowlist 结果上再删；强制必删项始终优先 |
| `model` | 否 | `inherit` | 具体模型 id 或 `inherit`；无效 id fail-closed |
| `maxTurns` | 否 | `SUBAGENT_MAX_ROUNDS` | 映射到 `LoopContext.maxRounds`，仅为初始值 |
| `readonly` | 否 | `false` | true = 强制移除所有非 `read` 级内置工具，并经扩展后的风险闸门拒绝写/外部操作，记 `subagent_refused` 审计 |
| `skills` | 否 | 空 | 预加载技能目录 id，逗号分隔；见 4.5.1 |
| `mcpServers` | 否 | 会话全部 | server id 白名单，逗号分隔，与会话已启用的 MCP 工具求交；`task.servers` 再收窄 |

Markdown 正文 = 该类型专属 prompt。**全局守则仍在末尾统一拼接**：`RUNTIME_ENVIRONMENT`、`UNTRUSTED_CONTENT_RULE`、交接格式要求，避免多份漂移。

### 4.2 加载器 `apps/agent-server/src/subagents.ts`

职责：

1. 解析 frontmatter 与正文。**复用 `skills.ts:112-125` 的 `parseFrontmatter` / `bodyAfterFrontmatter`**，但这两个函数当前是私有的，需先导出（或抽到 `frontmatter.ts`）；解析器只支持单行 `key: value`，字段按标量或逗号分隔字符串写。
2. 合并优先级：代码内置定义 < `subagents/*.md` < `.data/subagents/*.md`，同名后者覆盖前者（对齐 Claude Code / Cursor 的作用域优先级）。
3. 启动期校验：缺 `name` / `description`、文件名与 `name` 不一致、`name` 不匹配 `^[a-z0-9-]{1,64}$`、非法字段名、正文为空 → 跳过该文件并告警，不静默生效。`tools` / `skills` / `mcpServers` 中出现未知 id 时**逐项告警并忽略该项**，不连带废掉整个文件（动态工具如 `search_tools` 依赖运行时）。
4. 对外导出：`listSubagentTypes()`、`getSubagentType(id)`、`subagentIndexText()`；预留 `invalidateSubagentCache()`，首版不接管理页。
5. 缓存：启动加载一次；定义变更随进程重启生效，避免引入热更竞态。

### 4.3 父代理提示索引

在 `system-prompt.ts:378-380` 的 `stableParts` 数组里、`renderSkillIndex(...)` 之后插入 `subagentIndexText()`：

- 只含每个类型的 `name` 与 `description`，**不含正文 prompt**。
- 单个 `description` 上限 500 字符，超出截断；总字符上限 `SUBAGENT_INDEX_CHARS`（默认 4000，可配），超限按名排序截断并注明「还有 N 个类型未列出」。
- 明确写一句：`task` 的 `description` 必须自包含，子代理看不到当前对话。
- **只注入主代理**。子代理仍用现有 `SUBAGENT_PROMPT` 拼装，不得递归注入索引。

放在稳定段是因为它跨轮不变，不破坏 prompt cache；定义改动随重启换前缀，与角色切换口径一致。

### 4.4 `task` 工具参数

在 `builtins.ts:721-742` 扩展：

| 参数 | 类型 | 说明 |
|---|---|---|
| `description` | string，必填 | 自包含的任务描述（不变） |
| `subagent_type` | string，可选 | 缺省 `general-purpose`；未知值 fail-closed，错误中列出可选 id |
| `label` | string，可选 | UI 短标签，不影响执行（对齐 Deep Agents） |
| `servers` | string[]，可选 | **降级为在类型允许范围上再收窄**；只接受 MCP server id，不再是唯一能力来源 |

`task` 描述文本同步改写：说明可选类型来自系统提示索引；`servers` 只收窄 MCP server，内置工具不要填它。

`label` **不参与同轮去重**：`toolCallSignature("task", argsJson)` 必须先剥掉 `label` 再算指纹，否则模型给同一子任务换标签就能绕过「同轮重复跳过」。去重键仍为 `description + subagent_type + servers`。

### 4.5 执行流程（`chat.ts:4089` 的 `runSubagent`）

1. 解析 `description`，空则照旧返回结构化 `failed`（不变）。
2. 解析 `subagent_type`：未知类型 → 返回 `failed`，`errors` 写明「未知子代理类型，可选：...」，不退化成通用型。
3. 解析工具集，顺序固定：
   - MCP 侧：类型 `mcpServers` ∩ `ctx.mcpTools`；`servers` 参数在这之上再收窄；复用现有 `resolveSubagentTools`，无匹配即 fail-closed。
   - 内置侧：类型 `tools` allowlist ∩ `builtinToolSpecs`；未声明则继承全部。
   - 强制删除 `task` / `write_todos` / `request_clarification` / `SUBAGENT_DENIED_BUILTINS`（防递归、用户决策权归父轮）。
   - 再应用类型 `disallowedTools`。
   - `readonly: true` 时，按 `BUILTIN_RISK` 再删掉所有 `level !== "read"` 的内置工具，作为第一道闸；MCP 工具无法按静态表剥离，留到运行期风险闸门拒绝。
   - 最终交集为空 → `failed`，原因 `task 的 tools 与当前可用工具无交集`。
4. 提示词 = 类型正文 + 共享 `SUBAGENT_PROMPT` 尾部；`model` 用 `config.ts:82` 的 `getModel(id)` 解析，无效 id 或处于冷却中的 id 返回 `failed`（提示去掉 `model` 或换类型）；它等价于「用户点名模型」，**固定该模型、跳过 auto 候选排序**，但仍走 `models.ts` 层已有的瞬时重试与端点自愈；`maxTurns` 必须是正整数，按 `[1, SUBAGENT_MAX_ROUNDS]` 钳制后覆盖 `LoopContext.maxRounds`（`chat.ts:2171`，运行期护栏仍可能上调）；`readonly` 经扩展后的风险闸门做第二道闸（含 MCP 写），拒绝即记 `subagent_refused`。
5. 其余一律不变：`subagentRegistry` 注册与取消级联、`subagent_start/delta/end` 事件、四态 handoff（`success | partial | no_findings | failed`）、`success` 才算接地证据、回传 `wrapUntrusted`、每次委派一条 span。
   - span 增加低基数 attr `gen_ai.tool.subagent.type`。

#### 4.5.1 相邻文件改动清单

| 文件 | 改动 |
|---|---|
| `apps/agent-server/src/subagents.ts`（新增） | 加载器、内置定义、索引生成 |
| `apps/agent-server/src/skills.ts` | 导出 `parseFrontmatter` / `bodyAfterFrontmatter`；`skills` 预加载复用 `readSkillDocument`（`skills.ts:305`）取正文，上限复用 `ENABLED_SKILLS_INJECT_CHARS`，作为数据段拼入子代理 prompt，不注入 skills 索引 |
| `apps/agent-server/src/builtins.ts` | `task` 加 `subagent_type` / `label`，改写描述 |
| `apps/agent-server/src/system-prompt.ts` | `stableParts` 插入 `subagentIndexText()` |
| `apps/agent-server/src/risk.ts:278-283` | `subagentMayExecute(v, allowWrite, readonly = false)`：readonly 时连免确认的工作区写也拒绝，记 `subagent_refused`（`audit.ts:18`） |
| `apps/agent-server/src/config.ts:82-85` | 用 `getModel(id)` 解析类型覆盖模型 |
| `apps/agent-server/src/chat.ts` | 类型解析、工具过滤、prompt/模型/轮次覆盖、span attr；`toolCallSignature` 调用前剥掉 `label`；`SubagentHandle`（`chat.ts:493-499`）增 `subagentType?` / `label?` 供独立取消与展示 |
| `packages/shared/src/index.ts:196-204` | `subagent_start` 增可选 `subagentType?` / `label?` |
| `apps/web/src/chat-types.ts:81-87` | `subagents[]` 元素增可选 `subagentType?` / `label?` |
| `apps/web/src/chat-stream.ts:213-223` | 把新字段写入 `reply.subagents` |
| `apps/web/src/components/ChatBubble.vue:215` | 步骤名改为 `label ?? toolDisplayName(step.name, uiLocale)`，`label` 从 `step.args` 解析，无需改 `ToolStep` 结构 |

`subagents.ts` 只依赖 `skills.ts` 的解析函数，**不得 import `builtins.ts` / `chat.ts` / `system-prompt.ts`**，否则 `system-prompt.ts → subagents.ts → ...` 会成环。

### 4.6 首批内置类型

| 类型 | 工具 | 用途 |
|---|---|---|
| `general-purpose` | 当前全部允许工具 | 完全等同今天的不传类型行为 |
| `web-researcher` | `web_search` / `fetch_url` / `fs_read` / `fs_write` | 联网查资料回摘要；直接消除 `servers:["web"]` 误用 |
| `bi-explorer` | BI 相关 MCP + `fs_ls` / `fs_glob` / `fs_grep` / `fs_read`，`readonly: true` | 多步 BI 探查，落实 `deep-agents-plan.md` §11.2-E |
| `explore`（可选） | `fs_ls` / `fs_glob` / `fs_grep` / `fs_read`，`readonly: true` | 对标 Claude Code / Cursor 的 Explore，只读代码/资料探索 |

### 4.7 失败契约

所有失败仍走 `subagentHandoffText` 的四态结构，首行是状态+调用次数，紧随其后的 `原因：` 行给出根因。新增原因：

- `未知子代理类型：xxx。可选：general-purpose, web-researcher, ...`
- `子代理类型定义无效：缺 description / 文件名与 name 不一致`
- `task 的 tools 与当前可用工具无交集`
- `只读子代理禁止写操作：<tool>`（复用 `subagent_refused`）
- `子代理模型无效或处于冷却：xxx`

**事件边界**：上述失败若发生在 `subagent_start` 之前（缺 description、未知类型、无效模型、工具交集为空、servers 不匹配），保持现状——**不发 `subagent_start` / `subagent_end`**，只在父轮产生 `tool_result` 步骤；前端「子代理」列表不会出现条目，只有步骤行显示失败。`runSubagentBatch` 的启动异常兜底仍用 `call.id` 发 `subagent_end`，不在本期改。

前端步骤摘要只取首行的问题另案处理：失败步骤应把 `原因：` 行一并显示在收起态（`apps/web/src/composables/chat/useChatReasoningUI.ts:69` 的 `stepSummary`）。

## 5. 兼容性与不变量

- 不传 `subagent_type` → `general-purpose`：**子代理执行路径**与当前一致；父代理系统提示会新增类型索引段（预期变化，由 prompt 契约测试锚定）。
- 不传 `servers` 且类型未声明 `mcpServers` → 继承会话全部 MCP 工具，等同当前实现。
- 子代理依旧不能派子代理、不能弹确认卡、不能向用户提问；写权限按扩展后的风险闸门判定，`readonly` 类型连免确认工作区写也拒绝。
- 事件契约只增可选字段：`subagent_start.subagentType?` / `label?`（shared + chat-stream），span 增 attr；旧前端忽略即可。
- 本地定义文件与本地 skills 同信任模型：仅服务端文件、路径校验、符号链接拒绝；不新增上传接口。

## 6. 实施顺序与验收

**第一批（本期）**

1. `skills.ts` 导出 frontmatter 解析函数。
2. `apps/agent-server/src/subagents.ts`：加载器 + 内置定义 + 索引生成。
3. `builtins.ts`：加 `subagent_type` / `label`，改写 `task` 描述。
4. `system-prompt.ts`：注入 `SUBAGENT_TYPES` 索引与字数上限。
5. `risk.ts` / `config.ts` / `chat.ts`：类型解析、工具过滤、readonly 闸门、模型/轮次覆盖、span attr。
6. `packages/shared` 与 `apps/web`：事件新增可选字段。
7. 新增内置类型文件：至少 `general-purpose` / `web-researcher` / `bi-explorer`。
8. 测试。
9. 文档回写：`CURRENT_ARCHITECTURE.md` §2 D4 从「通用型」改为「具名类型」；`deep-agents-plan.md` §11.2-E 与 §11.6 的缺口条目标记已落地并指向本文。

**测试落点**

- `tests/subagent-types.test.ts`（新增）：frontmatter 解析、文件名/name 校验、优先级覆盖、未知类型、工具 allow/deny、readonly 写拒绝、索引预算。
- `tests/subagent-status-contract.test.ts`：扩展混合类型并行 batch，原有契约不回归。
- `tests/write-gate.test.ts`：扩展 `readonly` 类型的 `subagent_refused` 审计断言。
- `tests/system-prompt-contract.test.ts`：索引只含 name+description、不含正文、超限时截断。
- `tests/round-trace.test.ts`：span 新增 `gen_ai.tool.subagent.type`。

**验收用例**

1. `task(subagent_type: "web-researcher", description: "查 X 并回摘要")` 不传 `servers` 也能跑通，不再出现「servers 没有可用工具：web」。注意：类型化只是给出正确出口；若模型仍显式传非法 `servers`，现有 fail-closed 语义不变，仍返回失败——这是刻意保留的契约，靠 `task` 描述与类型索引把模型引导到「不填 servers」。
2. `task(subagent_type: "unknown", ...)` 返回 `failed`，原因列出可选类型，父轮能据此纠正。
3. `bi-explorer` 的 `tools` 即使误写 `fs_write`，也在强制过滤阶段被移除；绕过过滤的调用由风险闸门拒绝并记 `subagent_refused`。
4. 不传 `subagent_type` 的旧调用，子代理执行路径与当前一致，全部既有子代理契约测试通过。
5. 系统提示中的类型索引总长不超过 `SUBAGENT_INDEX_CHARS`，且索引不出现在子代理系统提示中。

## 7. 后续（不在本期）

- 按 agent id resume 子代理（Claude Code / Cursor 都有）。
- 每类型独立工作区（git worktree / 云环境）解决并行写冲突。
- 一层嵌套子代理：主 → 子 → 孙，孙不可再派；当前 `allowTask:false` 更严格。
- `responseSchema` 结构化回传，给后续代码消费。
- 前端 `@名字` / `/名字` 显式调用与步骤标签展示。
- 管理页热更新子代理定义（需先定义写接口、校验与缓存失效协议）。

## 8. 证据锚点

- 当前 `task` 参数：`apps/agent-server/src/builtins.ts:721-742`
- 当前硬编码工具过滤：`apps/agent-server/src/chat.ts:4107-4132`
- 当前子代理 prompt：`apps/agent-server/src/system-prompt.ts:158-173`
- 系统提示稳定段拼装：`apps/agent-server/src/system-prompt.ts:373-397`（`stableParts` 在 378-380）
- 现成 frontmatter 解析器：`apps/agent-server/src/skills.ts:112-125`（当前私有）；技能索引渲染 `:587-588`
- 风险闸门：`apps/agent-server/src/risk.ts:278-283`；审计决策 `apps/agent-server/src/audit.ts:18`
- 模型解析：`apps/agent-server/src/config.ts:82-85`
- 事件契约：`packages/shared/src/index.ts:196-204`；前端映射 `apps/web/src/chat-stream.ts:213-223`
- `LoopContext.maxRounds`：`apps/agent-server/src/chat.ts:2171`；`SubagentHandle` 定义 `:493-499`
- 去重指纹调用点：`apps/agent-server/src/chat.ts:3129`（`task` 分支）与 `tests/deep-agent-control.test.ts:50`
- 前端子代理类型：`apps/web/src/chat-types.ts:81-87`；步骤行 `apps/web/src/components/ChatBubble.vue:215`
- 已记录的专业化缺口：`docs/deep-agents-plan.md:305-309`、`:362`（§11.6）
- 事故 trace：`apps/agent-server/.data/traces/spans-run_21841e10-d959-4b68-9115-67b630a09cd1.jsonl`（第 5–7 行）
