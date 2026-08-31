# Cursor 架构调研与 bx-admin-agent 对齐可行性

> **文档类型**：调研文档（仅分析，不含代码改动）
> **撰写日期**：2026-08-22
> **背景**：用户要求「输入到确定需要调用工具之前」的链路"全部参考 Cursor 的实现方式"重做。本文先回答 Cursor 本身用什么实现、用到哪些功能，再评估 bx-admin-agent 能否照搬。

---

## 1. Cursor 是用什么实现的？

**一句话**：Cursor 是一个 **VS Code 分支（Electron + TypeScript 桌面客户端）**，其 Agent 能力是 **自研编排层**，**没有使用 LangGraph 或其他开源 agent 框架**。

| 维度 | Cursor 的实现 | 说明 |
|---|---|---|
| 运行时 | Electron（桌面应用）+ TypeScript | 不是服务端框架，是 IDE 客户端 |
| Agent 编排 | **自研的 tool-loop（ReAct 变体）** | 模型返回 → 解析 tool_call → 执行 → 结果回填 context → 再调模型，由客户端代码控制循环，**不是 DAG/图** |
| 图框架 | **无**（不用 LangGraph / Temporal / 任何 workflow 引擎） | "流程"是线性 turn-based loop，不是有向图 |
| 模型层 | 自研多模型路由（Claude / GPT / 自定义 OpenAI-compatible） | 直接调 API，无中间编排框架 |
| 规则层 | **Cursor Rules（`.mdc` 文件）** | Markdown + frontmatter，纯提示词注入，不是代码逻辑 |
| 技能层 | **Cursor Skills（`SKILL.md`）** | 按需加载的能力包，模型读 description 自主判断 |
| 工具层 | 内置 tools（读/写/终端/grep）+ **MCP 协议**扩展 | 标准 function calling 形态 |
| 代码检索 | **embedding 向量索引 + 传统索引** | 模型调检索工具时查此索引 |

**关键澄清**：你项目里的 `workflow-orchestrate.ts`、`chat.ts` 的 `LoopState`/`StateGraph`、本仓库 `.cursor/rules/*.mdc` 和 `.cursor/skills/**` —— **前两者是你们自己写的，后两者是 Cursor 生态格式的文件（你们读取并复用其语义）**。Cursor 本身不提供"workflow 引擎"，"workflow"只是你们对自家编排层的命名。

---

## 2. Cursor 用到哪些功能？（逐点拆解）

### 2.1 Rules（常驻底线）
- 文件：`.cursor/rules/*.mdc`，frontmatter 含 `description` / `alwaysApply` / `globs`
- `alwaysApply: true` → **每次请求常驻注入 system 层**（优先级最高）
- `globs` → 按文件路径自动匹配注入
- `description` → agent 自主判断何时加载（按需）
- **本质 = 提示词注入，不是代码逻辑**

### 2.2 Skills（按需能力）
- 文件：`.cursor/skills/<name>/SKILL.md`，frontmatter 含 `name` / `description` / `version` / `disable-model-invocation`
- 模型读 `description` 判断相关性后加载正文作为"技能指南"
- `disable-model-invocation: true` → 禁止模型自动调用，仅显式触发

### 2.3 Tools / MCP
- 内置：读文件、写文件、终端、ripgrep
- MCP：通过外部 MCP server 扩展（你们已用 `mcp.ts` 接钉钉/知识库）
- 调用形态：标准 function calling，模型决定调哪个、调几次、何时停

### 2.4 Codebase Retrieval（实时读源码的源头）
- embedding 向量索引 + 传统索引
- 模型调 `grep_codebase` 之类检索工具时查此索引
- **这正是你们"方案 A 模块定位实时读源码"的设计源头**

### 2.5 没有的东西
- ❌ 没有 LangGraph / 任何图编排框架
- ❌ 没有可视化 workflow DAG
- ❌ 没有独立的"意图路由引擎"（意图理解交给模型，rules 只做底线）

---

## 3. bx-admin-agent 当前实现 vs Cursor 范式

### 3.1 已对齐 Cursor 的部分（✅）

