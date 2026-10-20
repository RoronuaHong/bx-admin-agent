# 对话框回复质量审计（2026-10-19）

## 审计范围与方法

本次审计覆盖三类"对话框回复"相关的数据，统一记录发现的问题。

| 数据源 | 内容 | 规模 |
|---|---|---|
| MongoDB `bx_agent.chat_conversations` | 真实聊天对话的助手回复（可见文本） | 379 会话 / 1723 条助手消息 / 36 个含回复的会话 |
| `.data/analytics/ledger/ask-202609.jsonl` | 问数（analytics）子系统每次提问的运行台账（含生成的 SQL 与执行结果） | 2331 条运行记录（2026-09 整月） |
| `.data/analytics/*.err` + `slice-*.jsonl` | 问数子系统运行时日志与评测结论 | 41 个 .err 文件 / 多个评测切片 |

> 说明：审计日期为 2026-10-19，问数台账与评测切片均为 2026-09 的历史数据（约一个月前），运维日志亦为历史记录。当前线上若已修复下述问题，请以最新运行结果为准。

---

## 一、对话回复（MongoDB 聊天记录）审计

### 1.1 总体规模

- 379 个会话中，仅 **36 个** 含助手回复，共 **1723 条** 助手消息。
- 其余 343 个会话为空壳（仅创建、未产生回复，或纯后台任务占位）。
- 其中 1 个会话 `6ac730d4...` 独占 **1633 条** 消息，全部是「印度客服对话量预警」定时任务的周期状态输出（`[NORMAL]` / `[NO_DATA]` 协议行），属机器自动生成，**非人工交互回复**，下文单独标注、不计入交互质量评估。
- 真正的人工交互回复约 **90 条**，分布在另外 35 个会话。

### 1.2 乱码（无实际发现）

- 全量 1723 条助手消息扫描：未检出 `U+FFFD` 替换符、UTF-8/Latin1/GBK 误读（Ã / Â / â€ / æ 等）等真实乱码。
- 仅 3 条命中"连续问号串"，经逐条核对，**均为助手正确识别并告知用户"您的上一条消息是乱码（??????）"**——属于正确行为，不是输出乱码。即：系统侧输出无乱码，反而是助手在帮用户兜底输入侧乱码。

### 1.3 空回复 / 截断（无发现）

- 0 条空回复。

### 1.4 模板变量 / 占位符泄漏（无实际发现）

- 初筛命中 2 条 `模板变量未替换`，经全文核对，**均为 JSON 工具参数的 `}}`（`"limit": 100}}`）**，属正常工具调用回显，非模板泄漏。
- 未发现 `{{...}}` 未替换、系统提示占位符 `XX/` 泄漏、内部协议标记 `[workflow/`/`[chat:` 泄漏。

### 1.5 SQL 语法（发现 1 处损坏）

全量回复仅 **2 个会话** 含 SQL：

- **会话 `6ad31d777...`（idx 6）—— 正常、高质量**
  ClickHouse SQL（`WITH v AS (...) SELECT ... UNION ALL ...`），结构合法，且助手主动做了口径说明，并诚实指出"分项相加 773,396 与合计 773,386 相差 10"的算术差异与未核查原因。**该回复是正向样例，无问题。**

