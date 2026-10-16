# 查缺补漏：多子 agent 并行审查发现清单（2026-10-17）

> 方法：3 个 code-explorer 子 agent **并行只读审查**（未修改任何文件），分别覆盖 ①后端 BI/护栏链 ②前端类型与状态显示 ③测试覆盖与文档一致性。
> 本文汇总全部发现，按**严重度**排序，每条含 `文件:行号` / 问题 / 影响 / 建议，供整改排期。

---

## 一、P0 / 严重（与线上事故同源，优先修）

| # | 维度 | 问题（文件:行号） | 影响 | 建议 |
|---|---|---|---|---|
| **P0-1** | 后端 | **未判定数据库引擎就追加 ClickHouse SETTINGS，且三个 SQL 入口的 `database_id` 归一化不一致**：`metabase-mcp.mjs:245-262`（追加在 251）、`execute_sql:872-873`、`query:911`，只有 `run_native_query:622-628` 做了 `id===1→wid` 归一化；而 `list_databases:347-349` 明确返回 `engine`（Metabase 是多引擎，id=1 是 H2 样例库） | **与事故①完全同源**：一处全局注入打挂全部 BI 查询。换库或误填 id=1 时，SETTINGS 子句让该库所有查询语法失败 | `runSql` 内先 `GET /database/:id` 取 engine，**仅 ClickHouse 系 driver 才 append**；把 wid 归一化**上提到 runSql**，三个入口共用 |
| **P0-2** | 后端 | **`classifyUpstreamError` 不识别 `Code 115 / UNKNOWN_SETTING`**：`bi-query-settings.mjs:95-124`（只认 241/307/394） | 事故①只是被"改名+默认关闭"**遮住**，自愈能力仍为零：换 CK 版本 / DBA 打开 `BI_CH_MAX_ESTIMATED_TIME` 而目标不支持 → 全部查询失败，且把模型引导去"改 SQL/查字段名"（**归因方向相反**），反复重试烧轮次 | 增加 `115/UNKNOWN_SETTING` 分支：①自动以**不带 SETTINGS 的原文重试一次**；②打 `[bi:settings]` 日志并回显被跳过的 setting 名；③再失败才回落通用文案 |
| **P0-3** | 后端 | **`result_overflow_mode: 'break'` 默认静默截断结果集**：`bi-query-settings.mjs:33-38`（`max_result_rows`=1e6、`result_overflow_mode`='break'），且 `appendClickHouseSettings:77-85` 保证它们**每次都带** | 高基数 GROUP BY 返回 >1e6 行时，金额/计数**系统性偏小且无任何提示**——「静默给错数」比报错更危险（这是仅有的两个默认非 0、每次都追加的 setting） | 默认改 `'throw'`；或在响应头部强制写一行「本查询触及行数上限，结果可能不完整」 |
| **P0-4** | 后端 | **`hasDateWindow` 只认 `'YYYY-MM-DD'`，DateTime 字面量整条不识别**：`sql-lint-common.mjs:62`（BETWEEN 正则）、`76`（比较正则）都要求日期后紧跟 `'` | 用 `toDateTime('2026-10-15 08:00:00')` 或 `'2026-10-15T00:00'` 写法时，**有界短窗仍被判"无窗"** → 误报 `HEAVY_EXACT_AGG_NOWINDOW` | 正则放宽为支持日期部分可选时间部分（`'YYYY-MM-DD[ T]HH:MM(:SS)?'`） |
| **P0-5** | 后端 | **`HEAVY_EXACT_AGG_NOWINDOW` 漏掉 `uniqExactIf/Array/State/OrNull`**：`sql-lint-common.mjs:263`（正则只匹配 `uniq exact`） | **恰好是文档 §7.1 记录的线上事故形态**（`uniqExactIf(guid, …)` 打挂库）却不在拦截范围内 → 护栏对真实事故形态**失效** | 正则改为 `uniq\w*(?:If|Array|State|OrNull)?` 家族匹配 |
| **严重-1** | 测试 | **前端零测试**：`apps/web` 全目录 `*.test.*`/`*.spec.*` 命中 **0**；`package.json:6-11` 只有 `dev/build/preview/type-check`，devDeps 无 vitest；`agent-server/vitest.config.ts:6` 只 include `tests/**` | 改动④（`refused` 状态映射）**完全无回归保护**：后端 13 处 `executed` 任一处漏发/改名 → 前端静默回退成红色「失败」，与本次意图相反，且无红灯 | `apps/web` 装 vitest（纯函数即可，不需 jsdom）→ 至少 3 条：`executed===false&&ok===false→refused`、`executed===true&&ok===false→error`、`executed===undefined&&ok===false→error`（锁住向后兼容承诺） |
| **严重-2** | 测试 | **`tool_result` 的 `executed` 13 个 yield 分支 0 测试**：`chat.ts` 共 13 处（2830/2850/2879/3001/3026/3122/3217/3240/3260/3312/3333/3348/3491） | 「闸门拒绝→黄色未执行」与「真失败→红色失败」的区分是改动④的**核心语义**，无任何自动化用例 | 新建 `tool-result-executed.test.ts`：把「拒绝类返回」抽成可导出纯函数表，逐条断言 `executed===false`；成功类断言 `true` |
| **严重-3** | 文档 | **COMPARISON 文档 DAU 数字同文档自相矛盾（3 处过时值）** | 同一文档内数字打架，削弱结论可信度 | 统一为实测值（见 §四「文档校准」） |
| **严重-4** | 文档 | **GUARDRAIL 文档 §6.6 与 §五 / §6.7 表格直接矛盾**（已过期段落） | 读者会被引向已被修复/改名的做法 | 按当前代码校准（见 §四） |

