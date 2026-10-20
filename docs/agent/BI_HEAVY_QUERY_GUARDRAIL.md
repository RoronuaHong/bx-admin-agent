# BI 重查询击穿 Metabase/ClickHouse：事故复盘与防线方案

> 日期：2026-10-16 · 状态：**实施中（P1/P2 已落地并加单测，P0 待 DBA 执行）**
> 证据来源：ClickHouse `system.query_log`（只读拉取；排查用的临时脚本 `_bi-querylog-pull.mjs` / `_bi-qlog2.mjs` 等为一次性工具，排查完已清理，不在仓库内）
> 对齐资料：ClickHouse 官方 KB《Memory limit exceeded for query》、Metabase 官方文档《ClickHouse 连接》、ClickHouse settings/quotas 官方文档

---

## 一、事故复盘（query_log 实证）

今天（2026-10-16）由 **Agent 经 Metabase**（`user=metabase_user`，native 查询自带 `-- Metabase:: userID: 13371351` 指纹）触发的异常与重查询：

| 时间 | 结果 | 内存 | 读行数 | SQL 形态（归一化） |
|---|---|---|---|---|
| 07:04:51 | **Code 241 内存爆顶**（would use 28.08 GiB，上限 27.68 GiB，OvercommitTracker 选定杀掉） | 28G+ | 286 亿行 / 501GB | `uniqExact(guid) FROM elt_user_full_history WHERE recordDate>='2026-10-09' GROUP BY recordDate,countryCode`（即用户截图那条） |
| 07:06:04 | **Code 241**（would use 29.34 GiB）同一条重试 | — | 270 亿行 | 同上 |
| 09:37:05 | **Code 241**（would use 28.05 GiB） | 7.9G 已用 | 1.5 亿行 | `argMax(rechargeType…) OVER elt_user_vip_info JOIN` 流失查询 |
| 05:55 / 06:01 / 08:12 / 10:28 / 11:00 / 13:39 | Code 394（60s 被 Metabase 客户端取消） | **3.9 / 21.6 / 21.1 / 5.5 / 13.2 / 18.5 GB** | 最高 115 亿行 | `uniqExactIf(dau30…)`、`elt_active_guid JOIN elt_user_full(_history)`、`WITH dateRange` 重 JOIN 等 |
| 13:50–13:57 | 全部**成功**但巨内存：20.4GB/33s、20.6GB/40s、17.8GB/61s、14.2GB、14.1GB、3.7/3.0/2.5/2.4GB×4 | — | 2 亿行级 | 同一会话连续 10+ 条 `uniqExact`/`countIf` 跨 30 天聚合（avg_30d / dau30 / 逐渠道 / 流失分层） |

**对照组（说明"只有 metabase_user 在裸奔"）：**
- `film_test`（mcp_clickhouse，Python MCP）：已被 DBA 限了读取上限 → `Code 307 Limit for rows or bytes to read exceeded, max bytes: 256.00 MiB`（防线存在且有效）。
- `default`（业务 JVM，JDBC）：10 万+ 查询/天，单条最大 5.8GB——是正常业务流量；但今天 13:54–14:55 有一个**逐 ugId 循环连发 263 条** `uniq(a.guid)…WHERE a.ugId=N` 的模式，每条 ~2.3GB（非本 Agent，是业务侧自己的循环，与 Agent 同为反面教材）。
- DBeaver（人工）：个位数条数。

**根因链：**
1. **R1 SQL 形态本身重**：`uniqExact`（精确基数，内存 ∝ 去重值数 × 线程数）打在高基数 guid 上 + 全历史设备级宽表 / 亿级大表互 JOIN + 跨 30 天窗口 + 无预聚合。
2. **R2 metabase_user 无资源边界**：`Memory limit (total) … maximum: 27.68 GiB` = 整机内存口径，与业务流量共享；无 `max_execution_time`（394 全是 Metabase 侧 60s 客户端超时，不是服务端掐的）、无读取行/字节上限、无并发/配额。
3. **R3 "假超时"**：适配器客户端 abort 只是"不再等"，SQL 在 DB 上继续跑（`metabase-mcp.mjs` 头注释自知此局限）→ 多条 20GB 级查询即使"失败"也在 DB 上占内存直到结束。
4. **R4 Agent 行为放大**：一个会话在 13:50–13:57 连发 10+ 条重聚合反复换口径重试；现有"总调用预算"只限工具调用次数，**不锁单条 SQL 的资源成本**。
5. **R5 现有 lint 只管口径不管资源**：`DEVICE_LEVEL_COUNT`（guid 设备级告警）是 advisory 且只针对"口径错"，对"合法口径但资源爆炸"（如 `uniqExact(uid)` 全表 30 天）无任何提示。

