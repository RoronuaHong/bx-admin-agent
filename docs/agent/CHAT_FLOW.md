# 智能问法全场景流程（Chat Flow）

> **说明**：用户输入一句话后，bx-admin-agent 从入口到最终回答的完整链路（按场景）。
> **适用版本**：2026-08-22（Cursor 规则对齐 + parse_intent 安全校验改造 + 方案 A 模块定位去索引化 + 模型失败/输出护栏加固后）
> **主流程代码**：`apps/agent-server/src/chat.ts`（chatStream + LangGraph）
> **本文件与 7 步蓝图对齐**：第 0~7 步为设计蓝图，每个步骤标注「实际实现状态」与代码位置。

---

## 0. 设计蓝图（7 步总览）

| 步 | 名称 | 职责 | 红线 |
|---|---|---|---|
| 0 | 入口与预处理 | 上下文加载 + 轻量预处理（指代消解 / 闲聊识别 / 知识库预检） | 不抢模型、不路由工具 |
| 1 | 语义理解 | 原话交模型拆 ToolCall / QueryPlan | 信任模型；规则只校验 + 反问，不猜不纠正 |
| 2 | 工具定位与参数归一 | 实时读源码定位模块/接口；alias 归一 | 不用过期索引；多语言不硬编码 |
| 3 | 安全与确认门禁 | 写操作强制确认；凭证缺失给指引 | 写操作不经确认不下发 |
| 4 | 编排执行 | 单轮收口按 QueryPlan 执行；事件流逐条 yield | 模型调用与兜底解耦 |
| 5 | 结果加工与格式化 | 结果→自然语言/卡片；知识库带出处 | 禁止编造文档/数据 |
| 6 | 输出与回流 | 推前端；超时取消回显；写日志 | 输出前过护栏（Format + Faithfulness） |
| 7 | 持续学习 | Bug→改规范；别名数据驱动；改进留痕 | 改正文而非另写事故报告 |

> **架构原则（2026-08-22 起）**：
> - 意图理解完全信任模型（对齐 Cursor「模型语义判断」）：orchestrate 第一步由模型拆解原话，规则层不再用关键词表解析/纠正/覆盖模型结果。
> - `parse_intent` 职责收窄为**安全校验 + 有歧义反问**：校验模型给出的模块是否可调用、写操作是否确认、能力问法识别；模型未给模块 / 模块不可调用 / 存在歧义时一律反问，**不猜**。
> - **模块定位以实时读 PC 端源码为准（方案 A）**：模型用 `grep_codebase`/`search_api_module`（实时 grep `bx-film-admin-in2/src/api|views|router`）+ `read_file` 读接口源码确认函数/路径/参数；`api-module-index.json` 索引**不再作模块定位强依赖**（只作源码未命中时的兜底候选，且不返回模糊短词误导）。
> - **符号级检索（AST 双轨并存）**：`search_symbol` 用 AST 解析 PC 端 `src/api` 提取导出函数签名/HTTP方法/URL/中文动作/跨文件依赖，与 `grep_codebase` 文本检索互补——先 `search_symbol` 精确定位接口函数，再 `grep`/`read_file` 看实现细节。
> - **call_api 执行保留 operation 索引作安全底座**：参数别名归一、写操作确认、`logEnabled` 日志、URL base 推导仍由 `api-operation-index.json` 支撑（安全执行层，非语义理解层）。
> - 常驻底线来自 Cursor Rules（`.cursor/rules/*.mdc`，alwaysApply）：写确认/禁止编造/查询默认参数等。
> - 技能按需加载（Cursor Skills 语义）：`.cursor/skills/**/SKILL.md`，模型读 description 自主判断。

---

## 1. 第 0 步：入口与预处理（轻量、不抢模型）

```
用户请求 userText
   ↓
① 会话上下文加载（session.messages 历史 / 用户身份权限 / 环境 country）
   ↓
② 待澄清状态检查（上一轮 pendingClarification 是否在等你补全）
   ├─ 是 + isLikelyFreshRequest(新意图) → 丢弃旧状态，走新请求
   ├─ 是 + 视为回复 → pickClarificationOption 选序号 → runAgentTool(resumeTool) 续接
   └─ 否 → 走新请求
   ↓
③ actionableQuery 判定（isActionableBusinessQuery）
   ↓
④ 构造消息 + rules/skills/项目上下文注入 system 层 → 进入 LangGraph
```

> 注（2026-08-24）：服务端 KB 关键词预检短路已删除——模型已有 `search_knowledge_base` 工具自主检索（实测「上班迟到了会扣钱吗」即模型调工具命中考勤制度）；chit-chat 分支补「知识库文档类问题可调 search_knowledge_base」意图提示补位。