---

## 二、P1 / 高

| # | 维度 | 问题（文件:行号） | 影响 | 建议 |
|---|---|---|---|---|
| P1-1 | 后端 | **`!=` 被当成"单日等值窗"**（修复③引入的假阴性）：`sql-lint-common.mjs:76-81`，`=` 分支同时进 lowers/uppers | `col != '2026-10-15'` 这类**非窗口**条件会让 span=0，把"无窗"误判成"有界短窗" → **漏报** HEAVY | 排除 `!=` / `<>`（只认 `=` 为等值） |
| P1-2 | 后端 | **`GROUP BY 1`（单个序号）误报 `GROUP_BY_SELECT_MISMATCH`**：`sql-lint-common.mjs:358`（`parts.length>1` 才返回 null）→ `364` 返回**空 Set（对象为真）**→ `214` 的 `gb ? … : []` 走真分支 → missing=全部 SELECT 裸列 | 合法 SQL 被误报"分组不一致" | `GROUP BY` 只含序号时返回 `null`（放弃判定，避免误报，与既有注释意图一致） |
| P1-3 | 后端 | **形态过滤把真正的外部专名也一起删掉**：`chat.ts:1142-1155`（snake/驼峰整词剔除） | 护栏实际只剩"纯小写英文单词"这一类在生效——**已知遗留 (a)(b) 的根因延伸**：贴 SQL、提技能名仍误伤；而 `Netflix` 这类真专名若写成 `Netflix_App` 也会被删 | 见方案 C（护栏降级为软提示）——**这条是"判据选错"的实证** |
| P1-4 | 后端 | `GENERIC_LATIN_TOKENS` 覆盖面不足：`chat.ts:1125-1131` 不含 `select/from/where/join/group/order/distinct/between/with/limit/having/business/query` | 已知遗留 (a)(b) 的直接成因 | 随方案 C 处理（不再依赖词表做准入） |
| P1-5 | 后端 | 自有业务护栏**硬编码 `mcp__bi__` server id**：`chat.ts:1112`、`1167`、代码桥 `2094-2096` | 换连接器命名即失效 | 改为常量/配置 |
| P1-6 | 后端 | `usedOwnBusiness` 只看"是否点名"不看"是否执行"：`chat.ts:2698`（`calls.some(startsWith)`），与 `2193-2195` 的 `ownBusinessExecuted` 不同源；`2631` 的 `afterInternalMiss` 依赖它 | **未执行的库被当成"查过了"** → 影响"外部检索"判据 | 改用 `ownBusinessExecuted` |
| P1-7 | 后端 | **专名闸被拦不计入 `ownBusinessRefused`**：`chat.ts:3433`（只对 `blocked` 生效，`nameBlocked` 不计）、并发路径 `2791-2796` 同；兜底条件在 `2645-2652` | 被专名闸拦下时**拿不到"技能闸重试"兜底** | 专名闸命中也置 `ownBusinessRefused=true` |
| P1-8 | 后端 | `repeatBudgetStop` 只存在于并发分支：`chat.ts:2764`（在 `executeOne` 内），串行路径 `3189-3457` 完全没有（`:3053` 明确"只有 1 个就走原路径"） | 串行重复调用无上限保护 | 串行路径补同一检查 |
| P1-9 | 后端 | 工具循环内部无 try/catch：`chat.ts` 2037-3620 区间（除 `:2579` 核验器）无任何 `try`；对比 `runSubagentBatch:3996-4021` 有 try/finally，**两处标准不一致** | 单调用异常会逃逸 `runLoop` | 主循环补 try/catch 兜底 |
| P1-10 | 后端 | **服务端重建 steps 时把"无工具结果"记成成功，并完全丢弃 `executed`**：`app.ts:587-596` | 页面刷新/续传后，「未执行」步骤会**回退成 ok/失败**，`executed` 信息全丢 | 重建时保留 `executed`，无结果记 `interrupted` 而非 ok |
| P1-11 | 后端 | **`execute_query(question_id)` 路径绕过 lint / SETTINGS / 只读校验**：`metabase-mcp.mjs:892-909`（直接 `POST /card/:id/query`，无 `assertSql`、无 `lintSql`、无 SETTINGS，且 `allRows` 全量取回后才 `slice`） | 现成卡片查询是**绕过全部资源护栏的后门**（全量取回再截断 = 内存风险） | 纳入同一校验链 + 结果上限 |
| 高-1 | 前端 | **子代理「出错/中断」圆点渲染成灰色**：`ChatPage.vue:4681` 返回 `"error"`，但 CSS 只有 `.mcp-dot.err`（`bubble.css:86`、`chat-page.css:3919`），**全仓库无 `.mcp-dot.error`** | 子代理失败/中断时红色语义**完全丢失**（回落半透明灰），且与步骤侧 `err` 命名不一致 | 统一返回 `"err"`，或两侧 CSS 补 `.mcp-dot.error` |
| 高-2 | 前端 | **`subagentDotClass` 把 `cancelled` 映射成 `ok`（绿点）**：`ChatPage.vue:4679-4683`（其余一律 return "ok"，含 done 与 cancelled） | 取消子代理后**绿点 + 「已取消」药丸**自相矛盾；`done` 也无显式分支 | 显式分支：`done→ok`、`cancelled→muted`、`error|interrupted→err` |
| 高-3 | 前端 | **`ChatPage.vue:1162` 第二份 `interface Bubble` 未收敛**（`chat-types.ts:23-93` 之外） | 改动②的目标**只完成一半**：给 `chat-types.Bubble` 加字段不会同步到页面侧，直到 provide/inject 签名漂移才炸（注释里警惕的风险原样保留） | 删除本地定义，改 import；`1202` 的行内 import 提到文件头 |
| 高-4 | 前端 | **`--warn` 主题变量根本不存在**：`styles.css:39-41` 定义了 `--danger/--success/--accent/--stop/--muted` 与 `*-soft`，**没有 `--warn` / `--warn-soft`**；4 处 `var(--warn,#b26a00)` 走硬编码（`bubble.css:93/241`、`chat-page.css:3262/3925`） | 深色主题下琥珀色对比度不足；「未执行」药丸无法沿用其它状态的 `*-soft` 方案 | `styles.css` 浅/深两套各补 `--warn` 与 `--warn-soft` |
| 高-5 | 前端 | **`.step.warn .step-status` 缺失**：`bubble.css:311-324` 只有 running/ok/err 三套药丸配色 | 「未执行」是**琥珀圆点 + 琥珀光环 + 灰色药丸**，与三态「圆点色+药丸色」双通道不一致，列表里不显眼 | 补 `.step.warn .step-status` 配色 |

