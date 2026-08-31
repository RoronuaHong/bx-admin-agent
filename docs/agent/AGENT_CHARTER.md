# Agent 总章程（Enterprise Agent Charter）

> **本文件是所有 Agent 能力变更的强制约束基准。**
> 任何新功能、修复、重构，均须遵循本章程的五层模式框架，不得绕过。

---

## 〇、Bug 修复标准流程（修改前强制，任何缺陷修复必须按此执行）

> **每次修改/修复前必须过一遍本流程，不得直接动手改代码。**
> 本方法论来自 2026-08-22「查询优惠活动配置列表 → Parameter checking failed」实战提炼。

### 定位：五步断层定位法

```
Step 1 复现 + 环境前置检查：复现错误，抓完整事件流（tool_call / tool_result / error），
          确认失败发生在哪一层：模型理解 / 模块定位 / 索引数据 / 工具执行 / 渲染 / 外部上游；
          先确认运行环境工具链完整（rg/git/node 在 PATH、依赖已装）——2026-08-24 教训：
          rg 不在 PATH 时 grepCodebaseNative 静默退化为全量递归（分钟级慢 + 每轮
          'rg' is not recognized 噪音），会污染复现判断，必须先查环境再归因
Step 2 分层归因：从失败现象反推链路，用日志/事件流确认断点——找证据，不是猜
Step 3 数据层验证：凡是「模型选错/猜错」类问题，先验证服务端给模型的信息对不对
          （模块定位：grep 命中的源码/路径对不对；字段对齐：索引/映射表对不对）——
          【服务端给的信息错 = 模型必然错，模型行为只是信息的投影】
Step 4 配置一致性检查：检查「配置 key」与「查找 key」是否一致
          （本项目教训：别名配置用完整模块 id「<模块>/<接口模块>」，
           生成脚本却用 baseName「<接口模块>」查 → 带目录模块的别名永不生效，
           候选给错 → 模型误调 <其他模块>.<接口> → 后端 Parameter checking failed）
Step 5 修复 → 重生成索引 → 重启 → 端到端验证（真实业务用例，非 mock）
```

### 三不原则

- **不把失败归咎「模型行为方差」**——模型错必是上游给的信息错（候选/提示/数据），追到上游证据为止。
  **反例（2026-08-24）**：zen 免费链不走 function calling，把工具调用以纯文本 `[[{name,parameters}]]`
  （裸嵌套数组、常残缺未闭合）输出，原状态机只认 `{tool_calls:[...]}` 对象 → 整轮 toolCalls=0 静默失败，
  业务查询全部调不起工具。这不是「模型这次没输出工具调用」的行为方差，而是端点功能不稳定时模型的自由发挥——
  治本在解析器兼容多形态（对象/裸数组/嵌套数组/正则括号配平兜底，不依赖 JSON 整体闭合），而非把锅甩给模型。
- **不修「表面现象」**——`Parameter checking failed` 是后端 400 表象，根因链：模型调错接口 → 候选给错模块 → 别名索引缺/脚本查找 key 不一致。要修到最深的确定性根因。
- **不跳过验证**——每次修复必须有真实业务用例的端到端复测（真实登录 + 真实上游），禁止只 mock/单测。

### 服务端护栏补全原则（对齐 Cursor agent 模式）

- **不依赖模型自觉**：模型没提交理解（如没调 submit_understood_intent）时，服务端用 grep 命中源码定位 module——grep 命中 `src/api/**/*.ts` 直接取路径为模块 id；命中 views 页面则读源码提取 `@/api/`（或 `/@/api/`）import；再加规则推断 operation（查询默认 read），确定性完成查询——而不是反问/失败。
- **模型不可靠时服务端兜底**：`understoodFromLlm` 只认显式字段；服务端 grep 定位出的 module 同样做「可调用性」校验（必须在操作索引中），不在则不调接口。

---

## 一、五层模式框架（强制）

所有 Agent 能力的设计与落地，必须归属以下五层之一或多层，并在变更说明中注明归属层：

```
workflow  →  skill  →  MCP  →  tools  →  superpower
```

| 层 | 职责 | 典型产物 |
|---|---|---|
| **workflow** | 主流程编排，决定节点顺序和分支条件 | LangGraph 节点、路由逻辑、前后置钩子 |
| **skill** | 固化可复用的推理行为模板 | 问答模板、输出格式规范、操作收敛规则 |
| **MCP** | 检索与外部知识接入 | 模块索引检索、接口目录查询、知识库文档拉取 |
| **tools** | 原子执行单元，有副作用或 I/O | call_api、grep_codebase、normalize_output 等 |
| **superpower** | 策略中心化、配置驱动 | 策略 JSON、字段映射表、阈值配置、指标收集 |

**变更规则**：

- 新功能 = 先写对应层的设计，再实现。
- 不允许在层外（如直接改 system prompt）实现业务规则。
- 任何新增工具必须在 `tools.ts`（单一来源）注册，`mcp.ts` 同步暴露。

---

## 二、标准输入解析规则（强制，所有输入必须先经过此步骤）

### 输入四元组格式

任何用户输入，**必须首先解析为以下四元组**，缺少必填槽位则触发反问，不得直接猜测执行：

```
[项目 project] [模块 module] [值 value?] [操作 operation]
```

| 槽位 | 是否必填 | 说明 | 补全方式 |
|---|---|---|---|
| **project** | 必填 | 操作哪个项目/系统 | 优先从 `session.activeProject` 读取（跨轮记忆），有值则不再询问 |
| **module** | 必填 | 操作哪个业务模块，对应 PC 端菜单 | 大模型理解 + `grep_codebase` / `search_api_module` 检索 |
| **value** | 可选 | 操作对象的具体值（id、名称等） | 大模型从用户输入提取；详情/更新操作缺 id 时反问 |
| **operation** | 必填 | 做什么操作（read: 查/列/详情；write: 增/改/删/上下线） | 大模型理解，规则只校验 read/write |

### 反问顺序（一次只问一个）

按以下优先级逐个确认缺失槽位：

```
1. project（有 session 上下文则跳过）
2. module（先用 grep_codebase 自动推断，推断不出才反问）
3. operation（read/write 无法判断时反问）
4. value（只在当前操作需要时且用户未提供时反问）
```

### 反问边界（2026-08-25 对齐 Cursor：去掉「查询一律不反问」写死压制，改正向「目标/词义不明先反问」）

反问与否由大模型自主判断，prompt 引导边界如下（对齐 Cursor AskQuestion + `<tool_calling>` 缺参条款，不做任何写死负面压制）：

- **目标/词义语义模糊 → 反问**：用户请求的目标或关键用词语义模糊、无法确定唯一业务含义（如某词既可能指模块路由/跳转链接、也可能指数据字段里的 URL）时，先 `request_clarification` 用结构化问题反问用户收敛，**禁止硬猜取数后输出与请求不符的结果**。
- **缺关键槽位 → 反问**：module / operation / 操作对象等必要槽位缺失时反问（沿用反问顺序）。
- **已明确请求 → 直接执行，不反问**：请求目标明确可执行（如明确的列表/详情查询）时直接取数；可选筛选条件（状态、时间范围、分页）缺失时用默认参数，不反问。

> 承接：`request_clarification` description（tools.ts，已去掉「查询类缺筛选条件不反问」负面句，改为 AskQuestion 式纯正向）+ resident rule（agent-routing-baseline.mdc「目标/词义不明先反问，已明确请求直接执行」）+ `[workflow/tool-calling]`#4。改动均为 prompt 引导，反问判定完全交模型，服务端不做词形/正则写死判断。

### 项目上下文（全局，跨轮持久）