---

## 二、最佳实践对齐（出处见文首链接）

1. **ClickHouse 官方 KB**：内存超限最常见原因就是"高基数上的大 JOIN / 大聚合"。优先级：
   - 能改写查询就改写：缩时间窗、降基数、预聚合、小表放 JOIN 右侧；
   - 聚合内存超阈值落盘：`max_bytes_before_external_group_by`（建议设为低于 `max_memory_usage`，给哈希表留余量）；
   - 排序落盘：`max_bytes_before_external_sort`（`GROUP BY … ORDER BY … LIMIT` 场景尤其需要）；
   - JOIN 算法：`join_algorithm='auto'`（hash 优先、超内存自动降级 partial_merge）。
2. **`uniqExact` vs `uniq`**：官方文档明确 `uniqExact` 对高基数列内存消耗大；`uniq`（自适应采样近似）内存 O(1) 级，误差约 1–2%。**趋势/看板类指标可用 `uniq`，对账/结算类才必须 `uniqExact`**——这是"口径是否允许近似"的业务判断，必须交用户/技能规则声明，不能由 Agent 默认替用户选精确口径然后炸库。
3. **按账号设边界（settings/profile/quota）**：`max_memory_usage`（单查询内存上限，超限快速失败而不是拖垮整机）、`max_execution_time`（服务端执行超时）、`max_result_rows` + `result_overflow_mode='break'`（结果集上限）、`max_bytes_to_read`（扫描上限）、QUOTA（周期内累计资源配额）。`film_test` 账号已证明此路有效。
4. **Metabase 官方（ClickHouse 连接文档）**：
   - 连接配置的 **"ClickHouse settings"** 字段（逗号分隔）可直接下发服务端设置，官方示例就是 `max_result_rows=100`；JDBC 串用 `clickhouse_setting_` 前缀（如 `clickhouse_setting_max_execution_time=300`）；
   - **没有按库分别设参的功能**，不同限制需**拆分多账号/多连接**；
   - 库慢时应关闭 "Re-run queries for simple explorations"、慎开 "Periodically refingerprint tables"（都会放大负载）。
5. **错误反馈要可操作**（Anthropic《Writing effective tools》同款原则）：Code 241 的回复应引导"改用近似计数/缩窗/预聚合/降维度"，而不是只把异常文本抛给模型。

---

## 三、方案（分层，P0 可立即由 DBA 执行，P1/P2 需改我们代码——均待确认）

### P0 · DB 层防线（DBA 执行，不依赖我们发版，今天即可上）
给 `metabase_user` 建独立 settings profile。**阈值推导**：整机可见上限 **27.68 GiB**（事故当日 `would use 28–29.3 GiB` 即撞到它）；单查询 cap 取 **8 GiB ≈ 29% 整机**——既留"超阈值秒级快速失败（Code 241）"信号，又给并发留余量；聚合落盘 4GiB 必须 **< 8GiB**（给哈希表留余量）。一周后按 `system.query_log` 的 `memory_usage` P95 回头固化。两种方式：

```sql
ALTER USER metabase_user SETTINGS
  max_memory_usage                          = 8589934592,  -- 单查询 8GB：快速失败，不与业务共享整机 27.68G
  max_execution_time                        = 120,          -- 服务端执行超时（秒），掐掉"假超时"残留
  max_bytes_before_external_group_by        = 4000000000,   -- 聚合超 4GB 落盘（必须 < max_memory_usage）
  max_bytes_before_external_sort            = 4000000000,   -- 排序同理
  max_result_rows                           = 1000000,
  result_overflow_mode                      = 'break';      -- 结果超限截断而非报错（看板场景）
-- 可选：QUOTA（小时级累计执行时间/查询数），防逐 ID 连发循环
```

**方式 B（更可维护，可复用 / 可叠加到既有 profile）**——方式 A（上方程 `ALTER USER … SETTINGS`）已对新会话立即生效；方式 B 建独立 profile 再挂给账号，便于复用与审计：