---

## 三、P2 / 中低

| # | 维度 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | 后端 | 求源类护栏触发时**无日志/审计/usage 计数**（`chat.ts:2791-2798`、`3430-3437` 直接 continue；对比 verdict 分支 3222/3245/3266/3296 都有 `appendAudit`） | 补 `appendAudit` |
| P2-2 | 后端 | `alreadyHasSettings` 静默跳过整道资源护栏（`bi-query-settings.mjs:59-72`，调用点 `metabase-mcp.mjs:251`） | 记录/提示，或至少日志 |
| 中-6 | 前端 | 四个状态函数都是 if 链 + 兜底 return，**无编译期穷尽性**（`stepClass:4659` running 走兜底 → 未知状态渲染成"执行中"呼吸圆点） | 改 `Record<Status, X>` 常量表，缺键即编译失败 |
| 中-7 | 前端 | 同一「未执行」语义前端有**三套冲突写法**（确认卡拒绝→红「已拒绝」；超时→红「已拒绝」但文案"未执行"；票据失效→红「失败」；服务端 `executed:false`→琥珀「未执行」） | 统一：确实没执行 → `refused`；`cancelled` 只给显式用户拒绝 |
| 中-8 | 前端 | `chat-stream.ts:53` 内联 `SubagentStatus`（第二份）；`:13-45` 整段复制 Bubble 的 pending/clarification/usage | import 自 chat-types，用 `Pick<>` 组合 |
| 低-9 | 前端 | `refused` 缺 a11y 原因：按钮无 `title`/`aria-label`，原因锁在折叠 `<pre>`（`ChatBubble.vue:160-165`）里，读屏激活前听不到"为什么未执行" | 给 `.step-head` 加 `:title="stepSummary(step)"` |
| 低-10 | 前端 | `id="step-result-${step.id}"`（`ChatBubble.vue:163`）与展开键 `stepKey(b,step)=${b.id}::${step.id}`（`ChatPage.vue:1963`）**口径不一致** → 同 id 出现在两气泡时**重复 DOM id**，`aria-controls` 歧义 | 统一为 `step-result-${b.id}-${step.id}` |
| 低-11 | 前端 | `bubble.css` 有一批**永远命中不了的页面侧死规则**（`.conv-dot.*`、` .mcp-status.err/.running`、`.group-head` 等），且复制 `.mcp-status` 时漏了 `.ok` | 清理死规则；共享类加「需在 chat-page.css 同步」注释 |
| 低-12 | 前端 | 动画缺 `prefers-reduced-motion` 兜底（`bubble.css:96-99/1244-1301`）；`@keyframes mcp-pulse` 在两份 CSS 各一份，改一份会不一致 | 补 reduced-motion + 双向同步注释 |
| 中-5 | 测试 | 已知遗留⑤（贴 SQL / 技能名误伤）**无测试固化** | 随方案 C 一并加断言用例 |
| 中-10 | 测试 | `ownBusinessNameRefusal` 的**边界输入**无覆盖（`chat.ts:1160-1174`） | 补空串/纯中文/纯 SQL/技能名等用例 |
| 低-13 | 测试 | `checkCaliber` 硬拦（GUARDRAIL §7.1 所述 fail-closed）**全仓库无单测** | 补单测或文档降级说明 |
| 中-9 | 测试 | `sql-lint.test.ts:128` 用例名 `[K+]` 过时 | 改名对齐当前规则 |
| 低-11 | 文档 | GUARDRAIL 对 `MULTI_JOIN_UNBOUNDED` 的描述**窄于代码**（文档 L118/L155 写"≥2 JOIN 且**无时间窗**"） | 按代码校准 |
| 低-12 | 文档 | COMPARISON L187 风险警示章沿用 A 旧值「部分周 3.0 万」，而实测第 5 周为 **70,222**（同文档第五章已覆盖） | 统一为实测 |
| 低-14 | 文档 | COMPARISON 实测数字**未标注时点**（`endDate>=now()`、DAU 单日快照会随时间漂移） | 第五章表头标「截至 2026-10-17」 |
| 中-7 | 文档 | 三份文档**零交叉引用**（彼此是孤岛） | 互相加引用链接 |
| 中-8 | 文档 | GUARDRAIL §五「测试（已加）」三处计数**全部过时** | 校准 |
| 中-6 | 文档 | 方案 C 文档**未标注「待实施」状态**，回滚描述过粗 | 标注状态 + 细化回滚步骤 |

