// SQL 静态体检（scripts/sql-lint-common.mjs）的判据回归。
//
// 为什么要有这层：2026-10-15 审计 30 条模型自写 SQL，发现 16 条**完全没有 WHERE**
// （在列式引擎的明细事实上就是全表扫描）、多条 GROUP BY 不带 LIMIT、出现 SELECT *。
// 这些不是模型"不会"，而是没人告诉它判据。体检把这套判据变成可执行提示回灌给它。
//
// 与只读判定的分工必须锁住：只读 = fail-closed（写操作直接拒）；体检 = fail-open
// （照常执行 + 提示）。一旦有人把体检改成拦，会误杀合法的探索语句
//（例如"查这张表的时间范围"本来就不该有 WHERE）。
import { test, expect } from "vitest";
import { lintSql, lintSummary } from "../scripts/sql-lint-common.mjs";

const codes = (sql: string) => lintSql(sql).map((f) => f.code);

test("[A] 无界结果集：明细无 LIMIT / 分组无 LIMIT", () => {
  expect(codes("SELECT a, b FROM t WHERE x = 1")).toContain("NO_LIMIT_ROWS");
  expect(codes("SELECT a, count() FROM t WHERE x = 1 GROUP BY a")).toContain("GROUP_BY_NO_LIMIT");
  // 加了 LIMIT 就干净
  expect(codes("SELECT a, b FROM t WHERE x = 1 LIMIT 20")).toEqual([]);
  expect(codes("SELECT a, count() FROM t WHERE x = 1 GROUP BY a ORDER BY 2 DESC LIMIT 50")).toEqual([]);
});

test("[B] 全表扫描：无 WHERE（探边界的用法放行但仍提示）", () => {
  expect(codes("SELECT count() FROM t")).toContain("NO_WHERE");
  expect(codes("SELECT max(d) FROM t")).toContain("NO_WHERE");
  expect(codes("SELECT count() FROM t WHERE d >= '2026-01-01'")).toEqual([]);
});

test("[C] 列裁剪：SELECT * 无 LIMIT 才报（探结构给 LIMIT 就不报）", () => {
  expect(codes("SELECT * FROM t WHERE x = 1")).toContain("SELECT_STAR_UNBOUNDED");
  // 探结构给了 LIMIT 就不该再报列裁剪（是否另报 NO_WHERE 取决于有没有过滤条件，两者独立）
  expect(codes("SELECT * FROM t WHERE x = 1 LIMIT 5")).toEqual([]);
});

test("[D] 引擎实践：count(DISTINCT)、前导通配 LIKE、SHOW CREATE TABLE", () => {
  expect(codes("SELECT count(DISTINCT uid) FROM t WHERE d > 1")).toContain("COUNT_DISTINCT");
  expect(codes("SELECT * FROM t WHERE name LIKE '%x%' LIMIT 5")).toContain("LIKE_LEADING_WILDCARD");
  expect(codes("SELECT * FROM t WHERE name LIKE 'x%' LIMIT 5")).toEqual([]);
  expect(codes("SHOW CREATE TABLE t")).toContain("SHOW_CREATE_TABLE");
});

test("[E] 笛卡尔积：JOIN 无 ON", () => {
expect(codes("SELECT a.x FROM a JOIN b WHERE a.x > 0 LIMIT 5")).toContain("JOIN_WITHOUT_ON");
  expect(codes("SELECT a.x FROM a JOIN b ON a.id = b.id WHERE a.x > 0 LIMIT 5")).toEqual([]);
});

test("[F] 元数据/会话语句不适用行级规则（否则会误杀）", () => {
  // 这些语句结果集天然有界或极小，不该被要求 WHERE/LIMIT
  for (const sql of ["SHOW TABLES FROM db", "DESCRIBE TABLE db.t", "SHOW TABLES FROM film_report"]) {
    expect(codes(sql), `不应命中行级规则：${sql}`).toEqual([]);
  }
  // 但引擎实践类规则仍然生效（与语句类型无关）
  expect(codes("SELECT count(DISTINCT x) FROM system.tables")).toContain("COUNT_DISTINCT");
});