- 用 `set_project` 工具切换当前项目，存入 `session.activeProject`。
- 每轮 LLM 调用时，workflow 层自动将 `activeProject` 注入 system 提示，模型知晓后不再向用户询问。
- 用户说「切换到xxx项目」「我要操作xxx系统」时，自动调 `set_project`。

### 执行流程（五层映射）

```
workflow: LLM 先行（自主调 tools）→ 模块定位：实时读 PC 端源码（grep + read_file，方案 A）→ 安全校验门（parse_intent 只校验+反问 / 写确认）→ call_api → normalize
rules:    Cursor Rules（.cursor/rules/*.mdc）常驻底线，每次业务请求注入 system 层
skill:    Cursor Skills + 本地 SKILL.md 按需注入指南（模型读 description 自主判断），约束「先检索再调用」
MCP:      grep_codebase / search_api_module（实时 grep 源码定位）/ read_api_module / read_file（与聊天 tools 同源）
tools:    submit_understood_intent、request_clarification、call_api、normalize_output…
superpower: clarification-policy / field-mapping；call_api 前安全校验，缺槽/歧义才反问
```

**强制顺序**：先大模型理解并用 tools/skill/MCP/superpower 整理 → 再过规则落地。  
禁止服务端跳过模型、用关键词硬编码直接编排业务链路。  
**模块定位**：以实时读 PC 端源码为准（方案 A，2026-08-22 起支持多项目 gitlab 代码库）——每项目经 `clarification-policy.json` project.options 配 `gitRepo`（gitlab 仓库）/`branch`（测试 dev、生产 master）/`codebaseRoot`（gitlab 拉取落地目录，可复用本地 clone），`scripts/sync-gitlab-project.mjs` 用 git 协议（本机凭据）拉取到 codebaseRoot，请求级 `project-context.resolveCodebaseRoot()` 按 `session.activeProject` 解析当前项目代码根目录（2026-08-24 起该脚本仅同步代码，不再生成 api-module-index 索引文件，模块定位完全交模型实时 grep 源码）。`call_api` 的 operation 索引保留作安全底座（参数校验/写确认/日志）。gitlab REST API（http 301→https、443 不通）不可用，一律走 git 协议。

**完全抛弃 aliases（2026-08-22）**：模块定位链路不再存在任何「中文词 → 模块」映射表——
- **已移除（第一轮）**：候选 brief（`buildModuleCandidateBrief`，chat.ts preprocess）、候选 enum（`buildModuleCandidateIds`，submit 工具 module enum）、parse_intent 模块关键词表（`buildModuleAliasesFromIndex` / `collectExactAliasCandidates` / project 级 moduleAliases 合并）、orchestrate 候选补全、运行时别名叠加（`loadRuntimeCnAliases`/`withRuntimeAliases`）、生成脚本 `MANUAL_ALIASES`、`project-aliases.json` 的 `moduleAliases` 段。
- **已移除（第二轮 2026-08-22 彻底核查）**：`search_api_module` 的索引兜底分支（tools.ts，基于 aliasIndex 术语表的「中文术语→模块」模糊映射——泛词误命中元凶「查询」→ paymentChannel → Parameter checking failed）、`searchCatalogModules`/`buildCatalogTermIndex`（module-api-catalog.ts 整文件删除）、`searchApiModules`（api-index.ts 死代码）、`clarification-policy.json` 的 project 级 `moduleAliases` 关键词表、`check-whitelist*.mjs` 失效脚本、`sources.ts` 中 module-api-catalog.json 路径纠错条目。`search_api_module` 无命中时诚实返回「未找到」；operation 级 aliases（operationAliases/paramAliases）亦于 2026-08-25 全删（`project-aliases.json` 整个文件删除，见下），接口选择完全交模型按 `api-interface-routing` skill 读源码。
- **模块定位 100% 交模型实时 grep 源码**：模型用 `search_api_module`（rg 扫 PC 端 src/api+src/views）/ `grep_codebase` / `read_api_module` 自主确认英文模块 id；`submit_understood_intent.module` 为自由文本英文 id（来自源码路径，如 `<模块>` / `<模块/子模块>`）。
- **服务端 parse_intent 只做两件事**：① 无损预处理（括号剥离：模型常输出「report（用户观影数据统计）」复合描述 → 剥为 report）；② 英文 id 可调用性校验——不在操作索引 → `MODULE_RETRY` 回传模型自愈（主流程）/ 澄清渲染给用户（服务端兜底）。不猜、不纠正、无中文表。
- **orchestrate 兜底（模型 loop 失败）**：服务端代模型 grep 定位——grep 命中 `src/api/**/*.ts` 直接取路径为模块 id；命中 views 页面则读源码提取 `@/api/`（或 `/@/api/`）import。定位不到 → 诚实 partial（提示用户），禁止用空 module 拼 `.getList` 模糊命中别的接口。
- **历史教训沉淀**：候选错（如「<某业务配置>」漏配别名 → 模型误调 <其他模块>.<接口>）的终极解法是「让候选不存在」——模块定位不靠任何静态映射，靠源码 grep。

**禁止写死（2026-08-24 红线，强制）**：

> **除 skill / tool / MCP 这类能力机制本身（它们由模型驱动或配置驱动），orchestrate 链路不得写死任何业务判断。**

**凡是业务词都不行（2026-08-25 最高红线，强制）**：

> **服务端任何位置（代码逻辑、正则、映射表、配置 JSON、工具描述、错误提示、兜底文案、示例说明）都不得出现具体业务词——包括业务模块名、业务接口名、业务字段名、业务菜单名、业务枚举值、业务中文术语，也不得以真实业务词举例。**（本红线同样适用于本总章程自身的表述：说明规则时用类别描述与占位符，不用具体业务词示例。）
>
> **判定标准**：一个词是否是"业务词"看它是否**依赖特定业务系统的存在**。跨系统通用的才不是业务词：
> - ✅ 允许（非业务词）：英文接口命名契约（`getList`/`getById`/`create`/`update`/`delete`/`List`/`Detail`/`Option`/`Stat`/`Report` 等 CRUD/接口语义词）、通用数值/字段语义词（`value`/`count`/`total`/`amount`/`rate`/`ratio`/`cycle`/`date` 等）、通用 NLP 功能词（查询/查看/列表/详情/新增，用于 grep 关键词清洗）、通用显示词缀（报表/报告/图表/看板/页面）、通用终端语义（`clientType`/`terminalFlag` 位值）、通用字典（`id`→`ID`）、HTTP 方法、确认弹窗通用文案（"该记录/对象"）、URL 主机白名单（基础设施安全）。
> - ❌ 禁止（业务词）：任何能在**当前业务系统源码中找到对应物**的词——模块 id、接口函数名、业务字段名、业务枚举值、中文菜单名/业务术语。
> - **工具描述/错误提示/兜底文案中的示例**：一律用 `XX`/`<模块>`/`<接口>` 占位，禁止写真实业务示例（格式示例用 `<模块>.getList` 这类占位形态）。
> - **豁免（严格隔离）**：`mock-upstream.ts`（仅 `mock-token-` 前缀 + `MOCK_UPSTREAM=true` 双保险时生效，生产 JWT 路径永不进入）；`translation-lookup.ts`（反查是实时扫 PC 源码，不写死）。
> - **审计口径**：grep `src/` 不允许出现写死业务候选 options（label/value 均为真实业务词）；模型提示字符串中不允许出现具体业务词示例。

**全部由大模型判断，对齐 Cursor（2026-08-25 最高红线，强制，后续每次改动必须遵守）**：

