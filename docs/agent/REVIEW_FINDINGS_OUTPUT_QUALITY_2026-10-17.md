# 输出质量审查发现（SQL 质量 / 结果正确率 / 总结质量 / 排版）

> 2026-10-17 由 3 个子 agent 并行只读审查（SQL 质量、输出正确率与总结、排版与输出规范），对照联网检索的**输出规范最佳实践**。
> 配套文档：`GUARDRAIL_REMEDIATION_ROADMAP.md`（综合整改路线图，含本专项的「批次 6」）、`REVIEW_FINDINGS_2026-10-17.md`（护栏/测试/文档审查）。
>
> **重要事实澄清（范围核查）**：本仓库当前 `src` 的实际代码与 memory/docs 描述的 `analytics/*`、`output-tools.ts`、服务端「中文表头/枚举翻译层」**不一致**——子 agent 核查 `src/analytics/*`（sql-generate/sql-compile/verified-query/sql-ast/capability-gate/semantic-layer）、`src/output-tools.ts`（extractColumnsFromSource/needsValueMapping）、`synthesizeReplyFromToolResults`/`redirectSummary` **均不存在**（仅出现在 docs/tests 的引用里）。实际落地是：最终回答 = 模型综合轮 `outcome.text` 原样上屏（`chat.ts:2676`，`markSynthesis` 只计数不重组）；表头来自模型自填的中文键名（`builtins.ts:855`），枚举值原样透传。**以下审查以当前 `src` 实际代码为准**；若实施时相关模块实际存在，请以真实路径核实。

---

## 一、输出规范最佳实践对照（检索依据）

| 原则 | 来源 / 依据 | 对本项目的含义 |
|---|---|---|
| **结论先行 + 总分总** | CSDN「结论先行协议」、Pydantic AI structured output、Anthropic Output Styles | 先给答案/结论，再展开明细；长文有结构骨架 |
| **数字必须可溯源、不编造** | text-to-SQL hallucination mitigation（d23.io、arXiv 2512.22250）、「Text-to-SQL Agent 落地：Schema 感知、安全边界与自纠错」 | 数字来自工具返回；无证据断言如实说「没数据」 |
| **口径 / 来源 / 时间范围声明** | 同上 + 实测事故复盘 | 回答应声明指标定义、数据来源、时间段 |
| **合计 / 汇总可自检** | schedule-alert `formatScheduledCountFacts` 服务端确定性求和（已落地） | 普通查询的合计也应服务端重算校验，而非只靠模型 |
| **结构化排版（表格/代码块/图表）** | Anthropic 输出规范、Markdown 通用约定 | SQL/JSON 用代码块、结构化数据用表格、重点数字突出 |
| **净化不可信内容（防 XSS）** | 本项目 DOMPurify 已落地（见 C 维度「做得好」） | 模型原始 HTML 需统一加固 |

---

## 二、维度一：SQL 质量与正确性（子 agent A）

> 与护栏审查重合的 P0-1/2/3/5、P0-4、P1-2、P1-11 此处不重复详述，仅确认仍在代码中存在；下方重点列**新发现**。

### [P∅-结构] gold SQL 静态校验层未落地（最该补的根因）
- **事实**：`src/analytics/*` 在当前快照不存在；SQL 完全由模型生成经 MCP 执行。唯一静态校验 = 运行时 **fail-open** 的 `lintSql`（只提示不拦）+ fail-closed 的 `isReadOnlySql`（只管写操作）。
- **影响**：GROUP BY 与聚合不匹配（CK 宽松模式下静默给错值）、JOIN 关系/别名/窗口函数/`SELECT *` 编译期零校验；「跑通了但口径错」无法在生成时拦截 → **静默给错数**的根本来源。
- **建议**：在编译期落地 gold SQL 静态校验（GROUP BY/聚合/别名一致性、窗口函数、`SELECT *` 检测），至少强提示；`JOIN_DANGLING_REF`（`:293-337`）仅正则、对子查询/CTE 覆盖有限需补强。

### [P2-中] metabase-mcp.mjs:553-601 — get_field_values 绕过 runSql
- **问题**：手拼 SQL 后直接 `mb("/dataset")`，绕开 `runSql` → 无 SETTINGS、无 lint、无只读校验。
- **影响**：缺 `max_execution_time` 资源护栏（注入风险因 `ident()` 白名单较低）。属「绕过统一执行核心」的漂移源。
- **建议**：改经 `runSql`（或抽共享「带护栏 POST」），仅保留标识符白名单。