```sql
CREATE SETTINGS PROFILE IF NOT EXISTS bi_heavy_guard
  SETTINGS
    max_memory_usage                   = 8589934592,
    max_execution_time                 = 120,
    max_bytes_before_external_group_by = 4000000000,
    max_bytes_before_external_sort     = 4000000000,
    join_algorithm                     = 'auto',
    max_threads                        = 16,
    max_result_rows                    = 1000000,
    result_overflow_mode               = 'break';

ALTER USER metabase_user SETTINGS PROFILE bi_heavy_guard;
```

> 先 `SHOW CREATE USER metabase_user` 确认当前 profile/settings，方式 B 会整体替换默认 profile，别冲掉既有必须项；也可在 `ALTER USER … SETTINGS` 里直接补 `join_algorithm='auto', max_threads=16`（与方式 A 等价，不必建 profile）。

同时在 Metabase 该库连接配置的 **"ClickHouse settings"** 字段加同一组值作为第二道保险（官方文档支持），逗号分隔：

```
max_memory_usage=8589934592,max_execution_time=120,max_bytes_before_external_group_by=4000000000,max_bytes_before_external_sort=4000000000
```

**刻意不设** `max_bytes_to_read`：Agent 合法查询有读 6.8GB 字节的先例，行/字节上限会误杀；内存+时长已足够兜底。`result_overflow_mode` 现在默认 `'throw'`（fail-loud：超限报错而非给半截数据，避免静默给错数）；若该账号还被人类用于看板需要静默截断，运维显式设 `BI_CH_RESULT_OVERFLOW_MODE=break` 还原旧行为。

预期效果：07:04 那条查询会在 8GB 处 1~2 秒内报 Code 241 快速失败（而不是吃到 28GB 挤爆整机），OvercommitTracker 不再需要"选杀"，业务流量（default 用户）不再被连坐。P0 是真正硬边界，P1 是双保险；**任何一层生效即可**。

**验证（上线后）**：

```sql
-- 1) 重放事故 SQL，应在秒级收到 Code 241（卡在 8GB），而非吃到 28GB
SELECT uniqExact(guid) FROM elt_user_full_history GROUP BY recordDate, countryCode;

-- 2) 观察 metabase_user 的单查询内存上界是否降到 8G 内
SELECT max(memory_usage) FROM system.query_log
WHERE user = 'metabase_user' AND event_time > now() - INTERVAL 1 DAY;

-- 3) default（业务）流量不受影响：同窗口内该用户 memory_usage 应无尖峰
```

### P1 · 适配器层（`metabase-mcp.mjs`，改动小）
1. **执行前追加查询级 SETTINGS**：`runSql` 对 native query 剥掉尾部分号后追加 `SETTINGS max_execution_time=…, max_bytes_before_external_group_by=…`（env 可配、默认与 P0 对齐；已有 SETTINGS 子句则合并）。这样即使 DBA 还没做 P0，我们自己的查询也自带边界——**双保险，任何一层生效即可**。
2. **Code 241/307/394 专属可操作文案**：按"改用近似计数 / 缩窗 / 预聚合 / 降维度 / 拆分查询"给出下一步（现有超时文案已是这个风格，补齐内存超限分支）。
3. 维持只读闸门与现有 lint 回灌不变。

### P2 · SQL 体检强化（`sql-lint`，通用、零业务词）+ SKILL
1. 新增**资源类 lint**（advisory，与口径告警同风格）：
   - `uniqExact(…)`/`count(distinct …)` 且**无时间窗 WHERE** 或时间窗 ≥ N 天（默认 14）→ 提示"确认口径可否用近似 `uniq`，或缩窗/预聚合"；
   - 同一 SQL 出现 ≥2 个大表 JOIN 且副查询无范围过滤 → 提示"先过滤再 JOIN / 检查 JOIN 顺序（小表在右）"；
   - `GROUP BY` 维度 ≥3 且 `ORDER BY` 聚合列但无 `LIMIT` → 提示补 LIMIT。
2. `skills/business-data-query/SKILL.md` 增补"资源纪律"节：先小范围探量级再放大；趋势类优先 `uniq`（近似）并在回答中注明是近似值，对账类才用 `uniqExact`；**逐 ID 循环取数必须改写成单条 `GROUP BY … IN (…)`**（今天业务侧 263 连发是现成反面教材）。
3. 该 lint 是提示不是拦截（fail-open）——真正硬边界在 P0/P1 的资源设置上，两层互补。

### 验收
1. P0 上线后重放 07:04 那条 SQL → 应在秒级收到 Code 241（8GB 阈值），整机内存无抖动，default 业务流量不受影响；
2. Agent 对同类问题改走 `uniq`/缩窗/预聚合路径，`system.query_log` 中 metabase_user 的 `max(memory_usage)` 显著下降（目标 <2GB P95）；
3. 单测：sql-lint 资源类正反用例；metabase-mcp SETTINGS 追加与 241 文案用例。