> **服务端不得用任何正则 / 映射表 / 词表 / 词形匹配去预判语义——包括业务与闲聊判别、意图判定、功能分类、参数含义、输出格式选择等，一律 100% 交给大模型自主判断（按需引导其读源码/用 skill）。**
>
> **判定口径**：
> - ❌ 禁止：任何「语言/功能词」写死的服务端正则或判定——如问候句式正则（你好/hello/有什么可以帮你）、业务功能词正则（列表/详情/查询/统计/导出/第X页/数据/记录 等）、中文参数键正则（方法/路径/参数/查询/模块/描述 等）、JSON 字段名功能词判定（module/operation/params/method/url 用于预判工具计划）。此类判定在 2026-08-25 已全部删除。
> - ✅ 允许（协议/契约护栏，非语义判定）：**纯协议结构检测**（`isToolPlanText`/`validateFinalText` 仅识别「把工具调用写成文本」的 JSON/XML/方括号/action 形态，工具名取自 `AGENT_TOOL_NAMES` 英文契约，无中文无功能词）、**数量/循环护栏**（`understandAttempts`/`pseudoPlanExhausted`/`MAX_TOOL_ROUNDS`，仅计数不判语义）、**HTTP 方法**（`method!==GET` 判定写）、**英文 CRUD 契约词**（`get`/`List`/`Detail`/`create`/`update`/`delete`/`Option`/`Stat`/`Report`，代码契约非语义）、**通用字典**（`id`→`ID`、`1001`→英语）、**历史压缩阈值**（`HISTORY_*`，数量预算）。
> - **模型引导走 prompt / skill**：业务与闲聊的判别、意图、接口选路、参数补齐、字段中文化、报表/导出触发等，一律通过系统提示（如 `[workflow/tool-calling]` 第 5 条）与 skill 规范交模型判断；prompt 里可以描述「涉及业务数据就要调工具」，但服务端代码逻辑不得再出现用于判定的中文/功能词正则。
> - **审计口径**：新增/修改任何服务端判定逻辑时，grep 不得出现「问候/功能词/参数键」形态的正则；出现即视为违反本红线，PR 必须驳回。判定语义的唯一来源是大模型输出（tool_calls / operationType / text）。

- **意图判定不写死**：read/write/create/update/delete/list/detail 等意图，**一律以模型提交的 `operationType` 为准**；列表/详情分支判定只认 `operationType==="read" + 是否带 id`，**禁止用中文意图词正则兜底**（如 `/(新增|添加|创建)/`、`/(列表|全部|所有|批量)/`、`/(详情|明细|详细)/` 等写死中文词一律删除）。模型未提交意图（unknown）时，服务端直接返回 null 交模型自愈 / 反问澄清，不得用中文词猜。
- **模块/接口定位不写死任何业务名**：模块 id 来自 grep 源码路径或模型提交；接口选择靠英文 CRUD 语义正则（如 `^get`/`List`/`Detail`/`create`/`update`/`delete`，属代码契约非业务词），**不再有任何别名表**（operationAliases 已删），完全交模型按 `api-interface-routing` skill 读源码选唯一接口；禁止写死具体模块名/接口名（一律以占位符 `<模块>`/`<接口>` 表述）。
- **字段映射不写死**：输出中文化靠实时读 PC 端 `configs.data.tsx` + i18n 源码（`pc-column-mapping` skill / `grep_codebase`），`field-mapping.json` 仅作历史兼容兜底，**不新增手工字段映射**；`colTitle`/`langLabel` 等通用字典（id→ID、1001→英语）属通用约定非业务写死，保留。
- **写意图/读意图的中文词判定已全删**（workflow-orchestrate.ts：`INFER_WRITE_INTENT`、`WRITE_INTENT_WORDS_CJK`、`isListIntent`、`detailKw`、`listKw` 全部移除）——任何新增意图分支若再出现中文字面量正则，视为违反本红线，PR 必须驳回。
- **审计口径**：grep `workflow-orchestrate.ts` 不允许出现 `(中文|中文|...)` 形态的业务意图正则；允许的正则仅限：英文接口约定（`get`/`List`/`Detail`/`create`/`update`/`delete`/`Option`/`Stat`/`Report`）、ID 数字提取（`\d{5,}`）、HTML 剥离、路由/澄清模板标识（`需要确认|CLARIFICATION_REQUIRED`）。
- **服务端写死预判函数已全删（2026-08-24）**：`tool-gate.ts` 的 `isActionableBusinessQuery`（写死中文业务动词白名单 + 能力询问词表 + "模块/管理"组合）已删除——它既不属于 skill/tool/MCP，又写死业务中文词，违反本红线。原用途"业务/闲聊判别、首轮是否强工具、条件边收束"已全部改由**模型信号**驱动：`chat.ts` 的 preprocess 恒注入业务 rules/skills 交模型自主判别；fallback 触发条件改为 `businessToolCalled`（模型本轮真调过 call_api/search_api_module/read_api_module/grep_codebase）或 `writeForce`；catch 兜底收紧为仅 `writeForce`（写操作必须经确认执行，读操作模型失败走 402/error 提示，避免无模型理解时误调接口）。`ls_` 的 state 类型无 `toolCalls` 字段，catch 分支不依赖它。
- **写操作判定/模型路由/确认弹窗词表已去写死（2026-08-24 追加）**：
  - `chat.ts` 的 `isWriteQuery`（写死中文写意图词：新增/添加/创建/修改/编辑/删除/移除/上下线等）已删除。写操作判定只认 **HTTP 方法**（`call_api` 的 `method !== "GET"` 即写，POST/PUT/DELETE 是最可靠信号）；服务端兜底确认（writeForce）改由**模型提交的 `understood.operationType==="write"`** 计算（主 fallback 与 catch 段均从 `findLastUnderstood` 取）。
  - `chat.ts` 的 `pickAutoModel` 不再用中文业务词（统计/报表/对比/趋势/汇总/图表/最新的/全部/批量）预判"复杂统计/写操作走强模型"——统一走 fast/默认模型，弱模型由条件边重试护栏兜底。
  - `chat.ts` 的 `buildConfirmationImpact` 删除业务实体词表（兑换码/影片/用户/会员/分类/批次/白名单/黑名单/标签/片单/订单/国家/配置）与中文危险动词表（删除/移除/作废/清空/批量/全部/禁用/下架/封禁/停用）——确认弹窗的 target 退化为"该记录/对象「参数名」"，highRisk 仅由 HTTP 方法判定（delete/remove 恒高危）。具体操作影响由模型在确认 input.description 描述，展示层不猜业务词。
- **接口选路 skill 化 + 通用字典删除（2026-08-24 追加）**：
  - **新建 `api-interface-routing` skill**：模型已定位模块后，用 `read_api_module` 读模块接口源码，按函数名语义（getList/byId/create/update/delete/export/online 等）选出**唯一接口**，把完整 `operation`（`module.func`，如 `<模块>.getList`）填入 `call_api`。服务端 `inferCallOperation` 的英文命名正则**降级为兜底**（仅当模型没给完整 operation 时才按 getList/byId 惯例选）。
  - **`submit_understood_intent` 增加 `operation` 字段**（可选，完整接口 id `module.func`）：`UnderstoodIntent.operation` 单独解析（不经过 `asOp` 强转，避免把 `<模块>.getList` 误当 unknown）；`operationType` 只取 `input.operationType`。orchestrate 的 `explicitOp` 优先取 `llmIntent.operation`，其次从用户原文提取（`<模块>.<函数>` 显式书写），都没有才走正则兜底。
  - **`colTitle`/`langLabel` 静态 MAP 字典已删**：表头中文化完全交给 `pc-column-mapping` skill 实时读 PC 源码（configs.data.tsx/i18n），`colTitle` 恒返回 key（保留签名仅作「英文表头检测」判据）；语言 id 中文化交给模型（有真实来源时调 language/getOptionList）。英文表头检测改为「所有纯英文字段都需模型映射」。
  - 验证：`parseUnderstoodIntent` 正确解析 operation（含误填 read 兼容）、`inferCallOperation(explicitOp=<模块>.getList)` 直接返回、无 explicitOp 时正则兜底仍选 getList。
