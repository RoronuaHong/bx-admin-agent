# 查库 / 查表 SQL 的写法最佳实践（bi / text2sql）

**定位**：本文是 `bi`（Metabase）这条取数通道上 **SQL 怎么写** 的权威口径。判据的实现落点是
`scripts/sql-lint-common.mjs`（静态体检）与 `scripts/sql-readonly-common.mjs`（能不能执行）。
其余文档与本文冲突时以本文为准。

**效力约定**：
1. 判据只依据 **SQL 语法与结构**（有没有 `WHERE` / `LIMIT` / `GROUP BY`、谓词列有没有被函数包裹……），
   **不含任何业务语义**——代码里不许出现业务词，这里也不举例真实业务。
2. **行号会漂移**，核对时先搜函数名（`lintSql` / `isReadOnlySql`）。
3. 本文所有示例都是**结构示例**（`sch.tbl` / `col_a`），不是可直接跑的查询。

---

## 1. 两道闸门，分工不能混

| 闸门 | 模块 | 回答的问题 | 处置 | 理由 |
|---|---|---|---|---|
| 只读闸门 | `sql-readonly-common.mjs` | **能不能执行** | **fail-closed**，不合规直接拒 | 安全问题，没有商量余地 |
| 写法体检 | `sql-lint-common.mjs` | **该不该这么写** | **fail-open**：照常执行 + 把「怎么改」回灌 | 效率与**正确性**问题，拦了会误杀 |

**为什么体检不拦**：体检若改成硬拒，第一个被误杀的就是「查这张表的时间范围 / 数据边界」——
这类探索语句本来就不该有 `WHERE`，一旦被拒，模型会绕路（换工具、编口径），
**比慢一点更糟**。体检的产出是**给模型看的可执行改法**，不是禁令。

> 依据：Anthropic《Writing effective tools for agents》——错误反馈应当**可操作**（告诉它怎么改），
> 而不是只当一个拒绝；OWASP LLM 相关的"fail-safe 但不阻塞"原则同理。

### 1.1 只读闸门必须管住「表值函数」（2026-10-15 审计补的高危缺口）

只读闸门原本只看**首词白名单 + 关键字黑名单 + 危险构造**。但列式引擎的**表值函数**
首词就是 `select`、也不含任何写操作关键字，**全部放行**——而它们的能力并不小：

| 函数 | 能力 | 风险 |
|---|---|---|
| `url()` / `urlCluster()` / `remote()` / `remoteSecure()` | 任意 HTTP / TCP 出网 | **SSRF**：可读云元数据凭据（`169.254.169.254`）、探测内网服务 |
| `file()` / `hdfs()` / `s3()` | 读服务器本地文件 / 对象存储 | `.env`、密钥、配置都在射程内 |
| `mysql()` / `postgresql()` / `mongodb()` / `redis()` / `odbc()` / `jdbc()` | 连任意其它数据源 | 绕过本库账号权限边界去读别处 |
| `executable()` | 旧版本可执行命令 | 命令执行 |

这些不是"写操作"，所以只读闸门原本**完全看不见它们**；但它们同样突破只读边界的意图
（只允许读本库数据）。现一律 fail-closed 拒绝，判据 `DENY_TABLE_FN_RE`。
刻意**不**拒 `values()` / `numbers()` / `input()`——它们只产生内联数据，不越界。

回归：`tests/sql-readonly-table-functions.test.ts` 5 例（含"列名里含 `file`/`url` 不误伤"
与"注释里的函数名不算"两组反向约束）。

---

## 2. 判据清单（20 条）

### 2.1 结果集有界类（最容易出事：跑得慢、结果不可控）

| 码 | 触发条件 | 后果 | 改法 |
|---|---|---|---|
| `NO_LIMIT_ROWS` | 明细形态（有 `FROM`、无聚合）且无 `LIMIT` | 行数由数据决定，回灌与渲染都不可控 | 加 `LIMIT`；只探结构就 `LIMIT 10~20` |
| `GROUP_BY_NO_LIMIT` | 有 `GROUP BY` 且无 `LIMIT` | 分组基数由数据决定，规模不可预期 | 加 `LIMIT`，并按需 `ORDER BY … DESC` 截断 |
| `SELECT_STAR_UNBOUNDED` | `SELECT *` 且无 `LIMIT n` | 宽表把无关大字段全拉进内存 | 只列需要的列；探结构也只取小 `LIMIT` |
| `DISTINCT_WITHOUT_LIMIT` | `SELECT DISTINCT` 且无 `LIMIT` | `DISTINCT` 需对全结果去重 | 先 `WHERE` 收窄，或加 `LIMIT` |