test("[F2] 元数据语句免 SELECT_STAR_UNBOUNDED / DISTINCT_WITHOUT_LIMIT（§2.5 一致性）", () => {
  // 复杂用例电池 L8 暴露：原 isMetaStatement 只豁免 NO_WHERE/NO_LIMIT_ROWS，
  // SELECT_STAR_UNBOUNDED 与 DISTINCT_WITHOUT_LIMIT 漏豁免——`SELECT * FROM system.columns` 仍被报无 LIMIT。
  expect(codes("SELECT * FROM system.columns")).not.toContain("SELECT_STAR_UNBOUNDED");
  expect(codes("SELECT * FROM system.tables")).not.toContain("SELECT_STAR_UNBOUNDED");
  expect(codes("SELECT DISTINCT name FROM system.columns")).not.toContain("DISTINCT_WITHOUT_LIMIT");
  // 反向：非元数据语句仍照常报，避免把豁免变成「SELECT * 永远不报」
  expect(codes("SELECT * FROM sch.tbl")).toContain("SELECT_STAR_UNBOUNDED");
  expect(codes("SELECT DISTINCT a FROM sch.tbl WHERE d > 1")).toContain("DISTINCT_WITHOUT_LIMIT");
});

test("[G] 字面量/注释里的关键字不误报（判据只认真实语法）", () => {
  expect(codes("SELECT a FROM t WHERE note = 'group by' LIMIT 5")).toEqual([]);
  expect(codes("SELECT a FROM t WHERE note = 'drop table' LIMIT 5")).toEqual([]);
  expect(codes("SELECT a FROM t -- no where here\n LIMIT 5")).toContain("NO_WHERE");
  // ⚠️ 反向约束：LIKE 的模式**就在字面量里**，若判据跑在剥掉字面量的文本上就永远失效
  //（实现初版就踩了这个：stripNoise 把 '%x%' 抹掉，LIKE 判据形同虚设）
  expect(codes("SELECT a FROM t WHERE name LIKE '%x%' LIMIT 5")).toContain("LIKE_LEADING_WILDCARD");
});

test("[G2] 元数据/会话语句豁免行级规则，但引擎实践类仍生效", () => {
  for (const sql of ["SHOW TABLES FROM db", "DESCRIBE TABLE db.t", "EXPLAIN SELECT 1"]) {
    expect(codes(sql), `不应命中行级规则：${sql}`).toEqual([]);
  }
  // system.* 也豁免行级规则
  expect(codes("SELECT name FROM system.tables")).not.toContain("NO_WHERE");
  expect(codes("SELECT name FROM system.tables")).not.toContain("NO_LIMIT_ROWS");
  // 但引擎实践类与语句类型无关
  expect(codes("SELECT count(DISTINCT x) FROM system.tables")).toContain("COUNT_DISTINCT");
});

test("[G2] 敏感列 advisory（CLS）：命中敏感列形态给提示、不阻断、非敏感列不误报、元数据查询豁免", () => {
  expect(codes("SELECT email, user_phone FROM t WHERE d > 1 LIMIT 1")).toContain("SENSITIVE_COLUMN");
  expect(codes("SELECT col_a FROM t WHERE d > 1 LIMIT 1")).not.toContain("SENSITIVE_COLUMN");
  // 元数据查询（system.columns）豁免，避免按列名扫全集群时误报
  expect(codes("SELECT name FROM system.columns WHERE name LIKE '%email%'")).not.toContain("SENSITIVE_COLUMN");
  // advisory = fail-open：仍照常产出其它体检项、不阻止执行
  expect(codes("SELECT email FROM t")).toContain("NO_WHERE");
});