- **第二波去写死（2026-08-24 追加）**，运行期写死业务规则清零：
  - **`tools.ts` 删除 `MODULE_TO_MENU_ENGLISH`**（39 条「模块英文 id → 菜单英文名」静态映射，操作日志 menuId 仅直接匹配英文名，命中不了留空）。
  - **`tools.ts` 删除 `/movie/getDetail` 参数兼容**（硬编码特定接口路径 + movieId 转换规则；模型按 skill 读源码填对参数，缺参后端如实报错）。
  - **`report-pc-parity.ts` 删除 `humanize` 静态中文字典**（successCount→成功数 等写死字段映射，只留 camelCase 可读化）；删除 `isAnalysisReportOperation`（写死接口名正则 report/retention/income/ltv 判断报表分流）——报表图表渲染改由模型主动提交 `pageKind=analysis_chart` 触发。
  - **`workflow-orchestrate.ts` 删除 `extractWriteBizParams`**（写死中文键值词：名称/排序/导航栏/搜索栏/系统内置；写操作 name/order/开关参数完全交模型按 skill 填）。
  - **保留（非业务写死）**：`clientType=5`（PC 端全局请求约定，基础设施参数）、`DISPLAY_SUFFIXES`（grep 输入清洗，有红线注释约束）、`opLabel`（英文接口名→中文操作名通用惯例）、`inferOperator`（接口路径→操作名英文惯例）、`SLOT_LABELS`（澄清表单 UI 文案）、field-mapping.json 的 `renderRules`（渲染行为定义，非字段映射）、`hasApiData` 的 UI_TABLE/【表格输出】等（工具输出格式约定）。
- **第三波去写死（2026-08-24 追加）**：
  - **`report-pc-parity.ts` 的 `NUMERIC_FIELD_HINTS` 删除业务特定指标名**（successCount/income/recharge/retention/ltv/uv/pv/duration 等，写死特定业务字段）——仅保留跨项目通用数值词（value/y/count/total/num/amount/rate/ratio），特定指标列由模型按图表上下文判断。
  - **`docs/agent/project-aliases.json` 全删（2026-08-25）**：`paramAliases`（film.getById 的 id→movieId 参数映射）与 `operationAliases`（接口层中文动作别名）连同整个文件删除——接口参数名与接口选择完全由模型按 api-interface-routing skill 读接口源码填/选，服务端零别名表。generate-api-operation-index.mjs 不再读该文件，aliases 仅含源码自动生成的英文标识（module.func / func / apiKey）。
  - **接口选路命名错位增强（2026-08-25）**：`api-interface-routing/SKILL.md` 新增第 4/5 条——①「`List.vue` 页面但模块无 `getList`」场景：目标页面名带 List、但对应 `src/api/<模块>.ts` 没有标准 `getList` 时，**必须以页面源码实际 `import` 的函数为准**（用 `grep_codebase`/`read_file` 打开该 `List.vue` 看它拉数据用哪个函数，把那个函数当列表接口调用），禁止因"找不到 getList 就认为没列表接口"而空转/放弃；②「别被其他模块 getList 诱惑」：`read_api_module` 返回的 `[接口速览]` 会标注各函数 method 与「← 列表/分页候选」，**判定标准只有「目标页面 import 的模块 + 该模块下语义最贴切的函数」**，不因函数名恰叫 getList 就改选别家模块接口。同时 `search_api_module` 命中 views 页面时提取「页面 import 的接口函数」直接返回给模型（如命中 List.vue → 该页 import 的列表数据函数），降低模型读源码试错成本。服务端**不**把命名错位场景的具体函数硬编码进列表候选正则（坚持全交给大模型，兜底仅靠英文命名约定）。端到端验证：`<模块>`（List.vue 页面但模块无 getList）前 5 页由模型自主 5 次分页 call_api 走通；`用户列表前3页`/`优惠活动配置`/`影片搜索统计` 无退化。
- **分页彻底去结构化 + 对齐 Cursor 模型驱动（2026-08-24 追加）**：
  - **删除 `PaginationPlan` 类型 / `parsePaginationPlan` / `UnderstoodIntent.pagination` 字段**（`understood-intent.ts`）——不再让模型填"四种分页 mode 结构"（pages/lastPages/limit/page，属过度设计）。
  - **删除服务端多页执行器**（`workflow-orchestrate.ts` 原 1054-1130 行循环拉取拼接）、`listParamsFromPagination`、`inferCallOperation` 的 `pagination` 参数、`extractTotal`（死代码）——服务端不做分页循环/拼接/补默认分页值。
  - **删除 `submit_understood_intent` 的 `pagination` schema 字段与描述**（`tools.ts`）；`call_api` 描述改为"分页由模型按接口契约多次调 call_api 拉取拼接"，删除原"禁止逐页多次调用同一接口"写死规则。
  - **删除 `tools.ts` call_api 的列表缺参补默认（page=1, size=100）**；`resolveModuleDetail` 删除详情参数键名 `id` 写死（详情参数名由模型读源码提供）。
  - **追加清理（2026-08-24 检查遗漏）**：`inferCallOperation` 全部分支的写死参数键名 `id` 一并删除（explicitOp/详情/列表别名/列表优先级/读型兜底/write 分支的 `params.id` 或 `{ ...(id ? { id } : {}) }` → 全部 `params: {}`）——详情/写/过滤参数名完全由模型按 api-interface-routing skill 读接口源码在 call_api.params 填，服务端零参数键名写死；`resolveModuleDetail` 签名删除未用的 `id` 入参。id 仅保留用于「read+带 id 走详情接口」的判断（179/240 行），不进入 params。
  - **哲学（参考 Cursor）**：分页数据量由模型自主决定（模型在主路径 tool-loop 里多次调 call_api 拉取拼接），服务端零分页结构、零默认值、零循环、零参数键名写死。LangGraph 循环控制保留。
  - **方案 A：数据回喂模型校验总结（2026-08-24 落地）**——删除服务端 forcedReply 跳过模型机制，对齐 Cursor「模型是数据的最终校验者与回答生成者」：
    - **列表/详情渲染分支**（chat.ts tool 节点）：渲染表格后不再 `forcedReply=rendered.md`+`outputReady=true` 强制收束，改为：①`UI_TABLE` 事件推送表格上屏（前端 tables 区）；②call_api 原始 toolResult 替换为渲染后的中文 markdown 表格回喂模型（模型直接看真实数据）；③push `[workflow/list-verify]/[workflow/detail-verify]` 引导模型基于真实数据校验——维度含「业务对象语义匹配」（类别是否对应用户请求，取错模块须重定位，规则见 `[workflow/tool-calling]`#5）与「页数/条数/筛选条件/字段覆盖」，符合则总结收束、不符合可继续调 call_api 补取；④不设 outputReady → 回 understand 由模型自主校验总结收束（Cursor 模型驱动收束）。删除因此失效的 `persistRawToolOutput` 死代码。
    - **端到端实测（zen 免费链 nemotronultra）**：普通"用户列表" 20s——call_api 返回 → 表格上屏 → 模型基于真实数据总结"共 10 条记录、返回第一页、可按条件筛选/翻页"（不再 forcedReply）；**"用户列表前3页" 162s——模型自主循环调 3 次 call_api(page:1/2/3, pageSize:20)，3 个表格上屏，模型逐页校验总结"共 30 条记录，第1页渠道 FoxA/INGoogle13、第2页出现 GoGo/BD/IndiaA、第3页 IndiaTV 客户端类型6"**——彻底解决"前3页只返回第1页"（根因：forcedReply 短路 + 模型只调一次）。
    - **保留的 forcedReply/outputReady**：analysis_chart 报表链路（presentGenericChart，图表 UI 已上屏）、模型主动调 normalize_output/render_table/summarize_chart_data 后的收束、call_api 失败收束——这些是"模型主动完成"或"图表展示兜底"，仍符合 Cursor 语义。
    - **性能代价**：多页场景每页一次渲染+模型轮次，zen 免费链 3 页约 162s（TokenHub 强模型恢复后更快）。