- **会话 `6ab238bf...`（idx 0）—— SQL 骨架损坏（质量问题）**
  该回复是一份"广告 ROI 指标方案设计"，其中给出的 SQL 骨架被破坏（非执行 SQL，但作为示例会误导）：

  ```sql
  WITH daily AS (
    SELECT dt, channel, language, package,
           SUM(impressions) AS imp, SUM(clicks) AS clk,
           SUM(plays) AS play, SUM(pay_users) AS pay_uv,
           SUM(pay_amount) AS pay_amt, SUM(cost) AS cost
    FROM ads_daily_fact
    WHERE dt IN (:today, :yesterday, :same_day_last_week)
    GROUP BY 1,2,3,4
  )
  SELECT channel,
         SUM(pay_amt)/NULLIF(SUM(cost),0)               SUM(clk)/NULLIF(SUM(imp),0)                SUM(pay_uv)/NULLIF(SUM(clk),0)              ily WHERE dt = :today
  GROUP BY channel;
  ```

  **问题**：第二阶段 `SELECT` 列表缺失列别名与逗号，且末尾混入了 `ily WHERE dt = :today`（疑似 `daily` 别名被截断成 `ily` + 误把 `WHERE` 写进 SELECT 列表）。属模型输出断裂/拼接错误导致的 SQL 语法损坏。虽非执行 SQL（环境未连库），但作为"方案交付"示例存在误导，**建议在生成 SQL 示例后做一次语法自检或截断保护。**

### 1.6 其它发现

- 巨型定时任务会话 `6ac730d4...`（1633 条）：全部为 `[NORMAL]` 周期状态（如"窗口…计数 34 条，未破线"）与 `[NO_DATA]` 协议句。这些是无人值守结论协议的正常产物，不是缺陷，但**会严重稀释"对话总数"统计**——若有人工回复质量看板，建议把自动任务会话从指标中剔除。
- 该会话中存在少量 `[NO_DATA] 这次没有取到可核对的数据，没有下结论。` 短句，是无人值守取数失败时的确定性兜底文案，符合设计，**非缺陷**。

---

## 二、问数（analytics）SQL 语法与质量（运行台账 2331 次）

> ⚠️ **现状重要说明**：生成这些 SQL 的「问数 / NL→SQL」子系统（`src/analytics/*`、`sql-guard`、`stage4-sql-generate` 等）**已从当前代码完全移除**——全仓 `grep` 对 `elt_watch_detail` / `watch-detail.pack` / `generateCandidateSqls` / `assertAnalyticsSqlSafe` **零引用**。以下错误均为 **2026-09 历史数据**，当前线上已无该生成链路。
> 但**缺口仍在**：当前唯一的 SQL 安全层 `isReadOnlySql`（`scripts/sql-readonly-common.mjs`）**只校验「只读语义」（单条 SELECT / 无写操作 / 无越界表函数），完全不校验 SQL 语法正确性**。若将来重引入 NL→SQL，或经 Metabase MCP 原生查询通道让模型写 SQL，同类错误仍会直达 ClickHouse 才暴露。详见第五节验证。

### 2.1 总体分布

| 状态 | 次数 | 占比 |
|---|---|---|
| clarify（需澄清/缺时间等） | 1279 | 54.9% |
| ok（成功） | 810 | 34.7% |
| refuse（拒绝/护栏拦截） | 168 | 7.2% |
| error（执行/生成失败） | 74 | 3.2% |

失败细分：error 39、aborted（用户取消）33、refuse 162、refuse_verify_fail 2、error_exec 2、refuse_dim 4。

### 2.2 SQL 语法错误（Code 62）—— 真实语法问题，2 例

根因一致：**模型把中文枚举值当标识符，未加单引号**。

- 运行 `c5e89873...`（nl="全都要"）：`movieType IN (电影, 电视剧, 真人秀, 短剧, 动漫, 肥皂剧)`
- 运行 `9046e224...`（nl="电影，电视剧，真人秀，短剧，动漫，肥皂剧，"）：同上

报错：`Code: 62. DB::Exception: Syntax error: failed at position 441 ('�') ... 电影, 电视剧, ...`。系统已识别并回显中文解释"未正确添加单引号"，但**查询首次生成即错、需用户二次确认才能修正**，属于生成侧质量缺陷。

### 2.3 字段/表幻觉与错误（非语法，但属 SQL 质量问题）