test("[G3] Join 引用完整性（幻觉防护）：ON 引用未声明表/别名给 advisory、真实 self-join/CTE 不误报", () => {
  expect(codes("SELECT a.x FROM t1 AS a JOIN t2 AS b ON a.x = ghost.y WHERE d > 1 LIMIT 1")).toContain("JOIN_DANGLING_REF");
  // 真实 self-join：别名都声明过，不误报
  expect(codes("SELECT x.id FROM t1 AS x JOIN t1 AS y ON x.id = y.pid WHERE d > 1 LIMIT 1")).not.toContain("JOIN_DANGLING_REF");
  // CTE 别名在 ON 里引用不误报
  expect(codes("WITH cte AS (SELECT id FROM t1) SELECT a.id FROM cte AS a JOIN t2 AS b ON a.id = b.x WHERE d > 1 LIMIT 1")).not.toContain("JOIN_DANGLING_REF");
  // 反引号标识符（ClickHouse 常见）也能正确解析，不漏报
  expect(codes("SELECT `a`.`x` FROM `t1` AS `a` JOIN `t2` AS `b` ON `a`.`x` = `ghost`.`y` WHERE d > 1 LIMIT 1")).toContain("JOIN_DANGLING_REF");
  // advisory = fail-open：仍照常产出其它体检项
  expect(codes("SELECT a.x FROM t1 AS a JOIN t2 AS b ON a.x = ghost.y")).toContain("NO_WHERE");
});

test("[H] fail-open：体检从不改写、从不拒绝，只产出提示", () => {
  const bad = "SELECT * FROM t";
  const findings = lintSql(bad);
  expect(findings.length).toBeGreaterThan(0);
  // 摘要必须带机器码 + 可操作改法，且说明"已执行"
  const sum = lintSummary(findings);
  expect(sum).toContain("SELECT_STAR_UNBOUNDED");
  expect(sum).toContain("LIMIT");
  expect(sum).toContain("仍已执行");
  expect(lintSummary([])).toBe("");
});

test("[I] 真实审计样本回归：这 4 条曾全部命中问题，改后干净", () => {
  // 审计里出现的真实形态（去掉业务标识，只留结构）
  expect(codes("SELECT ch, count() AS c FROM sch.tbl GROUP BY ch ORDER BY c DESC")).toContain("GROUP_BY_NO_LIMIT");
  expect(codes("SELECT ch, count() AS c FROM sch.tbl WHERE d > 1 GROUP BY ch ORDER BY c DESC LIMIT 30")).toEqual([]);
  // 探边界的全扫聚合：有提示但执行不受阻（fail-open 的语义）
  expect(codes("SELECT max(d), count() FROM sch.tbl")).toEqual(["NO_WHERE"]);
});

