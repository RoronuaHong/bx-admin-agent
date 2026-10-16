# 输出质量 vs 最佳实践 · 对齐对照（含示例）

> 2026-10-17，基于三份审查（`REVIEW_FINDINGS_OUTPUT_QUALITY_2026-10-17.md` 三子 agent + `REVIEW_FINDINGS_2026-10-17.md` 护栏 + `GUARDRAIL_REMEDIATION_ROADMAP.md`）+ 联网检索的**输出规范最佳实践**。
> 状态图例：✅ 已对齐　⚠️ 部分对齐（有机制但不强制/有缺口）　❌ 未对齐（缺失或失效）
> 所有结论以当前 `src` 实际代码为准（注：`src/analytics/*`、`src/output-tools.ts` 当前快照不存在，最终回答是模型 `outcome.text` 原样上屏）。

## 最佳实践依据（检索）
- **结论先行 + 总分总 + 数字可溯源**：CSDN「结论先行协议」、Pydantic AI structured output、Anthropic Output Styles。
- **text-to-SQL 质量**：schema 感知 + 安全边界 + 自纠错（d23.io、arXiv 2512.22250）、「Text-to-SQL Agent 落地：Schema 感知、安全边界与自纠错」——生成后必须**验算**（聚合口径、成本/超时）。
- **结构化排版**：SQL/JSON 用代码块、结构化数据用表格、重点数字突出、净化不可信内容（DOMPurify）。

---

## 总表（逐项状态）

| # | 维度 | 检查项 | 最佳实践要求 | 状态 | 证据 |
|---|---|---|---|---|---|
| S1 | SQL | 编译期静态校验（GROUP BY/聚合/别名） | 生成即校验，错误不靠运行时静默 | ❌ | 仅 fail-open `lintSql` |
| S2 | SQL | 静默给错数防护（截断/超行） | 触及上限必须明示 | ❌ | `result_overflow_mode='break'` 无提示 |
| S3 | SQL | 只读校验 | 写操作 fail-closed | ⚠️ | `runSql` 强拦；`execute_query` 后门绕过 |
| S4 | SQL | 方言/版本兼容 | 非 ClickHouse 不注入 CK 语法 | ❌ | `runSql` 未判引擎 |
| S5 | SQL | 重聚合护栏 | 高基数/长窗拦截 | ❌ | `HEAVY` 漏 `uniqExactIf` 家族 |
| O1 | 正确率 | 结论先行 + 总分总 | 运行时强制结构 | ⚠️ | 仅 few-shot `ANSWER_SHAPE_EXAMPLE` |
| O2 | 正确率 | 数字可溯源 / 不编造 | 零证据不收束 | ⚠️ | `grounding` 两阶段强；但 generic 未开 |
| O3 | 正确率 | 合计 / 汇总自检 | 服务端确定性重算 | ❌ | 普通查询合计无复核 |
| O4 | 正确率 | 中文表头 / 枚举翻译 | 服务端翻译层 | ❌ | 表头=模型键名，枚举直出 |
| O5 | 正确率 | 口径 / 来源声明 | 运行时强制 | ⚠️ | 仅 few-shot |
| P1 | 排版 | 图表深色主题 | 随主题切换 | ❌ | `isDark()` 读 `.dark` 类（全仓无） |
| P2 | 排版 | 代码块语法高亮 | SQL/JSON 着色 | ❌ | markdown-it 无 `highlight` |
| P3 | 排版 | 不可信内容净化 | 链接 target/rel 加固 | ⚠️ | markdown 链接已加固；原始 `<a>` 绕过 |
| P4 | 排版 | 表格 / 长文 a11y | scope、折叠 | ✅ | `chat-richtext.ts` 已做 |
| P5 | 排版 | 关键标签主题适配 | 深色可读 | ❌ | `support-label` 深色不可见 |
| P6 | 排版 | 结论视觉强调 | 重点数字突出 | ❌ | 无结论卡片/数字高亮 |

---

## 一、SQL 质量

### S1 ❌ 编译期静态校验缺失
- **最佳实践**：gold SQL 在编译期校验 GROUP BY 完整性、聚合/别名一致性、窗口函数、`SELECT *`，错误在生成时拦截而非 ClickHouse 执行后静默给错值。
- **现状**：唯一静态校验是运行时 **fail-open** 的 `lintSql`（`sql-lint-common.mjs`），只提示不拦；`JOIN_DANGLING_REF` 仅正则、对子查询/CTE 覆盖有限。
- **当前问题示例**：模型生成
  ```sql
  SELECT region, uniqExactIf(guid, is_paid) FROM elt_watch_detail GROUP BY region
  ```
  CK 宽松模式下 `uniqExactIf` 内部列 `guid` 不在 GROUP BY 也可能"跑通"，返回**口径错的值**而非报错；无任何编译期拦截。