| Cursor 范式 | bx-admin-agent 落地 | 代码位置 |
|---|---|---|
| Rules 常驻底线 | `.cursor/rules/agent-routing-baseline.mdc` + `loadResidentRules()` 每次业务请求注入 | `skills.ts` / `chat.ts` preprocess |
| Skills 按需加载 | `.cursor/skills/**` + 模型读 description 自主判断加载 | `skills.ts` 的 `loadSkills()` + preprocess 节点目录式注入 |
| 信任模型语义判断 | orchestrate 第一步直接把原话交模型拆意图；`parse_intent` 只做安全校验+反问 | `chat.ts` understand / `tools.ts` |
| 实时读源码定位 | `search_api_module` 实时 grep PC 端源码 + `read_file` 确认 | `tools.ts` |
| MCP 扩展工具 | `mcp.ts` 注册钉钉/知识库等 | `mcp.ts` |
| 知识库检索 | `knowledge-base.ts` 本地索引检索 | `chat.ts` preprocess（KB预检） |

### 3.2 未对齐 / 不同栈的部分（⚠️）

| 维度 | Cursor | bx-admin-agent | 差异性质 |
|---|---|---|---|
| 编排框架 | 自研线性 tool-loop（无图） | **LangGraph `StateGraph` + 条件边**（你们上一轮明确要求用 LangGraph） | **技术栈相反**：Cursor 用线性 loop，你们用图 |
| "流程"表达 | 模型自主决定循环（tool-loop 天然支持） | 条件边 + `understandAttempts`/`round` 计数器显式控制 | 你们更"重"、更可控 |
| 闲聊识别 | 靠模型理解（无独立层） | `isActionableBusinessQuery` 规则判定（间接） | 你们多了规则层，Cursor 没有 |
| 指代消解 | 靠模型上下文（无独立层） | 靠模型上下文（同样无） | 一致，都未做独立层 |
| 模型失败降级 | 客户端直接报错/重试 | 你们有 `modelError` + 402 专用提示 + 服务端兜底 | 你们比 Cursor 更完善（Cursor 无这套服务端兜底） |

### 3.3 核心冲突点

**用户上一轮要求"链式/循环调用要用上 LangGraph"，但 Cursor 的范式是"不用 LangGraph 的线性 tool-loop"。**

这构成直接矛盾：
- 若"全部照 Cursor" = 连技术栈也改成线性 loop → 推翻上一轮的 LangGraph 改造
- 若"全部照 Cursor" = 只对齐设计哲学（信任模型、rules 仅底线、tool-loop 由模型主导）→ 与现有 LangGraph 不冲突，可继续用 LangGraph 实现"模型主导"的语义

---

## 4. 能否"全部参考 Cursor 改"？——判断

### 4.1 能直接照搬的（设计哲学层，建议对齐）
1. **Rules 只做常驻底线，绝不在规则层做意图路由/纠正** —— 你们已对齐 ✓
2. **Skills 按需加载，模型自主判断相关性** —— 你们已对齐 ✓
3. **模块定位实时读源码，不用过期索引** —— 你们已对齐（方案 A）✓
4. **意图理解 100% 信任模型** —— 你们已对齐 ✓

### 4.2 不能照搬的（技术栈层，不建议改）
1. **LangGraph → 线性 tool-loop**：你们已用 LangGraph 且上一轮明确要求保留。Cursor 不用图是因为它是 IDE 客户端、循环天然由代码 while 控制；你们是服务端 agent，LangGraph 提供结构化状态/可观测/超时控制，更适合。且"全部改成线性 loop"会推翻上一轮已部署的 `preprocess`/`understand` 节点化改造。
2. **去掉所有规则层判定**：你们有 `isActionableBusinessQuery` 等轻量预判，这是服务端 agent 的必要护栏（Cursor 作为 IDE 不需要判断"这是不是业务请求"）。保留。

### 4.3 可以补强但 Cursor 也没有的（你们超前）
1. **模型失败降级**（`modelError` + 402 提示）：Cursor 没有这套，你们有，保留并继续完善
2. **输出护栏**（`validateFinalText` 伪计划拦截）：Cursor 靠模型自觉，你们有显式护栏，保留
3. **写操作双重确认**：Cursor 无强制确认机制（IDE 操作可撤销），你们有，保留

---

## 5. 建议的"对齐 Cursor"改造方案（仅设计，待确认后实施）

> 前提：保留 LangGraph 技术栈，只对齐 Cursor 的**设计哲学**。以下为"输入→确定调工具之前"这一段的设计目标。

### 5.1 preprocess 节点（对应 Cursor 的轻量预处理）
- ✅ 已落地：KB预检、pending恢复、候选模块、rules 注入全部进图第一个节点
- 🔲 TODO（Cursor 也无，但可补）：`resolveOrdinal` 指代消解、`CHIT_CHAT` 闲聊识别独立层（当前靠模型 + `isActionableBusinessQuery` 间接处理，与 Cursor 一致，可不改）