test("[K+] 13 条判据全部有码有话（新增判据不能只进代码不进清单）", () => {
  const all = [
    "SELECT a FROM t", // NO_LIMIT_ROWS + NO_WHERE
    "SELECT DISTINCT a FROM t WHERE d > 1", // DISTINCT_WITHOUT_LIMIT
    "SELECT a, count() AS c FROM t WHERE d > 1 GROUP BY a", // GROUP_BY_NO_LIMIT
    "SELECT * FROM t WHERE d > 1", // SELECT_STAR_UNBOUNDED
    "SELECT count(DISTINCT a) FROM t WHERE d > 1 LIMIT 1", // COUNT_DISTINCT
    "SELECT uniqExact(guid) FROM t WHERE d > 1 LIMIT 1", // DEVICE_LEVEL_COUNT
    "SELECT a FROM t WHERE n LIKE '%x' LIMIT 1", // LIKE_LEADING_WILDCARD
    "SHOW CREATE TABLE t", // SHOW_CREATE_TABLE
    "SELECT a.x FROM a JOIN b WHERE a.x > 0 LIMIT 1", // JOIN_WITHOUT_ON
    "SELECT a.x FROM a, b WHERE a.x > 0 LIMIT 1", // IMPLICIT_CROSS_JOIN
    "SELECT count() FROM t WHERE toDate(d) = '2026-01-01' LIMIT 1", // NON_SARGABLE_PREDICATE
    "SELECT a, b, count() AS c FROM t WHERE d > 1 GROUP BY a LIMIT 1", // GROUP_BY_SELECT_MISMATCH
    "SELECT count() AS c FROM (SELECT count() AS c2 FROM (SELECT count() AS c3 FROM (SELECT a FROM t WHERE d > 1) AS q1 GROUP BY a) AS q2 GROUP BY a) AS q3 LIMIT 1", // DEEP_SUBQUERY_NESTING
    "SELECT email FROM t WHERE d > 1 LIMIT 1", // SENSITIVE_COLUMN
    "SELECT a.x FROM t1 AS a JOIN t2 AS b ON a.x = ghost.y WHERE d > 1 LIMIT 1", // JOIN_DANGLING_REF
    "SELECT uniqExact(uid) FROM t WHERE d >= '2026-10-09'", // HEAVY_EXACT_AGG_NOWINDOW
    "SELECT a.x FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id", // MULTI_JOIN_UNBOUNDED
    "SELECT a, b, c, count() AS n FROM t GROUP BY a, b, c ORDER BY 3 DESC", // GROUP_BY_HIGH_DIM_NOLIMIT
  ];
  const seen = new Set(all.flatMap((sql) => lintSql(sql).map((f) => f.code)));
  const expected = [
    "NO_LIMIT_ROWS", "NO_WHERE", "DISTINCT_WITHOUT_LIMIT", "GROUP_BY_NO_LIMIT", "SELECT_STAR_UNBOUNDED",
    "COUNT_DISTINCT", "DEVICE_LEVEL_COUNT", "LIKE_LEADING_WILDCARD", "SHOW_CREATE_TABLE", "JOIN_WITHOUT_ON",
    "IMPLICIT_CROSS_JOIN", "NON_SARGABLE_PREDICATE", "GROUP_BY_SELECT_MISMATCH",     "DEEP_SUBQUERY_NESTING",
    "SENSITIVE_COLUMN",
    "JOIN_DANGLING_REF",
    "HEAVY_EXACT_AGG_NOWINDOW", "MULTI_JOIN_UNBOUNDED", "GROUP_BY_HIGH_DIM_NOLIMIT",
  ];
  expect([...expected].filter((c) => !seen.has(c)), "这些判据没被任何用例触发").toEqual([]);
  // 每条发现都必须带可操作提示（不能只有码没有"怎么改"）
  for (const sql of all) {
    for (const f of lintSql(sql)) expect(f.message.length, `${f.code} 缺少提示文案`).toBeGreaterThan(10);
  }
});
// ── dogfood：我们要求模型遵守的判据，适配器自己的 SQL 也要过 ──────────────────────
// 爬源码抽 SQL 天然脆弱（模板跨行 + 占位符会把代码片段误当 SQL——实测抽出来 4/5 是误报），
// 所以把**真实拼出的形状**固定在这里。改适配器的拼法时这条会红。
test("[I2] dogfood：取值分布工具自己拼的 SQL，除已说明的例外外应体检干净", () => {
  // 与 scripts/metabase-mcp.mjs 的 get_field_values 兜底查询同构（占位符已替换）
  const composed =
    "SELECT col_a AS value, COUNT(*) AS occurrences FROM (SELECT col_a FROM sch.tbl LIMIT 200000) AS sampled " +
    "GROUP BY value ORDER BY COUNT(*) DESC LIMIT 200";
  const found = codes(composed);
  // 有界：内层采样封顶 + 外层分组截断，两层都在
  expect(found).not.toContain("NO_LIMIT_ROWS");
  expect(found).not.toContain("GROUP_BY_NO_LIMIT");
  expect(found).not.toContain("SELECT_STAR_UNBOUNDED");
  expect(found).not.toContain("DEEP_SUBQUERY_NESTING");
  expect(found).not.toContain("GROUP_BY_SELECT_MISMATCH");
  // 唯一命中 NO_WHERE —— **这是该工具的设计本意**：它就是"取样看取值分布"，
  // 不加 WHERE 才能看到全量取值域；结果已标注 approximate / scanLimit，可信度如实说明。
  expect(found).toEqual(["NO_WHERE"]);
});

test("[J] sargable：谓词列被函数包裹 → 全扫且掩盖范围", () => {
  // 反例：函数包裹谓词列
  expect(codes("SELECT count() FROM t WHERE toDate(d) = '2026-01-01' GROUP BY 1 LIMIT 1")).toContain("NON_SARGABLE_PREDICATE");
  expect(codes("SELECT count() FROM t WHERE lower(n) = 'x' GROUP BY 1 LIMIT 1")).toContain("NON_SARGABLE_PREDICATE");
  // 正确写法：裸列 + 左闭右开范围
  expect(codes("SELECT count() FROM t WHERE d >= '2026-01-01' AND d < '2026-01-02' GROUP BY 1 LIMIT 1")).toEqual([]);
  // 只在 WHERE 子句里判；SELECT 里的函数不该误报
  expect(codes("SELECT toDate(d) AS day, count() AS c FROM t WHERE d >= '2026-01-01' GROUP BY day LIMIT 10")).toEqual([]);
});