- **目标示例**：编译期 `validateGoldGroupBy` 命中 → 返回 `verified_query_gold_group_by:<id>` 拒绝，提示"检查 SELECT 列是否都落在 GROUP BY 或聚合内"，绝不把 CK 原始异常抛给用户。

### S2 ❌ 静默给错数（`result_overflow_mode='break'`）
- **现状**：`bi-query-settings.mjs` 默认 `max_result_rows=1e6` + `result_overflow_mode='break'`；`runSql` 只按工具 `limit` 判截断，不检测 CK break、不读 `rows_truncated`。
- **当前问题示例**：某高基数 `GROUP BY user_id` 返回 1.2M 行 → CK 静默砍到 1M，**金额/计数系统性偏小，无任何提示**——比报错更危险。
- **目标示例**：默认改 `'throw'`；或响应头强制写"本查询触及行数上限，结果可能不完整"，并比对返回行数是否等于 `max_result_rows`。

### S3 ⚠️ 只读校验（有强拦但有后门）
- ✅：`runSql → assertSql → isReadOnlySql`（fail-closed，拦 INSERT/UPDATE/DELETE/DDL）。
- ❌：`execute_query(question_id)` 与 `query` 的 question_id 分支直接 `POST /card/:id/query`，**绕过 lint/SETTINGS/只读/口径硬拦**（`metabase-mcp.mjs:839/892`）。

### S4 ❌ 方言/版本兼容
- **现状**：`runSql`（`metabase-mcp.mjs:251`）无条件 `appendClickHouseSettings`（CK 专有语法），未先取 engine；非 CK 引擎（误填/未来 PG/MySQL/H2）会语法错误 400。
- **目标**：取 engine，仅 ClickHouse 系才 append；wid 归一化上提共用。

### S5 ❌ 重聚合护栏漏网
- **现状**：`HEAVY_EXACT_AGG_NOWINDOW` 正则 `/\buniq\s*exact\s*\(/i` 要求 `exact` 后紧跟 `(`，漏掉 `uniqExactIf(`/`uniqExactArray`/`uniqExactState`——恰是线上事故形态。

---

## 二、输出正确率与总结质量

### O1 ⚠️ 结论先行 / 总分总（只有 few-shot，无强制）
- **最佳实践**：先给结论（数字+口径），再展开明细；长文有总分总骨架。
- **现状**：`system-prompt.ts:111` `ANSWER_SHAPE_EXAMPLE` 仅示范骨架（注释"只演示骨架，不重复规定"），无运行时结构判定。弱模型可能直接堆表格不总结。
- **当前问题示例**（弱模型可能产出）：
  > | 区域 | 新增用户 |
  > |---|---|
  > | 华东 | 420 |
  > | 华北 | 310 |
  > | … | … |
  >
  > （直接贴 30 行表，没有任何结论句、口径、来源）
- **目标示例**（最佳实践）：
  > **结论**：近 7 天（2026-10-10~17）新增用户共 1,200，华东占比 35% 最高。
  > **口径**：按注册时间、全部状态、已排除 3 条状态为空的记录。**来源**：`<接口/表>`。
  > **明细**：华东 420 / 华北 310 / 华南 280 / 其它 190。需按城市拆分可再取。

### O2 ⚠️ 数字可溯源 / 不编造
- ✅ 已落地：`grounding.ts` 零证据拦截 + 受约束诚实兜底 + 两阶段核验（抽断言/判支持，来源走服务端集合比对）。
- ❌ 缺口：通用角色 `roles.ts` 未设 `enforceGrounding`（movie/support 已开 `:128/:150`），通用角色做数据查询时零工具数据给具体事实无拦截。

### O3 ❌ 合计 / 汇总自检
- **现状**：`grounding.ts:296/444` 把"四则运算等价改写"视为有支持 → "明细 60+60=120 但写成 130" 这类**算错不算无证据**，直接上屏。
- **目标**：对回答中的合计类断言，服务端用工具返回明细做确定性求和/计数校验（仿 `schedule-alert.ts:204` `formatScheduledCountFacts` 已落地的思路）。