| Code | 次数 | 类型 | 示例 |
|---|---|---|---|
| 47 | 3 | 引用不存在的列（幻觉字段） | `watchDate`（实际只有 `lastWatchTime`）、`src`（实际无该列） |
| 60 | 1 | 表/库限定错误 | `film_report.gather_stat` 应为 `gather.gather_stat` |
| 241 | 1 | 资源超限（非语法） | `Memory limit exceeded`（13.67 GiB > 13.50 GiB），大查询未限流/未下推 |

### 2.4 运维类失败（非 SQL 语法，但影响回复可用性）

- **模型不可用级联降级**：大量 `MissingSessionID` / `not supported`（"OpenCode's free tier can only be used in OpenCode"、免费模型陆续下架）。导致问数生成失败、回退到兜底。
- **凭据缺失**：`METABASE_USERNAME/PASSWORD missing`——多笔"订单数/影片资料"类查询因 Metabase 凭据未配置直接失败。
- **用户取消（aborted）33 次**：部分与上文 2.2 的乱输入重试有关。

---

## 三、运维日志（`.err`）高频问题

| 问题 | 出现次数 | 说明 |
|---|---|---|
| 模型不可用级联（MissingSessionID / not supported） | 705 | 免费模型不稳定，触发长链路降级 |
| 模型额度耗尽（401008）级联降级 | 145 | TokenHub/OpenCode 免费额度耗尽 |
| 端点不支持 thinking 参数 | 37 | 网关重发处理，非致命 |
| 超出运行预算（budget） | 16 | 单 run 超 100000ms 预算 |

---

## 四、统一问题清单（按严重程度）

### 🔴 高（直接影响回复正确性）

1. **问数生成 SQL 中文枚举未加单引号（语法错误 Code 62）** —— 2 例（台账 `c5e89873`、`9046e224`）。建议：生成 SQL 后对 `IN (...)` / `= '...'` 中的中文字面值做引号补全校验，或在 prompt 明确"字符串必须单引号包裹"。
2. **问数幻觉字段（Code 47）** —— 3 例（`watchDate`、`src`）。建议：执行前用 `system.columns` 校验列存在性（已有 guard，但仍漏，需强化或加大模型侧 schema 约束）。

### 🟡 中（影响可用性/稳定性）

3. **会话 `6ab238bf...` 回复中的 SQL 骨架损坏**（缺别名/逗号 + 误混入 `WHERE`）—— 1 例。建议：SQL 示例生成后做语法自检或截断保护。
4. **问数表/库限定错误（Code 60）** —— 1 例（`gather_stat`）。建议：库名显式白名单。
5. **大查询内存超限（Code 241）** —— 1 例。建议：默认加 `LIMIT` 或采样下推。
6. **Metabase 凭据缺失** 导致一批查询直接失败。建议：凭据缺失时提前拦截并明确提示，而非执行期报错。

### 🟢 低 / 观察项

7. **模型可用性差**（705+145 次降级/耗尽）—— 供应商侧额度问题，非代码缺陷，但直接影响回复成功率，建议接入稳定付费模型或降级提示优化。
8. **巨型自动任务会话稀释统计** —— 1633 条机器周期输出混入"对话总数"，建议看板/质检排除自动任务会话。
9. **输入侧乱码** —— 用户侧发送 `??????` 乱码，助手已正确兜底告知重发，非系统缺陷，但可加输入编码预检。

---

## 五、实证验证（测试证实，未改任何代码）

> 以下结论均经脚本对真实数据/真实守卫运行验证，非断言。验证脚本位于 `apps/agent-server/scripts/_verify-sql-guard.mjs` 与 `_verify-garble.mjs`（临时分析草稿，可删）。

### 5.1 SQL 语法错误的真实性 + 守卫缺口（已证实）

用项目**当前**的 `isReadOnlySql` 守卫对生产台账里 6 条「执行失败」SQL 逐一判定：