test("[K] GROUP BY 与 SELECT 不一致 → 静默错值", () => {
  expect(codes("SELECT a, b, count() AS c FROM t WHERE d > 1 GROUP BY a LIMIT 10")).toContain("GROUP_BY_SELECT_MISMATCH");
  // b 在 GROUP BY 里 → 干净
  expect(codes("SELECT a, b, count() AS c FROM t WHERE d > 1 GROUP BY a, b LIMIT 10")).toEqual([]);
  // 别名不算漏分组（先按名后按别名）
  expect(codes("SELECT toDate(d) AS day, count() AS c FROM t WHERE d > 1 GROUP BY day LIMIT 10")).toEqual([]);
  // 序号分组是合法写法，放弃判定而不是误报
  expect(codes("SELECT a, b, count() AS c FROM t WHERE d > 1 GROUP BY 1, 2 LIMIT 10")).toEqual([]);
});

test("[L] 笛卡尔积：逗号隐式交叉连接", () => {
  expect(codes("SELECT a.x FROM a, b WHERE a.x > 0 LIMIT 5")).toContain("IMPLICIT_CROSS_JOIN");
  // 显式 JOIN 带 ON 不报
  expect(codes("SELECT a.x FROM a JOIN b ON a.id = b.id WHERE a.x > 0 LIMIT 5")).toEqual([]);
  // 逗号出现在函数参数里不算交叉连接
  expect(codes("SELECT concat(a, b) AS c FROM t WHERE a > 0 LIMIT 5")).toEqual([]);
});

test("[M] 深层嵌套与 DISTINCT 的隐性代价", () => {
  const deep =
    "SELECT count() AS c FROM (SELECT count() AS c2 FROM (SELECT count() AS c3 FROM (SELECT a FROM t WHERE d > 1) AS q1 GROUP BY a) AS q2 GROUP BY a) AS q3 LIMIT 1";
  expect(codes(deep)).toContain("DEEP_SUBQUERY_NESTING");
  expect(codes("SELECT DISTINCT a FROM t WHERE d > 1")).toContain("DISTINCT_WITHOUT_LIMIT");
  expect(codes("SELECT DISTINCT a FROM t WHERE d > 1 LIMIT 10")).toEqual([]);
});

test("[N] 设备级 guid 去重告警：按设备数人会被判（2026-10-16 /chat 虚高 1.6 倍事故回归）", () => {
  // 事故真实形态：uniqExactIf(guid, ...) 用来算日活人数 → 设备级，口径错
  expect(codes("SELECT uniqExactIf(a.guid, u.cc = 91) AS dau FROM film_report.elt_active_guid a JOIN film_report.elt_user_full u ON a.guid = u.guid WHERE a.d >= '2026-01-01'")).toContain("DEVICE_LEVEL_COUNT");
  expect(codes("SELECT uniqExact(guid) AS users FROM t WHERE d > 1")).toContain("DEVICE_LEVEL_COUNT");
  expect(codes("SELECT count(DISTINCT guid) AS users FROM t WHERE d > 1")).toContain("DEVICE_LEVEL_COUNT");
  expect(codes("SELECT count(guid) FROM t WHERE d > 1")).toContain("DEVICE_LEVEL_COUNT");
  // 账号级(uid)不告警；字面量/子串不误报
  expect(codes("SELECT uniqExact(uid) AS users FROM t WHERE d > 1")).not.toContain("DEVICE_LEVEL_COUNT");
  expect(codes("SELECT uniq(guid_hash) FROM t WHERE d > 1")).not.toContain("DEVICE_LEVEL_COUNT");
});