- **第四波去写死（2026-08-26 追加）**：
  - **`tools.ts` 删除 `request_clarification` 写死中文标签→模块映射**（原 options 写死「推荐片段管理→movie-fragment / 影片管理→film / 时间标签→movietimetag / 用户管理→user」真实业务菜单名 + 模块 id，违反「错误提示/候选不得出现具体业务词」红线）——改为单条通用占位 `{ label: "按模块检索", value: "__search__" }`，由模型按 `search_api_module` 实时 grep 源码定位。
  - **`tools.ts` 删除 `read_field_mapping` 错误提示写死业务词**（原提示「如需用户列表请用 user 模块」含具体业务词「用户列表」）——改为中性「[`<模块>`] 无接口（sys 类目录模块），已跳过」。
  - **`tools.ts` / `mcp.ts` 模型提示字符串去写死业务模块名示例**：`read_field_mapping` 的 `module` 参数描述、错误提示里的「如 film、movietimetag、category、user」业务模块名举例，全部改为占位符「如 `<模块>`」（符合审计口径「模型提示字符串中不允许出现具体业务词示例」）。`base` 基址枚举（`backend/user/film/gather`）与「如 `<影片>`」类别词占位符属合法保留（URL 主机白名单 / 通用类别词）。
  - **删除写死业务参数 + 凭证的调试脚本 `scripts/query-clickhouse.mjs`**：该脚本写死默认事件名（clickhouse 统计某具体事件）、测试账号口令、国家线硬编码，违反「禁止写死业务参数/凭证」红线且无运行时引用，属调试残留，已删。
  - **审计回归**：grep `src/` 现已无「写死业务候选 options（label/value 均为真实业务词）」「错误提示/描述写死业务模块名示例」残留；clickhouse 业务名仅存在于 `api-operation-index.json`（数据驱动索引，来自源码生成，非写死）与 `symbol-index.json`（索引产物），合法。

- **第五波去写死（2026-08-26 追加，对齐 Cursor「除 tools/skills 外不写死」）**：用户要求「流程里除 tools 和 skills，其他不能有写死的判断、映射、正则，对齐 Cursor 方式」。本波清理**服务端流程代码**（非 tools/skills）里所有写死的中文功能词表/业务词映射/意图正则，把「口语词→核心词」的语义判断 100% 交模型（模型调 `search_api_module` 时自己决定 `query` 参数，服务端不做中文剥词）：
  - **`tool-gate.ts` `extractGrepPattern` 删除写死中文动词/功能词剥离表**（原 `/(?:请|帮我|查询|查看|列出|...)/g` 一整张中文功能词正则 + 后缀剥词表，违反「禁止功能词写死正则」红线）——改为仅做两类无业务语义归一化：①英文 `module.operation` 形态提取（英文 CRUD 契约，合法）②首尾空白/标点清理 + 超长截断（保留全部词，由 rg 自行匹配，不剥中文）。历史收益：消除「搜索/统计」等业务词根被误剥导致 hotMovieStat 误命中的事故。
  - **`query-contraction.ts` 删除写死中文显示词缀表 `DISPLAY_SUFFIXES`（报表/报告/图表/看板/页面）**——`contractCandidates` 改为纯词尾逐字收缩算法（逐字删已能自然覆盖「留存报表」→「留存」，无需显式词表），零写死业务词/功能词/显示词缀。
  - **`call-api-guard.ts` `detectDroppedFilter` 删除写死中文功能词正则**（`/^(管理|列表|查询|查看|详情|导出|模块|搜索|筛选|统计|报表|新增|编辑|删除|导入)$/` 一张功能词表，违反红线）——改为纯结构判定（字段提示含中英文即保留，不写死任何功能词），「疑似被吞筛选条件」检测仍靠通用 `名词=值` 结构与 `params` 序列化比对。
  - **`tools.ts` `search_api_module` 描述 + 收缩重搜注释**：去掉写死中文显示词缀举例（报表/报告/图表/看板/页面），改为通用表述「口语词整词搜不到时直接搜核心词，服务端做词尾逐字收缩降级重搜」。
  - **`workflow-orchestrate.ts` 注释清理**：去掉「优先选分类/用户/影片/订单等业务实体词」写死中文举例；`extractGrepPattern(plainUserText)` 调用点注释更新为「仅英文 module.operation 归一 + 截断，不做中文剥词」。
  - **保留（合规，非写死业务词）**：`workflow-orchestrate.ts` `buildModuleCapabilitiesText` 的 `opLabel`（英文 CRUD func→中文动作，如 getList→查看列表，属「英文接口命名契约 + 通用字典」豁免，跨模块通用语义翻译，非业务词映射）；`export-tools.ts` `WIN_FONTS`（OS 字体目录基础设施路径，类比 URL 主机白名单）；`resolveApiOperationByPath` 路径反查（数据驱动索引，非写死）；`translation-lookup.ts`（实时读 src/locales 翻译表反查，零静态产物）。
  - **审计回归**：grep `src/` 现已无「服务端流程代码写死中文功能词正则 / 中文业务词映射表 / 中文显示词缀表」残留；`extractGrepPattern` / `detectDroppedFilter` / `contractCandidates` 三处均为无业务语义的通用算法（英文契约 / 结构符号 / 逐字收缩）。

- **方案 B：列表行提取栈式配平 + 结构判定（2026-08-26 落地）**——「影片列表前2页」偶发无表格/错渲染为「详情键值对」的解析层面根因修复（对齐 Cursor「渲染层确定性结构化解析」）：
  - **根因（实例验证 11 样本，旧逻辑失败 6/11）**：`extractListRowsForRender` 原用 `search(/[[{]/)+JSON.parse(c.slice(start))` 脆弱解析 + 一层 `o[key]` 容器检查 + `length>=2` 条数门槛——①`{code,data:{rows}}`/`{code,result:{list}}` 两层封装时一层检查漏判返回 null；②数组首位夹带「获取成功」字符串时把字符串当行；③**真实 mock 影片列表 `{code,data:{list:[1条],total:1}}` 仅 1 条被 `length>=2` 门槛判 null → 渲染分支跳过 → 详情分支把整个包装对象当详情渲染成「字段/值」键值对**（end-to-end 实测复现「film 详情」×2）。
  - **修复（全在 report-pc-parity.ts + chat.ts，纯 JSON 结构语义，无业务词）**：①新增 `findFirstBalancedJson`（栈式括号配平定位首个完整 JSON 值，对齐 `extractSingleDetailPayload`）+ `drillListRows`（递归下钻 rows/list/records/items/data/result，过滤非对象元素，深度护栏 6）+ `extractListRowsFromContent` 统一入口；②**列表/详情判定改「结构里有数组容器」而非「条数≥2」**——1 条数据的列表也是列表（门槛 `length>=1`，空数组仍 null）；③`extractSingleDetailPayload` 补 `hasListContainer` 递归检查（含两层 `{data:{list}}` 封装），防止列表包装被误当详情；④方案 C 兜底同步修：`extractJsonFromResult` 配平提取、`looksLikeListJson` 配平判定（原 startsWith+浅层正则漏判两层封装，synthesize 兜底失效）。
  - **端到端实测（修复后，mock 环境）**：「影片列表管理，前2页」127s——SUBMIT + 2 次真实 CALL(film.getList page:1/2 size:20) + `listRows=array/1` 渲染分支进入 + PC 中文 8 列（id/token/影片名称/国家/语言/用户名称/创建时间/状态）+ `[chat:table]` 2 张分表合并 1 张（去重 1 行）+ 模型【校验结论】完整输出（筛选参数/业务对象/页数条数/字段覆盖/结论，诚实指出 mock 仅 1 条）。对比修复前 `listRows=null` + 「film 详情」键值对 ×2 错渲染。
  - **回归脚本**：`scripts/verify-list-extract.mjs`（11 样本，真实实现 0 失败）+ `scripts/verify-movie-list.mjs`（端到端 PASS）。列表/详情渲染判定=结构而非条数，符合「全部由大模型判断」红线（服务端只做确定性结构解析，语义交模型）。