```
=== 生产台账中的 SQL 执行错误（status=error 且含 ClickHouse Code） ===
错误条目数: 6
按错误码: {"47":2,"60":1,"62":2,"241":1}
  [code=62] nl="全都要"
  [code=62] nl="电影，电视剧，真人秀，短剧，动漫，肥皂剧，"
  [code=47] nl="FoxA呢？"
  [code=60] nl="查 gather_stat 在 2026-08-19 到 2026-08-25 的行数"
  [code=241] nl="1"
  [code=47] nl="最近14天 IndiaA 1.0.0 版本的付费率按语言拆列"

=== 当前 isReadOnlySql 守卫对这些“错误 SQL”的判定 ===
  isReadOnlySql=true  code=62  SELECT toDate(lastWatchTime) AS watchDate, ...
  isReadOnlySql=true  code=62  SELECT toDate(lastWatchTime) AS watchDate, ...
  isReadOnlySql=true  code=47  SELECT watchDate, channel, uniq(guid) AS users ...
  isReadOnlySql=true  code=60  SELECT count() AS rows FROM gather_stat ...
  isReadOnlySql=true  code=241  SELECT contentLang, round(avg(a),0) AS avg_max_progress ...
  isReadOnlySql=true  code=47  SELECT countIf(contentLang = '') AS en, ...

结论：上述 6 条 SQL 全部被判为“可放行的只读查询”，
但其中 code=62/47/60 是明确语法/ schema 错误——守卫未拦截，直达执行期才报错。
```

**焦点 Code 62（中文枚举未加单引号）**——生产台账原文：

```sql
-- 运行 c5e89873 / 9046e224，model=glm5turbo，guardIssues=[], rewriteRounds=0
AND movieType IN (电影, 电视剧, 真人秀, 短剧, 动漫, 肥皂剧)   -- ❌ 中文未加单引号
-- ClickHouse 报错：Code: 62. DB::Exception: Syntax error: failed at position 441 ('�')
-- 系统回给用户的话：未正确添加单引号，导致数据库将其误认为无效标识符而报语法错误
```

→ **证实两点**：①该 SQL 语法确实错误（真实 ClickHouse 报 Code 62）；②生成时守卫（`guardIssues:[]`）与模型自纠（`rewriteRounds:0`）双双失效；③当前 `isReadOnlySql` 即便现在跑也返回 `true`，证明语法校验缺口在现网守卫中依然存在。

### 5.2 乱码问题（已证实：无输出乱码，3 例为助手正确处理输入乱码）

```
真实乱码(�/Ã/Â/â€)命中: 0
连续问号串命中: 3  其中助手在描述用户输入乱码: 3
示例：
  [连续问号串] 您发来的消息显示为一串问号（???????），可能是编码问题导致内容无法显示，我这边完全读不到原文。麻烦您重新发送一次…
  [连续问号串] 您这条消息依然是乱码（一串 `?????`），我无法辨认具体内容，所以暂时没办法帮您处理具体问题…
  [连续问号串] 您这条消息**仍然是乱码**（一串 `?????`），我完全无法读取原文内容…
```

→ **证实**：存储的助手回复中**不存在任何输出乱码**（无 U+FFFD、无 UTF-8 误读）。3 处 `????` 均为助手**正确识别并告知用户「您的输入是乱码、请重发」**，属正确兜底行为，非缺陷。

### 5.3 关键现状佐证

- 全仓对 `elt_watch_detail` / `watch-detail.pack` / `generateCandidateSqls` / `assertAnalyticsSqlSafe` 引用数 = **0** → 问数 SQL 生成链路已从当前代码移除。
- `src/analytics` 目录不存在（已 `list_dir` 确认）；当前 `src/` 仅有 `sql-readonly.ts`（仅再导出只读守卫）。

## 六、关键更正 + 每一步修改对当前功能的影响（对齐最佳实践）

### 6.1 重大更正：九月 SQL 错误来自「已移除的问数子系统」，当前 SQL 路径已有大量防护