**实际实现状态**：
- ✅ 上下文加载、`pendingClarification` 恢复检查、`actionableQuery` 判定均已实现（`chat.ts` 543-705 行）
- ⚠️ **蓝图规划 vs 代码现状**：蓝图第 0 步写明的「指代消解（'它'指代哪个对象）」「闲聊识别」**当前无独立预处理层**——
  - 闲聊：靠 `isActionableBusinessQuery` 返回 false 间接跳过业务路径，直接进模型聊天（场景 7）
  - 指代：靠模型自身上下文能力补全（场景 5），无 `resolveOrdinal` 之类规则层
  - 这是**有意偏离**（对齐 Cursor「上下文交给模型」），但蓝图文字需与代码一致。当前以模型处理为主，轻量预处理层为后续可选增强。

---

## 2. 第 1 步：语义理解（信任模型）

```
LangGraph: llm node
   ↓
callAgentSafe(model, ...)  ← 生产环境第一步直接把原话交通用大模型
   ↓
模型拆解为结构化意图：
   submit_understood_intent（module / operationType / operationHint）
   + 工具调用计划（ToolCall / QueryPlan）
   ↓
规则层（parse_intent）只做安全校验 + 有歧义反问：
   ├─ 模块可调用 + 无歧义 → 放行
   ├─ 模块不可调用 / 模型未给模块 / 歧义 → CLARIFICATION_REQUIRED 反问（不猜不纠正）
   └─ 能力问法 → capabilities
```

**模型不可用时的降级（蓝图原未写明，2026-08-22 加固补齐）**：
```
callAgentSafe 抛错（如 402 额度耗尽 / 网络 / 超时）
   ↓
llm node try/catch 捕获 → 写入 state.modelError → 返回空 text（不静默返回触发误反问）
   ↓
主流程检测 ls.modelError：
   ├─ 额度类（401008/quota/额度/后付费）→ 直接返回 402 提示，不进业务 fallback
   └─ 其他模型错误 → 直接返回错误文案，不进误导性的业务反问
（外层 catch 的 isQuotaError 递归穿透 LangGraph 包装链作双保险）
```

**瞬时网关错误兜底（2026-08-22 补，实测踩坑）**：`callAgentSafe` 重试判定正则须覆盖 **503**（服务暂不可用，body 常为空，仅 `model http 503:` 无错误码可匹配）——`/504001|gateway_error|504\s/` 漏掉 503 导致偶发 503 直接炸掉整轮。现为 `/504001|gateway_error|model http 50[34][:\s]/`（最多重试 1 次）；402/401008 等业务性错误不重试。`models.ts` openai 与 anthropic 分支均对 503 单独给「过载或维护中，请稍后重试」可操作文案。**额度更换经验**：模型 402/401008 后路由配置（`superpower-router-policy.json` autoModel）须同步把 `fastModels` 换为实测可用模型（2026-08-22 dsflash 耗尽→临时换 glm53，实测 200；同批实测 hy3 亦耗尽、hymt2 400 为模型名待核对），否则简单请求静默走已耗尽默认模型。**OCR 转录失败注入**（chat.ts）：`visionErrors` 非空时把失败原因拼进 user 消息（此前仅结尾 error 事件提示，模型对看不到的图可能瞎编），并保留 `VISION_OCR_FAILED` error 事件。