> 注意：本工具的 `limit` 参数是**拿到结果之后**才截断的，数据库已经把整条查询算完了。
> 所以**要减少数据库侧的代价，必须写进 SQL 的 `LIMIT`**。

### 2.2 扫描代价类

| 码 | 触发条件 | 后果 | 改法 |
|---|---|---|---|
| `NO_WHERE` | 有 `FROM` 且无 `WHERE` | 明细事实 = **全表扫描**，烧 IO、拖慢库 | 探数据边界可以接受，但要在回答里说明；否则加可分区裁剪的过滤 |
| `NON_SARGABLE_PREDICATE` | `WHERE` 里对列套了函数（`toDate(col)=…` / `lower(col)=…`） | 引擎无法据此跳过数据，退化为全扫；写法还**掩盖了真实范围** | 对裸列做范围比较：时间是 `col >= '起' AND col < '止'`（左闭右开）；字符串用 `LIKE '前缀%'` 或 `IN (…)` |
| `LIKE_LEADING_WILDCARD` | `LIKE '%…'` | 前导通配走不了跳数 / 主键索引 | 改前缀匹配 `LIKE 'x%'`，或 `IN` / 等值 |
| `DEEP_SUBQUERY_NESTING` | 括号嵌套 ≥ 3 层 | 可读性与优化器都受损 | 改用 CTE（`WITH … AS`）分层 |

### 2.3 正确性类（**跑得通但数是错的**——最难发现，因此最该拦在执行前）

| 码 | 触发条件 | 后果 | 改法 |
|---|---|---|---|
| `GROUP_BY_SELECT_MISMATCH` | `SELECT` 里的裸列既不在 `GROUP BY`、也不在聚合函数里 | 分组后取值任意：严格模式报错，**宽松模式静默给错值** | 加进 `GROUP BY`，或用聚合函数包起来 |
| `JOIN_WITHOUT_ON` | 有 `JOIN` 但无 `ON` | 笛卡尔积，行数相乘 | 补 `ON` |
| `IMPLICIT_CROSS_JOIN` | `FROM a, b`（逗号并列） | 隐式笛卡尔积，连 `JOIN` 都没有，最容易漏看 | 改成带 `ON` 的显式 `JOIN` |
| `JOIN_DANGLING_REF` | `JOIN ... ON` 里点号前缀指向未在 `FROM`/`JOIN`/`WITH`/派生表声明的表或别名 | 幻觉拼表：执行期才报 Unknown table，提前核对表名/别名是否真实存在（advisory，不阻断） | 核对表名/别名是否拼错，或漏写某个 JOIN 的表 |

### 2.4 引擎实践类

| 码 | 触发条件 | 改法 |
|---|---|---|
| `COUNT_DISTINCT` | `count(DISTINCT x)` | 列式引擎上退化为全量去重；改用 `uniqExact(x)`（精确）或 `uniq(x)`（近似） |
| `SHOW_CREATE_TABLE` | `SHOW CREATE TABLE` | 会输出建表 DDL（含引擎参数、分区键等实现细节）。查结构用 `DESCRIBE <table>` 或元数据接口 |

### 2.5 资源类（重聚合 / 多表 JOIN 的内存与扫描代价，advisory 不阻断）

判据只用 SQL 结构（是否精确去重、是否带时间窗、JOIN 数量、GROUP BY 维度），不含业务语义；提示不阻断执行，对齐 OWASP LLM05:2025（把模型生成的 SQL 当不可信输入，下发数据库前做结构校验）。

| 码 | 触发条件 | 后果 | 改法 |
|---|---|---|---|
| `DEVICE_LEVEL_COUNT` | 用 `guid`（设备）做去重/计数（`uniqExact(guid)` / `count(guid)`） | 设备级宽表一号多机，按 guid 统计「用户/会员/日活人数」会系统性虚高（实测约 1.6 倍） | 统计用户/会员人数请绑定去重到账号（`uniqExact(uid)`）；若确实要统计设备数，可忽略本条 |
| `HEAVY_EXACT_AGG_NOWINDOW` | `uniqExact(...)`（精确去重）出现在「无时间窗」或「窗口 ≥ 阈值天」的查询里 | 精确去重为每行维护去重状态，内存随去重基数线性增长，全历史宽表上极易撞服务端内存上限 | 只要趋势/看板类指标改近似 `uniq()`（误差约 1~2%）；必须精确则先收窄时间窗（1~3 天跑通再放大）或用已聚合表/现成卡片 |
| `MULTI_JOIN_UNBOUNDED` | ≥ 2 个 `JOIN` 且整条查询没有时间窗过滤 | 每个 JOIN 放大扫描量，无范围过滤时整条链路退化为全扫 | 先对每张表在子查询里各自过滤（缩时间窗/加条件）再 JOIN，小表放 JOIN 右侧（哈希表更小） |
| `GROUP_BY_HIGH_DIM_NOLIMIT` | `GROUP BY` 维度 ≥ 3 且带 `ORDER BY` 但没有 `LIMIT` | 高维分组中间状态规模由数据决定、不可控，ORDER BY 聚合列时易一次性拉满 | 加 `LIMIT` 截断（配合 `ORDER BY ... DESC` 取头部），或先降维到核心维度再逐步展开 |