### 5.2 understand 节点（对应 Cursor 的 tool-loop 首轮语义理解）
- ✅ 已落地：纯语义理解、模型失败捕获、首轮 retry 条件边外化
- 🎯 对齐 Cursor 的"模型主导循环"：当前 `understandAttempts` 上限=2 是**服务端硬控**；Cursor 是模型自主决定"再想一次"。建议：把硬上限保留为安全护栏，但**放宽模型自主重试的信号**（如模型返回"我需要再检索一次"时允许继续循环，而非仅看 toolCalls 数）

### 5.3 不改动的部分
- `route` / `tool` 节点（工具定位/参数归一/安全门禁/执行）维持现状
- LangGraph 图结构维持现状

### 5.4 与 Cursor 的真正差距（文档层面已记录）
- Cursor 的"循环"是**模型天然驱动**的（tool-loop 里模型自己说"再调一次"）；你们的"循环"是**条件边 + 计数器驱动**的（更确定性）。这是**有意差异**，因为服务端 agent 需要可控的超时/上限，不建议消除。

---

## 6. 结论

| 问题 | 答案 |
|---|---|
| Cursor 用 LangGraph 吗？ | **不用**，自研线性 tool-loop |
| Cursor 有 Workflow 吗？ | **没有独立引擎**，流程=rules 提示词 + 模型 tool-loop |
| Cursor 用 Tools/MCP 吗？ | **用**，标准 function calling + MCP 协议 |
| Cursor 用 Skills/Rules 吗？ | **用**，`.mdc` rules 常驻 + `.cursor/skills` 按需 |
| 能否"全部照 Cursor 改"？ | **设计哲学可全对齐（已对齐），技术栈不建议全改**（与现有 LangGraph 冲突，且服务端 agent 需要 LangGraph 的确定性/可观测） |
| 下一步建议 | 保留 LangGraph，仅强化"understand 阶段模型自主驱动循环"的信号，不推翻现有架构 |

---

## 7. 实施结论（2026-08-22 已拍板）

**决策：设计哲学对齐 Cursor，技术栈保留 LangGraph（不推翻现有 `preprocess`/`understand` 节点化改造）。**

理由：
1. Cursor 的"循环"靠 IDE 客户端线性 while-loop 天然驱动；bx-admin-agent 是服务端 agent，需要 LangGraph 提供的结构化状态、可观测性、超时/上限控制。两者目的相同（让模型"调工具→看结果→再调→直到完成"），技术栈不同是**有意差异**。
2. 上一轮已明确要求"链式/循环用 LangGraph"，推翻会与既有红线冲突。
3. "全部对齐 Cursor"在本项目语境下 = 对齐 Cursor 的**设计哲学**（信任模型、rules 仅底线、skills 按需、实时读源码、模型主导循环），而非复制其技术栈。

---

## 8. 对齐 Cursor 设计哲学的代码改造清单（已实施 / 待实施）

> 范围仍限定"输入→确定调工具之前"（preprocess + understand 节点），route/tool 节点不动。

### 8.1 已落地（上一轮改造）
- ✅ `preprocess` 节点：KB预检、rules 常驻注入、候选模块 brief、全局项目上下文，全部进图第一个节点
- ✅ `understand` 节点：从 `llm` 抽出纯语义理解；模型失败捕获、首轮伪计划清空
- ✅ 首轮 retry 由条件边外化（`understand → understand`，`understandAttempts` 上限=2 作安全护栏）
- ✅ 图边：`START→preprocess→understand→(条件边)→tool/final`

### 8.2 本次新增对齐（设计哲学层微调）
对应 Cursor 范式，做以下不推翻架构的增强：

1. **模型主导循环信号（对齐 Cursor 的"模型自主决定再查一次"）**
   - 现状：首轮无工具调用仅靠 `understandAttempts < 2` 硬控
   - 改造：`understand` 节点允许模型通过返回特定信号（如文本含"需要再检索/我需要确认"）主动请求继续循环，而非仅看 `toolCalls` 数。硬上限保留为安全护栏（`MAX_UNDERSTAND_ATTEMPTS` 从 2 放宽到 3，给模型更多自主空间）
   - 对应 Cursor 能力：tool-loop 里模型自己说"再调一次"