**parse_intent 规则解析层废弃（2026-08-22 A+B 方案，对齐 Cursor）**：parse_intent 不再做「精确别名归一 + 服务端硬反问」——调研确认该层非业界主流（业界=function calling+结构化输出+错误回传自愈，Cursor 无归一化层）。落地：
- **B（结构化输出约束）**：`submit_understood_intent.module` 注入候选 enum（`buildModuleCandidateIds(userText,15)`：aliasIndex 命中含泛词 → 可调用过滤 → 常用回退，数据驱动）——模型从源头输出英文 id，消灭「用户」中文自由文本 → 服务端归一化踩坑（原 bug：中文「用户」被 sys/user 截胡 → 硬反问无关模块）。
- **A（候选集合 + 回传自愈）**：`collectExactAliasCandidates`（英文 key 精确命中优先且权威唯一；仅 key 未命中才走中文别名匹配，可命中多个）替代 `normalizeExactAlias`（首个命中即定）。可调用候选**唯一**→直接解析；**多个**→`MODULE_RETRY` 反馈回传模型自愈（模型结合语境重选/检索），不中断 tool-loop；**零个**→同上给检索指引。`rulesGateBeforeCallApi` 返回判别联合 `{kind:ok|clarification|retry}`；orchestrate（无模型可回传）仍走 CLARIFICATION_REQUIRED 渲染给用户选，且 options 改为「相关可调用候选」而非无关 slice(0,6)。
- **模型额度耗尽降级（2026-08-22，多次迭代）**：TokenHub 免费额度**逐模型持续耗尽**（实测时间线：dsflash/dspro/hy3 → 后 glm53/mimopro 也 402，仅 glm5/glm52 长期可用）。三层机制：① `exhaustedModels` 缓存（**TTL 30min**，额度耗尽是持续状态非 5min 自愈）+ `pickAutoModel` 跳过已耗尽；② `preferredLiveModel`（进程级记住最近降级成功模型，**understand 节点每轮 `activeModel=getPreferredLiveModel()||model` 优先复用**——闭包 model 是首轮固定的，若不重取则降级成功后后续轮次仍撞 402 → 每轮雪崩降级，曾致单次查询 366s）；③ understand catch 额度错/超时按 `fallbackModels` 降级链逐个尝试。配置见 `superpower-router-policy.json`（**strong/fast/fallback 首位均放实测可用模型，避免首轮撞 402**）。速度实测：366s → 142s → ~20s（「用户列表前5页」）。**残余瓶颈**：上下文膨胀后单轮模型调用可达 50s（TokenHub 免费模型长上下文慢，round=5/6 steps=19/22 时），无代码解，只能靠减少工具轮次缓解。
- **Cursor 式三原则落地（2026-08-22）**：① **受控渲染**（`execRenderTable`）：columns 只保留 key 在 rows 中真实存在的列（防模型 columns 与 data 分裂致整列 `--`）；columns 为空时从 rows 推断 + field-mapping 中文化（columns 与 rows 同源必一致）；title 中「共 N 条」按实际 rows.length 权威覆盖（防「标题100 数据10」分裂）。② **一次拉够**（call_api 描述 + workflow 指南加「分页/列表一次 size 拉够，禁止逐页多次调用」）——「用户列表前5页」call_api 从 5 次降到 1 次（size=100）。③ **工具结果上屏**（前端 `ToolResultCard.vue` 折叠卡片 + ChatPage 处理 `tool_result`，最多 20 条）——对齐 Cursor「工具结果即产出」。**长输出写文件按需读（2026-08-22 落地，Cursor 动态上下文）**：`chat.ts` 的 `persistToolOutput`——探索类工具结果（read_api_module/read_file/grep/list_dir 等）>4K 写 `apps/agent-server/.agent-context/tool-outputs/`（gitignore 已加），steps 只放「绝对路径+600字摘要」，模型需细节时 read_file 读回（resolveLocalDoc 支持任意绝对路径）。**关键教训**：数据类工具（call_api/normalize_output/render_table/get_page_schema）必须保持完整进 steps——曾对所有工具统一写文件，call_api 数据只剩摘要 → 模型无数据可 normalize/render，直接伪 tool_call 文本结束不渲染表格。故 `TOOL_OUTPUT_KEEP_FULL` 白名单放行数据类。目录注意：服务端 `process.cwd()` 是 `apps/agent-server`（非项目根），脚本验证时别查错目录。