test("[O] 资源类·精确去重无窗/长窗（2026-10-16 内存爆顶事故回归）", () => {
  // 事故真实形态：uniqExact(guid) 全历史宽表、无上界时间窗 → 内存随去重值数线性增长
  expect(codes("SELECT recordDate, uniqExact(guid) AS devs FROM elt_user_full_history WHERE recordDate >= '2026-10-09' GROUP BY recordDate, countryCode ORDER BY recordDate, devs DESC")).toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 单边界无上界（>= 某天）也视为长窗
  expect(codes("SELECT uniqExact(uid) FROM t WHERE d >= '2026-10-09'")).toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 短窗（< 14 天）不报：鼓励先小范围探通再放大
  expect(codes("SELECT uniqExact(guid) FROM t WHERE d BETWEEN '2026-10-01' AND '2026-10-03'")).not.toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 长窗（≥ 14 天）报
  expect(codes("SELECT uniqExact(guid) FROM t WHERE d BETWEEN '2026-10-01' AND '2026-10-31'")).toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 提示里明确给「近似 uniq()」与「缩窗/预聚合」两条路
  const msg = lintSql("SELECT uniqExact(guid) FROM t WHERE d >= '2026-10-09'").find((f) => f.code === "HEAVY_EXACT_AGG_NOWINDOW")?.message ?? "";
  expect(msg).toContain("uniq()");
  expect(msg).toContain("时间窗");
});

test("[P] 资源类·多表 JOIN 无时间窗（放大扫描）", () => {
  // 两个 JOIN 且无任何时间窗 → 整条链路全扫
  expect(codes("SELECT a.x, b.y, c.z FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id")).toContain("MULTI_JOIN_UNBOUNDED");
  // 有非日期过滤但无时间窗，仍算无窗（扫描未被时间裁剪）
  expect(codes("SELECT a.x FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id WHERE a.flag = 1")).toContain("MULTI_JOIN_UNBOUNDED");
  // 短日期窗 → 不报
  expect(codes("SELECT a.x FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id WHERE d BETWEEN '2026-10-01' AND '2026-10-02'")).not.toContain("MULTI_JOIN_UNBOUNDED");
  // 单 JOIN 不报（规则只针对多表放大）
  expect(codes("SELECT a.x FROM a JOIN b ON a.id=b.id WHERE d >= '2026-10-09'")).not.toContain("MULTI_JOIN_UNBOUNDED");
});

test("[Q] 资源类·高维 GROUP BY 无 LIMIT", () => {
  // 维度 ≥3 + ORDER BY + 无 LIMIT → 中间状态规模不可控
  expect(codes("SELECT a, b, c, count() AS n FROM t GROUP BY a, b, c ORDER BY 3 DESC")).toContain("GROUP_BY_HIGH_DIM_NOLIMIT");
  // 加 LIMIT 就不报
  expect(codes("SELECT a, b, c, count() AS n FROM t GROUP BY a, b, c ORDER BY 3 DESC LIMIT 50")).not.toContain("GROUP_BY_HIGH_DIM_NOLIMIT");
  // 维度少（2）不报
  expect(codes("SELECT a, b, count() AS n FROM t GROUP BY a, b ORDER BY 3 DESC")).not.toContain("GROUP_BY_HIGH_DIM_NOLIMIT");
});

test("[R] 资源类·count(DISTINCT) 大窗同样按精确去重判内存爆库（补齐 HEAVY 漏覆盖）", () => {
  // 日活/获客渠道常用 count(distinct guid) 近一月：与 uniqExact 同等内存风险，原 HEAVY 只认 uniqExact 漏了它。
  // 长窗 / 无上界单边界 → 报（与 [O] 的 uniqExact 形态对称）
  expect(codes("SELECT count(DISTINCT guid) FROM elt_user_full_history WHERE recordDate >= '2026-09-16'")).toContain("HEAVY_EXACT_AGG_NOWINDOW");
  expect(codes("SELECT count(DISTINCT uid) FROM t WHERE d >= '2026-10-09'")).toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 短窗（< 14 天）不报：鼓励先小范围探通再放大
  expect(codes("SELECT count(DISTINCT guid) FROM t WHERE d BETWEEN '2026-10-01' AND '2026-10-03'")).not.toContain("HEAVY_EXACT_AGG_NOWINDOW");
  // 短窗仍走 COUNT_DISTINCT（退化变慢）提示，与 HEAVY 不冲突
  expect(codes("SELECT count(DISTINCT guid) FROM t WHERE d BETWEEN '2026-10-01' AND '2026-10-03'")).toContain("COUNT_DISTINCT");
});