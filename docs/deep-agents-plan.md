# Deep Agents 架构评估与迁移方案

> 版本：v2（2026-09-17，决议已冻结 + 实施记录见 §8）
> 定位：评估稿 → 实施记录。回答两个问题：① 现在的架构是不是 harness？② 要不要/能不能升级成 Deep Agents 架构，现有代码支持吗？
> 相关：`docs/agent-infrastructure.md`、`docs/conversation-state-plan.md`（thread/并发/队列契约）。

---

## 1. 结论先行

1. **现在的架构是 harness**——而且是「最小 harness」：一个核心工具调用循环（`chat.ts runWithTools`，≤14 轮）+ 自研的上下文治理（压缩/卸载/句柄）+ 人审门（确认卡）+ 长期记忆 + Mongo thread 持久化。
2. **Deep Agents 也是 harness**，官方定义：*"It is the same core tool calling loop as other agent frameworks, but with built-in capabilities that make agents reliable for real tasks"*。**循环是同一个，差别在于循环外挂了哪些内置能力层。**
3. 因此这不是「换范式重写」，而是「给现有循环补齐缺失的能力层」。**现有代码支持演进，不需要推翻**——我们的主循环是 `AsyncGenerator<ChatEvent>`，每个 Deep Agents 能力都能做成一个可插拔层挂上去。
4. 差距集中在四块：**虚拟文件系统（scratchpad）、任务规划（todo）、子代理（委派）、详细系统提示 + Skills**。其中子代理正是我们 BI 场景「查 60 行回灌上下文」这个 context-bloat 问题的正解。

---

## 2. 最佳实践参考（原文依据）

| 来源 | 关键结论（原文关键句） |
|---|---|
| **LangChain · Deep Agents overview（JS）** | *"Deep Agents is an 'agent harness'. It is the same core tool calling loop… but with built-in capabilities"*；能力分四板块：**执行环境**（工具/MCP、虚拟文件系统、权限、代码执行）、**上下文管理**（Skills 渐进加载、Memory、压缩与卸载、prompt caching）、**委派**（todo 规划自 v0.7 起 **opt-in**；子代理默认内置）、**Steering**（`interrupt_on` 人审） |
| 同上 · 文件系统地位 | FilesystemMiddleware 是 *"required scaffolding"*，**不允许移除**；SubAgentMiddleware 同样 *"intentionally rejected"* 移除 |
| 同上 · 运行时依赖 | *"deepagents is a standalone library built on top of LangChain's core building blocks… using LangGraph's tooling for running agents in production"*（npm 装 `deepagents langchain @langchain/core`） |
| 同上 · 非必要不引入 | *"For building custom agents without these built-in capabilities, consider using LangChain's createAgent or building a custom LangGraph workflow."* —— 官方承认：不需要这些内置能力时不必用 Deep Agents |
| **Deep Agents · Subagents** | *"Subagents solve the context bloat problem… the main agent receives only the final result, not the dozens of tool calls that produced it."*；默认 `mode: "isolated"`（只看 task 描述），`mode: "fork"` 仅用于"延续父代理已开始的工作"；**任务描述要具体**（*"The main agent uses descriptions to decide which subagent to call. Be specific."*）；**子代理只回摘要不回原始数据**（*"Instruct subagents to return summaries, not raw data"*，300 词内）；**工具集最小化**（*"Only give subagents the tools they need"*）；主代理 *"keep… focused on high-level coordination"*；并行 = 同一轮发多个 `task()` |
| 该用 / 不该用（子代理） | ✅ 多步、专业域、需不同模型、想让主代理只做协调；❌ 单步任务、需要中间上下文、开销大于收益 |

---

## 3. 能力差距矩阵（Deep Agents 能力 × 现状）