### 边界与不做
- 适配器层**不改写 SQL**（改写=替模型猜口径，违反红线）；只提示 + 资源边界硬拦。
- 近似口径（`uniq`）必须由 SKILL 规则/用户确认背书，文档已写明"何时可用近似"。
- default 用户（业务 JVM）的 263 连发循环不属于本系统，建议 DBA 另行治理（QUOTA/查询队列），仅在此记录。

---

## 四、执行顺序建议
1. **今天**：DBA 执行 P0（风险最低、收益最大，不等发版）；
2. ~~确认后我做 P1 + P2 代码与测试~~ **已完成（2026-10-16）**：见第五节；
3. 一周后复查 `query_log`（metabase_user 的内存 P95 / 异常数）固化阈值。

---

## 五、实施记录（2026-10-16）

### P1 · 适配器层（已落地）
- 新增 `scripts/bi-query-settings.mjs`（纯函数、零副作用，可单测）：
  - `appendClickHouseSettings(sql, settings)`：执行前在 SQL 末尾追加 `SETTINGS max_execution_time / max_bytes_before_external_group_by / max_bytes_before_external_sort`；**不改写 SQL 语义**（原 SQL 仍用于回显与静态体检，只有发往 ClickHouse 的那份带 SETTINGS）；已有 SETTINGS 不重复追加、剥尾部分号、以换行隔离行尾注释。
  - `classifyUpstreamError(text)`：识别 241 内存 / 307 扫描上限 / 394 超时，翻译成「降基数 / 缩窗 / 预聚合 / 降维度」可操作提示。
  - `defaultClickHouseSettings(env)`：阈值从环境变量读（默认 `BI_CH_MAX_EXECUTION_TIME=90`、落盘 4GB），与 P0 对齐且略保守。
- `metabase-mcp.mjs` 的 `runSql`：执行 SQL 改用 `appendClickHouseSettings(check.sql, …)`；上游拒绝（含 200 包错误）时接 `classifyUpstreamError` 给出资源类文案。
- **生效条件**：BI MCP 是 agent-server 拉起的子进程，改完需重载该 MCP（重启 agent-server 或重载对应 MCP 服务器）才会生效。

### P2 · SQL 体检 + SKILL（已落地）
- `scripts/sql-lint-common.mjs` 新增三条资源类规则（advisory、零业务词、不改写）：
  1. `HEAVY_EXACT_AGG_NOWINDOW`：`uniqExact(...)` 出现在无时间窗 / 窗口 ≥14 天的查询 → 提示改用近似 `uniq()` 或缩窗/预聚合；
  2. `MULTI_JOIN_UNBOUNDED`：≥2 个 JOIN 且整条无时间窗 → 提示先各自过滤再 JOIN、小表放右侧；
  3. `GROUP_BY_HIGH_DIM_NOLIMIT`：`GROUP BY` 维度 ≥3 且带 `ORDER BY` 无 `LIMIT` → 提示加 `LIMIT`。
  - 时间窗判定修过一次坑：`stripNoise` 会把日期字面量抹空，导致短窗口误判成「无窗」；改为在只去注释的文本上判定。
- `skills/business-data-query/SKILL.md` 新增「资源纪律」节；`docs/bi-sql-best-practices.md` 重建后，SKILL.md 的 SQL 写法引用已指回该权威文件（本文件不再作为 SQL 写法唯一入口）。

### 测试（已加）
- `tests/bi-query-settings.test.ts`（7 例，含本次新增 `[S7]` 字符串值引号 + `[S4]` 扩展覆盖结果集/超时/成本字段）：SETTINGS 追加/去重/剥离/环境变量、错误分类。
- `tests/sql-lint.test.ts` 新增 `[O][P][Q]` 三条资源类回归，并把三码补进 `[K+]` 全码覆盖清单。
- 两个文件合计 30 用例全绿；`read_lints` 对改动文件 0 错误。

### P1 补充（2026-10-16 续）：SETTINGS 双保险补齐 + 查询前成本硬拦（我们自己做，不涉及 DBA）

