# Deep Agents 架构评估与迁移方案

> 版本：v4（2026-09-20，追加 §11 内置工具对标与全量补齐计划 + §11.6 查缺补漏修订 + §11.7 第二轮核对：去冗余 / 主循环缺口 / 回归脚本断层）；v2（2026-09-17，决议已冻结 + 实施记录见 §8）
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

> 本表为 2026-09-17 评估时的差距快照；D1–D4 已于 §8 全部落地，当前符合性见 §10（2026-09-19 自检：六项差距闭合，harness 已达 Deep Agent 最佳实践）。

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
3. **并发/队列重做**：对话级 409、任务注册表（当时的 `runningStreams`，现已是 `chat-tasks.ts`）、pendingQueue 出队，都要包在 LangGraph run 外面。
4. **依赖面**：langchain + @langchain/core + langgraph 进服务端；我们目前是零框架自研（~2k 行），排障成本可控。
5. 自研的上下文治理（预算/句柄/治理）与 Deep Agents 内置的 summary/offload **职责重叠**，等于两套上下文管理并存，得关掉一套。

### 路线 B（推荐）：在现有循环上按「middleware 形态」补齐缺失层

把 Deep Agents 的能力矩阵当作**清单**，在 `chatStream` 的流水线上挂可插拔层，保持 NDJSON 契约 / thread / 409 / 队列 / 确认门不动：