**实测发现与修复（2026-08-22 真用例验证）**：① `grep_codebase` 对「文件路径当 dir」返回空（rg 报错 + grepCodebaseNative walk 吞 ENOTDIR）→ 新增 `grepSingleFile`（单文件行级匹配）+ `tryStat` 判目录；② `read_api_module` 结果 >4K 被 persistToolOutput 写文件 → 模型只拿到摘要看不到 getList → 绕路 grep/list_dir 空转放弃未调 call_api → 把 `read_api_module` 与「read_file 读接口定义文件（路径含 /api/ 或 .ts 且不在 views/components/layouts）」加入 KEEP_FULL；③ system 提示加「【模块定位】search_api_module 命中后用 read_api_module 读源码确认函数名，禁止反复 grep/list_dir 绕路」，search_api_module 命中建议同改。**Agent 自主续探（2026-08-22 对齐 Cursor agent 模式）**：`understand` 条件边重写——业务请求（actionableQuery）不再「一轮无工具即 final」，改为**模型驱动多轮持续探索直到数据就绪**（Cursor 核心）：`!outputReady && round<MAX_TOOL_ROUNDS && !gaveFinalText` → 回 understand 让模型看已完成探索后自主决定继续；`outputReady`（受控渲染完成）或模型已给总结文本（gaveFinalText，非 NEED_RETRY 信号）才 final。循环上限用 round（工具执行轮数）而非 understandAttempts（它在每次回 understand 都 +1 会过早耗尽续探）。system 提示加【Agent 自主续探】指引：未拿到数据主动继续调工具，拿到即收束。防死循环：模型每轮输出总结但永不调工具时 gaveFinalText=true 收束。**2026-08-22 晚间额度状态**：TokenHub 全部模型 402 永久耗尽（需控制台开启后付费），当前全走 OpenCode Zen 免费链。zen 实测（真实工具负载）：**nemotron-3-ultra-free 4.7s 且识别正确（优选）**；nemotron-3.5-lightning-free 3.4s 但会误识别 share/activityConfig；x-preview-f-free（alpha）33.5s 慢且大请求 `prematurely closed` 卡死 5min+；laguna 429 限流。故 strong/fast/fallback 首位全放 nemotronultra。
**「优惠活动配置」别名修复（2026-08-22）**：`project-aliases.json` moduleAliases **无 `user/special_offer` 中文别名**（正确模块 user/special_offer，接口 beac/list；页面标题「优惠活动配置」List.vue），且 **`generate-api-index.mjs` 用 baseName 查别名导致带目录模块（user/xxx）手动别名永不生效**（行 101）→ 候选 brief 给 paymentChannel/vipPage 误命中 → 模型误调 share/activityConfig（beinvite/getInviteActivities，另一个页面）→ 后端 `Parameter checking failed`。已修：补别名 + 脚本改 `MANUAL_ALIASES[moduleId]` 优先。端到端验证：「查询优惠活动配置列表」13.3s 返回 user/special_offer 12 条（走服务端护栏补全，模型未完整 submit 也能完成查询）。
**本地源码定位设计澄清**：代码库用本地 `CODEBASE_ROOT=D:\Code\bx-film-admin-in2`（git.work.xxbbc.com 的本地 clone），`search_api_module`/`grep_codebase`/`read_api_module` 实时 grep 本地源码定位接口（对齐 Cursor 实时读源码），不依赖 git 远程/MCP 拉索引。
- **100% 稳定性修复（2026-08-22，追查「2/3 → 2/5」失败根因）**：逐层定位并修复三类确定性缺陷，同输入「用户列表」连测 5/5 全成功（均渲染表格、call_api=2 次）：
1. **429 限流未识别**（真根因之一）：TokenHub 免费额度 `model http 429: FreeUsageLimitError / Rate limit exceeded` 连发即挂。`isQuotaErrorMsg` 扩入 `rate\s?limit|FreeUsageLimit|http 429` → 走降级链换模型；新增 `isHardQuotaErrorMsg`（仅 402/401008/quota 等永久耗尽才 markModelExhausted 封禁 30min，**限流不封禁**——换模型后可能恢复）。
2. **首轮空转**（`toolChoice:"auto"`）：业务请求（actionableQuery）understand 轮次改 `toolChoice:"required"`（对齐 Cursor agent 模式强制工具循环；闲聊/知识库保持 auto）。
3. **orchestrate 兜底反问**（模型 submit.module 空时）：`workflow-orchestrate.ts` 的 parse_intent 调用传 `retryOnModuleAmbiguity:true`，且 module 空时用 `buildModuleCandidateIds(userText)` 自动补全可调用候选（服务端护栏确定性补全，不再反问无关模块列表）；MODULE_RETRY/CLARIFICATION 时若候选已补全则直接用其继续。
4. **fallback 触发条件过宽**（`hasToolResult` 把 search 结果误当产出）：模型「submit→search→直接结束」时 final 合成失败抛「已完成若干工具调用」兜底文案。改为 `hasApiData`（toolResult 中 call_api 数据特征：`[已对齐 PC 端字段`/`UI_TABLE`/`【表格输出】`/`【图表摘要`/JSON 开头，排除 `[源码定位]`/`未找到匹配`/`错误：`）→ 无 API 数据即走 orchestrate 兜底。
**残余（模型行为方差）**：探索路径长短随机（24 条接口 30s vs 277 万接口 150s+）；`call_api` 偶发同时传 size 与 pageSize。均非架构问题。
- **列表自动受控渲染（2026-08-22 落地，对齐 Cursor「渲染由执行器完成」）**：`workflow-orchestrate.ts` 新增导出 `renderListForAgent(payload, moduleKey)`——call_api 返回多行列表（≥2 行，`extractListRowsForRender`）时，服务端强制按 PC 列定义渲染表格（复用 pickRowsByPcColumns/renderCell/loadModuleRenderConfig，列名模板字符串 `${getTran(` 回退 fieldMap→colTitle），chat.ts 的 call_api 成功分支在 detail 渲染前接入：渲染成功 → emit table + forcedReply 收束 + **`persistRawToolOutput` 把原始数据写文件替换 steps 中 toolResult**（防跨轮上下文污染）；失败 → 回退 output-align 提示模型自行处理。至此列表/详情/报表三类全部服务端受控渲染，模型不再调 render_table/normalize_output（实测「用户列表前5页」：call_api 1 次、render_table 0 次、表格列全中文）。**注意**：模型命中大接口（277万用户 user/search）时探索路径仍可能长（147s），属模型行为方差。
- **final 兜底盲区修复（2026-08-22）**：`synthesizeReplyFromToolResults` 原只认「图表摘要/表格输出/UI_TABLE」三类，普通列表/详情结果兜不住 → 模型收尾超时即抛「已完成若干工具调用，但未能生成最终说明」（数据已查到却对用户宣称失败）。修复：① 识别 `[已对齐 PC 端字段`（normalize_output）与 call_api 裸 JSON（`looksLikeListJson`，排除 _tool 元工具）→ `jsonToMarkdownTable` 转 Markdown 表格（数组→表格 / {rows|list}→表格+total/page / 单对象→键值对）；② `normalize_output` 对字符串 data 剥引号/嵌套转义再 parse（原返回「带引号字符串字面量」致 render_table「无数据」）；③ `render_table.toRows` 容忍「[已对齐 PC 端字段」前缀与转义字符串；④ `limitListRows`（call_api 列表 rows 裁剪到 50 行+占位行）防单次结果顶满 20K 上下文。对齐 Cursor「工具结果即产出，总结是增量」。

**实际实现状态**：✅ 完全对齐（含降级分支，已被本次修复补全）。

---

## 3. 第 2 步：工具定位与参数归一

```
模型按理解定位模块/接口：
   grep_codebase / search_api_module 实时 grep bx-film-admin-in2/src/api|views|router
   → read_file 读接口定义源码，确认函数名 / path / 参数
   （2026-08-24 起 api-module-index 索引已删除，模块定位完全交模型 grep 源码，索引仅作向前兼容的空兜底）
   ↓
参数别名归一（paramAliases 映射）
   ↓
多语言 / 环境差异 → 由真实接口校验，不硬编码 languageId
```

**实际实现状态**：✅ 完全对齐（方案 A，源码实时定位优先）。

---

## 4. 第 3 步：安全与确认门禁

```
call_api 执行前：rulesGateBeforeCallApi（parse_intent 安全校验）
   ↓
判断是否为写操作（method≠GET / isWriteQuery）
   ↓
写操作 → 强制发 confirmation_required：
   先注册 waiter（waitForConfirmation）再 yield 事件 → 用户确认后才执行
   ↓
凭证缺失 → 返回配置指引（不中断对话）
```

**实际实现状态**：✅ 完全对齐（tool node + 服务端兜底双重确认）。

---

## 5. 第 4 步：编排执行（orchestrate）

```
LangGraph 单轮编排收口：llm ⇄ tool → final
   ↓
按 QueryPlan 顺序执行工具调用（模型自主或服务端兜底）
   ↓
服务端兜底与模型调用解耦：
   模型整轮未调工具 / 编造 → runServerFallback 用真实接口结果覆盖
   ↓
事件流（eventQueue）逐条 yield 给前端（tool_call / tool_result / text_delta / table / file / chart）
   ↓
调用真实接口 / 检索知识库 → 拿到原始结果
```

**实际实现状态**：✅ 完全对齐。

---

## 6. 第 5 步：结果加工与格式化

```
接口 / 检索结果 → 组织成自然语言或结构化卡片：
   ├─ 列表 → normalize_output 对齐中文字段 → render_table
   ├─ 详情（单条对象）→ 服务端强制渲染两列表格 + 表格事件
   └─ 知识库结果 → formatSearchResults 带引用出处（> 来源：docs/knowledge/...）
   ↓
模型禁止编造文档名 / 内容（KB 预检拦截 + Faithfulness 护栏）
   ↓
必要时二次调用模型做总结 / 润色
```

**实际实现状态**：✅ 完全对齐。

---

## 7. 第 6 步：输出与回流（含输出护栏）

```
final node 收束 → 推前端展示
   ↓
【输出护栏 Guardrail】（蓝图原仅写"推前端"，2026-08-22 加固补齐）：
   validateFinalText 拦截以下形态，清空走 synthesizeReply 兜底：
   ├─ tool-call：裸工具调用描述 JSON
   ├─ clarification：parse_intent 的 CLARIFICATION_REQUIRED JSON
   ├─ bare-json：其他裸 JSON
   └─ pseudo-plan（新增）：自然语言 + ```json 代码块（含 action/module/operation）
                          或文本含 "action":"call_api" / "module":"x"+"operation":"y"
   ↓
自然语言幻觉护栏（伪计划之外）：
   若最终文本含系统提示词复述 / 自指句式（"我的能力包括" / "您可以"），清空走兜底
   ↓
失败 / 超时（如 60s / signal.aborted）→ 取消与错误回显，不无响应
   ↓
本轮输入-输出、工具调用链写入日志（console.error 诊断 + 拦截事件结构化记录）
```

**实际实现状态**：✅ 基本对齐；**伪计划拦截 + 402 降级为 2026-08-22 本次修复新增**（之前漏洞：模型复述系统提示词 + JSON 伪计划被透传）。

---

## 8. 第 7 步：持续学习（离线 / 异步）

```
Bug / 返工 → 直接改对应 _template/ 规范文件正文（加门禁 / 检查项）
   ↓
别名配置数据驱动化（project-aliases.json 单点配置 → 重跑生成脚本）
   ↓
流程改进日志一行留痕（README.md §五 / guidelines.md §1）
   ↓
知识库增量索引、embedding 语义检索升级（TODO）
```

**实际实现状态**：✅ 完全对齐。

---

## 9. 按场景完整链路

### 场景 1：业务数据查询（列表 / 详情 / 统计）
```
「三级分类列表」/「三级分类，5850754967898112的所有数据」
   ↓ isActionableBusinessQuery → true
   ↓ Cursor Rules 常驻底线注入 system 层
   ↓ 模型 submit_understood_intent（信任模型）
   ↓ 模型实时读 PC 端源码定位接口（方案 A）
   ↓ parse_intent 安全校验（可调用 + 合理性）
   ↓ 模型调 call_api（operation 索引作安全底座）
   ↓ 列表 normalize → render_table / 详情强制渲染表格
   ↓ 模型基于工具结果输出最终回答
```
**关键点**：模型理解主导；模块定位以实时源码为准；`search_api_module` 只给明确别名候选不模糊猜测；详情服务端强制渲染。

### 场景 2：能力询问
```
「三级分类，可以做哪些操作？」
   ↓ capabilityKeywords 最高优先级
   ↓ buildModuleCapabilitiesText（从 api-operation-index 读 operations）
   ↓ 直接返回操作清单（不调接口）
```

### 场景 3：写操作
```
「删除三级分类 999999999999999」
   ↓ isWriteQuery → true
   ↓ 服务端强制确认（先注册 waiter 再 yield）
   ↓ 确认 → 执行 / 取消 → "你取消了该操作，未执行。"
   ↓ 执行后如实回显
```
**关键点**：工具节点 + 服务端兜底双重强制确认；fallback 阶段确认事件必须直接 yield。

### 场景 4：知识库问答
```
「公司报销流程是什么？」
   ↓ actionableQuery=false → chit-chat 提示（含「知识库文档类可调 search_knowledge_base」）
   ↓ 模型自主调 search_knowledge_base 检索 docs/knowledge/**
   ↓ 基于检索结果回答（标注来源，禁止编造）
```
**关键点**（2026-08-24 起）：KB 预检短路已删除，改由模型自主调 `search_knowledge_base` 工具（description 明确触发场景，避免服务端词表低召回/误短路/无整合的偏离）；检索实现仍为中文 bigram + TF-IDF + embedding RRF。

### 场景 5：多轮续聊（上下文继承）
```
先：三级分类，5850754967898112，可以做哪些操作？
后：查看详情
   ↓ "查看详情" 缺 module/ID
   ↓ 模型基于对话历史理解（模型自带上下文能力）→ submit_understood_intent 带 module/ID
   ↓ parse_intent 安全校验 → call_api 查详情
```
**关键点**：上下文继承交给模型（对齐 Cursor），不再用规则层反推；模型未补全/不可校验 → 反问。

### 场景 6：模型全失败兜底（防编造 + 防误导）
```
模型整轮没调工具、直接输出（或编造数据 / 伪计划）
   ↓ 主流程 hasToolResult=false → runServerFallback
   ↓ orchestrateBusinessQuery 兜底：parse_intent（安全校验+反问）→ call_api → 渲染
   ↓ 用服务端真实结果覆盖模型编造文本
```
**关键点**：兜底同样遵守「不猜」；写操作先强制确认；澄清 JSON 渲染成友好问题。
⚠️ **2026-08-22 加固**：模型 402 额度错误不再走此路径反问无关模块，而是第 1 步降级直接返回 402 提示（见第 1 步降级分支）。

### 场景 7：闲聊
```
「hello 你好」
   ↓ isActionableBusinessQuery → false（无业务词）
   ↓ chit-chat 提示：纯文本回答、禁调业务工具（知识库文档类除外，可调 search_knowledge_base）
   ↓ 模型直接聊天回答（不调工具）
```
**注**：当前闲聊识别即 `isActionableBusinessQuery=false` 的间接结果，无独立 `CHIT_CHAT` 预处理层（见第 0 步说明）。

### 场景 8：澄清交互
```
「查看详情」（全新会话、无上下文）或 模型给的模块不可调用
   ↓ parse_intent 缺 module / 不可校验 / 歧义 → CLARIFICATION_REQUIRED
   ↓ 服务端渲染成友好问题（"你要操作哪个模块？" + 候选）
   ↓ 你回复序号或补全 → 进入场景 1 执行
```

---

## 10. 关键防护点（贯穿所有场景）

| 防护 | 机制 | 代码位置 |
|---|---|---|
| 防编造业务数据 | 业务请求 → 服务端兜底用真实接口结果覆盖模型文本 | `chat.ts` runServerFallback |
| 防编造公司制度 | 知识库类问题 → 模型自主调 `search_knowledge_base` 返回真实检索结果（来源可溯）；chit-chat 提示引导 | `tools.ts` search_knowledge_base + `chat.ts` chit-chat |
| 写操作安全 | 增/改/删 → 强制用户确认（双重） | `chat.ts` tool node + fallback |
| 防规则层误判 | parse_intent 只做安全校验 + 反问，不做关键词解析/纠正 | `tools.ts` parse_intent |
| 防裸 JSON | 澄清 JSON → 渲染成友好问题 | `chat.ts` renderClarificationForUser |
| 防伪计划透传 | validateFinalText 拦截 pseudo-plan（自然语言+JSON） | `chat.ts` finalText node |
| 防模型失败误导 | llm node 捕获 modelError + 主流程直接返回 402/错误，不进业务反问 | `chat.ts` llm node + 主流程 |
| 防步骤泄露 | 输出纪律：禁止模型复述内部工具调用过程 | `chat.ts` initialSteps |
| 上下文连贯 | 模型读历史自主补全（不再用规则反推） | LangGraph llm node |

---

## 11. 相关文件索引

| 文件 | 作用 |
|---|---|
| `apps/agent-server/src/chat.ts` | 主流程（chatStream + LangGraph + 兜底 + 确认 + 模型失败降级 + 输出护栏） |
| `apps/agent-server/src/workflow-orchestrate.ts` | 规则编排（parse_intent → inferCallOperation → call_api → 渲染） |
| `apps/agent-server/src/tools.ts` | 工具注册表（21 个工具）+ runAgentTool dispatch + parse_intent |
| `apps/agent-server/src/tools/knowledge-base.ts` | 本地知识库（检索 + 引用出处） |
| `apps/agent-server/src/tool-gate.ts` | isActionableBusinessQuery（业务/闲聊判定） |
| `apps/agent-server/src/api-index.ts` | 模块索引 + 文本反推模块（resolveApiModulesFromText） |
| `docs/agent/clarification-policy.json` | 澄清策略（四元组 / 槽位 / 风险分级） |

---

## 12. 2026-08-22 修复记录（Cursor 规则落地 + 模块路由 bug）

### 问题
- 输入「看下影片搜索统计的列表，最新的前50条」被错误路由到 `film`（影片列表），而非 `search.getMovieSearchStatList`。

### 根因（三个通用 bug）
1. `clarification-policy.json` 项目级 `moduleAliases` 是「完全替换」内置表 → 漏配的模块（search）规则识别全失效；
2. 模块匹配是「顺序 break」→ 「影片搜索统计」被 film 的「影片」截胡；
3. `sys/user`（无接口模块）与 `user`（有接口）同命中「用户」时误选 `sys/user`。

### 修复（数据驱动 + 代码层）
| 文件 | 改动 |
|---|---|
| `project-aliases.json` | search 模块补别名；`operationAliases` 给两个统计接口配中文别名 |
| `api-index.ts` | 新增 `buildModuleCandidateBrief()`：候选模块语义目录（最长命中 + 可用性过滤）注入系统提示 |
| `tools.ts` | `matchAlias`/规则遍历改「最长命中 + 操作索引可用性」优先；项目 `moduleAliases` 改「合并」语义 |
| `workflow-orchestrate.ts` | 新增 `extractListParams`（前N条→page/size）；`inferCallOperation` 列表分支按 operationAliases 精确选择 |
| `chat.ts` | `rulesGateBeforeCallApi` 模块纠正；`validateApiResultShape` 结果校验；`validateFinalText` 输出 Guardrail；catch 分支补写操作确认；`pickAutoModel` 意图路由 |
| `field-mapping.json` | search 模块字段中文映射（对齐 PC 端） |
| `router-policy.json` | `autoModel` 强/快模型路由配置 |
| `scripts/test-regression.mjs` | bad case 回归集（`npm run test:regression`，6 用例全绿） |

### 前端
- `ChatPage.vue` + `api.ts` + `@bx/shared`：补写操作确认弹窗（影响面：高危标识/对象/数量），对齐 Cursor 权限分级。

---

## 13. 2026-08-22 改造记录（Cursor 架构对齐 + parse_intent 安全校验化）

### 目标
用户要求「输入语句解析规则对齐 Cursor」：Cursor 是「模型语义判断主导 + Rules 常驻底线 + Skills 按需」，规则层不做意图路由、不反向覆盖模型；有歧义就反问。

### 改动
| 文件 | 改动 |
|---|---|
| `.cursor/skills/pc-agent-crud-router/SKILL.md` | 去掉 `disable-model-invocation: true`；改为模型按需调用；Required Inputs 改用 `api-module-index.json` |
| `.cursor/rules/agent-routing-baseline.mdc` | **新增** Cursor Rules 常驻底线（写确认/禁止编造/查询默认参数/PC 日志/写后回读/normalize_output） |
| `src/skills.ts` | 多目录扫描；新增 `loadResidentRules()` 加载 `.cursor/rules/*.mdc`（alwaysApply）；支持 `enabled:false` 停用旧技能 |
| `skills/business-intent/SKILL.md` | `enabled:false` 停用 |
| `src/chat.ts` | 业务请求时把 Cursor Rules 注入 system 层；`rulesGateBeforeCallApi` 删除旧"规则层纠正模块"逻辑，回归纯校验 |
| `src/tools.ts` | `parse_intent` 重写：有模型理解时只做安全校验；无理解/模块不可调用/歧义 → 反问（不猜） |
| `src/module-api-catalog.ts` | catalog 文件读取注释掉 |

### 行为验证（tsx 实测）
| 场景 | 结果 |
|---|---|
| 模型给 `videosource` /「影片采集源」/「采集源」 | ✅ 信任/归一 → videosource |
| 模型给「影片采集员」（模糊） | ✅ 反问「未找到模块对应的接口」 |
| 模型未给 module | ✅ 反问「你要操作哪个模块？」 |
| 能力问法（可以做哪些操作） | ✅ op=capabilities |
| 模型给不可调用模块 | ✅ 反问 |
| 端到端「获取全部的影片采集员列表」 | 模型自主探索 grep → 发现 moviesource（最后 call_api 因模型服务额度 402 未完成，环境问题） |

---

## 14. 2026-08-22 方案 A：模块定位去索引化（模型实时读源码）

### 背景
索引快照会过期、缺近义词别名（如「影片采集员」在索引里只有「影片采集源」），导致模块定位失败。用户选择**方案 A**：让模型实时 grep PC 端源码。

### 改动
| 文件 | 改动 |
|---|---|
| `src/tools.ts` `search_api_module` | **主路径改为实时 grep 源码**（`bx-film-admin-in2/src/api` + `src/views` + `src/router`），过滤噪声目录；`rg` 缺失时回退 `grepCodebaseNative`；索引仅作兜底候选且不返回模糊短词 |
| `src/chat.ts` | 模型引导强化：探索阶段改为 `grep_codebase / search_api_module（源码定位）→ read_file 读接口源码 → call_api` |
| `src/call-api.ts` / `src/tools.ts` `execCallApi` | **未改**：operation 索引保留作安全底座 |

### 行为验证（tsx 实测）
| 关键词 | 结果 |
|---|---|
| 兑换码 | ✅ 源码命中 `api/vipExchangeCode.ts`、`api/redeemCode/*.ts` |
| 三级分类 | ✅ 源码命中 `router/routes/modules/film.ts` + `views/dictionary/messageSubCategory/` |
| 采集源 | ✅ 源码命中 `views/film/configs.data.tsx`、`views/actor/configs.data.tsx` |
| 影片采集员 | ✅ 源码未命中 → 提示"可能指影片采集源，请结合语义确认"，**不误导成 film** |
| 噪声过滤 | ✅ `local/`、`locales/`、`tran.json`、`*.txt` 不再出现 |

### 环境注意
- `rg`（ripgrep）**不在系统 PATH**：靠 `grepCodebaseNative` 回退运行。建议安装：`winget install BurntSushi.ripgrep.MSVC`（可选）。

---

## 15. 2026-08-22 本轮加固（模型失败降级 + 输出护栏，对齐 7 步蓝图第 1/6 步）

### 问题（用户实测暴露）
1. 模型 402 额度耗尽时，服务端兜底无模型理解只能产出「与输入无关的模块列表反问」——误导用户；
2. 模型基于历史补全出「自然语言 + ` ```json ` 伪计划」（能力清单复述 + call_api 步骤），被直接透传上屏；
3. `validateFinalText` 原只拦「以 `{` 开头的纯 JSON」，漏了「自然语言 + 内嵌 JSON 代码块」；
4. `isLikelyFreshRequest` 靠标点「？」把"什么？"误判为新请求，错误丢弃上轮 `pendingClarification`。

### 修复（4 处拦截点 + 双保险）
| 位置 | 改动 |
|---|---|
| `chat.ts` llm node try/catch（约 838 行） | 模型调用失败 → 捕获写入 `state.modelError`，返回空 text（不再静默返回触发误反问） |
| `chat.ts` llm node 首轮（约 854/884 行） | 首轮业务请求 retry 后 / 返回前：`isToolPlanText` 命中伪计划 → 清空；`firstRoundPlan` 检查同样清空 |
| `chat.ts` `isToolPlanText`（约 296 行） | 增强：识别"自然语言 + ` ```json ` 代码块（含 action/module/operation）"和裸 `"action":"call_api"` JSON 对象 |
| `chat.ts` `validateFinalText`（约 326 行） | 新增 `pseudo-plan` 返回值（自然语言+JSON 代码块）；finalText node 命中即清空走 `synthesizeReply` 兜底 |
| `chat.ts` 主流程（约 1319 行） | 新增 `ls.modelError` 检查：额度类 → 直接返回 402 提示，不进 fallback 反问；其他错误亦直接返回 |
| `chat.ts` 外层 catch（约 1424 行） | `isQuotaError` 递归穿透 LangGraph 包装链（cause/originalError）作双保险 |

### 行为验证（修复后预期）
| 输入 | 修复前 | 修复后 |
|---|---|---|
| 模型 402 + "获取全部的影片采集员列表" | 反问无关模块列表 | 直接返回 402 提示 |
| "什么？"（基于历史影片采集员） | 透传能力清单 + JSON 伪计划 | 清空走兜底（402 提示或友好澄清） |
| "你好" + 模型 402 | 反问无关模块列表 | 直接返回 402 提示 |