- `defaultClickHouseSettings` 在原有 `max_execution_time` + 聚合/排序落盘两项基础上补齐（全部 env 可配，与 P0 profile 对齐且略保守）：
  - `max_result_rows = 1_000_000` + `result_overflow_mode = 'break'` —— 结果集超阈截断，治"结果物化成本"（P0 未做时 P1 兜底；`runSql` 的 `limit=200` 只是展示层 slice，ClickHouse 仍算全量，故此条关键）。
  - `timeout_overflow_mode = 'throw'` —— 超 `max_execution_time` 直接中断，显式写出更稳。
  - `max_estimated_execution_time`（env `BI_CH_MAX_ESTIMATED_TIME`，默认 `0`=关闭）—— 查询前基于规划估算执行时间的硬拦，超过则**执行前直接拒绝**，不先跑再爆（对应文档 6.5.1）。**注意**：ClickHouse 24.2 没有 `max_estimated_execution_cost`（会 UNKNOWN_SETTING 致整条查询 400），故改用内建的 `max_estimated_execution_time`（基于成本估算的执行时间上限，单位秒）；默认关闭以避免误杀合法大查询，由运维/DBA 按经验开启保守阈值。
- `appendClickHouseSettings` 字符串值（如 `result_overflow_mode='break'`）自动加单引号，避免 SQL 语法非法；数字值不加引号，保持原行为。
- **仍不做** DBA 侧 P0（profile / QUOTA / `max_concurrent_queries_for_user` / 只读副本 / Metabase 超时对齐）—— 那些由平台/DBA 负责，见第六节的 6.1–6.4。

### 仍待办
- **P0（DBA）**：给 `metabase_user` 建 profile（`max_memory_usage=8G` 等）。这是真正的硬边界，P1 是双保险；任何一层生效即可。
- 一周后复查 `system.query_log` 固化阈值（见第四节第 3 步）。

---

## 六、联网复核补充（2026-10-16）：最新最佳实践与待补强项

复盘当日又对照了 ClickHouse 官方文档（`query-complexity` / `permissions_for_queries` / `settings`）、Metabase ClickHouse 连接文档，以及 2026 年 AI Agent 数据库安全/护栏的实践文章，整理出以下**当前方案尚未覆盖或覆盖不足**的点，按优先级列出。

### 6.1 最关键的缺口：Metabase 客户端超时 vs 服务端超时未对齐（R3「假超时」未真正根治）

- **事实**：Metabase 应用层对原生查询有**自己的超时（默认约 60s，对应 HTTP `--timeout`，社区经验 60s/120s 两档）**。事故里所有 Code 394 都是这个 60s 客户端取消触发的，不是服务端掐的。
- **当前设定**：我们的 `SETTINGS max_execution_time=90`（代码）/ `120`（P0 profile），都**大于** Metabase 60s 客户端超时。
- **后果**：客户端 60s 先断 → 模型收到"超时"，但 SQL 在 ClickHouse 上**继续跑到 90s/120s 才被服务端砍**——中间 30~60s 那条重查询仍在占内存（正是 R3 描述的"假超时"）。`max_execution_time` 只治了服务端，没治客户端。
- **修复（二选一，必须对齐）**：
  1. **调高 Metabase 连接超时**到 ≥ 服务端 `max_execution_time`（如 Metabase 设 130s，服务端 120s）——服务端能先于此砍断，客户端不再"白等后取消"；
  2. 或**把服务端 `max_execution_time` 压到 ≤ Metabase 超时**（如 50s）——但会牺牲部分合法慢查询。
- **同步要点**（多个来源一致）：JDBC/HTTP 的 `socket_timeout` 必须 ≥ `max_execution_time`，否则客户端先断、服务端还在跑，现象同上。当前走 Metabase HTTP 适配器，重点在 Metabase 连接配置里的 timeout 项。**这条不做，R3 假超时就治不干净。**

### 6.2 服务端累计限流：QUOTA（治 R4 连发叠加的最强手段）

当前 P0 仅在注释里写了"可选 QUOTA"。但 R4 的根因是"一个会话连发 10+ 条重聚合"、以及业务侧"逐 ID 循环 263 连发"——这些是**累计**资源消耗，单查询的 `max_memory_usage` 管不到。ClickHouse `QUOTA` 按 user/时间窗口累计限制，正好堵这个口子：

```sql
CREATE QUOTA IF NOT EXISTS bi_heavy_quota
  KEYED BY user_name
  FOR INTERVAL 1 HOUR
    MAX query_time            = 1800,            -- 该账号每小时累计执行时长上限（秒）
    MAX memory_usage          = 100000000000,    -- 每小时累计内存（字节，约 93GB）
    MAX queries               = 500,            -- 每小时查询数上限
    MAX read_rows             = 500000000000,
    MAX errors                = 50              -- 防"反复重试同一爆库查询"刷屏
  TO metabase_user;
```