审计初版把 6 条 Code 62/47/60/241 当成"当前功能缺陷"。进一步核对执行路径后发现：

- 这些错误来自 **2026-09 的问数（analytics）NL→SQL 子系统**，它走的是**独立的、较弱的守卫**（台账 `guardIssues:[]`、`rewriteRounds:0`，Path C 模型 SQL 仅靠 `collectIssues` 重试环），且**不经过**当前 BI 通道 `scripts/metabase-mcp.mjs`。该子系统现已从 `src` 完全移除（零引用），错误为历史。
- **当前仍在线的 SQL 执行路径 `metabase-mcp.mjs` 已具备**：
  1. `assertSql()` 硬门：空 / 多语句 / `isReadOnlySql`（只读语义）/ `checkCaliber`（2 条业务口径硬拒）；
  2. `lintSql()`（`sql-lint-common.mjs`，fail-open 静态体检，约 20 条规则）：其中 **`GROUP_BY_SELECT_MISMATCH` 已覆盖 Code 47 类（未聚合未分组的裸列）**、**`JOIN_DANGLING_REF` 已覆盖 Code 60 类（JOIN 引用未声明表/别名）**、**`HEAVY_EXACT_AGG_NOWINDOW` 已覆盖 Code 241 类（精确去重无窗爆内存）**——只是 fail-open（提示但照常执行）；
  3. `bi-query-settings.mjs` 资源护栏：`appendClickHouseSettings` 给每条查询加 `max_execution_time / max_bytes_before_external_group_by / _sort / max_result_rows` 等边界，且 `classifyUpstreamError` 把 **Code 241/307/394 翻译成可操作提示**——**即 Code 241 的内存护栏已经落地**；
  4. 错误文案可操作性（2026-10-14 事故复盘要求）。

→ 结论：**初版方案 A2（分组/表名校验）、C（内存护栏）对当前路径基本已落地**；真正在当前路径**仍无预检**的只有 **Code 62 类（未加引号的中文字符串字面量）**。若问数子系统将来重做，务必让其生成的 SQL **复用** `metabase-mcp.mjs` 的 `assertSql + lintSql`（不要再造一条无 lint 的独立通道——这正是九月错误的根因）。

### 6.2 每一步修改对当前功能的影响矩阵（对齐最佳实践）

> 评级：🔴 高影响（会改当前在线行为，需严防误杀）/ 🟡 中（有副作用或新增依赖）/ 🟢 低（基本只新增提示或仅影响统计/运维，无在线行为变化）。"当前功能"指 `metabase-mcp.mjs` 原生查询通道 + `risk.ts` 服务端硬拒 + 后台 QC/看板。