### [P2-中] sql-lint-common.mjs:58-94 — hasDateWindow 整条 SQL 扫日期字面量（非 WHERE 作用域）
- **问题**：扫描全文日期字面量，不限定 WHERE/JOIN ON；`SELECT`/`CASE` 里偶然出现日期（如 `toDate('2026-10-09')`、`toString(dt)='...'` 非 sargable 等值）会假造「有界窗」→ **抑制** HEAVY/MULTI_JOIN（漏报资源风险，方向与 P0-4 相反）。
- **影响**：无真实时间过滤的重聚合被放过。
- **建议**：仅对 WHERE/JOIN ON 内裸列日期比较计窗，并区分 sargable / 非 sargable。

### [P2-中] sql-lint-common.mjs:273-281 — MULTI_JOIN_UNBOUNDED 描述窄于代码
- **问题**：消息写「整条查询没有时间窗过滤」，实际触发条件 = 无窗 **或** ≥14 天有界长窗；单 JOIN 无窗 / 多 JOIN 但用非日期过滤（仍全扫）不触发。
- **影响**：提示文案误导，且对「多 JOIN + 非日期过滤」全扫链漏报。
- **建议**：消息改为「无时间窗过滤**或窗口≥14天**」；考虑单 JOIN 无窗 + 高基数也提示。

### 确认仍存在（与护栏审查一致）
- metabase-mcp.mjs:251 未判引擎就全局追加 CK SETTINGS（P0-1）；classifyUpstreamError 不识 Code 115（P0-2）；result_overflow_mode='break' 静默截断（P0-3）；HEAVY 漏 uniqExactIf/Array/State/OrNull（P0-5）；hasDateWindow 只认 'YYYY-MM-DD' DateTime 不识别（P0-4）；GROUP BY 1 误报（P1-2）；execute_query(question_id) 绕过校验（P1-11）。
- **核对 P1-1（`!=` 当单日等值窗）**：当前代码**未复现**——操作符集 `(>=|<=|>|<|=)` 不含 `!=`/`<>`，`col != '...'` 不会当单日窗。该条可不排期。

---

## 三、维度二：输出正确率与总结质量（子 agent B）

### [高] 1. 结论先行 / 总分总只有 few-shot，无运行时强制
- `system-prompt.ts:111-116`（ANSWER_SHAPE_EXAMPLE 仅示范骨架）；`chat.ts:2170-2173`（`markSynthesis` 只计数）；`chat.ts:2676`（最终答案=原样 `outcome.text`）。
- **影响**：弱模型可裸堆数据，遗漏口径与结论先行。
- **建议**：综合轮收束前加轻量「结构判定」（首句是否含结论数字+口径），不通过回灌结构提示重生成；或拆「结论行/口径行/明细」结构化槽位再渲染。

### [高] 2. 非预警路径无服务端数字 / 合计复核
- `grounding.ts:296,444`（「四则运算算有支持」）；`chat.ts:2549-2624`（核验门+共识）。
- **影响**：「明细 60+60=120 但写成 130」这类**算错不算无证据**，合计错误直接上屏。
- **建议**：对合计类断言，服务端用工具返回明细做一次确定性求和/计数校验（仿 `schedule-alert.ts:204`）。

### [高] 3. 中文表头 / 枚举翻译层完全缺失，英文键与枚举值会直出
- `builtins.ts:855`（表头=模型键名）、`builtins.ts:1809`（「不自动从表格推算，避免编造」）、`chat.ts:1671-1672`（`prepareToolResultText` 仅截断/压缩，无翻译）。
- **影响**：模型若返回 `status`/`created_at` 或枚举 `PENDING`/`active`，纯英文/裸枚举上屏，违背中文呈现预期。
- **建议**：`export_data`/`render_chart` 入参到矩阵这一步加可选「字段名→中文」「枚举值→中文」映射（由角色/技能提供字典），缺失映射时至少告警。