| Deep Agents 能力 | 我们的现状 | 判定 |
|---|---|---|
| 核心工具调用循环 | `runWithTools`：模型 → tool_calls → 执行 MCP → 回灌 → 再调，≤ `MCP_MAX_TOOL_ROUNDS=14` 轮 | ✅ 等价 |
| MCP 支持 | `mcp/hub.ts`（HTTP Streamable）+ 确认门 + 引用计数 | ✅ 等价 |
| 历史压缩（summarization） | `history.ts`：窗口 → 无损裁剪 → LLM 摘要（预算按模型窗口推导） | ✅ 等价 |
| 大结果卸载（offloading） | `governToolResults`：预算内把旧工具结果清成占位符 + `ToolHandle` 轻量句柄跨轮（只留"查过什么"） | ✅ 等价，**但方向不同**：Deep Agents 卸载到文件系统（可再读回），我们清成占位符（只能重新调用工具） |
| 人审（`interrupt_on`） | `confirm.ts` + `toolNeedsConfirm` 确认卡（事件流内等待应答） | ✅ 等价（自研版 interrupt） |
| 长期记忆 | `memory.ts`：显式写入、可查删、注入 system | ✅ 等价（他们用 AGENTS.md 文件承载） |
| Thread 持久化 | Mongo `conversation.context` + `$push/$inc` 原子追加（对标 checkpointer） | ✅ 等价 |
| **虚拟文件系统** | **无**。大结果要么进上下文、要么被清掉，没有"落盘 + 指针"的中间态 | ❌ 缺（他们定位为必选脚手架） |
| **任务规划 todo** | **无**。多步 BI 分析（探查→查询→校验→结论）没有显式计划载体，前端也看不到进度 | ❌ 缺（他们 v0.7 起 opt-in → 说明**可选但常用**） |
| **子代理 task** | **无**。所有工具结果都进主上下文；`MCP_TOOL_RESULT_BUDGET=12k` 只能事后清理 | ❌ 缺（对我们收益最大） |
| **详细系统提示 + Skills** | **system 基本为空**（只有一条回复语言指令）；无 skill 渐进加载 | ❌ 缺（这是"详细系统提示"这块最明显的差距） |
| 代码执行沙箱 | 无 | ⚪ 可选，暂不需要 |
| Prompt caching | 无（系统提示为空 → 没有可缓存前缀；provider 层未做 `cache_control`） | ❌ 缺（做 D1 时顺带） |
| 子代理流式事件 | 无（他们有 `stream.subagents`） | ❌ 缺（D4 一并做） |

---

## 4. 路线对比

### 路线 A：直接引入 `deepagents` npm（LangGraph 运行时）

**优点**：四大板块开箱即用；官方长期维护；middleware 生态（caching、summary、summarization）白拿。

**代价（都要落到我们的契约上）**：
1. **运行时替换**：LangGraph 的 checkpointer/store 要接我们的 Mongo（否则又多一份状态真相，违背"对话即唯一真相"）。
2. **流式契约重写**：我们对外是 NDJSON `ChatEvent`（text_delta/tool_call/confirmation_required/usage/done…），deepagents 的事件模型不同，要写一层转换；确认卡要映射到 `interrupt_on`（LangGraph interrupts）——而我们已有自研确认门 + 前端确认卡 + 「队列在确认等待时停下」的语义。
3. **并发/队列重做**：对话级 409、`runningStreams`、pendingQueue 出队，都要包在 LangGraph run 外面。
4. **依赖面**：langchain + @langchain/core + langgraph 进服务端；我们目前是零框架自研（~2k 行），排障成本可控。
5. 自研的上下文治理（预算/句柄/治理）与 Deep Agents 内置的 summary/offload **职责重叠**，等于两套上下文管理并存，得关掉一套。

### 路线 B（推荐）：在现有循环上按「middleware 形态」补齐缺失层

把 Deep Agents 的能力矩阵当作**清单**，在 `chatStream` 的流水线上挂可插拔层，保持 NDJSON 契约 / thread / 409 / 队列 / 确认门不动：

```
chatStream
  → 系统提示层（静态前缀 + 记忆 + skill 渐进注入）        [D1]
  → 上下文装配（现有 buildTurns + 预算）                   [已有]
  → 工具注入（MCP + 内置工具：fs / todos / task）          [D2/D3/D4]
  → runWithTools 循环（现有）+ 子代理执行器                [D4]
  → 事件流（现有 ChatEvent + 子代理维度）                  [D4]
```

**优点**：契约零破坏、可分期、每期独立验收、现有回归清单继续有效；子代理 = 同一个 `runWithTools` 换一套（更小的）工具集 + 独立上下文再跑一遍，**我们的 AsyncGenerator 结构天然支持**。
**代价**：子代理的隔离/并行/取消要自己写（无框架兜底）；没有官方 middleware 生态。