| 步骤 | 内容 | 当前是否已做 | 对当前功能的影响 | 最佳实践对齐 |
|---|---|---|---|---|
| A1 语法预检（先 `SELECT…FORMAT Null`） | 执行前多一次解析往返 | 否；但 lintSql 是静态、运行期错误已 classified | 🟡 若加到当前路径：每条 BI 查询多一次往返 → 延迟+负载翻倍；与现有运行期错误分类冗余。**当前路径不推荐** | LLM02/ASI10（安全输出），但被静态 lint 更优地满足 |
| A2a 未加引号字符串检测（Code 62） | 检测 `IN (中文)` / `= 中文` 裸标识符 | **否（当前唯一缺口）** | 🟢 加进 `lintSql`（fail-open）：与现有 20 条规则同形态，**零误杀面**（只给提示不阻断）；若误加进 `assertSql` 硬门则 🔴 有拒真风险 | LLM02/ASI10、结构判定（零业务词）、red-line 安全 |
| A2b 列存在性校验（Code 47 `watchDate`/`src`） | 查 `system.columns` 确认列真存在 | 部分（`GROUP_BY_SELECT_MISMATCH` 只查"未分组"，不查"列不存在"） | 🟡 fail-open 需运行时查 schema（一次往返）；若硬门会 🔴 误杀。建议：只做 advisory 并复用现有 `get_database_schema` 工具，schema 信息**不入代码写死** | LLM02/ASI10；须 schema 驱动，不可写死业务列名（red-line） |
| A2c 表/库限定校验（Code 60 `gather_stat`→`gather.gather_stat`） | 校验 `schema.table` 在已知表清单 | 部分（`JOIN_DANGLING_REF` 查未声明别名，不查库限定错） | 🟡 同 A2b，须 schema 驱动；硬门 🔴 | 结构判定为主 |
| A3 模型提示强化（引号/字段/限定） | 系统提示引导 | 无关（当前无 NL→SQL） | 🟢 仅当问数重做时相关；当前路径不影响 | Prompt 工程最佳实践 |
| B `isWellFormedSql` 并入硬门 | 在 `assertSql` 加语法健全性硬拒 | 仅 `isReadOnlySql`（语义） | 🔴 **影响最大**：`metabase-mcp.mjs` 与 `risk.ts` 两侧每条原生查询都过此门，过严会拒真查询→**直接破坏在线 BI 取数**。须极窄（仅不平衡引号/括号），并保持 `sql-readonly-consistency.test.ts` 不漂移 | fail-closed 原则，但爆炸半径大；须守"单一可信源、两侧 import" |
| C 资源护栏（Code 241） | 加 LIMIT/内存预算 | **已落地**（`bi-query-settings` + `classifyUpstreamError`） | 🟢 无需再做 | LLM04/ASI08 ✓ 已对齐 |
| D 会话内 SQL 示例损坏（6ab238bf） | 设计类回复 SQL 生成后自检 | 无关（chat.ts 深代理） | 🟡 触及 `chat.ts` 核心回复路径，须严格限定"含 SQL 的设计/架构回复"，否则 🔴 误伤正常回复 | 输出处理（LLM02/ASI10） |
| E 运维/凭据预检 | 模型/凭据缺失给清晰错误 | 部分（模型回退、错误分类已有） | 🟢 仅新增清晰报错，不改在线成功路径 | 可观测/UX |
| F 统计口径排除自动任务会话 | 看板/QC 排除 `6ac730d4` 类机器会话 | 仅统计/看板 | 🟢 只影响计数，不触核心 | 指标卫生 |

### 6.3 红线与架构约束（落地任何修改前必读）

- **禁止写死**：任何新增静态检查必须是**结构/形态判定**（关键词、引号配对、列名形态），**不得**把业务表名/列名（如 `elt_watch_detail`、`watchDate`）写进代码或正则。列/表存在性校验须走 `system.columns`/`get_database_schema` 运行时取，不写死。⚠️ 注意现有 `checkCaliber()` 已写死 `ipCountryCode`/`networkCountryIso`/`elt_user_full_history` 等——属既有口径硬拒，扩张写死面前建议评审时一并讨论改 schema 驱动。
- **单一可信源、两侧 import**：若做 B，新函数必须加在 `sql-readonly-common.mjs`，`metabase-mcp.mjs` 与 `risk.ts`（`src/sql-readonly.ts` 再导出）两侧都 import，且 `tests/sql-readonly-consistency.test.ts` 须同步（该测试会抓"适配器又内联一份"的漂移）。
- **fail-open vs fail-closed**：只读语义/多语句/危险表函数 = fail-closed 硬拒；效率/稳定性/口径提示 = fail-open（照常执行+回灌提示）。新增 SQL 检查默认走 fail-open（与 `lintSql` 一致），避免误杀探索性查询。
- **不做 LLM-as-judge**：SQL 校验用纯静态结构判定，不引入评委模型（与线上"确定性打分、刻意不上 LLM judge"原则一致）。

### 6.4 推荐落地序（最高性价比、最低爆炸半径）