- 也可 `KEYED BY client_key` / `ip` 细分；`errors` 上限能拦住"重试同一爆库 SQL"的死循环。
- 配合 P0 profile 的 `max_memory_usage`（单查询硬上限）形成"单查询硬上限 + 周期累计软上限"双层。

### 6.3 并发限制：max_concurrent_queries_for_user（治并发叠加）

R4 还有"并发"维度：即使每条都 <8GB，5 条并发各跑 80s 仍叠加挤占。`max_concurrent_queries`（全局）和 `max_concurrent_queries_for_user` 可在服务端限制单账号并发：

```sql
-- 挂到 bi_heavy_guard profile，或 ALTER USER metabase_user SETTINGS 补
max_concurrent_queries_for_user = 4;  -- metabase_user 同时最多 4 条查询
```

### 6.4 基础设施层：BI/分析路由到只读副本（治"重查询压主库"）

2026 年 AI Agent 数据库安全实践普遍强调**读写分离**：把分析/BI 类重查询指向只读副本而非主库，主库只承接业务写入与低延迟读。若 `metabase_user` 当前直连主库，重查询会和业务写入抢资源（`default` 用户 10 万+/天 已是常态流量）。建议 DBA 把 Metabase 的 ClickHouse 连接指向**只读副本/读负载均衡**，与业务主库隔离。

### 6.5 Agent 侧护栏模式（2026 最新，补 R4 的"反复换口径"）

仅服务端限流不够，Agent 自身也应加护栏，从源头减少重查询：

1. **查询成本预估（fail-closed 前置）**：ClickHouse 提供 `max_estimated_execution_time`——基于查询规划估算执行时间，超过即**查询前拒绝**（不先跑再爆），比现有 fail-open lint 更前一步（已在 `defaultClickHouseSettings` 落地，env `BI_CH_MAX_ESTIMATED_TIME` 默认关闭）。注意 `max_estimated_execution_cost` 在 24.2 不存在（UNKNOWN_SETTING），故不用。可对"明显会爆"的形态（如 `uniqExact` 全历史无窗）先用 `EXPLAIN`/估算成本做硬拦，其余仍 fail-open 提示。
2. **结果缓存 / 去重**（已落地，见 6.5.2）：R4 证据显示同一会话连续 10+ 条 `uniqExact` 反复换口径——应在 Agent 层对同一对话内的相似查询做结果缓存/复用，避免重复跑同一重查询。
3. **Human-in-the-loop**：对预估成本超阈（如预计扫 >X 行 / 跑 >Y s）的查询，先让用户确认再执行，而非静默发出。
4. **速率/并发限制（per session）**：单会话单位时间内的重查询次数/并发上限（与服务端 `max_concurrent_queries_for_user` 互为补充，Agent 侧更早拦截、用户体验更好）。**暂未落地**：`runSql` 当前无会话维度入参，per-session 限流需改工具 schema + agent 调用方传 `conversation_id`，改动较大；短期依赖服务端 `QUOTA` / `max_concurrent_queries_for_user`（6.2/6.3）兜底。
5. **最小权限**：`metabase_user` 应 `readonly=1`（P0 profile 可加），只允许 SELECT，从源头杜绝误写。

#### 6.5.2 已落地：进程内结果缓存去重（2026-10-16 续，我们自己做）

- 新增 `scripts/bi-query-cache.mjs`（`makeQueryCache` / `createQueryCacheFromEnv`，纯函数可测）+ 在 `metabase-mcp.mjs` 的 `runSql` 集成：
  - `runSql` 发往 Metabase 的 `POST /dataset` **之前**，先查缓存：相同 `(database_id, 规范化SQL, limit)` 直接命中返回，跳过下游查询——直接治 R4「反复换同一口径 / 重试同一重查询」。
  - 成功结果（ok 且无上游错误）才入缓存；失败不缓存。
  - key 折叠空白，仅空白差异的同一 SQL 也能命中；`limit` / `database_id` 不同视为不同查询。
  - 短 TTL 默认 60s（`BI_QUERY_CACHE_TTL_MS`），非持久、重启即清空；容量上限 200 条（`BI_QUERY_CACHE_MAX_ENTRIES`）惰性淘汰最旧；`BI_QUERY_CACHE_ENABLED=false` 可关。