> 判断依据：官方自己说"不需要这些内置能力时不必用 Deep Agents"；我们缺的是**四块能力**而不是**运行时**。先用 B 补齐，若 D4（子代理）做完发现隔离/并行/取消的自研成本失控，再评估切 A（届时 D1–D3 的提示/文件/规划层与框架无关，不白做）。

---

## 5. 分期（路线 B）

| 期 | 内容 | 验收 |
|---|---|---|
| **D1 系统提示 + Skills + caching** | ① 静态系统前缀（角色/BI 领域约定/工具使用守则/输出约束）写入 provider 适配层；② 记忆注入位置固定（现状已注入，纳入前缀以便缓存）；③ skills 目录（`SKILL.md` frontmatter 只载标题，命中才全文注入）；④ Anthropic/OpenAI 的 prompt caching（`cache_control` 标静态前缀） | 系统前缀稳定可缓存（命中率可见）；skill 只在需要时注入；usage 行显示缓存命中 |
| **D2 虚拟文件系统** | 内置 `fs_*` 工具（write/read/edit/ls）+ 可插拔 backend（先磁盘 `.data/fs/<convId>/`，后可换 GridFS/对象存储）；**工具结果卸载升级**：超预算的大结果改为"落盘 + 返回指针/摘要"，替代现在的纯占位符；权限按对话隔离 | 大结果不再撑爆上下文，且跨轮可 `read_file` 取回；`usage.toolResultsOffloaded` 计入透明度行 |
| **D3 任务规划 todo** | 内置 `write_todos` 工具（pending/in_progress/completed/cancelled）+ `conversation.todos` 持久化 + NDJSON `todos` 事件 + 前端计划卡（当前步高亮） | 多步任务先出计划再执行；重启/刷新后计划仍在；前端可见进度 |
| **D4 子代理（委派）** | 内置 `task` 工具：`{description, subagent_type}`；子代理 = `runWithTools` + **该任务允许的最小工具集** + 独立上下文（只看 task 描述）+ 回传摘要（长度上限）；支持单轮多个 `task` 并行（`Promise.all`）；NDJSON 增加 `subagent_start/delta/end` 事件；取消级联（abort 主流 → abort 子代理）；通用型子代理继承主代理工具，专用型（如 `bi-explorer`）白名单 | 长查询被隔离：主上下文只见摘要；两个子代理并行跑同一个对话不串写；取消生效 |
| **D5（可选）代码执行** | 沙箱 `execute`/`eval`（QuickJS 起步），用于数据二次加工 | 沙箱内无网络/文件越界 |

> 每期都跑既有回归清单：NDJSON 流式、确认卡、usage、队列、MCP 面板、BI 工具、`tsc` + `vite build`。

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 自研子代理的隔离/并行/取消复杂度失控 | D4 先做**同步阻塞 + 串行**（对齐官方"同步子代理"页），并行与取消作为二期；若仍失控 → 切路线 A（D1–D3 不白做） |
| 文件系统成为新的持久化真相（与 Mongo 并存） | fs backend 以 `conversationId` 为命名空间，删除对话级联删除文件；元数据记在 conversation 文档 |
| todo/计划让模型"表演式规划"（规划了不执行） | todo 只在多步任务提示注入；前端显示计划 vs 实际工具调用的对照；不做强制 |
| 系统前缀过大反而费 token | 前缀进 prompt cache（D1）；预算公式把 system 前缀计入 `toolSchemaTokens` 一类预留 |
| 事件契约膨胀（子代理维度） | 新事件全部可选、向后兼容：旧前端忽略未知 `type` |

---

## 7. 决议（已确认，2026-09-17）

1. **路线 B**：在自研 harness 上按 middleware 形态补齐，不引入 LangGraph/deepagents。
2. **文件系统 backend**：磁盘 `.data/fs/<conversationId>/`（单机起步，保留 backend 可插拔）。
3. **子代理范围**：只做**通用型**（继承主代理工具集，剔除 `task`/`write_todos` 防递归）。
4. **todo 本期做**（D3 落地）。

## 8. 实施记录（2026-09-17 落地 D1–D4）