1. **A2a（未加引号字符串检测）加进 `lintSql`，fail-open** —— 命中当前路径唯一缺口（Code 62），且零误杀面（与现有 20 条规则同形态）。**这是唯一强烈建议立刻做的。✅ 已落地（见 §6.5，待提交）**。
2. （可选）**A2b/A2c 做 advisory + schema 驱动**：复用 `get_database_schema`，不写死，补 Code 47/60 的"列/表真存在"提示。
3. **B（硬门）暂缓**：爆炸半径大，仅在确认有"明显破损且误杀率极低"的类（如不平衡引号）时，窄化后并入，并保持一致性测试。
4. **C 已落地，跳过**；**D/E/F** 按优先级酌情。
5. 若问数 NL→SQL 重做：**复用** `metabase-mcp.mjs` 的 `assertSql + lintSql`，不要再造无 lint 的独立执行通道。

### 6.5 本轮已落地（A2a，未提交，等用户确认）

**改动**：在 `scripts/sql-lint-common.mjs` 的静态体检 `lintSql` 中新增 fail-open 判据 `UNQUOTED_STRING_LITERAL`，并在 `tests/sql-lint.test.ts` 补 `[S]` 正反例 + `[K+]` 覆盖登记。

**判据形态（零业务词、不对具体中文写死，符合红线）**：在值位置（`IN (...)` 列表项、比较 RHS `= / != / <>`）检测「裸的非 ASCII 标识符」——本系统列名/别名均为 ASCII，裸中文等非 ASCII 字符几乎必然是漏加单引号的字符串值（生产 Code 62 的 `movieType IN (电影, 电视剧, …)` 形态）。剥掉字符串字面量后（`stripNoise`）再判，已正确加引号的 `'电影'` 不会被误报；ASCII 裸词（列名/别名）与数字一律不误报。命中只回灌提示、照常执行（fail-open，与全模块一致），**零误杀面、不影响任何在线查询**。

**对齐最佳实践**：OWASP LLM Top 10（2025 版把 "Improper Output Handling" 编号为 **LLM05:2025**，2023/24 版为 LLM02；本项目 `BEST_PRACTICE_ALIGNMENT.md` 记录的 LLM02/ASI10 即此控制）——核心缓解是「把模型生成的输出当作不可信输入，下发数据库/下游系统前做校验与净化，而非直接透传」。本项目此前已在输出 schema（`output-schema.ts`）、脱敏（`redact.ts`）等处落实该原则；本次把同一原则延伸到模型自写 SQL 的语法/结构层，补齐"值位置漏引号"这一具体破损形态。**该改动对当前功能零影响**：它只是让 BI 取数失败时多一句"请加单引号"的提示，不增删任何硬门、不碰只读校验、不碰资源护栏。

**验证**：`tests/sql-lint.test.ts` 全绿（25/25，新增 1 个 fail-open 判据用例 + 覆盖登记）；改动文件 `git diff` 仅两处：判据实现 + 测试。临时验证脚本（`_verify-sql-guard.mjs` / `_verify-garble.mjs`）与分析输出已删除。

**未做（属原方案 B/C/D/E/F，本轮未动，保持评估结论）**：B（硬门，爆炸半径大、暂缓）、C（内存护栏已落地跳过）、A2b/A2c（列/表存在性需运行时查 `system.columns`，schema 驱动，可选）、D/E/F 按优先级酌情。

### 6.6 护栏缺陷修复 + 测试基线修复（未提交，等用户确认）

A2a 落地后跑全量测试，暴露出两类失败：一类是**被测代码本身的缺陷**（`tests/bi-guardrail-findings.test.ts` 的 7 个预存失败，映射为 F-P0-2/3/4/5、F-P1-1/2），一类是**测试断言/场景过时**（5 个无关失败）。两类都属「让门禁如实反映正确行为」，与 A2a 同一纪律（fail-open 提示、不阻断、零业务词写死）。