### O4 ❌ 中文表头 / 枚举翻译层缺失
- **现状**：`builtins.ts:855`"对象的键就是表头文字，可直接用中文键名"——表头完全靠模型自觉填中文；枚举值（如 `PENDING`/`active`）原样透传，无服务端映射。
- **当前问题示例**：
  > | status | created_at | client_type |
  > |---|---|---|
  > | PENDING | 2026-10-15 08:12 | 3 |
- **目标示例**（最佳实践，服务端至少告警/可映射）：
  > | 状态 | 创建时间 | 客户端类型 |
  > |---|---|---|
  > | 待处理 | 2026-10-15 08:12 | Android |

### O5 ⚠️ 口径 / 来源声明
- **现状**：仅 `ANSWER_SHAPE_EXAMPLE` few-shot 示范；`grounding.ts:482/502` 的 verify 只查"来源是否存在"，不查"是否声明"。无口径无来源的吻合结论会直接通过。

---

## 三、排版与输出规范

### P1 ❌ 图表深色主题永不生效
- **现状**：`ChartCard.vue:32` `isDark()` 读 `document.documentElement.classList.contains("dark")`；但全仓深色靠 `html[data-theme="dark"]` 属性激活，`.dark` 类无任何调用 → `isDark()` **永远 false**，G2/G6 始终 light 渲染；`themeObserver` 监听 `class` 也不触发。
- **当前问题示例**：深色模式下图表是**白底浅色图**，与整体暖纸/深色风格割裂，且卡片背景写死 `#fff`（`--surface`/`--border` 未定义回退）。
- **目标示例**：`isDark()` 改读 `getAttribute("data-theme")==="dark"`，卡片用 `--panel`/`--line`，深色下图表与卡片一体化。

### P2 ❌ 代码块无语法高亮
- **现状**：`chat-richtext.ts:6` markdown-it 仅 `html/linkify/breaks`，未传 `highlight`；`.md :deep(pre code)` 只设字号背景无着色。SQL/JSON 全为等宽纯文本。
- **目标示例**：` ```sql ` 块关键字着色（SELECT/FROM/GROUP BY 高亮），长查询字段一眼可辨。

### P3 ⚠️ 不可信内容净化（有强项有缺口）
- ✅：DOMPurify 自定义 `ALLOWED_TAGS/ATTR` + `ALLOWED_URI_REGEXP` 拦截 `javascript:` + 净化 `style` 属性白名单，链路扎实（`chat-richtext.ts:28-66`）。
- ❌：模型原始 HTML `<a href="https://evil">` 经 `html:true` 透传，DOMPurify 保留但**不补** `target/_blank`+`rel`，存在反向 Tabnabbing 风险（markdown 链接已加固，原始 HTML 未覆盖）。

### P4 ✅ 表格 / 长文 a11y
- `chat-richtext.ts` 自动补 `scope=col/row`、>12 行表与工具轨迹默认折叠、标题层级降一级避免跳级——对齐最佳实践。

### P5 ❌ support-label 深色不可见
- **现状**：`bubble.css:786` `color: var(--text,#1f2430)`（`--text` 未定义，回退深色）；high/review/alert band 只改背景不改字色 → 深色下对比度 ~1.2:1（违 WCAG 1.4.3）。
- **目标**：`color` 改 `var(--ink)`（随主题反色）。

### P6 ❌ 结论视觉强调缺失
- **现状**：正文 `.md` 对标题/段落/列表/表格只统一排版，无结论卡片、关键数字高亮、目录；所有"重点突出"依赖模型是否自行产出。
- **目标**：对 `**加粗数字**`、`> 引用结论`、`<mark>` 增主题化强调（`<mark>` 当前无样式）。

---

## 四、整改优先级（回指路线图批次 6）
1. **输出正确率**（最高优先，会直接给错数）：O3 服务端合计复核 + O4 中文表头/枚举翻译层 + O1/O5 结构判定 + O2 通用角色 `enforceGrounding`
2. **SQL 质量**：S1 gold SQL 静态校验 + S4/S5 方言兼容/HEAVY 补网 + S2 截断明示
3. **排版**：P1+P5 深色适配（牵连 `--warn/--text/--surface/--border` 变量补齐）+ P3 原始 `<a>` 加固
4. **打磨**：P2 高亮 / P6 结论视觉强调 / M6 M7 表格包裹与流式性能