| 期 | 落点 | 说明 |
|---|---|---|
| D1 系统提示 + Skills + caching | `src/system-prompt.ts`、`src/skills.ts`、`models.ts` | 系统提示拆**两段**：稳定前缀（角色守则 + skills 索引）+ 动态后缀（长期记忆 / 历史摘要 / 回复语言）；anthropic 通道对稳定段加 `cache_control: ephemeral`，openai 兼容通道走隐式前缀缓存；skills 目录 `skills/<name>/SKILL.md`（frontmatter: name/description），索引常驻、全文由 `read_skill` 按需加载；示例 skill：`metric-caliber-check` |
| D2 虚拟文件系统 | `src/fs-store.ts` | 磁盘 backend，按对话命名空间隔离（拒绝 `..`/绝对路径/反斜杠；单文件 256KB、每对话 100 文件上限）；**工具结果治理升级**：超预算的大结果先卸载为 `results/<callId>_<tool>.txt` 并在上下文里留 `fs_read` 指针（落盘失败才退化为纯占位符）；删除对话级联删工作区 |
| D3 任务规划 | `builtins.ts(write_todos)`、`conversations.todos`、NDJSON `todos` 事件、前端计划卡 | 全量替换语义（对齐 Claude Code/deepagents）；持久化到 `conversation.todos`；前端气泡内渲染 ✓/•/○/× 状态（不只靠颜色） |
| D4 子代理（通用型） | `builtins.ts(task)` + `chat.ts runLoop/runSubagent` | 子代理 = 同一个 `runLoop` 换独立上下文（只看 description）+ 最小工具集（无 `task`/`write_todos`）+ `SUBAGENT_PROMPT` + 回传摘要（≤4000 字，超出截断并提示先落盘）；**连续的 task 调用并行执行**（并发上限 3，worker 池）；取消级联（沿用主代理 signal）；轮次上限 `SUBAGENT_MAX_ROUNDS=10` |

**工具注入规则**：内置工具（fs_* / write_todos / read_skill / task）只在**工具模式**（启用 MCP）注入，直连模式保持零工具语义（实测 `budget=86246` 不变，即 schema 为 0）。schema token 已并入预算公式。

**顺带修复**：前端 `streamChat` 之前漏发 `conversationId`（一直靠服务端 activeConversationId 回退，多标签页会串）——现已显式带上（对齐 §6.1 契约）。

**验证**：
- 新增回归脚本 `scripts/_deep-agents-check.mjs`（真实模型流）：**9/9 PASS** —— fs_write/fs_read 走通、todos 事件+持久化、task 委派返回摘要；
- 既有回归：`tsc --noEmit` ✓、`vite build` ✓、`_bi-tools-check.mjs` 全绿 ✓、`_thread-check.mjs` PASS=22/FAIL=0 ✓；
- 直连模式冒烟 ✓（事件序列 model→text_delta→text→usage→done，无工具注入）。

**已知待办（后续期）**：
- 2026-09-17 追加（多 MCP 服务器加固轮）：①**工具按需加载**（Tool Search：schema 占窗口 >10% 时只注入工具名 + `search_tools`，命中后加载；未加载的工具调用被拒并引导）——对齐 Claude Code `ENABLE_TOOL_SEARCH=auto` 与 Anthropic「Code execution with MCP」；②**确认门按工具注解**（`readOnlyHint` / `destructiveHint`，服务器级 `requireConfirm` 优先，无注解默认不确认、`MCP_CONFIRM_STRICT=on` 转保守，确认卡带原因）；③**子代理服务器白名单**（`task.servers`，对齐「only give subagents the tools they need」）；④**空闲连接回收**（30 分钟未用即断开，在途调用不动）；⑤多服务器稳定性修复（工具顺序确定化、缺席服务器上报、静默截断改为如实回报、连接单飞、失败冷却、取消信号透传、失败即关传输）。回归：`scripts/_mcp-multi-server-check.mjs` 46/46；实链路 `mode=search mcp=0/5`（模型自主检索后取数）/`mode=eager mcp=5/5`（常规路径零回归）。
- 2026-09-17 追加（循环护栏轮）：⑥**同轮同参数去重**（`toolCallSignature` 规范化签名 + 每轮已执行集合，一轮内重复调用只执行一次，其余回灌「已跳过」）；⑦**跨轮 Doom Loop 熔断**（`LoopGuard`：同一组工具调用连续重复达 `MCP_DOOM_LOOP_MAX`（默认 3）即主动收束并提示，指纹变化/空轮重置连击）。均纯函数化、已单测覆盖。回归 `55/55`。待补：并发工具调用、断点恢复。
- ~~`history.ts buildContext` 与 `setConversationSummary` 未接线~~ ✅ 已接线（见 §9）：`chat.ts` 改用 `history.ts assembleContext` 统一上下文装配，摘要层（LLM 压缩 + 水位线跨轮复用）已生效，两套实现合并为一套；
- 子代理目前是「同步阻塞」语义，中途 steer/取消独立子代理（Async subagents）与 `subagent_start/end` 独立事件维度未做；
- 前端尚无工作区文件浏览（fs 内容只在工具步骤里可见）；
- 长期记忆（`.data/memory.json`）已有 HTTP 增删改查端点，但前端没有管理界面（现阶段用 curl / 直接改文件）。