```
chatStream
  → 系统提示层（静态前缀 + 记忆 + skill 渐进注入）        [D1]
  → 上下文装配（现有 buildTurns + 预算）                   [已有]
  → 工具注入（MCP + 内置工具：fs / todos / task / skill / 知识库检索）[D2/D3/D4]
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

> 注：D5 与「图表可视化」不是同一件事——**出图不需要代码执行沙箱**（图表由工具/前端渲染即可，27 种图已有现成方案），D5 只在「数据需要二次加工」时才需要。图表方案见 `docs/chart-visualization-plan.md`（挂账待实施）。
>
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
- 2026-09-17 追加（输入框左下角统一「工具」入口，对齐 ima 等主流产品）：①**MCP（连接器）按钮从顶栏迁移到 composer 左下角**，并与新增的技能入口合并为**单个「＋」工具菜单**（菜单项：添加文件 / 技能 / 连接器；原独立上传图标收进菜单「添加文件」）；点或悬停「技能」「连接器」在菜单**右侧飞出面板**（顶部搜索框 + 图标+名称+描述列表 + 底部操作，选中行右侧打勾，列表按名称/描述/标识本地过滤），打开菜单即预取两份列表；②**新增「技能（Skills）」面板**（此前 skills 只有服务端能力，无任何前端入口）：`GET/PUT /chat/skills` 两个端点——`available` 来自 skills 目录索引（`skills.ts listSkillMetas`），`enabled` 持久化到 `conversation.skillsEnabled`（与 `mcpServers` 同构的对话级设置，PATCH keys 同步放开）；用户**勾选的 skill 全文注入系统提示动态后缀**（`renderEnabledSkills`），稳定前缀（skills 索引段）不动 → prompt cache 命中不受影响；未勾选保持渐进加载现状（索引 + `read_skill` 按需取全文）。语义：勾选 = 用户明确「本对话要用这个技能」，跳过按需加载直接全文注入；不勾 ≠ 禁用（模型仍可通过索引 + read_skill 自主加载）。前端 `ConvSettings` 增加 `skillsEnabled` 镜像 + 乐观更新 + 失败回滚，交互与 MCP 面板完全一致。
- 2026-09-17 追加（多 MCP 服务器加固轮）：①**工具按需加载**（Tool Search：schema 占窗口 >10% 时只注入工具名 + `search_tools`，命中后加载；未加载的工具调用被拒并引导）——对齐 Claude Code `ENABLE_TOOL_SEARCH=auto` 与 Anthropic「Code execution with MCP」；②**确认门按工具注解**（`readOnlyHint` / `destructiveHint`，服务器级 `requireConfirm` 优先，无注解默认不确认、`MCP_CONFIRM_STRICT=on` 转保守，确认卡带原因）；③**子代理服务器白名单**（`task.servers`，对齐「only give subagents the tools they need」）；④**空闲连接回收**（30 分钟未用即断开，在途调用不动）；⑤多服务器稳定性修复（工具顺序确定化、缺席服务器上报、静默截断改为如实回报、连接单飞、失败冷却、取消信号透传、失败即关传输）。回归：`scripts/_mcp-multi-server-check.mjs` 46/46；实链路 `mode=search mcp=0/5`（模型自主检索后取数）/`mode=eager mcp=5/5`（常规路径零回归）。
- 2026-09-17 追加（循环护栏轮）：⑥**同轮同参数去重**（`toolCallSignature` 规范化签名 + 每轮已执行集合，一轮内重复调用只执行一次，其余回灌「已跳过」）；⑦**跨轮 Doom Loop 熔断**（`LoopGuard`：同一组工具调用连续重复达 `MCP_DOOM_LOOP_MAX`（默认 3）即主动收束并提示，指纹变化/空轮重置连击）。均纯函数化、已单测覆盖。回归 `55/55`。待补：并发工具调用、断点恢复。
- ~~`history.ts buildContext` 与 `setConversationSummary` 未接线~~ ✅ 已接线（见 §9）：`chat.ts` 改用 `history.ts assembleContext` 统一上下文装配，摘要层（LLM 压缩 + 水位线跨轮复用）已生效，两套实现合并为一套；
- ~~子代理目前是「同步阻塞」语义，中途 steer/取消独立子代理（Async subagents）与 `subagent_start/end` 独立事件维度未做~~ ✅ 已落地（2026-09-17）：①**独立事件维度**——`runSubagent` 改为 async generator，产出 `subagent_start`（id + parentId + description）/ `subagent_delta`（子代理文本增量）/ `subagent_end`（ok + status: done|cancelled|error + 摘要），主循环逐片转发，旧前端忽略未知 type 即向后兼容；子代理内部工具调用不再静默丢弃（计数 + 文本增量可见），交接摘要仍经 `tool_result` 回灌模型上下文；②**独立取消**——模块级 `subagentRegistry`（key = `sa_<conversationId>_<seq>`）登记运行中实例与其 `AbortController`，新增 `POST /chat/subagent/:conversationId/:subagentId/cancel` 可单独取消某一个子代理（不影响主代理继续运行），取消后子代理以 `status=cancelled` 收束、主代理拿到「已被取消」交接继续编排；③**级联**——`POST /chat/cancel` 主取消与父 signal 中止均级联 abort 该会话所有子代理；④前端推理区新增「子代理」面板（描述 + 状态 + 增量文本 + 运行中可点 × 独立取消）；⑤纵深防御——子代理的交接摘要回灌主上下文时同样按 `src/untrusted.ts` 定界为不可信数据（子代理自身消费的工具结果也已定界），避免外部内容借子代理通道越权指挥主代理。回归 `scripts/_async-subagent-check.mjs` 6/6（注册表单测 + 端点 404/未命中/级联 + 契约冒烟）。**未做（刻意）**：真异步编排（父模型不等待子代理、结果异步回灌）与 mid-flight steer（中途改指令）——前者要重写 `runLoop` 的轮次驱动契约，风险高于收益；后者需要子代理侧消息注入通道，收益有限。
- 子代理活路径 e2e ✅ 已实测（2026-09-17，`scripts/_rag-e2e.mjs` 场景 2）：内置 MCP 服务器 `chart`（`defaultEnabled`）使新对话天然处于工具模式，模型自主调 `task` 并行委派两个子代理 → 事件流 `subagent_start ×2 / subagent_delta ×184 / subagent_end ×2` 完整到达前端（26.9s）；子代理写操作被安全闸门拒绝（子代理默认只读）后主代理自行改为直接 `fs_write` 完成，验证「子代理失败不拖垮主流程」。仍未实测：**运行中点 × 独立取消某一个子代理**（端点与注册表已单测，取消时机需人工在 web 端掐点验证）。
- ~~前端尚无工作区文件浏览~~ ✅ 已落地（2026-09-17：`GET /chat/conversations/:id/files[/content]` + 顶栏「资源」面板，与长期记忆管理合并为一个抽屉）；
- ~~长期记忆前端没有管理界面~~ ✅ 已落地（2026-09-17：「资源」面板内增删查；记忆已按 owner 隔离注入系统提示）。

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
9. `runningStreams: Map<string, number>` 的 value 从未读取 → 改 `Set<string>`。（该结构随后被异步任务底座整体取代：今天运行态的唯一真相是 `src/chat-tasks.ts` 的任务注册表 `running: Map<convId, ChatTask>` + `isTaskRunning()`；全仓已无 `runningStreams`。）

**补齐的缺口**：长期记忆补 HTTP 端点（原注释声称"接口可查看/增删"但无实现）——`GET/POST /chat/memory`、`DELETE /chat/memory/:id`、`DELETE /chat/memory`。

**回归**：`tsc --noEmit` ✓、`vite build` ✓、`context-budget.test.ts` PASS=30/FAIL=0 ✓。

---

## 10. 最佳实践符合性自检（2026-09-19）

> 对当前 `apps/agent-server/src` 实现逐条核对 Deep Agents 官方能力清单与 `docs/agent-infrastructure.md` §安全护栏。结论：**当前 harness 已符合 Deep Agent 最佳实践，无需改动**。原 §3 差距矩阵所列六项（虚拟文件系统 / todo / 子代理 / 详细系统提示+Skills / prompt caching / 子代理流式事件）经 D1–D4 全部闭合。

### 10.1 能力符合矩阵（现状）

| Deep Agents 能力 | 实现位置 | 状态 |
|---|---|---|
| 多轮工具循环 + 轮次上限 | `chat.ts` `runLoop` + `MAX_TOOL_ROUNDS=14`（:58/:1268） | ✅ |
| 子代理委派（独立上下文 / 最小工具集 / 并行 / 可取消 / 独立事件） | `builtins.ts` `task` + `chat.ts` `runSubagent`/`runSubagentBatch` + `subagentRegistry` | ✅ |
| 任务规划（每轮重注入，Claude Code TodoWrite 式） | `builtins.ts` `write_todos` + `system-prompt.ts` `renderTodos` | ✅ |
| 长期记忆（按 owner 隔离、不自动脑补） | `memory.ts`（显式写入 + `renderMemory` 注入） | ✅ |
| Prompt Cache（稳定前缀 / 动态后缀） | `system-prompt.ts` 两段式 + `models.ts`（OpenAI 隐式前缀缓存 / Anthropic `cache_control: ephemeral`） | ✅ |
| 工具按需加载（Tool Search） | `builtins.ts` `search_tools` + 延迟注入模式（`deferred`），命中即加载 spec（:677-716） | ✅ |
| 大结果卸载工作区 | `fs-store.ts` `governToolResults`/`offloadToolResult`，每轮治理（:291/:886） | ✅ |
| 同轮同参数去重 | `chat.ts` `toolCallSignature`（参数排序归一）+ `executedSigs`（:355/:621） | ✅ |
| 跨轮 Doom Loop 熔断 | `chat.ts` `LoopGuard`（连续相同指纹达 `MCP_DOOM_LOOP_MAX` 默认 3 即强制收束，空轮不计连击，:370-388/:889） | ✅ |
| 伪调用拦截（文本模拟工具） | `chat.ts` `looksLikePseudoToolCall` + 作废回灌纠正提示（:154/:596） | ✅ |
| 提示注入防护（结构隔离，非词表） | `untrusted.ts` `wrapUntrusted`（nonce+来源+中和伪造定界+剥离控制符）+ 覆盖全部工具结果与子代理回传（:868/:665） | ✅ |
| 写操作确认闸门（fail-closed） | `risk.ts` + `confirm.ts`（`_risk-gate-check.mjs` 17/17 PASS，见下） | ✅ |
| 模型 fallback 韧性（瞬态重试 / 永久不切 / 已执行工具不重跑防副作用重复） | `chat.ts` 候选链（:1286-1293） | ✅ |
| 执行/推送解耦（断线续传 / 取消 / 结果回投） | `chat-tasks.ts` 异步任务底座 | ✅ |
| 工具通道现状透明告知（防「拿不到 = 没有」幻觉） | `system-prompt.ts` `ToolingStatus`（就绪/缺席/裁切如实上报，:117-148） | ✅ |
| 红线：语义 100% 交模型，零业务词写死 | `SAFETY_GUARDRAIL`/`BASE_PROMPT`/`TOOLING_RULES` 全通用；`untrusted.ts` 显式「不检测自然语言词表」 | ✅ |

### 10.2 本轮核对发现的两处重构（非回归，是改善）

- **Doom Loop**：从早期 Annotation 写法（`lastToolSignature`/`toolSignatureStreak`/`doomLoopExhausted`）重构为 `LoopGuard` 类 + `DOOM_LOOP_MAX_ROUNDS`（默认 3），逻辑更内聚；空轮不计连击，避免思考轮误触发熔断。
- **同轮去重**：从仅针对 `call_api` 的 `callApiKey` 升级为通用 `toolCallSignature`（name + 排序后参数），覆盖所有工具（含子任务），避免「换工具名绕过去重」。

### 10.3 红线确认（agent-infrastructure §「禁止业务词写死」）

- harness 层（`system-prompt` / `chat` / `risk` / `untrusted`）**零业务词写死**：所有安全/工具守则均为跨系统通用语义；「是否该查、查哪个域」完全由模型基于工具返回的真实结果判定，服务端不做业务语义正则匹配。
- 提示注入防护为**纯协议层**（定界 + nonce + 来源标注 + 不可见控制符剥离），不依赖任何自然语言词表拦截，对齐 OWASP LLM01。
- 早期挂账的 `src/analytics` 中文业务正则（按天/按渠道/不要没标等写死）已随 `src/analytics` 删除而移除（复盘见 `docs/mcp-guide.md` §10 陌生库取证）；当前全仓源码已无此类写死（仅文档/注释出现业务词，属正常）。

### 10.4 验证脚本（当前可复跑）

> 2026-09-20 修订：原清单里的 `_deep-agents-check.mjs` / `_mcp-multi-server-check.mjs` / `_thread-check.mjs` **已不在仓库**（见 §11.7 G4）。下列为当前真实可复跑的清单。

- `node --import tsx scripts/_risk-gate-check.mjs` → **22/22 PASS**（写操作安全闸门纯函数断言：内置登记表 / 未知 fail-closed 三口径 / 只读授权降级 / 票据会话绑定 / 参数脱敏 / 审计落盘回读 / SQL 只读判定）。
- `node --import tsx scripts/_builtin-fs-check.mjs` → **22/22 PASS**（2026-09-20 新增，§11.8：fs_read 分页 / fs_glob / fs_grep / 越界拒绝 / 风险登记 / 工具接线）。
- `node --import tsx scripts/_clarify-check.mjs` → **10/10 PASS**（2026-09-20 新增：结构化澄清入参校验 + 票据回传值 / 跳过 / 跨会话 / 一次性 / 超时）。
- `node --import tsx scripts/_concurrent-check.mjs` → **10/10 PASS**（2026-09-20 新增：主循环并发批决策，§11.8）。
- `node --import tsx scripts/_memory-tools-check.mjs` → **7/7 PASS**（2026-09-20 新增：模型侧长期记忆写入/读取/隔离，§11.8）。
- `node --import tsx scripts/_async-subagent-check.mjs` → **6/6 PASS**（子代理独立事件维度 / 独立取消 / 级联，§8 记录）。
- `node --import tsx scripts/_untrusted-check.mjs` → **12/12**（提示注入防护：nonce 定界 / 伪造闭合中和 / 控制符清洗）。
- `node --import tsx scripts/_rag-check.mjs` → **23**（知识库：解析分发 / 切片 / 混合检索 / embedding 降级 / 增量，需先建索引）。
- `node --import tsx scripts/_bi-tools-check.mjs`（需真实实例与凭据）：BI 通道自检。
- **仍缺（挂账）**：真实模型驱动的端到端回归（D1–D4 活链路 / 多服务器加固轮），原由 `_deep-agents-check` 承担 —— 待补或改用现有 e2e 脚本（见 §11.7 G4）。

> 结论：**无需改动代码**。若后续引入新内置工具，只需在 `BUILTIN_RISK` 登记级别（漏登启动即抛错，见 `builtins.ts` `assertBuiltinRiskCoverage`）+ 必要时在 `toolRisks` 补定级，无需改主循环。

---

## 11. 内置工具对标与全量补齐计划（2026-09-20）

> 背景：对当前 `apps/agent-server/src/builtins.ts` 的通用内置工具，与两份业界参考逐项对标——**① Deep Agent 开源库（deepagents / `create_deep_agent`）八大内置工具 + Deep Agent SDK 扩展**；**② Cursor Agent 工具集**。用户决议：**参考清单所列缺口全部补齐**（"都要"）。本节先落文档（补齐清单 + 落点 + 风险 + 分期），代码随后按 §11.4 分期实施。

### 11.0 范围与前置澄清

- **本项目定位**：领域专用（后台管理 / BI 查询）Agent，非通用编码 Agent。原 `call_api` / `search_api_module` 等**业务/领域能力已外置为 MCP 服务器**（`bi` / `yapi` / `movie` / `chart`，经 `MCP_BUILTIN_SERVERS` 注入，见 `mcp/config.ts`）。**本节只针对通用 harness 内置工具**（`builtins.ts` 的 `BUILTIN_SERVER` 一组），不与领域 MCP 工具混算。
- **现状内置清单**：`fs_write` / `fs_read` / `fs_edit` / `fs_ls` / `write_todos` / `task` / `read_skill` / `search_knowledge` / `knowledge_sources` / `record_watched_movies`，外加仅按需加载模式注入的 `search_tools`。
- **补齐原则（不得破坏现有红线）**：
  1. **安全边界放在工具/沙箱层**（`risk.ts` fail-closed + 确认门 `confirm.ts`），不靠 LLM 自我约束；
  2. 高风险工具（`execute` / `browser` / `image_gen` / `http_request` 外发类）**默认关闭、opt-in**，且必须在 `BUILTIN_RISK` 登记级别（漏登 `assertBuiltinRiskCoverage` 启动即抛错）；
  3. **零业务词写死**（`AGENT_CHARTER.md` 最高红线）——工具描述 / 错误提示 / 示例一律用 `XX` / `<模块>` / `<接口>` 占位；
  4. 所有新增内置工具**只在工具模式（启用 MCP）注入**，直连模式保持零工具语义；
  5. schema token 计入预算公式，超阈值走 `search_tools` 按需加载（`deferred`）。

### 11.1 对标矩阵（现状 → 目标）

| 参考工具 | 参考来源 | 现状 | 目标 | 优先级 |
|---|---|---|---|---|
| write_todos / read_todos | deepagents 八件套 | `write_todos` ✅（读靠 `renderTodos` 每轮隐式注入） | 可选补 `read_todos` 显式读取 | P2 |
| ls | deepagents 八件套 | `fs_ls` ✅ | 保持 | — |
| read_file | deepagents 八件套 | `fs_read` ✅（**无 offset/limit**） | 补 `{offset, limit}` 行分页 | P0 |
| write_file | deepagents 八件套 | `fs_write` ✅ | 保持 | — |
| edit_file | deepagents 八件套 | `fs_edit` ✅（防御性替换，`old_string` 必须唯一命中） | 保持 | — |
| glob | deepagents 八件套 | ❌ 缺失 | 新增 `fs_glob`（工作区模式匹配） | P0 |
| grep | deepagents 八件套 | ❌ 缺失 | 新增 `fs_grep`（工作区内容正则，files/content/count 三模式） | P0 |
| task（子代理） | deepagents 八件套 | `task` ✅（通用型，隔离 + 最小工具集 + 并行≤3 + 可独立取消 + 独立事件） | 补**专用型** `bi-explorer` | P1 |
| execute*（沙箱 shell） | deepagents 八件套（需 SandboxBackend） | ❌ 缺失 | 新增 `execute`（沙箱约束 + opt-in） | P2 |
| web_search | Deep Agent SDK | ❌ 缺失 | 新增 `web_search`（provider 可配） | P2 |
| http_request | Deep Agent SDK | ❌ 缺失 | 新增 `http_request`（主机白名单 + 确认） | P1 |
| fetch_url | Deep Agent SDK | ❌ 缺失 | 新增 `fetch_url`（正文转 Markdown + 不可信定界） | P2 |
| Search files & folders（含语义） | Cursor | `fs_ls`（无模式/无语义） | 由 `fs_glob` + `fs_grep` 覆盖；语义搜索挂账 | P1 |
| Read files（图片） | Cursor | ⚠️ 用户上传图片**已有通路**（`uploads.ts` png/jpeg/webp + `VISION=direct` 视觉模型）；但 `fs_read` 仅 utf-8 文本，**读不了工作区里的图片文件** | `fs_read` 增加图片分支（交视觉模型） | P2 |
| Edit files | Cursor | `fs_edit` ✅ | 保持 | — |
| Run shell commands | Cursor | ❌ 缺失 | 同 `execute` | P2 |
| Web | Cursor | ❌ 缺失 | 同 `web_search` / `fetch_url` | P2 |
| Fetch rules | Cursor | `read_skill` + `skills/` ✅ | 保持 | — |
| Browser | Cursor | ❌ 缺失 | 新增 `browser`（opt-in） | P2 |
| Image generation | Cursor | ❌ 缺失 | 新增 `image_gen`（opt-in） | P2 |
| Ask questions | Cursor | ❌（澄清工具不在内置清单，全仓源码无定义） | **先核实现状**，按需补 `request_clarification` | P0 |
| Checkpoints | Cursor | ❌ 缺失 | 新增工作区快照 `fs_snapshot` / `fs_restore` | P1 |
| Subagents（预置类型） | Cursor | `task` ✅ 通用型 | 补专用型（同 `bi-explorer`） | P1 |
| Skills | Cursor | `read_skill` + skills 目录 + 勾选全量注入 ✅ | 保持 | — |
| Memory（模型侧持久化） | deepagents Memory / 最佳实践「Persistent backend」 | ⚠️ **仅用户侧**（`memory.ts` + `GET/POST/DELETE /chat/memory`），模型**无**可调用工具（全仓 `addMemory` 调用点只有 `app.ts`） | 新增 `save_memory` / `recall_memory`（模型显式写入 + 查删） | P1 |
| 可插拔 Backend（State / Filesystem / Persistent / Composite） | deepagents 最佳实践 | ⚠️ 仅磁盘单后端（`fs-store.ts` 硬编码 `.data/fs/`），无 Composite 路径路由（`/memories/` → 持久层） | 抽出 backend 接口 + Composite 路径路由 | P2 |
| Sandbox backend（`execute` 前置） | deepagents（`execute` 依赖 SandboxBackend） | ❌ 无沙箱后端（D5 未做） | 先实现受限沙箱，否则不注册 `execute` | P2 |

### 11.2 补齐清单（分组，含落点与验收）

**A. 文件系统补全（P0/P1）**

- `fs_glob`：`{pattern, path?}`——在工作区命名空间内做 glob 匹配（支持 `**/` 递归）；复用 `fs-store.ts` 现有越界校验（拒 `..` / 绝对路径 / 反斜杠）。
- `fs_grep`：`{pattern, path?, mode: files|content|count, glob?}`——正则搜索工作区文件内容，content 模式返回 `文件:行号:命中行`。
- `fs_read` 补 `{offset, limit}`：按行分页读取（对齐 deepagents `read_file`）；缺省整读，保持向后兼容。
- **验收**：新增 `scripts/_builtin-fs-check.mjs`——glob / grep / 分页各 ≥3 用例 + 越界（`..`、绝对路径）拒绝。

**B. 交互与体验（P0/P1）**

- `request_clarification`（对齐 Cursor Ask questions）：**现状已核实**（2026-09-20）——全仓无该工具定义（`builtins.ts` 与各 MCP 适配器均无），澄清当前**完全靠纯文本反问**：`system-prompt.ts` 的 `TOOLING_RULES` 第 3 条明确「为补全必填参数而追问是允许的」，`BASE_PROMPT` 第 1 条要求先写明对请求的理解。即**「反问」能力在，但无结构化选项**（模型只能写一段问题，用户以自由文本回答）。
  - 目标：补 `request_clarification` 工具 `{question, options[]}` + NDJSON 事件 `clarification_required` + 前端选项卡（复用确认门 `confirm.ts` 的等待/应答通道），把澄清从「散文追问」升级为「结构化多选」；纯文本追问作为无固定选项时的降级路径保留。
- `Checkpoints`（工作区快照）：`fs_write` 前对工作区打快照（`.data/fs/<convId>/.snapshots/`），提供 `fs_snapshot` / `fs_restore` 与 HTTP 端点；对齐 Cursor「重大变更前自动快照 + 一键回滚」，独立于 Git。
- **验收**：澄清选项可回填并驱动后续轮次；快照创建 → 改文件 → 回滚后内容与快照一致。

**C. 网络能力（P1/P2）**

- `http_request`：`{method, url, headers?, body?}`——**主机白名单**（env `TOOL_HTTP_ALLOW_HOSTS`）+ 默认走确认门 + 响应体大小上限。
- `web_search`：`{query, count?}`——provider 可配（env `WEB_SEARCH_*`）；**未配 key 时按 `ToolingStatus` 诚实上报"未配置"**，不静默失败。
- `fetch_url`：`{url}`——抓取正文转 Markdown；结果**必须**经 `untrusted.ts` `wrapUntrusted` 定界（外部内容 = 不可信数据）。
- **验收**：白名单外主机拒绝；未配 key 时诚实上报；抓取/搜索结果确被 `wrapUntrusted` 包裹。

**D. 沙箱与多模态（P2，opt-in）**

- `execute`：`{command, cwd?}`——**仅当 `TOOL_SANDBOX=on` 且检测到沙箱后端才注册**（对齐参考「默认 in-memory 不开放」）；无沙箱时工具不进入模型清单。`BUILTIN_RISK` 定 `destructive` + 强制确认。
- `browser`：导航 / 点击 / 截图 / 取文本，opt-in（`TOOL_BROWSER=on`），复用现有 playwright 依赖，默认关闭。
- `image_gen`：`{prompt, size?}`，opt-in（需 provider key）；产物落工作区 `assets/` 并内联预览。
- **验收**：默认关闭时工具不出现在模型清单（`budget` 不变）；开启后写/外发类操作走确认门。

**E. 子代理专业化（P1）**

- 新增专用子代理类型 `bi-explorer`（对齐 Cursor 预置类型 + 参考「任务专业化」）：**受限只读工具集**（BI / 知识库 / fs 读取），专用于多步 BI 探查并回传摘要；主代理保持高层协调（专治「查 N 行回灌上下文」的 context-bloat）。
- 落点：`roles.ts` 子代理类型注册 + `chat.ts` `resolveSubagentTools` 白名单 + `task` 参数 `subagent_type`。
- **验收**：`task(subagent_type: "bi-explorer")` 走受限工具集，写操作被拒（复用现有 `subagent_refused` 审计）。

**F. 长期记忆的模型侧工具（P1）**

- 现状：`memory.ts` 提供 `addMemory` / `removeMemory` / `listMemory`，但**调用点只有 `app.ts` 的 HTTP 端点**——记忆完全由用户手工维护，模型无法把「用户明确表达的稳定事实 / 偏好」自行沉淀（与参考的 Memory 能力不对齐）。
- 目标：新增 `save_memory` `{text}`、`recall_memory` `{}`（可选 `forget_memory` `{id}`）；写入仍守「**显式写入、不自动脑补**」原则——只落用户明确表达的事实，不做推断抽取；按 `ownerKey` 隔离（复用 `owner.ts`）。
- 落点：`builtins.ts`（注册 + `BUILTIN_RISK` 定 `write` / `scope: workspace`，无外部副作用故免确认）+ 复用 `memory.ts` 现有函数。
- **验收**：模型调 `save_memory` 后 `GET /chat/memory` 可见，且下一轮 system 动态后缀已注入；`recall_memory` 只返回当前 owner 可见条目。

**G. 可插拔 Backend（P2，架构项）**

- 现状：`fs-store.ts` 把根目录硬编码为 `.data/fs/`，后端不可替换；持久层（`memory.json`）与工作区是两套独立实现，无 Composite 路径路由。
- 目标：抽出 `FsBackend` 接口（read / write / edit / list / glob / grep）→ 先用现有磁盘实现；再评估 Composite（路径前缀路由，如 `/memories/` → 持久层、`/results/` → 工作区），为将来换 GridFS / 对象存储留口。**属架构重构、非新增工具，排最后做。**
- **验收**：磁盘 backend 行为与现状逐字节一致（回归全绿）；Composite 路由单测通过。

### 11.3 风险与护栏

| 风险 | 缓解 |
|---|---|
| 新增工具扩大攻击面 | 一律先 `BUILTIN_RISK` 登记 + fail-closed；高风险默认 off、opt-in 才注册 |
| `execute` / `browser` 沙箱逃逸 | 无沙箱后端不注册；网络/文件越界在**工具层**拦截（不靠 LLM 自律） |
| 外部内容注入主代理 | `http_request` / `fetch_url` / `web_search` / `browser` 结果全部经 `wrapUntrusted` 定界 |
| schema 膨胀挤占窗口 | 计入预算公式；超阈值走 `search_tools` 按需加载 |
| 违反「禁止业务词写死」红线 | 新增工具描述/错误提示全部通用措辞；评审按 `AGENT_CHARTER.md` 审计口径 |
| 模型侧记忆写入污染（把推断当事实沉淀） | 只落用户**明确表达**的事实，不做自动脑补抽取；按 `ownerKey` 隔离；写失败仅记录不阻断对话 |
| Backend 重构引入回归 | 先抽接口、保持磁盘实现逐字节一致，回归全绿后再做 Composite 路径路由 |

### 11.4 分期与验收

- **P0（先做）**：`fs_glob`、`fs_grep`、`fs_read` offset/limit、`request_clarification`（结构化多选）→ **四项均已于 2026-09-20 落地，见 §11.8**。
- **P1**：工作区快照（Checkpoints）、`http_request`、`bi-explorer` 专用子代理、Search files（由 glob/grep 覆盖）、`save_memory` / `recall_memory`。
- **P2**：`execute`（**需先有沙箱后端**）、`browser`、`image_gen`、`web_search`、`fetch_url`、Read files（`fs_read` 图片分支）、`read_todos`、语义搜索、可插拔 Backend（架构项，最后做）。

**回归清单**：`tsc --noEmit` ✓、`vite build` ✓、`scripts/_risk-gate-check.mjs`、`scripts/_deep-agents-check.mjs`、`scripts/_async-subagent-check.mjs`；新增 `scripts/_builtin-tools-parity-check.mjs`（新工具注册 + 风险登记 + 默认关闭断言）。

### 11.5 与 §10 结论的关系

§10「无需改动代码」成立的前提是**只对齐 Deep Agents 的能力层（middleware 形态）**，不含逐工具对标。按用户决议（参考清单缺口全补），本节为 §10 的**工具级增量**，不推翻其能力层结论；新增工具仍遵循 §10.4 的规则——在 `BUILTIN_RISK` 登记级别、必要时补 `toolRisks`，**不改主循环**。

### 11.6 查缺补漏核对记录（2026-09-20，源码级）

对 §11 结论逐条回源码核实；结果与修正如下。

**① 已核实为真的结论**

| 结论 | 证据（源码） |
|---|---|
| 内置工具就是这 11 个 | `builtins.ts` `builtinToolSpecs`（`search_tools` 条件注入）；`execBuiltin` 的 switch 分支一一对应 |
| `fs_read` 无分页 | `fs-store.ts` `fsRead(conversationId, path)` 只有 path；超 `MAX_FILE_BYTES`(256KB) 直接截断 |
| `fs_edit` 是防御性替换 | `fs-store.ts` `fsEdit`：命中 0 次报错、>1 次报「需要唯一」 |
| 无 glob / grep / snapshot | `fs-store.ts` 导出仅有 `fsWrite` / `fsRead` / `fsEdit` / `fsList` / `fsRemoveConversation` / `offloadToolResult` |
| 无 execute / browser / image_gen / web_search / http_request / fetch_url | 全仓无这些工具定义（`builtins.ts` + 各 MCP 适配器） |
| 无结构化澄清工具 | 全仓 grep `clarif` / `ask_question` / `request_question` = **0**；澄清靠 `TOOLING_RULES` 第 3 条纯文本追问 |
| `task` 无 `subagent_type` | `builtins.ts` 的 `task` 参数只有 `description` / `servers` |
| 业务工具已外置为 MCP（§11.0 判断成立） | `yapi-mcp.mjs` 的 `TOOLS` 含 `call_api` / `search_apis` / `get_api_desc` / `list_projects` / `list_categories`；`bi` → `metabase-mcp.mjs` |
| backend 不可替换 | `fs-store.ts` 顶部 `FS_ROOT = resolve(__dirname, "..", ".data", "fs")` 硬编码 |

**② 本轮修正 / 新增的 4 项（原稿遗漏）**

1. **模型侧 Memory 工具缺失**——`memory.ts` 的 `addMemory` / `removeMemory` / `listMemory` 调用点只有 `app.ts`（HTTP 端点），模型无法写入记忆。原 §11 未列 → 已补 §11.1 + §11.2 **F**。
2. **可插拔 Backend / Composite 未对齐**——参考最佳实践明确列出 Backends 四态（State / Filesystem / Persistent / Composite），本项目只有磁盘单后端、无路径路由。→ 已补 §11.1 + §11.2 **G**。
3. **`execute` 的硬前置 = 沙箱后端**——参考明确「仅当 backend 实现 SandboxBackend 才可用」；原稿只写 opt-in 开关，漏了「得先有沙箱」这个前置条件。→ 已补 §11.1 + §11.2 **D**。
4. **图片输入其实已部分具备**——`uploads.ts`（png/jpeg/webp）+ `VISION=direct` 视觉模型已支持用户上传图片；真实缺口只是 `fs_read` 读不了工作区里的图片文件。→ 已修正 §11.1 该项，避免误计为「零基础」缺口。

**③ 已对齐、无需新增的项（避免过度补齐）**

| 参考最佳实践 | 本项目现状 | 判定 |
|---|---|---|
| Tool Result Eviction（默认 20000 token 自动落盘） | `MCP_TOOL_RESULT_BUDGET=12000` + `_KEEP=3` + `_PROTECT`；`offloadToolResult` 落盘并留 `fs_read` 指针 | ✅ 已对齐（阈值 12000 可配，差异非缺口） |
| 工具 schema 超载 → Tool Search | `TOOL_SEARCH_MODE=auto` / `TOOL_SEARCH_RATIO=0.1` + `search_tools` | ✅ 已对齐 |
| 写操作安全边界在工具/沙箱层 | `risk.ts` fail-closed + `confirm.ts` + `_risk-gate-check.mjs` 17/17 PASS | ✅ 已对齐（强于「trust-the-LLM」） |
| `edit_file` 防御性替换 | `fsEdit` 唯一命中约束 | ✅ 已对齐 |
| MCP 接外部能力 | `MCP_BUILTIN_SERVERS` + `mcp/hub.ts` 命名空间 + 注解定级 | ✅ 已对齐 |
| Skills 渐进加载 | `skills.ts` 索引常驻 + `read_skill` 按需取全文 | ✅ 已对齐 |

> 小结：原 §11 方向正确（缺 8 类工具），但**漏了 4 项**——模型侧记忆、可插拔 Backend、`execute` 的沙箱前置、图片输入已部分具备；已全部补入 §11.1 / §11.2 / §11.4。**代码仍零改动**，待确认后按 §11.4 分期实施。

---

### 11.7 第二轮核对：去冗余 + 主循环缺口 + 回归脚本断层（2026-09-20，源码级）

> §11.6 只做了「内置工具 vs 参考清单」的补齐核对。本轮换维度：**① 主循环执行模型**、**② 已落地能力是否被重构吃掉**、**③ 冗余与死代码**、**④ 文档与仓库的一致性**。结论：新增 **1 个真功能缺口（G1 并发）**、**2 个回归型缺口（G2 审计端点 / G4 回归脚本断层）**、**1 个口径修正（G3）**，冗余 6 类（R1–R6）。

#### 11.7.1 新发现的缺口（§11.1–§11.6 未列）

| # | 缺口 | 证据（源码） | 参考口径 | 定级 |
|---|---|---|---|---|
| **G1** | 主循环单轮多工具**串行**执行 | `chat.ts` 主循环 `while (index < calls.length)` 逐个 `await`（:811–1090，普通工具分支 :947–1090）；**只有连续的 `task` 委派**合并成一批并行（:832–876，worker 池 ≤ `SUBAGENT_MAX_PARALLEL=3`） | Anthropic / Cursor / Deep Agents：单轮返回多个独立 `tool_calls` 时**并发执行**（同一批读查询不必付 N×RTT） | **P1** |
| **G2** | 审计只读查询端点缺失（**已落地能力被重构吃掉**） | `audit.ts:94 listAuditEvents` 在 `src/` 内 **0 引用**；`app.ts` 41 条路由中无任何 `/audit/*`，只 `import { appendAudit }`（:19）→ 审计**只写不查**（唯一读取路径是 `_risk-gate-check.mjs:166`） | 写操作安全闸门要求「可审计」：留痕而不可核查 ≈ 半个能力（对照 `docs/agent-infrastructure.md` §安全） | **P0** → ✅ **本轮已接线**（`GET /chat/audit`） |
| **G3** | 工具结果预算**单位**口径不一致 | `chat.ts:49 MCP_TOOL_RESULT_BUDGET = 12_000` 单位是**字符**；官方 eviction 阈值 20000 单位是 **token** | 官方：超 20000 token 自动落盘 | **文档修正** —— §11.6 写「已对齐（阈值差异非缺口）」不准确：字符 vs token 差 3–5 倍，实为**偏保守**（不是缺口，但要写清口径） |
| **G4** | **回归脚本断层**：文档声称可复跑的脚本已不在仓库 | `scripts/` 现存 30 个 `.mjs`；`_deep-agents-check.mjs`（§10.4 称 9/9）、`_mcp-multi-server-check.mjs`（§8 称 46/46、`docs/mcp-guide.md` 称 55 项）、`_thread-check.mjs`、`_summary-check.mjs`、`_movie-api-check.mjs`、`_movie-taste-check.mjs` **均已不存在** | 回归清单必须真实可跑；文档引用已删脚本 = 假回归 | **P0**（补脚本 **或** 改文档，需决策） |
| **G5** | 路径级权限（只读目录 / 写入白名单） | `fs-store.ts` 只有越界校验（:21–30 拒绝对路径 / `..` / 反斜杠），无「只读子目录 / 路径策略」 | Deep Agents filesystem backend 支持路径级策略 | P2 |
| **G6** | `read_todos` 显式工具 | 靠 `system-prompt.ts:173 renderTodos` **每轮注入**动态后缀 | 官方同时提供 `read_todos`，但也声明 middleware 会自动注入 | P2 维持可选（与 §11.1 一致，不重复立项） |

#### 11.7.2 冗余清单（去冗余）

| # | 类型 | 位置 | 处置建议 |
|---|---|---|---|
| **R1** | 未接线导出（实质死代码） | `audit.ts:94 listAuditEvents` + `AuditFilter`（`src/` 内 0 引用） | 与 G2 合并：接线为 `GET /chat/audit`（按 owner 隔离，与 `/chat/cost/summary` 同口径），**不删**（合规需要）→ ✅ 本轮已落地（附：`AuditEvent` 补 `ownerKey` 字段，否则端点无法做归属隔离） |
| **R2** | 双实现（口径漂移风险） | `src/sql-readonly.ts:16 isReadOnlySql`（TS，服务端权威判定）与 `scripts/metabase-mcp.mjs:82 isReadOnlySql`（mjs，MCP 适配器内粗筛） | 保留双层（纵深防御，符合「安全边界在工具/沙箱层」），但两处加**交叉引用注释**标明权威口径在 `sql-readonly.ts`；口径变更必须同步两处 → ✅ 本轮已加双向注释 |
| **R3** | 仅在自身文件内使用的 `export` | `chat.ts`：`looksLikePseudoToolCall`(:199) / `toolSearchEnabled`(:276) / `searchMcpTools`(:300) / `ToolMatch`(:291)；`session.ts`：`ConvSortMode`(:25) / `SessionPreferences`(:28)；`conversations.ts`：`ORDER_STEP`(:138) | 降为模块私有（零行为变化）。**低优先**，随下次改动顺手做 |
| **R4** | 一次性调测脚本堆积 | `scripts/` 下 26 个 `_` 前缀脚本。**有文档背书的保留**：`_risk-gate-check` / `_untrusted-check` / `_rag-check` / `_rag-e2e` / `_rag-inject-e2e` / `_bi-tools-check` / `_bi-readonly-check` / `_async-subagent-check` / `_async-task-check` / `_mute-check` / `_owner-isolation-check` / `_movie-grounding-gate` / `_trace-check` / `_role-check` / `_conversation-extras-check` / `_cost-schedule-check` / `_limit-workspace-check` / `_chart-e2e`；**一次性**：`_probe_stream` / `_e2e-more` / `_movie-mcp-probe` / `_movie-probe-detail` / `_movie-profiles` / `_movie-hub-check` / `_movie-e2e-now` / `_movie-e2e-cn` | 与 G4 一起处理：**先补齐/修正回归项，再归档一次性脚本**（顺序不能反，否则又删掉有回归价值的） |
| **R5** | 文档与仓库不一致 | §8 / §10.4 把已不存在的脚本列为回归项（见 G4）；§11.4 计划新增的 `_builtin-fs-check.mjs` / `_builtin-tools-parity-check.mjs` 尚未创建 | 随 G4 一并修订 |
| **R6** | 提示冗余 | `system-prompt.ts`：`BASE_PROMPT` 第 2 条讲 `write_todos`、`TOOLING_RULES` 第 1 条讲 `fs_write/fs_read` | 官方建议「不要在自定义 system_prompt 里重复解释内置工具（middleware 会自动注入）」——**但本 harness 无 middleware 自动注入，必须写**；保持，仅精简措辞（低优先） |

#### 11.7.3 优于参考的自研护栏（避免误当缺口“补齐”）

这些是参考清单里**没有**、而我们已落地的，本轮明确登记为「不因对标而删除」：

- 工具连续失败熔断（`chat.ts:929`–`946`，`TOOL_FAILURE_LIMIT`）——对已挂上游不再空耗；
- 接地核验（`grounding.ts` + `chat.ts:793` 事后作废并回灌纠正提示）——抗编造；
- 不可信内容定界（`untrusted.ts`，OWASP LLM01 结构隔离，非词表）；
- 确认票据会话绑定 + 一次性（`confirm.ts`）——防跨会话批准别人的写操作；
- 工具通道现状透明上报（`ToolingStatus`：缺席 / 裁切如实告知）——防「拿不到 = 没有」幻觉；
- 伪调用拦截、同轮同参去重、跨轮 Doom Loop 熔断。

#### 11.7.4 分期更新（并入 §11.4）

- **P0 追加**：`G2`（审计只读端点接线）、`G4`（回归脚本断层：补 `_deep-agents-check` / `_mcp-multi-server-check`，或把文档回归项改为现存脚本——**需先决策**）。
- **P1 追加**：`G1`（主循环并发）。**约束**：① 需确认（写/破坏性）的调用与 `task` 委派**必须保持串行语义**，避免同时弹多张确认卡、避免并行的子代理互相抢占注册表；② 同轮去重集合 `executedSigs`、失败计数 `failedTools`、`handles`/`conversation` 回灌顺序需保证**按原始 `calls` 顺序**落上下文（并发执行但顺序回灌，保证 prompt cache 与可复现）。
- **P2 追加**：`G5`（路径级权限）、`R3`（不必要 export 降私有）。

#### 11.7.5 本轮结论

1. **工具层缺口仍以 §11.4 为准**（P0：`fs_glob` / `fs_grep` / `fs_read` 分页 / `request_clarification`），本轮不推翻。
2. 新增的真缺口里，**G2 / G4 是回归型**（曾经有或声称有，现在没有），优先级高于新增工具——先止血再扩张。
3. **未发现新的架构级重复实现**（除已知 R2 双层 SQL 只读判定，属刻意纵深防御）。
4. **本轮代码改动（仅止血项，不含 §11.4 新增工具）**：`src/audit.ts`（`AuditEvent.ownerKey` + `AuditFilter.ownerKey` + 归属过滤）、`src/chat.ts`（审计落点带 `ownerKey`）、`src/app.ts`（新增 `GET /chat/audit`）、`src/sql-readonly.ts` 与 `scripts/metabase-mcp.mjs`（双向口径交叉注释）。`tsc --noEmit` exit 0。其余待确认后按 §11.7.4 与 §11.4 合并后的分期执行。

---

### 11.8 P0 实施记录（2026-09-20）

> §11.4 的 P0 四项已全部落地；本轮是**首次动到工具层代码**（此前 §11 全程零代码改动）。

#### 11.8.1 落地项

| 项 | 落点 | 说明 |
|---|---|---|
| `fs_read` offset/limit | `fs-store.ts fsRead` + `builtins`（spec/exec）+ `app.ts` `/chat/conversations/:id/files/content` | 按**行**分页（offset 从 0 起），回报总行数与实际区间并提示下一次 offset；不传即整读，向后兼容 |
| `fs_glob` | `fs-store.ts fsGlob`（`globToRegex`）+ `builtins` | 支持 `*` / `?` / `**` / `**/`；**先判绝对路径・盘符・`..` 再去前导斜杠**（否则 `/etc/x` 被规范化成相对模式后静默通过、反馈不清）；结果 200 条封顶 |
| `fs_grep` | `fs-store.ts fsGrep` + `builtins` | files / content / count 三模式 + `glob` 预过滤；正则长度 ≤200、命中 ≤2000、单行回显 ≤200 字符（截断加省略号）、含 `\0` 的二进制文件跳过、非法正则返回错误而非抛异常 |
| `request_clarification` | `packages/shared`（`clarification_required` / `clarification_response` 事件 + `ClarifyOption`）、`confirm.ts`（`requestClarification` + 应答带回 `value`）、`builtins`（spec/exec 返回 `clarification`）、`chat.ts`（下发事件 + 挂起等待 + 回灌）、`app.ts`（`/chat/confirm` 收 `value`）、`web`（`api.ts` + `ChatPage.vue` 选项卡） | 结构化多选（2–6 个选项）；**复用确认票据通道**（一次性 + 会话绑定 + 超时），不新增第二套等待机制；跳过 = 不带值应答，模型按自身理解继续；提示侧 `TOOLING_RULES` 第 6 条引导「目标/词义有歧义先澄清，能唯一确定就不要问」 |
| 风险登记 | `builtins.BUILTIN_RISK` | 三个新工具均 `read` / `workspace`（无外部副作用，免确认）；漏登由 `assertBuiltinRiskCoverage` 启动即抛 |

#### 11.8.2 实现中发现并修复的缺陷（清单外，回归型）

- **确认票据被跨会话应答 → 等待方永久挂起**：`confirm.ts answerConfirmation` 在会话不匹配时执行 `tickets.delete` + `clearTimeout` 后直接返回失败，等待中的工具调用既等不到应答也等不到超时 → **该轮卡死**（只能等连接断开）。原注释写的意图是「等待方超时后按拒绝处理」，但实现把定时器也清掉了，与该意图自相矛盾。
  **修复**：不匹配时先 `clearTimeout` 再立即 `resolve({ confirmed: false, timedOut: false })`——按「拒绝」立即收束（fail-closed），等待方不挂死。已由 `_clarify-check.mjs` 用例锁定。

#### 11.8.3 新增回归脚本

- `scripts/_builtin-fs-check.mjs` → **22/22 PASS**（分页 4 / glob 4 / grep 8 / 风险登记 1 / execBuiltin 接线 5）
- `scripts/_clarify-check.mjs` → **10/10 PASS**（入参校验 4 / 风险登记 1 / 票据回传值・跳过・跨会话・一次性・超时 5）

#### 11.8.4 G1 主循环并发（同日追加）

**问题**：主循环单轮多工具**串行**（`while (index)` 逐个 `await`），只有连续 `task` 委派并行 → 模型一轮发 3 个独立只读查询要付 3×RTT。

**落地**：
- 新增 `planConcurrentBatch`（`chat.ts`，纯函数可单测）：从 `start` 起收集**连续**的可并发调用段，遇到「已执行过 / 批内重复 / 已熔断 / 不可并发」即停，长度受 `MCP_CONCURRENT_CALLS`（默认 4）限制。
- **可并发判据**：`level === "read"` 且免确认且非交互（`task` 自带并行批、`search_tools` 会改工具清单、`request_clarification` 要挂起等用户，三者均排除）；写操作 / 需确认 / 被拒的一律**串行**（避免同时弹多张确认卡）。
- **顺序纪律**：并发执行但**事件与上下文回灌仍按模型给出的原始顺序**（`Promise.all` 后按索引依次 yield `tool_result` / push conversation / 记 handles），保证可复现与 prompt cache 稳定。
- 只有 1 个可并发调用时**走原串行路径**，零行为变化；≥2 个才真的并发。
- 审计留痕口径统一：抽出 `auditBaseOf(call, verdict)`，串行与并发两条路径共用。

**回归**：`scripts/_concurrent-check.mjs` **10/10 PASS**（三个只读成批 / 遇写即停不跳过去凑批 / 交互式与 task、search_tools 不进批 / 已执行与批内重复不进批 / 熔断不进批 / max 与 start 生效 / 空列表不越界）。

#### 11.8.5 G4 回归脚本断层（文档侧处置）

按 §11.7.4 的「补脚本 **或** 改文档」二选一，本轮先做**文档侧止血**（成本低、即刻消除假回归）：
- §10.4 回归清单已改为**当前真实存在**的脚本，并标注 `_deep-agents-check` / `_mcp-multi-server-check` / `_thread-check` 已不在仓库；
- 这些脚本原先覆盖的 D1–D4 能力，现由 `_builtin-fs-check`（文件系统工具）、`_clarify-check`（澄清通道）、`_async-subagent-check`（子代理）分别覆盖；
- **仍缺**：真实模型驱动的端到端回归（原 `_deep-agents-check` 的核心价值），挂账待补。

#### 11.8.6 模型侧长期记忆工具（P1，同日追加）

**问题**：`memory.ts` 此前只有 HTTP 端点（`app.ts`）能写 → 记忆完全由用户手工维护，模型无法把用户明确表达的稳定事实沉淀下来（与参考的 Memory 能力不对齐）。

**落地**（`builtins.ts`，复用 `memory.ts` 现有函数，无新增存储）：
- `save_memory {text}`：只记**用户明确表达**的事实/偏好（工具描述明文禁止推断、禁止把临时需求当长期偏好）；按 `ownerKey` 隔离；内容完全相同则不新增（幂等）；缺 owner 时如实报错而非静默丢弃。
- `recall_memory {}`：只回当前 owner 的条目；为空时如实回「没有」，不编造。
- 风险登记：`recall=read/workspace`、`save=write/workspace`（`external=false` → **不弹确认卡**，因为它无外部副作用，与 `fs_write` 区分开）。
- **刻意不做 `forget_memory`**：让模型删除用户记忆风险高于收益，删除仍走 HTTP 端点与前端「资源」面板。

**回归**：`scripts/_memory-tools-check.mjs` **7/7 PASS**（写入可见 / 空内容拒 / 缺 owner 报错 / 跨 owner 隔离 / 幂等 / 无记忆如实回 / 风险登记不弹卡），脚本结束前按 id 清理自己写入的条目，不留脏数据。

#### 11.8.7 回归与遗留

- 已跑：`tsc --noEmit` ✓、`_risk-gate-check.mjs` 22/22 ✓、`_builtin-fs-check.mjs` 22/22 ✓、`_clarify-check.mjs` 10/10 ✓、`_concurrent-check.mjs` 10/10 ✓、`_memory-tools-check.mjs` 7/7 ✓。
- 未跑：`vite build`（本轮执行未被授权，前端改动为标准模板/样式 + `read_lints` 0 错误，建议下次一起验）；真实模型端到端（见 §11.8.5）。
- 未做：§11.4 的 P1 余项（`http_request` / `bi-explorer` 专用子代理 / Checkpoints 工作区快照）与 P2 全部项；§11.7 的 R3/R4（不必要 export 降私有、一次性脚本归档）。

#### 11.8.8 实例验证（2026-09-20，真实服务 + 真实模型）

> 用户要求所有改动做真实实例验证。已重启 `agent-server-dev` 到新代码 `release=e63b124`（改完必须 `pm2 delete` + `pm2 start`，`restart` 会残留旧进程占端口）。

**已实例验证（HTTP 真实服务，确定性，不依赖模型）— 8 PASS：**
- `/health` 存活、返回新 release；
- `/chat/stream` 返回 200、模型跑通；
- `GET /chat/audit` 形状正确（`{events:[]}`）；
- **审计 owner 隔离**：A 的查询含 A 的事件、B 的查询不含（`listAuditEvents` 按 `ownerKey` 过滤成立）；
- `/chat/conversations/:id/files` 端点可用（返回数组）；
- `POST /chat/memory` 写入 200、`GET /chat/memory` 真实持久化（带正确 ownerKey）、`DELETE /chat/memory/:id` 可清理。

**模型驱动项 — 14 PASS / 1 SKIP（2026-09-20 换用支持 tool-calling 的模型后复跑）：**
- 模型切换：TokenHub `kimi-k2.7-code`（`.env` 的 `MODEL_PROVIDERS=kimi27,hyvision`，默认 `kimi27`）；下掉 402 未开通的 `minimaxm27`。网关侧直观证据：非流式 1.7s / 流式首字节 0.9s / 带 tools 返回 `finish_reason=tool_calls`。
- 转 PASS 项：`fs_write`/`fs_glob`/`fs_grep` 被模型主动调用、文件真实落盘（`notes/a.md`+`notes/b.md`）、`files/content` 分页、结构化澄清应答（流内自动应答 200 + `clarification_response` 回传）、主循环并发批（2 call / 2 result）。
- 唯一 SKIP：某次运行模型未主动发起 `clarification_required`（模型行为随机性，如实标记，不伪装通过）。
- 脚本加固 `scripts/_deep-agent-instance-check.mjs`：逐项即时输出、`waitForHealthy` 抗 pm2 重建窗口、流读取超时容错、流内自动应答（模拟前端确认/澄清），可用 `AGENT_MODEL=<id>` 指定模型一键复跑。

**排查中确认的两点（均非服务端 bug）：**
1. **记忆去重幂等**：`addMemory` 对相同 text 复用首次写入者的 `ownerKey`（不重复落条）。验证脚本初次用固定 text「小明」多次运行命中历史旧条目，导致 GET 用新 oid 查不到——改用唯一 text（带时间戳）后即通过。
2. **测试脚本 cookie jar 缺陷（已修）**：原实现只取第一个 `set-cookie`，把 `bx_agent_oid`（owner 标识）丢掉，导致归属隔离验证失真；已改为合并全部 `set-cookie`（sid 与 oid 都保留）。

> 线上浏览器会自动管理全部 cookie，此缺陷仅存在于测试脚本，不影响真实用户。