### [中] 4. 口径与来源声明无运行时强制
- `system-prompt.ts:113-115`（口径+来源仅 few-shot）；`grounding.ts:482,502`（verify 只查来源是否存在，不查是否声明）。
- **影响**：弱模型可给数字却不报指标定义/时间范围 ——「丢口径」无法自动发现。
- **建议**：结构判定（见 #1）把「首段含口径+来源」设为必要条件。

### [中] 5. 通用角色未开 enforceGrounding → 零证据拦截整体不生效
- `roles.ts:128/150`（movie/support 开）；generic 未设；`grounding.ts:279,544`（`!enforceGrounding` 直接 pass）。
- **影响**：通用角色做数据查询时，零工具数据给具体事实也无拦截。
- **建议**：注入业务数据源的对话默认开 `enforceGrounding`（或 `hasBusinessDataSource` 为真时强制）。

### [中] 6. 预警 count 规范化 total 与小时明细潜在不一致
- `schedule-alert.ts:257-262`：`total = unique ?? reduce(...)`；标题用 `unique`，括号明细用各小时 `item.count`。若 `unique` ≠ 小时桶求和 → 结论自相矛盾。
- **建议**：`unique` 存在时明细行不展示按小时「求和」口径，或显式标注双口径。

### [中] 7. 兜底合成 wrapUpWith 只要求结论性，无口径/来源/数字复核
- `chat.ts:812-815`（`WRAP_UP_HINT`）、`chat.ts:621-669`（`wrapUpWith`）。预算耗尽/中止时唯一答案合成点，同样丢口径、合计可能算错。
- **建议**：套用 #1/#2 的结构判定与数字复核。

### [低] 8/9/10. 总结无独立质检模块；核验共识投票一股不可用即放行；诚实兜底「未核对」依赖模型自觉
- `grounding.ts:556`（consensusUnsupported）、`grounding.ts:132`（webOnly 写「未核对」靠自然语言要求）。
- **建议**：数字类断言固定多票；核验不可用对含具体数字回答走更保守路径；未核对列由服务端强制填「未核对」。

### 已做得好（确认落地，非问题）
零证据拦截 + 受约束诚实兜底（`grounding.ts:85-148`、`chat.ts:2470-2543`）、反编造两阶段 + 引用溯源确定性比对（`grounding.ts:439-512`）、多页不估算防护、预警数字服务端规范化（`schedule-alert.ts:204`）。

---

## 四、维度三：排版与输出规范（子 agent C）

### [High] H1. 图表深色主题永不生效（选择器错位）
- `ChartCard.vue:32-34` `isDark()` 读 `classList.contains("dark")`；但全仓深色靠 `html[data-theme="dark"]` 属性激活，`classList.add("dark")` 无调用 → `isDark()` 永远 false，G2/G6 始终 light 渲染。`themeObserver`（`:584-587`）监听 `class` 同样不触发。
- **建议**：`isDark()` 改读 `getAttribute("data-theme")==="dark"`，或统一监听 `data-theme`。

### [High] H2. 图表卡片背景/边框写死白色（变量未定义）
- `ChartCard.vue:633,635` `var(--border,#e5e7eb)` / `var(--surface,#fff)`；`--border`/`--surface` 全仓**未定义** → 任意主题回退白底。深色下刺眼白块。
- **建议**：改用已定义 `--panel`/`--line`，或补定义并接入两套主题。

### [High] H3. support-label 深色模式文字不可见
- `bubble.css:786-794` `color: var(--text,#1f2430)`；`--text` 未定义，回退深色 `#1f2430`；band 类（high/review/alert）只改背景不改字色 → 深色下对比度约 1.2:1，违反 WCAG 1.4.3。
- **建议**：`color` 改 `var(--ink)`（随主题反色）；移除对未定义 `--text` 的依赖。

### [Medium] M1. 代码块无语法高亮（SQL/JSON 平铺）
- `chat-richtext.ts:6-10` 未传 `highlight`；`.md :deep(pre code)` 只设字号背景无着色。最佳实践要求 SQL/JSON 高亮，当前长查询难读。
- **建议**：接 highlight.js/shiki 或至少对 `language-sql/json` 着色（高亮输出也需过 DOMPurify）。

### [Medium] M2. refused（未执行）步骤状态药丸缺语义配色
- `bubble.css:238-242` 仅有 `.step.warn .mcp-dot`；`.step.warn .step-status` 规则不存在 → 文字走默认灰，弱化「未执行≠失败」语义。
- **建议**：补 `.step.warn .step-status` 黄调药丸（注意 `--warn` 也未定义，见 M4）。