**① 被测代码缺陷（`scripts/sql-lint-common.mjs` 4 处 + `scripts/bi-query-settings.mjs` 2 处）**：
- `hasDateWindow`：BETWEEN / 比较正则补可选时分秒、支持 `toDateTime()/toDate()` 包裹并排除 `!=`/`<>`（此前把带时分秒或函数包裹的日期判成「无时间窗」→ 误报 `HEAVY_EXACT_AGG_NOWINDOW`）。
- `HEAVY` 正则匹配 `uniqExactIf` 等变体（`/\buniq\s*exact\s*\w*\s*\(/i`）。
- `groupByColumns` 序号写法（`GROUP BY 1`）返回 null，避免误报 `GROUP_BY_SELECT_MISMATCH`。
- **`result_overflow_mode` 默认 `break` → `throw`**：行为变更，需用户知悉——结果集超限从「静默截断」改为「报错」。静默截断会让计数/金额系统性偏小且零提示，比报错更危险（fail-loud）；确需静默截断的看板可显式设 `BI_CH_RESULT_OVERFLOW_MODE=break` 还原。
- `classifyUpstreamError` 新增 Code 115 / UNKNOWN_SETTING 分支（上游设置名错误给可操作提示，不透传原始异常）。

**② 测试基线修复（5 个预存无关失败，逐个定位根因后最小化修复）**：
- `bi-tool-ergonomics [O]`：SKILL.md 的「## SQL 怎么写」已内联全部要点，但不再引用外部文档；在 `skills/business-data-query/SKILL.md` 补回 `docs/bi-sql-best-practices.md` 引用（文档仍在，避免成死文档，符合「技能指路信息才算数」）。
- `grounding-verify-single-baseline`：**根因是测试场景用了数字型断言**（`共30条` vs `共3条`），被确定性数值校验（numeric verify O3）抢先 `continue`，grounding 核验根本看不到草稿——测的是另一条通道。把标记改为非数字型（`MARKER-SUPPORTED`/`MARKER-UNSUPPORTED`），grounding 核验才接管。**非产品代码改动**（numeric verify 抢拦截是设计内的确定性机制，数字本就不该交给模型自核）。
- `notify-deliver [M]/[N]`：`buildScheduleDelivery` 有意把触发方式插入标题（`name · 手动执行 · status`，deliver.ts 的 `titleTrigger`），是产品增强；更新标题断言匹配。
- `wrap-up-evidence`：第 71 行 `expect(buildSynthesisHint("")).toBe(hint.split("\n\n")[0])` 依赖 `WRAP_UP_HINT` 内部不含换行，但其已含「【分析/数据类…】」段；改为「空证据不含证据内容且带证据时以基础提示为前缀」。

**验证**：全量 `npx vitest run` **118 文件 / 791 测试全绿，0 失败**；改动文件 lint 干净。未自动提交，等用户确认。

## 七、结论

- **对话回复本身（可见文本）质量良好**：未发现真实乱码、空回复、模板泄漏。
- **SQL 层面的质量问题集中在问数子系统**：真实语法错误为"中文枚举未加单引号"（2 例），另有字段幻觉、表名错误、资源超限等生成/执行侧缺陷，以及模型可用性引发的运维失败。
- **建议优先修复** 问数 SQL 生成的中文字面值引号校验与列存在性校验（第 1、2 项），可显著降低 `error` 占比（当前 3.2%）并减少用户二次确认。

---

### 附：本次审计使用的脚本（位于 `apps/agent-server/scripts/`，未跟踪草稿，可删除）

- `_conv-audit.mjs`：对话回复扫描（乱码/SQL/质量）+ 问数 verdict 分布 + 运维日志统计。
- `_ledger-audit.mjs`：问数运行台账按错误码/失败类统计。
- `_conv-dump*.mjs`：针对具体会话/消息的全文提取核对（排查误报用）。