### 2.6 敏感列提示（CLS，advisory / fail-open）

| 码 | 触发条件 | 改法 |
|---|---|---|
| `SENSITIVE_COLUMN` | SQL 里出现疑似敏感列形态（个人信息类，如 `email` / `phone` / `id_card` / `银行卡`） | advisory：不阻断执行，只提示确认输出已脱敏 / 已授权 / 仅做聚合统计不返回明细；明文泄露个人信息是真实风险 |

> 这是**列级安全（CLS）**的轻量落地：只做列名**形态**匹配、不含业务语义、零业务词，与「结果是 advisory 不阻断」一致。
> 直接硬拒会误杀合理的聚合统计（例如「按邮箱域名计数」）；真要硬拒应在**数据库层只读角色**做列黑名单（见 plan §三-P0.1），本判据只负责把风险回灌给模型。
> 元数据查询（`system.columns` 等）豁免，避免「按列名扫全集群」时误报。

### 2.7 语法合法性类（fail-open 提示）

| 码 | 触发条件 | 后果 | 改法 |
|---|---|---|---|
| `UNQUOTED_STRING_LITERAL` | `IN (...)` 列表项或比较 RHS 出现裸非 ASCII 标识符（如 `movieType IN (电影, 电视剧)`、`country = 中国`）；本系统列名/别名均为 ASCII，裸中文几乎必然漏加引号 | ClickHouse 把裸中文当标识符或语法错误处理（Code 62），整条查询 400 | 字符串值必须用单引号包裹：`movieType IN ('电影', '电视剧')`、`country = '中国'`；补上引号后重试 |

> fail-open（提示不阻断）：对齐 OWASP LLM05:2025 Improper Output Handling——把模型生成的 SQL 当成不可信输入，下发数据库前做结构校验，而非直接透传。

### 2.8 明确**不适用**行级规则的语句

`SHOW TABLES` / `DESCRIBE` / `EXPLAIN` / `system.tables` / `system.columns` 这类**元数据与会话语句**
结果集天然有界或极小，**不能**要求它们带 `WHERE` / `LIMIT`，也不对 `SELECT *`、`SELECT DISTINCT`（不加 LIMIT）报结果集有界类规则
（§2.1/§2.2 行级规则统一豁免，含 `SELECT_STAR_UNBOUNDED` / `DISTINCT_WITHOUT_LIMIT`）——否则会大量误杀。
但 2.4 的引擎实践规则对它们**仍然生效**。

---

## 3. 审计结果（2026-10-15 实测，9 轮复跑共 30 条模型自写 SQL）

| 判据 | 命中 | 性质 |
|---|---|---|
| `NO_WHERE` | **14 / 30** | 主要问题：全表扫描 |
| `GROUP_BY_NO_LIMIT` | **7 / 30** | 结果集不可控 |
| `NO_LIMIT_ROWS` | 1 / 30 | 同上 |
| `NON_SARGABLE_PREDICATE` | 0 | 预防项，模型本来就写对了 |
| `GROUP_BY_SELECT_MISMATCH` | 0 | 同上 |
| `IMPLICIT_CROSS_JOIN` | 0 | 同上 |
| `DEEP_SUBQUERY_NESTING` | 0 | 同上 |
| `DISTINCT_WITHOUT_LIMIT` | 0 | 同上 |
| `COUNT_DISTINCT` / `LIKE_LEADING_WILDCARD` / `SHOW_CREATE_TABLE` / `JOIN_WITHOUT_ON` | 0 | 同上 |

**结论要诚实说清楚两件事**：

1. **模型不是不会写，是没人告诉它判据**。前 3 类都不是「错」而是「不稳」——单条能跑完，
   量一上来就出事。把判据做成可执行提示回灌，是唯一不靠运气的做法。
2. **正确性类判据在真实样本上 0 命中**。它们是**预防**（防未来模型退化），不是修当前问题。
   不要拿「补了 6 条规则」当成修了 6 个缺陷——其中只有 3 类在实测里真的命中过。