### [Medium] M3. 模型原始 HTML 的 `<a>` 绕过 target/rel 加固（Tabnabbing 风险）
- `chat-richtext.ts:7`（`html:true`）+ `:16-20`（仅 markdown 链接加 `rel/target`）。原始 `<a href="https://evil">` 经 DOMPurify 保留但**不补** `target/_blank`+`rel`。
- **建议**：`addHook("afterSanitizeAttributes")` 对所有 `<a>` 统一设 `target="_blank" rel="noopener noreferrer"`。

### [Medium] M4. 主题变量 `--warn/--text/--surface/--border` 缺失
- `styles.css:1-73` 仅定义 `--bg/--panel/--ink/--muted/--line/--fill/--danger/--accent/--success/--surface-2/--surface-3` 等。`--warn` 回退 `#b26a00` 深色下对比度约 4.2:1 边缘达标。是 H1/H2/H3 根因之一。
- **建议**：`:root` 与 `html[data-theme="dark"]` 补齐并接入两套取值。

### [Medium] M5. 无「结论先行 / 总分总」自动视觉强调
- `ChatBubble.vue:280-313` 仅有模型驱动的 `alert-chip` 等；正文 `.md` 对标题/段落/列表/表格只统一排版，无结论卡片、关键数字高亮、目录。
- **建议**：对 `**加粗数字**`、`> 引用结论`、`<mark>` 增主题化强调样式（`<mark>` 当前无样式，见 L2）。

### [Medium] M6. `<table>` 包裹仅匹配裸标签，原始 HTML 表格会溢出
- `chat-richtext.ts:185-186` 正则只匹配 `<table>`；模型注入 `<table class="x">` 不命中 → 不套 `.table-wrapper` → 横向撑破气泡。
- **建议**：DOMParser 阶段 `querySelectorAll("table")` 统一包裹。

### [Medium] M7. 长文/大表流式重渲染性能
- `ChatBubble.vue:65` `bodyHtml` 随 delta 重算；缓存键为完整全文，流式期间命中不了缓存 → 大表逐 token 整表重解析可能卡顿。
- **建议**：超大内容分块/增量渲染，或流式暂用轻量路径。

### [Low] L1 h1 死规则；L2 `<mark>` 无样式；L3 缩略图 alt 用文件名；L4 魔法硬编码蓝色（应改 `var(--accent)`）；L5 bubble.css 改后需重启 dev（已知坑）。

### 已做得好（对照最佳实践，非问题）
XSS/净化（DOMPurify + 自定义 ALLOWED_TAGS/ATTR + `javascript:` 拦截）、标题层级降一级避免跳级、表格自动补 `scope`、长表/工具轨迹折叠 >12 行、步骤气泡 `aria-expanded/controls` 齐备、图表 `role=img`+`aria-label`+懒加载+ResizeObserver+失败降级+空数据占位。

---

## 五、跨维度整改优先级建议

**第一优先（会直接给错数 / 误导）**
1. 维度二 #2 服务端合计/汇总复核（普通查询也校验，不止预警）
2. 维度二 #3 中文表头/枚举翻译层（至少告警，避免裸英文上屏）
3. 维度二 #1/#4 结构判定（结论先行+口径+来源运行时强制）
4. 维度一 P∅ gold SQL 静态校验（或从 lint 升级为强提示/编译期校验）

**第二优先（视觉与体验断裂）**
5. 维度三 H1+H2+H3（图表深色 + support-label 不可见，牵连 `--warn/--text/--surface/--border` 变量补齐）
6. 维度三 M3（原始 `<a>` Tabnabbing 加固）

**第三优先（打磨）**
7. 维度三 M1（高亮）、M2（warn 药丸）、M5（结论视觉强调）、M6/M7（表格包裹/流式性能）
8. 维度二 #5（通用角色 enforceGrounding）、#6（预警 total 口径）、#7（wrapUpWith 复核）、#9/#10（核验保守化）
9. 维度一 P2 三项（get_field_values 归口、hasDateWindow 作用域、MULTI_JOIN 描述）

> 标注：以上均为只读审查结论，未修改任何文件。具体行号随代码演进可能漂移，实施前请 `git grep` 复核。