- **方案 C：字段差异清单回喂 LLM 校对（2026-08-26 落地，对齐 Cursor「模型是数据最终校验者」）**——用户要求「返回数据到返回结果层与 PC 端字段 100% 对齐需交 LLM 校对」：
  - **缺口确认**：渲染层虽无条件保留所有 PC 列（缺字段空值显示），`needsModelMapping/needsValueMapping` 只覆盖「表头英文/值未翻译」，但**「PC 列定义字段 vs 接口返回字段」的结构差异清单没有显式回喂模型**——list-verify 的「字段覆盖」项只是模型自觉核对，无硬数据支撑。
  - **落地**：①`workflow-orchestrate.ts` 的 `renderListForAgent`/`renderDetailForAgent` 返回 `fieldDiff={pcMissing,dataExtra}`——`pcMissing`=PC 端列定义/ formSchema 有但接口返回缺（列表渲染空列/详情占位"-"）；`dataExtra`=接口返回有但 PC 端未定义（列表未展示/详情补充展示）；meta 键（page/rows/code/msg/_mock/token 等通用契约）排除；纯数据驱动（字段名来自 PC 源码 dataIndex 与返回数据键），零业务词写死。②`chat.ts` list-verify/detail-verify 注入【字段差异校对】块（差异存在时）+ 校验结论加「字段差异裁决」项，模型逐项判断缺字段是接口不对/缺参数/嵌套未展平（需补取）还是如实说明、多余字段是否用户关注。
  - **端到端实测（mock 环境）**：「影片列表管理，前2页」37s——模型校验总结输出「PC 端定义但接口返回为空：token、countryName、language、userName、createTime（推测 mock 结构不完整或字段名不一致，需确认真实接口字段名）+ 接口返回有但 PC 未定义：title（未展示）」，字段差异裁决与 8 列渲染结果一致。字段对齐数据（diff 清单）由服务端结构比对产出、判断交模型，符合红线。

**故障复盘：伪 XML 调用文本泄漏上屏（2026-08-26 修复）**：
- **现象**：用户请求「查询 clickhouse 数据统计，事件名：xxx」时，弱模型（laguna 系）未走函数调用通道，而是把工具调用写成伪 XML 文本 `<tool_call><function=call_api>...` 直接作为最终文本上屏（`req1385.network-response` 实测），且 operation 写错模块（未定位到 clickhouseTotal），用户端看到的是伪 XML 而非真实数据。
- **根因（两层）**：
  1. **为什么有 XML**：工具调用**正常走 schema 通道**（`models.ts` 把 19 个工具以标准 `tools:[{type:"function",function:{name,description,parameters}}]` 发给模型，`tool_choice:"auto"`；强模型返回 `delta.tool_calls` 协议字段，服务端零文本解析）。但弱模型退化时不按 schema 返回 `tool_calls`，而是把调用"编成" `<tool_call><function=call_api>` 这类**它自己发明的 XML 文本**——这是模型侧退化产物，不是我们的协议；`models.ts` 原有"从纯文本 JSON 反解 tool_calls"的兼容兜底只覆盖 JSON 形态，覆盖不到 XML。
  2. **为什么泄漏上屏**：`chat.ts` final 节点 `validateFinalText` 的 `pseudo-plan` 拦截原靠 `businessToolCalled` 闸门——弱模型"文本模拟调用却没真 function call"时 `businessToolCalled===false`，既不触发 export 兜底、也不清空，最终 `return {}` 让伪 XML 原样上屏。
- **修复（双保险，响应层最前 + final 兜底）**：
  1. **选项 A（响应层丢弃，最根本，2026-08-26）**：`models.ts` 流式解析 `delta.content` 入口新增 `XML_PSEUDO_RE`（`<\s*tool_call` / `<[\w-]+=<工具名>` 覆盖 `search_api_module|read_api_module|call_api|grep_codebase|submit_understood_intent|request_clarification|export_dataset`）+ `xmlPseudoDetect` 状态机——命中即**丢弃该片段（不累积进 text、不推前端、不进 history）**，仅在「本应走 schema 工具」场景（`tools.length>0`）生效，闲聊/知识库正常文本不受影响（XML 伪调用标签是工具模拟专属形态，纯协议层判定，无业务词/功能词）。丢弃后 `text` 为空 → understand 节点走首轮空响应 retry（`pseudoPlanExhausted` 闸门）把调用纠正回 function calling 通道。
  2. **final 节点兜底（2026-08-26，双保险）**：`chat.ts` 新增 `isXmlPseudoCall` 判定，`pseudo-plan && !hasToolResults && isXmlPseudoCall` 时**强制 `return { text: "" }`**，无论 `businessToolCalled` 是否为真；纯 JSON 形态仍保留 `businessToolCalled` 豁免（避免误伤闲聊举例 JSON）。
- **实测验证**：`scripts/verify-xml-pseudo-discard.mjs` 用本地 HTTP 注入 SSE 流（模拟弱模型 `<tool_call>` 退化 + 模拟正常 schema `tool_calls` 通道）走真实 `callAgent` 代码路径，`2/2 通过`——XML 流返回 `text="" toolCalls=0`（被丢弃→触发 retry），schema 流返回 `toolCalls=call_api`（正常提取）。
- **关联护栏**：understand 首轮 `firstRoundPlan + isToolPlanText` 已拦截并推 `[workflow/tool-calling]` retry step（2026-08-25 落地），与本次响应层丢弃 + final 兜底三路互补，对齐 Cursor「工具调用必须走函数调用通道」协议护栏。
- **教训**：`businessToolCalled` 不能作伪调用拦截唯一闸门；伪调用**形态（XML/JSON/方括号）才是唯一可靠拦截信号**，语义 100% 交模型。响应层丢弃比 final 兜底更靠前（在模型响应层就掐掉，不污染 history），是首选防线。

**无接口模块防护（2026-08-22 更新）**：
- parse_intent 可调用性校验：模型提交的英文 id 必须在操作索引（有接口）中，否则 MODULE_RETRY 回传模型自愈 ✅
- `read_api_module`（tools.ts）：仍过滤无接口模块，跳过 <无接口模块> 并提示用 <模块> ✅