- **局限**：缓存 key 不含会话维度（MCP 层无 `conversation_id`），故是按「SQL 内容」去重、跨会话也生效——对「同一重查询被不同会话反复跑」同样是收益；但对「同一会话内不同口径的相似查询」无法合并（那是语义级去重，需模型/规划层做，不在本层）。这与 6.5 第 4 点的 per-session 速率限制是不同维度，后者仍待评估（见上）。

### 6.6 代码侧 P1 当前缺口（应立即补齐，与 P0 对齐）

`bi-query-settings.mjs` 的 `defaultClickHouseSettings` 目前只设了 `max_execution_time` + 落盘两项，**缺 `max_result_rows` + `result_overflow_mode`**——若 P0 未做，结果集会无截断地物化（`runSql` 的 `limit=200` 只是展示层 `slice`，ClickHouse 仍算全量）。建议补齐：

```
max_result_rows       = 1000000,
result_overflow_mode  = 'throw',   -- 默认 fail-loud（超限报错而非给半截数据）；若需看板友好的静默截断改 BI_CH_RESULT_OVERFLOW_MODE=break
timeout_overflow_mode = 'throw',   -- 超 max_execution_time 直接中断（默认即 throw，显式写出更稳）
```

> 注：`max_result_rows` 在 P0 profile 已设；此处补齐是"P0 没做时 P1 也兜住"，保持双保险一致。

### 6.7 待补强清单（按优先级）

| 优先级 | 项 | 负责人 | 状态 |
|---|---|---|---|
| P0-高 | Metabase 连接超时调到 ≥ 服务端 `max_execution_time`（治假超时 R3） | DBA/平台 | 待办 |
| P0-高 | 给 `metabase_user` 建 profile（`max_memory_usage=8G` 等，含 `readonly=1`） | DBA | 待办 |
| P0-中 | QUOTA 累计限流（治连发叠加 R4） | DBA | 待办 |
| P0-中 | `max_concurrent_queries_for_user` 并发限制 | DBA | 待办 |
| P0-中 | Metabase 连接指向只读副本 | DBA/平台 | 待办 |
| P1-中 | 代码 `SETTINGS` 补齐 `max_result_rows` / `result_overflow_mode` / `timeout_overflow_mode` | 我们 | 已落地 |
| P2-低 | Agent 层查询成本预估硬拦（`max_estimated_execution_time` 已加为 SETTINGS 机制，默认关闭，env 可开；`max_estimated_execution_cost` 在 24.2 不支持已弃用） | 我们 | 已落地(机制) |
| P2-低 | Agent 层结果缓存/去重（进程内，已落地，见 6.5.2） | 我们 | 已落地 |
| P2-低 | Agent 层会话级速率限制 / 高成本 HITL 确认（需会话维度，暂未做，依赖服务端 QUOTA） | 我们 | 待评估 |

---

## 七、真实场景验证与查缺补漏（2026-10-16 续）

用「印度/巴西 日活 + 会员数 + 近一月/近一周获客渠道 + 会员退订下降原因」这个真实分析需求，构造 Agent 实际会生成的 7 条典型 SQL，用落地的纯函数防护（`lintSql` / `checkCaliber` / `SETTINGS` / 缓存）在本地**真实跑了一遍**，检验防护对这些 SQL 的反应，并对照最新网上最佳实践查缺补漏（验证脚本为一次性工具，跑完已清理，不在仓库内）。

### 7.1 防护生效情况（验证结果）
- **日活 / 获客渠道**（近一月 `count(distinct guid)` 或 `uniqExact(guid)` 大窗）：触发 `COUNT_DISTINCT` + `DEVICE_LEVEL_COUNT`（guid 虚高）+ `HEAVY_EXACT_AGG_NOWINDOW`（大窗精确去重爆库风险）+ `GROUP_BY_NO_LIMIT`。
- **会员存量（错误口径）**：`checkCaliber` 第②条（用 `elt_user_full_history.vipExpireDay` 替代会员表）**硬拦（fail-closed）**——这条不靠 lint 提示，而是在 `runSql` 执行前直接拒绝，逼模型改用 `elt_user_vip_info` 去重账号口径（这是事故复盘里明确写错的形态）。
- **会员数下降多维对比**（维度≥3 无 LIMIT）：触发 `HEAVY` + `GROUP_BY_HIGH_DIM_NOLIMIT` + `GROUP_BY_NO_LIMIT`，三条全中。
- **退订会员明细**（无 LIMIT）：触发 `NO_LIMIT_ROWS`，并由 `SETTINGS max_result_rows` 截断结果集物化。
- **结果缓存去重**：同一 `(db, SQL, limit)` 重复下发直接命中、跳过下游查询，治「反复换口径/重试」。