2. **rules 仅底线、绝不抢路由（红线圈定）**
   - 现状已对齐：`parse_intent` 只做安全校验+反问，路由全交模型
   - 新增文档红线强调：`preprocess` 节点的 rules/候选模块 brief **只作提示注入，不得包含任何"如果用户输入含 X 则走 Y 工具"的关键词路由逻辑**（那是 Cursor 明令禁止的规则层越权）

3. **实时读源码作为模块定位唯一真相源（对齐 Cursor 的 codebase retrieval）**
   - 现状：`search_api_module` 实时 grep + `read_file` 确认
   - 明确为文档红线：模块定位**必须**以实时 grep 源码为准，禁止在 `preprocess` 用硬编码别名表反向纠正模型（候选模块 brief 仅给"可能候选"提示，模型结合语义最终决定）

4. **Skills 注入位置收敛 + 模型自主判断（对齐 Cursor Skills 语义）**
   - 改造前：`matchSkills()` 在图外（user 消息拼装处）用**服务端关键词硬匹配**注入技能正文
   - 改造后：移除图外 `matchSkills` 硬注入与 `skills.ts` 中的 `matchSkills` 函数（已删除），改为在 `preprocess` 节点把**可用技能目录（name + description）作为 system 提示**交给模型，由模型自主判断相关性后加载正文（对应 Cursor「模型读 description 自主加载 SKILL.md」）。
   - 效果：skills/rules 注入统一收敛到 preprocess 节点（图层面可观测），且不再由服务端 if/else 抢路由。

5. **`isActionableBusinessQuery` 明确为轻量预判红线**
   - 闭包变量 `actionableQuery` 仅用于「是否注入业务相关 rules/skills 提示」，不构成「该调哪个工具」的硬路由决策。
   - 这是服务端 agent 区分业务/闲聊的必要护栏（Cursor 作为 IDE 无此层），保留但明确仅作提示注入依据，不抢路由。

### 8.3 不改动
- `route` / `tool` 节点（工具定位/参数归一/安全门禁/执行编排）维持现状
- LangGraph `StateGraph` + 条件边结构维持现状
- `modelError` / 402 降级、`validateFinalText` 护栏、写操作双重确认 —— 这些是 bx-admin-agent 超越 Cursor 的能力，保留

### 8.4 补齐：代码库符号级索引（AST）与实时 grep 双轨并存

> 原 §4 差距表标注「缺符号级 AST 索引（靠 grep 替代）」，现已补齐，两者保留并存。

- **新增 `symbol-index.ts`**：用 `typescript` 编译器 API（devDependency，无新增重依赖）AST 解析 `bx-film-admin-in2/src/api/**/*.ts`，提取每个导出函数的：
  - 函数名、参数签名、所属文件/模块
  - HTTP 方法（defHttp.get/post/...）、完整 URL（解析同文件 `enum Api` 映射）、Api 枚举键
  - 中文动作（getLogOptions 第二参）、log 模块名
  - 跨文件 import 依赖（调用关系轻量表达）
- **构建脚本**：`npm run build-symbol-index`（`tsx src/symbol-index.ts` 自执行入口）→ 生成 `data/symbol-index.json`（已生成 1147 个符号，覆盖全模块）
- **新增 `search_symbol` 工具**（agent tools + MCP 双注册）：模型按函数名/中文动作/URL 片段/模块名**精确命中**符号，返回签名与调用关系
- **双轨互补**（不替代）：
  - `grep_codebase` / `search_api_module`：文本出现在哪一行（模糊扫全库）
  - `search_symbol`：这个函数签名/调用关系是什么（精确命中接口函数）
  - 模型工作流：先 `search_symbol` 定位函数 → 再 `grep_codebase`/`read_api_module` 看实现细节

### 8.5 与 Cursor 的真正差距（记录在案，不消除）
- Cursor 的"循环"是模型天然驱动（tool-loop 里模型自己说"再调一次"）；本项目的"循环"是条件边 + 计数器驱动（更确定性）。**这是有意差异**，服务端 agent 需可控上限，不消除。

---

## 9. 验收标准

- [ ] 业务请求走 `preprocess→understand→tool` 链路，preprocess 不出现任何关键词路由 if/else
- [ ] 首轮无工具调用时，模型可通过"再检索"信号触发 `understand` 自循环（受 `MAX_UNDERSTAND_ATTEMPTS` 护栏）
- [ ] 模型失败时 `modelError` 正确写入并由主流程返回 402 提示（不误进业务反问）
- [ ] lint 通过 + pm2 重启后图正常运行