复跑审计（对任意批次产物重新体检）：

```
node scripts/_audit-bi-sql.mjs
```

> 局限：复跑产物里记录的 SQL 参数**被截断到 300 字符**，超长 SQL 的问题会被低估。
> 要精确统计需提高 `_bi-replay.mjs` 里的 `argsPreview` 上限。

---

## 4. 两个实现坑（都是测试当场抓出来的，值得留档）

1. **判据不能只跑在「剥掉字符串字面量」的文本上**。
   初版复用了只读判定那套脱引号逻辑，结果 `LIKE '%x%'` 的**模式就住在字面量里**，被剥掉后
   `LIKE_LEADING_WILDCARD` 这条规则**形同虚设**。现在另保留一条「只去注释、保留字面量」的文本，
   专供 `LIKE` 判定。

2. **`GROUP BY 1,2` 是合法的序号写法**。初版按列名比对，把序号分组误报成
   `GROUP_BY_SELECT_MISMATCH`。现在识别到全序号分组就**放弃判定**（返回"不可判"）而不是误报。

> 两条都写进了 `tests/sql-lint.test.ts` 的**反向约束**用例——判据本身也要被体检。

---

## 5. 落点与回归

| 落点 | 说明 |
|---|---|
| `scripts/sql-lint-common.mjs` | 20 条判据的**唯一实现**（共享单源，适配器与后续服务端复用同一份） |
| `scripts/metabase-mcp.mjs` · `runSql` | 执行类入口统一回灌体检结论（`run_native_query` / `execute_sql` / `query` 的 SQL 分支共用） |
| `scripts/metabase-mcp.mjs` · `construct_query` | **执行前**就给出体检结论——「先确认口径再执行」这一环 |
| `tests/sql-lint.test.ts` | 25 例，覆盖每条判据 + 两组反向约束（不误伤、fail-open） |
| `scripts/_audit-bi-sql.mjs` | 对复跑产物重新体检的审计脚本 |

## 6. 评测集（这个实例在不在里面）

**已加入。** `apps/agent-server/tests/fixtures/text2sql-bi-cases.json` —— 6 个 case，
全部按本文判据固化，且**零业务词**（国家线/指标/维度/归因目标一律占位化）。

| case | 对应本轮发现 | 承载测试 |
|---|---|---|
| `reuse-saved-question-instead-of-rewriting-its-sql` | 读定义 17 次却 0 次执行现成提问 | `bi-tool-ergonomics` [N][O] |
| `offloaded-results-must-not-be-read-back-one-by-one` | 卸载 100 条 → `fs_read` 捞回 48 次 | `context-budget` [1c][1d] |
| `partial-unanswerable-needs-evidence-and-full-coverage` | 探 5 张表就收尾 / 措辞许可化后连续两轮退化 | `bi-tool-ergonomics` [O] |
| `sql-must-be-bounded-and-sargable` | 30 条 SQL 审计：NO_WHERE 14 / GROUP_BY_NO_LIMIT 7 | `sql-lint` [A][H][K+] |
| `upstream-outage-is-not-data-absence` | 整轮 502 被误当模型能力问题 | `bi-tool-ergonomics` [Q] |
| `code-tool-language-mismatch-feedback-must-be-actionable` | 每轮白费 4~11 次调用 | `tool-code-language` [A][C] |

**fixture 不腐化**（关键）：`tests/text2sql-eval-fixture.test.ts` 校验每个 case 的 `boundTests`
指向的测试**真实存在**，并执行 fixture 自己声明的零业务词自检。有人删了或改名了那条测试，
这个门禁立刻红。

> **这是从反面样本学的**：仓库已有的 `stall-incident-cases.json` 写了 10 个 case、每条都有
> assertions，但**全仓零代码引用**，只有文档提到它——这类 fixture 的断言不会随代码退化而失败，
> 等于没有回归价值。本文件用"绑定必须存在"把它变成承重结构。

### 仍然缺的（诚实记录）

现有 L3 在线评测的 8 个维度（`converged` / `grounded` / `rounds` / `tokens` / `latency` /
`stability` / `correction` / `classifier_health`）**全是过程量，没有任何"任务覆盖度"维度**。
所以「跑得动但答不全」这类失败在自动评测里仍然不可见——本文件是 L0/L1 层的定性和结构断言，
L3 层要真正覆盖需要一条可确定性计算的覆盖度指标（例如"声明过的子问题中有几个有交代"），
这需要先让模型把子问题列表结构化输出，属于独立立项。