### 7.2 查缺补漏（已修复 + 已补强）
1. **[已修复] `HEAVY_EXACT_AGG_NOWINDOW` 漏覆盖 `count(distinct ...)` 大窗**：原正则只认 `uniqExact()`，日活常用的 `count(distinct guid)` 近一月只被判「退化变慢」、没被判「内存爆库」。`sql-lint-common.mjs` 已把精确去重大类扩展到 `uniqExact(...)` 与 `count(DISTINCT ...)` 同等对待；新增 `[R]` 回归测试固化（见 `tests/sql-lint.test.ts`）。
2. **[已补强·对齐最新实践] 优先复用预聚合表**：日活/留存/会员存量/漏斗这类指标，正确做法是走预聚合物化视图（`_mv`/`_daily`/`_retention`）或现成 Metabase 卡片，而不是每次 `uniqExact(uid)` 对全量明细宽表扫 30 天——后者既慢又易爆库，正是事故根因形态。`skills/business-data-query/SKILL.md` 资源纪律已加第 0 条「优先复用现成聚合」，并提示先用 `list_cards`/`get_card` 找现成卡片。`SETTINGS` 兜底只是「防爆库」，预聚合才是「从源头把正常查询成本降几个数量级」。
3. **[趋势参考] ClickHouse 26.7 原生支持「TopK 查询条件缓存」**：说明查询缓存是官方认可方向，与我们的进程内缓存去重（6.5.2）互补——我们在应用层（MCP），原生在引擎层（跨查询/跨用户），可叠加。
4. **[呼应] `EXPLAIN` / `system.query_log` 取证成本**：与已加但默认关闭的 `max_estimated_execution_time` 思路一致——对重查询先预估成本再执行。是否默认开启仍建议由 DBA/运维按经验定（避免误杀合法大查询）。

### 7.3 仍存在的边界（如实记录）
- 缓存是按「SQL 内容」去重、不含会话维度，故无法合并「同一会话内不同口径的相似查询」（语义级去重需模型/规划层，不在本层）。
- `max_result_rows=1_000_000` 截断对聚合结果足够，但对「退订会员明细」这类大结果集仍可能物化百万行；如需更紧，可下调该默认值或按查询类型区别。
- 会员退订下降的真正归因（哪些会员/渠道/类型退订）是分析建模问题，护栏只能保证「这类查询跑得动、不爆库、口径正确」，归因结论仍需模型基于正确数据去推导。

### 7.4 线上回归与修复（2026-10-16 17:45，本次端到端测试发现）
用 chrome-devtools 真实走 `/chat` 端到端测试时，新对话启用 BI 数仓后**所有 BI 查询 `[400]` 上游拒绝**，错误 `Code: 115 UNKNOWN_SETTING: Setting max_estimated_execution_cost ... Maybe you meant ['max_estimated_execution_time']`。

- **根因**：`defaultClickHouseSettings` 把 `max_estimated_execution_cost` 默认设为 `0`（关闭态）；`appendClickHouseSettings` 当时只跳过 `undefined/null/""`，**不跳过 `0`**，于是 `max_estimated_execution_cost=0` 被追加到**每一条**查询的 `SETTINGS` 末尾；而目标 ClickHouse `24.2.1.2248` 根本不认识该 setting → 整条查询 400。这是 2026-10-16 下午提交引入的回归（上午的历史对话用旧代码，故当时成功）。
- **修复**：
  1. setting 改名 `max_estimated_execution_time`（ClickHouse 24.x 内建，基于成本估算的执行时间上限，单位秒）；环境变量 `BI_CH_MAX_ESTIMATED_COST` → `BI_CH_MAX_ESTIMATED_TIME`。`max_estimated_execution_cost` 在 24.2 不存在，彻底弃用。
  2. `appendClickHouseSettings` 循环跳过数值 `0`（0 = 关闭/不限制，不追加），双保险。
  3. 测试新增 `[S8]` 固化该回归（默认 settings 追加后不得出现任何 `=0` 或旧名）。
- **教训**：给 ClickHouse 追加 `SETTINGS` 前必须确认目标 CK 版本支持该 setting；且「关闭态的 0 值」绝不能追加进 SQL——否则会让整条查询失败，比不设这道护栏更糟。