**兜底路径第二轮核查（2026-08-22 收尾）**：operation 定位层与编排层确认无泛词残留：
- `resolveApiOperation`（api-operation-index.ts）：id/别名精确命中优先，模糊评分兜底仅在 `findApiOperationCandidates`（候选>1 时反问，绝不自动采用）；`call_api` 分支「候选=1 才自动采用，>1 反问」✅
- `orchestrateBusinessQuery`（workflow-orchestrate.ts）：模块定位依赖 grep 命中——模型已给英文 id 则直接用（parse_intent 只校验）；未给则服务端 grep（`src/api/**` 路径或 views 的 `@/api/` import）提取；多列表接口选择不按别名，靠模型 submit 的完整 operation / 服务端英文命名语义排序兜底（getList/List 优先），模型侧由 `api-interface-routing` skill 保证精确选（如「<某业务统计>」→ <模块>.<接口>）✅
- `extractWriteBizParams`（写字段提取）：只提取 name/order/navigationVisible 等，不猜模块 ✅
- `tool-gate.ts`（isActionableBusinessQuery/extractGrepPattern）：仅做业务请求识别与 grep 关键词提取，不参与模块定位 ✅
- **死代码清理**：`matchAlias`（tools.ts，parse_intent 内已不调用，主流程完全信任模型）与 `resolveModuleFromTerm`（module-api-catalog.ts，唯一调用方 matchAlias 删除后成死代码）已删除 ✅

**字段对齐链路修复（2026-08-22）**：PC 中文字段对齐的三处断裂已修复：
- `field-mapping.json`：report 模块补全「<某统计报表>」15 字段中文映射（<字段1>/<字段2>/<字段3>…，来源 PC `configs.data.tsx` columns）
- `parse_intent` 的 `normalizeExactAlias`：剥离「（中文注释）」括号后再精确匹配——模型输出「report（<中文报表名>）」可归一为 report（无损抽取，非猜测）
- `presentGenericChart`（report-pc-parity.ts）：**通用字段映射三层降级**——① 实时读 PC 端 `configs.data.tsx`（`execGetListColumns`，按 dataIndex 与行数据交集最多选组）；② `field-mapping.json` 手工配置兜底（历史兼容）；③ `humanize` 英文兜底。chat.ts 调用处传 module。
- `extractColumnsFromSource`（output-tools.ts）：修复列块提取器——原先正则 `\n\s*\{\s*\n` 只匹配「多行写」列，**单行列 `{ title: '<中文列名>', dataIndex: '<英文key>' }` 全被漏掉**（<某统计报表> 15 列只提取 3 列，正是 field-mapping 需手工补的深层原因）。现同时支持单行/多行列，按源码序合并去重。
- **报表渲染特例清理（2026-08-22）**：删除 `presentLoginDataTotal`/`pcLoginDataColumns`/`isLoginDataTotalCall`/`loginTypeLabel`/`LOGIN_TYPE_LABEL`——通用 `presentGenericChart` + 实时读 PC configs.data.tsx + `resolveI18nTitle` 已完全覆盖（验证：模型传 `<某统计接口>` → 通用提取器返回「周期/登录成功总数/点击登录方式总数/成功率」全中文，比硬编码还准）。`enrichLoginDataTotalParams` 保留（对齐 PC searchFormSchema 默认值，模型漏参时兜底，独立于渲染）。回归验证 10/12 PASS 与基线一致，浏览器端到端「<某统计报表>」仍全中文。
- **输入→输出链路缺陷修复（2026-08-22）**：
  - **静默无输出兜底**（P1-3，chat.ts 主 fallback + catch 兜底）：模型 text 为空（伪计划被清空）、KB 未接管、`runServerFallback` 返回 skip 时，原来 `if (text) yield` 会整段静默（前端只收 done）。现统一兜底为「模型服务暂时不可用/未能理解你的需求，请换种说法重试」；`runServerFallback` 的 `kind:"executed"` 空 text 也改为返回 undefined 由上层兜底；catch 分支 `fb.text` 空串不再 yield。
  - 审查确认无需改：KB 预检短路（`kbPreflight` 有结果才设 forcedReply，模型失败时返回 KB 结果优于错误提示）、understand 条件边 `modelError→final`（错误分支 retry 计数无害）、`MAX_UNDERSTAND_ATTEMPTS=3` 注释与实现一致、fallback 澄清后 1455 再解析 pendingClarification（幂等且必要，1444-1451 只设显示文本，1455 才写 session 状态）。

**通用方案（2026-08-22 确认）：新增项目/模块字段映射零配置** —— PC 端 196 个 `configs.data.tsx` 已全部可实时自动提取中文列（field-mapping.json 仅手工收录 10 个，覆盖率 5%），未收录模块（accountMerge/accountMessage/blackListManage/complaintOrder/whiteList 等）均验证可自动出中文列。**新增模块只需 PC 端有 `configs.data.tsx`，agent 侧无需任何配置**；field-mapping.json 定位降级为历史兼容兜底，不再需要新增。个别列 PC 用英文 getTran key 时靠 i18n 解析（resolveI18nTitle），解析不到回退 dataIndex。

### 上游认证（环境）

- **真登录 JWT**：`call_api` 打真实国家线上游。
- **`mock-token-*`（评测假登录）或 `MOCK_UPSTREAM=true`**：`call_api` 返回本地 fixture，不请求真实网关，避免「登录过期」空转。

---

## 三、核心执行原则（按优先级排序）

### 原则 1：输出前先与 PC 端后台对齐字段（最高优先级）

> **在向用户展示任何接口返回数据之前，必须先进行字段映射，将 API 原始字段转换为 PC 端后台管理系统所显示的字段名和值格式，然后再按用户要求输出。**

归属层：`workflow（输出节点前置）` + `tools（normalize_output）` + `superpower（field-mapping 配置）`

具体规则：

1. **字段名对齐**：API 返回的英文/缩写字段 → PC 后台显示的中文/业务字段名（如 `movieName` → `影片名称`）。
2. **值格式对齐**：枚举值/状态码 → PC 后台显示的中文标签（如 `status: 1` → `上架`）。
3. **结构对齐**：嵌套对象/数组按 PC 后台的列表/详情页布局拆平或聚合。
4. **用户自定义输出**：对齐之后，再按用户的额外要求（筛选字段、排序、格式）二次处理。
5. **对齐配置文件**：`bx-admin-agent/docs/agent/field-mapping.json`，按模块维护字段映射表，superpower 层统一管理。

### 原则 1.1：多轮搜索校对（Search-Driven Alignment，强制）

> **对齐不是一次性查静态映射表，而是多轮"搜索 → 核对 → 再搜索"的循环，以 PC 端源码与配置为唯一事实来源，逐层校验直到与 PC 端一致后才输出。**  
> 覆盖增删改查全部业务输出：read（列表/详情）与 write（新增/编辑/删除）的回显都必须经过本校对。

**为什么不能静态查表**：

- `field-mapping.json` 只覆盖已知模块的常见字段；新模块 / 新字段 / 枚举值变化时静态表会漏，导致直接透传英文或编造字段（用户侧表现为「裸 JSON、列名对不上 PC 端」）。
- PC 端真实列定义（表头、列序、隐藏列）、页面形态（列表/详情/表单/报表）位于 `D:\Code\bx-film-admin-in2` 源码，只有现场检索才有唯一答案。

**标准校对流程（workflow 编排，final 输出节点前置，强制顺序）**：

```
Step 1 定形态   get_page_schema(module)        → 判定 列表/详情/表单/报表 → 决定输出骨架
Step 2 取列定义 get_list_columns(module/path)   → 读 PC List.vue / configs.data.tsx 真实表头+列序
Step 3 读映射   read_field_mapping(module)      → field-mapping.json 字段名/枚举映射
Step 4 补缺失   grep_codebase(字段/枚举关键词)   → 静态表没有的字段，去 PC 源码搜真实叫法/枚举
Step 5 转换     normalize_output(module, data)  → 字段名中文化 + 枚举翻译 + 结构拆平/聚合
Step 6 渲染     render_table / summarize_chart  → 按 PC 列序与形态输出表格/摘要
```