## 9. 架构清理（2026-09-17，查缺补漏 + 去冗余）

**删除的死代码 / 冗余文件**：
- 源码：`fs-store.fsInit`、`conversations.appendMessages`、`models.CallOptions.systemExtra`（无人使用）、`config.modelTimeoutMs`（重复于模型级 `MODEL_<ID>_TIMEOUT_MS`）、`session.clearSessionContext`、`mcp/hub.collectTools`、`chat.ts` 对 `renderHandles` 的 re-export（测试改为直接从 `history.js` 导入）、未使用的 import（`SUMMARIZE_PROMPT`、`disconnectAll`）；
- 一次性调测脚本：`_chat-probe.mjs`、`_probe-model.mjs`、`_sse-proxy-test.ts`、`_sim-client.ts(+log)`、`_test-bi{,-debug,-live,-query}.mjs`、`_yapi-api-deep.mjs`（保留 `_bi-tools-check` / `_thread-check` / `_deep-agents-check` / `_summary-check` / `_bi-openapi` 等有回归价值的脚本）；
- 仓库根目录两个误创建的垃圾文件（`{}`、`{console.log('POST`）；
- 端点：`POST /chat/context/clear`（不带 conversationId 的 deprecated 端点，会用"服务端活跃对话"清错对象；前端改为 `POST /chat/conversations/:id/context/clear`）。

**修复的错误逻辑**：
1. **非流式通道输出恒为空**：`streamCall` 只从 `onDelta` 累积文本、丢弃 `callAgent` 返回的 `result.text`，导致 ollama 与不支持 SSE 的 anthropic 网关永远拼出空回复 → 无增量时补整包文本；
2. **anthropic 通道无流式**：原来完全忽略 `onDelta`，且请求不带 `stream: true` → 改为请求流式并按 `content-type` 解析 SSE（`text_delta` / `input_json_delta` / `message_stop`），网关不支持时自动降级整包 JSON；
3. **OpenAI 流式工具名被拼接**：`current.name += part.function.name`，部分网关每个分片都回传 name 会拼成 `namenamename` → 改为首个分片赋值；
4. **`[DONE]` 只跳出内层 for**：SSE 结束标记后仍继续读流 → 用 `finished` 标志结束外层循环；
5. **历史表格折叠按内容判重**：`head.includes(line)` 会把内容相同的重复行整段保留 → 改为按行号集合裁剪；
6. **用户中断（点"停止"）上下文丢失**：abort 后不落库，界面上已显示的一轮在服务端上下文里不存在 → 中断时仍把这一轮写回 `conversation.context`；
7. **直连模式提示不存在的工具**：稳定前缀里的 `fs_write/fs_read` 守则只在工具模式注入；
8. **图片惰性清理几乎永不触发**：`store.size % 16 !== 0` 的取模节流（删除会改变条目数）→ 改为按时间间隔（10 分钟）节流；
9. `runningStreams: Map<string, number>` 的 value 从未读取 → 改 `Set<string>`。

**补齐的缺口**：长期记忆补 HTTP 端点（原注释声称"接口可查看/增删"但无实现）——`GET/POST /chat/memory`、`DELETE /chat/memory/:id`、`DELETE /chat/memory`。

**回归**：`tsc --noEmit` ✓、`vite build` ✓、`context-budget.test.ts` PASS=30/FAIL=0 ✓。