---

## 四、文档校准（本次实测权威值，供修正文档引用）

| 指标 | 实测值（截至 2026-10-17） | 备注 |
|---|---|---|
| 印度当前有效会员（uid 去重） | **741,999** | `endDate >= now()`，随日期漂移 |
| 巴西当前有效会员 | **28** | 体量极小 |
| 印度逐周首充新增 | **119,163 / 130,104 / 141,571 / 111,690 / 70,222** | 第 5 桶只含 10-12~10-16 |
| 印度逐周流失 | **78,897 / 90,681 / 98,087 / 119,466 / 86,018** | 同上 |
| 全渠道 DAU（10-15 单日） | **4,111,806** | `uniqExact(guid)` 设备口径 |
| "India/INGoogle 渠道名前缀"小计（10-15） | **2,395,218** | 与千问的 245 万口径吻合（渠道名口径，非国家维度） |

---

## 五、整改优先级建议

1. **先修"会打挂线上 / 会静默给错数"的**：P0-1（引擎判断 + 归一化）、P0-2（Code 115 自愈）、P0-3（静默截断）、P0-5（uniqExactIf 漏拦）。
2. **再补"护栏自身正确性"的**：P0-4、P1-1、P1-2、P1-11（卡片查询后门）、P1-10（重建丢 executed）。
3. **然后落地方案 C**（专名护栏降级为软提示）——它同时解决 P1-3、P1-4、P1-7 与已知遗留 (a)(b)。
4. **补测试**：严重-1（前端装 vitest + 3 条映射用例）、严重-2（executed 13 分支契约测试）。
5. **前端显示收尾**：高-1、高-2、高-3、高-4、高-5（子代理 error 类名、cancelled 绿点、Bubble 收敛、--warn 变量、warn 药丸）。
6. **文档校准**：严重-3、严重-4、中-6/7/8、低-11/12/14（统一实测值 + 交叉引用 + 待实施标注）。

---

*审查：3 个 code-explorer 子 agent 并行只读（2026-10-17），未修改任何文件；完整原始输出存于 tool-results（task-call_1bb29c16…、task-call_cdfd0404…）。前端与测试/文档两份清单已完整收录；后端清单完整（21 条，含 P0×5、P1×11、P2×2 及补充项）。*