**核对规则（多轮）**：

- Step 5 之后，拿「对齐结果」与「Step 2 的 PC 列定义」互验：列序、表头、字段集合不一致 → 回到 Step 4 再搜索补正。
- 映射缺失 → `grep_codebase` 去 PC 源码确认该字段在 PC 端的真实展示名/枚举，**禁止直接透传原始英文，也禁止编造 PC 端不存在的字段**。
- 多轮上限 3 轮；仍不一致时如实向用户说明缺什么、需要补什么，不做猜测。
- **write 操作**：确认门（原则 5）通过并执行 `call_api` 后，返回结果**仍须走 Step 3-6** 对齐回显（如新增后的记录、状态变更后的枚举标签），保证写操作反馈与 PC 端一致。

实现路径（五层）：

- `workflow`：编排 Step 1-6 为 final 输出节点前的强制顺序；模型自主路径与服务端兜底编排统一走此流程。
- `skill`：输出 skill（如 `pc-output-formats`）固化「先取列定义 → 字段对齐 → 用户格式」输出规范。
- `MCP`：`get_page_schema` / `get_list_columns` / `read_field_mapping` / `grep_codebase` 经 MCP 检索 PC 源码与映射配置。
- `tools`：`normalize_output` / `render_table` / `summarize_chart_data` 落地转换与渲染。
- `superpower`：`field-mapping.json` + `PC_STRUCTURE_AND_OUTPUT_TYPES.md` 配置驱动，更新即生效不重启。

> ⚠️ 现状缺口（2026-08-21 记录）：read 列表的「取列定义 → 转换 → 渲染」链路已通；但**列定义目前未严格按 PC List.vue 拉取**（兜底路径用了通用精简列），write 回显的多轮校对也未落地。实现时按本原则补齐，禁止继续静态查表式输出。

---

### 原则 2：不确定时用反问精确范围（禁止猜测）

归属层：`workflow（Clarification Gate）` + `skill（问法模板）` + `tools（request_clarification）` + `superpower（clarification-policy.json）`

详见：[WORKFLOW_CLARIFICATION_GATE.md](./WORKFLOW_CLARIFICATION_GATE.md)

核心约束：

- 关键槽位（模块/操作/对象）缺失 → 先问再执行。
- 一次只问一个歧义点，提供 2-4 个收敛候选项。
- 反问上限（默认 2 轮）后输出候选方案让用户选，不再反问。

---

### 原则 3：去 Prompt 依赖（配置驱动）

归属层：`superpower`

- 不在 system prompt 硬编码业务规则、模块映射、风险边界。
- 所有行为由策略配置 + 状态机 + 工具返回决定。
- 新接入业务只需新增模块索引和映射配置，不需要新增/修改 prompt。

---

### 原则 4：全局代码搜索优先（定位模块与接口）

归属层：`tools（grep_codebase）` + `MCP（search_api_module）`

- 用户用中文/业务词描述模块 → `grep_codebase` 全仓库搜索定位 → `read_api_module` 读接口定义 → `call_api` 调用。
- 不依赖预生成索引的"精确匹配"，支持模糊中文词、别名、变量名等任意关键词。

---

### 原则 5：写操作必须显式确认

归属层：`workflow` + `superpower（clarification-policy.json 的 writeRisk 配置）`

- create / update / delete / toggle / batch 等写操作，必须展示操作摘要，等待用户确认后才执行。
- 批量操作需额外说明影响范围（条数/模块）。

---

## 三、变更流程（所有 PR/修改必须遵守）

```
1. 确定需求归属层（workflow / skill / MCP / tools / superpower）
2. 更新本章程（如新增原则或修改已有原则）
3. 按层实现，tools 必须同步注册 mcp.ts
4. 在 superpower 配置文件中落地阈值/映射/策略
5. 添加评测用例（eval 脚本），覆盖新增路径
6. 更新对应文档（本章程或子文档）
7. 写死检查（门禁）：新增/修改 orchestrate 链路时，grep 禁止出现 `(中文|中文|...)` 形态的业务意图正则；
   意图判定必须走模型 operationType，字段映射必须走源码实时读取，不得新增任何写死业务名/中文词/手工映射
```

---

## 四、已落地能力清单

| 能力 | 归属层 | 配置文件 / 工具 | 状态 |
|---|---|---|---|
| 反问澄清门（Clarification Gate） | workflow + skill + MCP + tools + superpower | `clarification-policy.json`, `request_clarification` | ✅ 已上线 |
| 全局代码搜索 | tools + MCP | `grep_codebase` | ✅ 已上线 |
| API 模块索引 | MCP + tools | `search_api_module`, `read_api_module` | ✅ 已上线 |
| API 调用 + 日志 | tools | `call_api` | ✅ 已上线 |
| 澄清指标存储 | superpower | MongoDB `bx_agent_metrics` | ✅ 已上线 |
| 上下文清除 | workflow | `clearSessionContext`, `/chat/context/clear` | ✅ 已上线 |
| **输出字段对齐（PC 端对齐，多轮搜索校对）** | workflow + skill + MCP + tools + superpower | `get_page_schema` / `get_list_columns` / `read_field_mapping` / `grep_codebase` / `normalize_output` / `render_table` + `field-mapping.json` | 🔵 原则1.1 已定稿，列定义/写回显校对待补 |
| **标准化输入解析（四元组）** | workflow + skill + MCP + tools + superpower | `submit_understood_intent` → `parse_intent`, `set_project`, `intentSchema` | ✅ 已上线 |
| **PC 输出类型盘点** | skill + superpower | `PC_STRUCTURE_AND_OUTPUT_TYPES.md` | ✅ 文档已上线 |
| **输出形态 skills/tools** | skill + tools + MCP | `pc-output-formats` 等 + `get_list_columns`/`render_table`/`summarize_chart_data`… | ✅ 已上线 |
| **需求匹配评估** | docs | `CAPABILITY_MATCH.md` | ✅ 见文档 |

---

## 五、子文档索引

| 文档 | 内容 |
|---|---|
| [WORKFLOW_CLARIFICATION_GATE.md](./WORKFLOW_CLARIFICATION_GATE.md) | 反问澄清机制详细设计 |
| [clarification-policy.json](./clarification-policy.json) | 澄清策略配置（superpower） |
| [field-mapping.json](./field-mapping.json) | 输出字段映射表（superpower） |
| [PC_STRUCTURE_AND_OUTPUT_TYPES.md](./PC_STRUCTURE_AND_OUTPUT_TYPES.md) | PC 后台结构、输出类型全清单、skills/tools 对照 |
| [CAPABILITY_MATCH.md](./CAPABILITY_MATCH.md) | 补齐后能力 vs 需求文档匹配评估 |
| [README.md](./README.md) | 本目录说明（文档唯一来源） |

> 2026-08-25 已删除 `pc-menu-module-alignment.json`（中文菜单→模块手写映射表，违反「全交给大模型」红线，且无运行时引用）；`data/clarification-policy.json`（孤儿死配置，`getClarificationPolicy()` 只用源码 `DEFAULT_POLICY`）；`scripts/generate-module-catalog.mjs`（产物 `module-api-catalog.json` 已无运行时使用，且含 `VIEW_TO_API_HINTS` 手写模块映射表）。符号索引生成源 `symbol-index.ts` 的写死绝对路径已改为按 `project-registry` 动态解析；`output-report-chart/SKILL.md` 已删除失配的 `presentLoginDataTotal` 接口特例描述（代码已删该特例，统一走 `presentGenericChart`）。
