// SQL 静态体检（查库/查表类语句的性能与安全实践）。
//
// 与 sql-readonly-common.mjs 分工：
//   · sql-readonly = 「能不能执行」（写操作 / 多语句），fail-closed，不合规直接拒；
//   · 本模块 = 「该不该这么写」（无界结果集 / 全表扫描 / 列裁剪），**fail-open**：照常执行，
//     但把发现回灌给模型让它自己改。理由：这些是效率与稳定性问题，不是安全问题；
//     直接拦会误杀合理的探索语句（例如「查这张表的时间范围」本来就该无 WHERE），
//     而误杀会逼模型绕路，比慢一点更糟。
//
// 为什么值得做（2026-10-15 实测审计 30 条模型自写 SQL）：
//   · 16/30 条**完全没有 WHERE**——在 ClickHouse 明细事实上就是全表扫描，烧 IO、拖慢库；
//   · 多条 `GROUP BY <高基数列>` 不带 LIMIT——结果集大小由数据决定，模型拿不到稳定的行数；
//   · 出现 `SELECT *`（宽表把无关大字段拉进内存与回灌文本）。
// 这些都不是模型"不会"，而是**没人告诉它判据**；把判据做成可执行提示，是唯一不靠运气��办法。
//
// 判据只用**SQL 语法与结构**（关键词、是否有 WHERE/LIMIT/GROUP BY），不含任何业务语义——
// 不判断某张表该不该加时间窗（那需要知道表多大、哪列是时间，属业务知识，交模型）。
// 服务端与 MCP 适配器共用这一份实现，避免两侧漂移（同sql-readonly 的做法）。

/**
 * @typedef {Object} SqlLintFinding
 * @property {"NO_WHERE"|"NO_LIMIT_ROWS"|"GROUP_BY_NO_LIMIT"|"SELECT_STAR_UNBOUNDED"|"COUNT_DISTINCT"|"DEVICE_LEVEL_COUNT"|"LIKE_LEADING_WILDCARD"|"SHOW_CREATE_TABLE"|"JOIN_WITHOUT_ON"|"IMPLICIT_CROSS_JOIN"|"NON_SARGABLE_PREDICATE"|"GROUP_BY_SELECT_MISMATCH"|"DEEP_SUBQUERY_NESTING"|"DISTINCT_WITHOUT_LIMIT"|"SENSITIVE_COLUMN"|"JOIN_DANGLING_REF"|"HEAVY_EXACT_AGG_NOWINDOW"|"MULTI_JOIN_UNBOUNDED"|"GROUP_BY_HIGH_DIM_NOLIMIT"} code 稳定的机器可读码，便于测试锚定与后续统计
 * @property {string} message 回灌给模型的可操作提示（含怎么改）
 */

/** 元数据 / 会话语句：结果集天然有界或极小，不适用行级规则。 */
function isMetaStatement(sql) {
  return /^\s*(show|describe|desc|explain)\b/i.test(sql) || /\bsystem\.(tables|columns)\b/i.test(sql);
}

/** 只去掉注释，保留字符串字面量——LIKE 的模式就住在字面量里，剥掉就永远判不出来。 */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

/** 去掉注释与字符串字面量，避免字面量里的关键字被当成真实语法（与只读判定同口径）。 */
function stripNoise(sql) {
  return stripComments(sql)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * 时间窗判据阈值（天）：窗口 ≥ 此值视为「长窗口」，配合高基数精确聚合会吃到大量内存。
 * 只做结构判定（SQL 里有没有日期范围过滤），不含任何业务语义——不判断某张表该不该加时间窗。
 */
const LONG_WINDOW_DAYS = 14;

/**
 * 判断 SQL 是否带了「时间窗」过滤（用于资源类规则：无窗 / 长窗的重聚合是内存杀手）。
 * 只认结构：BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'，或裸列与日期字面量的比较（>= / <= / =）。
 * 返回 { bounded, days }：
 *   · bounded=false  → 完全没有日期范围过滤（视为无窗，最危险）；
 *   · days=Infinity  → 有比较但无明确上界（如 col >= '2026-10-09'），仍视为长窗；
 *   · days=数字      → BETWEEN 的跨度天数（< 阈值算短窗、安全）。
 */
function hasDateWindow(input) {
  // 在「只去注释、保留字符串字面量」的文本上判定——否则 stripNoise 会把 'YYYY-MM-DD' 抹成 ''，
  // 短窗口会被误判成「无时间窗」。与 lintSql 主体里 stripNoise 的口径分离。
  const sql = stripComments(String(input ?? ""));
  const between = /\bbetween\s+'(\d{4}-\d{2}-\d{2})'\s+and\s+'(\d{4}-\d{2}-\d{2})'/i.exec(sql);
  if (between) {
    const a = Date.parse(between[1]);
    const b = Date.parse(between[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return { bounded: true, days: Math.abs(b - a) / 86_400_000 };
    }
  }
  const cmps = sql.match(/[<>]=?\s*'(\d{4}-\d{2}-\d{2})'/g);
  if (cmps && cmps.length >= 1) return { bounded: true, days: Infinity };
  return { bounded: false, days: Infinity };
}

/** 疑似敏感列的形态（个人信息类）。只做形态匹配、不含业务语义、零业务词。
 *  命中即 advisory（不阻断），提示模型确认脱敏/授权。元数据查询豁免（!meta）。 */
const SENSITIVE_COLUMN_RE =
  /\b(id_?card|idcard|id_no|ssn|passport|phone|email|salary|wage|income|bank_?card|bankcard|paypal|wechat_?id)\b|身份证|手机|邮箱|工资|银行卡|薪酬/gi;

/**
 * 对一条只读 SQL 做静态体检，返回发现列表（空数组 = 无问题）。
 * 只做结构判定，不做语义判定，也不改写 SQL——改写等于替模型猜口径。
 */
/** @returns {SqlLintFinding[]} */
export function lintSql(input) {
  const raw = String(input ?? "");
  const sql = stripNoise(raw);
  const findings = [];
  const meta = isMetaStatement(sql);
  const hasFrom = /\bfrom\b/i.test(sql);
  const hasWhere = /\bwhere\b/i.test(sql);
  const hasLimit = /\blimit\b/i.test(sql);
  const hasAgg = /\b(count|sum|avg|min|max|uniq|uniqexact|group\s+by)\b/i.test(sql);

  // 明细形态无 LIMIT：行数由数据决定，回灌与渲染都不可控。
  if (!meta && hasFrom && !hasAgg && !hasLimit) {
    findings.push({
      code: "NO_LIMIT_ROWS",
      message: "明细查询没有 LIMIT：返回行数由数据决定，加 LIMIT 限定（确认结构可先 LIMIT 10~20）",
    });
  }
  // 分组基数由数据决定，不带 LIMIT 就无法预期结果规模。
  if (!meta && /\bgroup\s+by\b/i.test(sql) && !hasLimit) {
    findings.push({
      code: "GROUP_BY_NO_LIMIT",
      message: "GROUP BY 没有 LIMIT：分组基数由数据决定，加 LIMIT 并按需 ORDER BY ... DESC 截断",
    });
  }
  // 无 WHERE：在明细事实上就是全表扫描。有聚合不代表便宜——聚合本身也要扫。
  if (!meta && hasFrom && !hasWhere) {
    findings.push({
      code: "NO_WHERE",
      message: "没有 WHERE 过滤：这是全表扫描。若目的是探数据边界（时间范围 / 基数）可以接受，但要在回答里说明；否则先加可分区裁剪的过滤条件",
    });
  }
  // SELECT * 且无 LIMIT：宽表把无关大字段拉进内存与回灌文本。
  if (!meta && /select\s+\*/i.test(sql) && !/\blimit\s+\d/i.test(sql)) {
    findings.push({
      code: "SELECT_STAR_UNBOUNDED",
      message: "SELECT * 且没有 LIMIT：宽表会把无关大字段全部拉回。只看结构请 LIMIT 10 并列出需要的列",
    });
  }
  // ClickHouse：count(DISTINCT) 会退化为全量去重，函数式（uniq/uniqExact）更快。
  if (/count\s*\(\s*distinct\s+/i.test(sql)) {
    findings.push({
      code: "COUNT_DISTINCT",
      message: "count(DISTINCT x) 在列式引擎上会退化为全量去重，改用 uniqExact(x)（精确）或 uniq(x)（近似）更快",
    });
  }
  // 设备级(guid)去重：设备级宽表一号多机，用 guid 统计「用户/会员/日活人数」会系统性虚高。
  // 2026-10-16 /chat 实跑：模型用 uniqExactIf(guid,...) 出「日活人数」，虚高约 1.6 倍。
  // 绑定去重到账号（uid）才是用户口径。确实要数设备时忽略本条（advisory 不阻断）。
  if (/\b(?:uniq\w*|count\w*)\s*\(\s*(?:distinct\s+)?(?:[\w.]+\.)?guid\b/i.test(sql)) {
    findings.push({
      code: "DEVICE_LEVEL_COUNT",
      message:
        "检测到按 guid（设备）去重/计数：设备级宽表一号多机，按 guid 统计「用户/会员/日活人数」会系统性虚高。" +
        "统计用户/会员人数请绑定去重到账号（uniqExact(uid)）；若确实要统计设备数，可忽略本条",
    });
  }
  // 前导通配：无法用跳数/主键索引，退化为全扫。
  // 注意必须在**只去注释**的原文上判——LIKE 的模式是字符串字面量，被stripNoise 剥掉就永远判不出来。
  // 例外：元数据查询（system.columns / system.tables）本就是小表扫描，子串匹配列名是正当用法，不报。
  const forLike = stripComments(raw);
  if (
    !meta &&
    (/like\s+'%/i.test(forLike) || /like\s+"%/i.test(forLike))
  ) {
    findings.push({
      code: "LIKE_LEADING_WILDCARD",
      message: "LIKE 以 % 开头：前导通配无法走索引，会退化成全表扫描。改为前缀匹配（LIKE 'x%'）或改用等值/IN",
    });
  }
  // SHOW CREATE TABLE 输出 DDL（含引擎参数、分区键等实现细节），查结构用 DESCRIBE / 元数据接口。
  if (/show\s+create\s+table/i.test(sql)) {
    findings.push({
      code: "SHOW_CREATE_TABLE",
      message: "SHOW CREATE TABLE 输出建表 DDL（含实现细节）：查结构请用 DESCRIBE <table> 或元数据接口",
    });
  }
  // 笛卡尔积：JOIN 无 ON = 笛卡尔积（行数相乘）。
  if ((sql.match(/\bjoin\b/gi) || []).length > 0 && !/\bon\b/i.test(sql)) {
    findings.push({ code: "JOIN_WITHOUT_ON", message: "JOIN 没有 ON 条件：这是笛卡尔积，行数会相乘" });
  }
  // 逗号隐式交叉连接：FROM a, b —— 老写法，同样是笛卡尔积但连 JOIN 都没有，最容易漏看。
  if (!meta && /\bfrom\s+[a-z_][\w$]*[.`"]?[\w$]*[^\s]*,\s*[a-z_][\w$]*/i.test(sql)) {
    findings.push({
      code: "IMPLICIT_CROSS_JOIN",
      message: "FROM 里用逗号并列多张表：这是隐式交叉连接，行数相乘。改写成带 ON 的显式 JOIN",
    });
  }
  // 谓词列被函数包裹 → 不可 sargable。列式引擎靠列块/主键跳过数据，
  // 写成 toDate(col) = '...' 就退化成全扫，而且写法本身掩盖了真实的时间范围。
  const wherePart = whereClauseOf(sql);
  if (
    wherePart &&
    /\b(to_?date\w*|to_?start_?of\w+|to_?yyyymm\w*|to_?string|lower|upper|substr|substring|concat|trim|replace|abs|datediff|date_?diff|cast|convert)\s*\(/i.test(
      wherePart,
    )
  ) {
    findings.push({
      code: "NON_SARGABLE_PREDICATE",
      message:
        "WHERE 里对列套了函数（toDate/lower/substr 等）：引擎无法据此跳过数据，会退化成全扫，写法还掩盖了真实范围。" +
        "改成对裸列做范围比较——时间是 `col >= '起' AND col < '止'`（左闭右开，别用 between），字符串是 `col LIKE '前缀%'` 或 `col IN (...)`",
    });
  }
  // GROUP BY 与 SELECT 列表不一致：未聚合也未分组的裸列，取值是任意的。
  // 严格模式直接报错，宽松模式**静默给错值**——这类错最难发现，因为"跑通了"。
  if (/\bgroup\s+by\b/i.test(sql)) {
    const gb = groupByColumns(sql);
    // gb 为 null = GROUP BY 用序号（`GROUP BY 1,2`），按名判不了 → 放弃判定，不误报
    const missing = gb ? selectBareColumns(sql).filter((c) => !gb.has(c) && !selectAliases(sql).has(c)) : [];
    if (missing.length) {
      findings.push({
        code: "GROUP_BY_SELECT_MISMATCH",
        message:
          `SELECT 里的列 ${missing.join("、")} 既不在 GROUP BY 也不在聚合函数里：分组后它的取值是任意的` +
          "（严格模式报错，宽松模式静默给错值）。要么加进 GROUP BY，要么用聚合函数包起来",
      });
    }
  }
  // 带函数的多层嵌套：可读性与优化器都受损，改用 CTE（WITH ... AS）分层。
  const depth = subqueryDepth(sql);
  if (depth >= 3) {
    findings.push({
      code: "DEEP_SUBQUERY_NESTING",
      message: `子查询嵌套约 ${depth} 层：改成 WITH cte AS (...) 分层写，可读性与优化器都更好`,
    });
  }
  // DISTINCT 要对全结果去重，行数越多越慢。
  if (!meta && /select\s+distinct\b/i.test(sql) && !hasLimit) {
    findings.push({
      code: "DISTINCT_WITHOUT_LIMIT",
      message: "SELECT DISTINCT 没有 LIMIT：DISTINCT 需对全结果去重，行数越多越慢；先用 WHERE 收窄或加 LIMIT",
    });
  }
  // 疑似敏感列（CLS）：手机号/邮箱/证件号/银行卡/薪资等。advisory——不阻断执行，
  // 只提示模型确认输出已脱敏、或已授权、或仅做聚合统计而非返回明细；避免明文泄露个人信息。
  // 元数据查询豁免（!meta）：避免「按列名扫全集群」时把列名误报成敏感列。
  if (!meta) {
    const sensitive = new Set();
    for (const m of sql.matchAll(SENSITIVE_COLUMN_RE)) sensitive.add(m[0].toLowerCase());
    if (sensitive.size) {
      findings.push({
        code: "SENSITIVE_COLUMN",
        message:
          `查询涉及疑似敏感列（${[...sensitive].join("、")}）：这些通常是个人信息（手机号/邮箱/证件号/银行卡/薪资），` +
          "明文返回有泄露风险。确认输出已脱敏、或已获授权、或仅做聚合统计而非返回明细；确需明细请走脱敏通道。",
      });
    }
  }

  // ---- 资源类规则（2026-10-16 事故后补）：重聚合的内存/扫描代价，advisory（不阻断）----
  // 判据只用 SQL 结构（是否精确去重、是否带时间窗、JOIN 数量、GROUP BY 维度），不含业务语义。
  const win = hasDateWindow(raw);
  const longOrNoWindow = !win.bounded || win.days >= LONG_WINDOW_DAYS;

  // 精确去重大类：uniqExact(...) 与 count(DISTINCT ...) 在 ClickHouse 内都做全量精确去重，
  // 大窗/无窗时内存随去重基数线性增长，全历史宽表上极易爆库（不仅是退化变慢，更会撞内存上限）。
  // 注：count(distinct) 在小窗已由 COUNT_DISTINCT 提示「退化变慢」，此处只在「大窗/无窗」叠加「爆库」警告。
  if ((/\buniq\s*exact\s*\(/i.test(sql) || /count\s*\(\s*distinct\s+/i.test(sql)) && longOrNoWindow) {
    findings.push({
      code: "HEAVY_EXACT_AGG_NOWINDOW",
      message:
        "uniqExact(...)（精确去重）出现在「无时间窗」或「窗口 ≥ " + LONG_WINDOW_DAYS + " 天」的查询里：它会为每一行维护精确去重状态，" +
        "内存随去重值数线性增长，全历史宽表上极易触发服务端内存上限。若只要趋势/看板类指标，改用近似 uniq()（误差约 1~2%，量级一致）；" +
        "若必须精确，先收窄时间窗（1~3 天跑通再逐段放大）或改用已聚合表/现成卡片（list_cards / get_card）。",
    });
  }
  // 多表 JOIN 且整体无时间窗：每个 JOIN 都放大扫描，无范围过滤时整条链路全扫。
  const joinCount = (sql.match(/\bjoin\b/gi) || []).length;
  if (!meta && joinCount >= 2 && longOrNoWindow) {
    findings.push({
      code: "MULTI_JOIN_UNBOUNDED",
      message:
        "出现 " + joinCount + " 个 JOIN 且整条查询没有时间窗过滤：JOIN 会放大要扫描的数据量，无范围过滤时整条链路退化为全扫。" +
        "建议先对每张表在子查询里各自过滤（缩时间窗/加条件）再 JOIN，并把小表放在 JOIN 右侧（哈希表更小）。",
    });
  }
  // GROUP BY 维度很多（≥3）又无 LIMIT：中间分组状态规模不可控，ORDER BY 聚合列时容易一次性拉满。
  const gbCols = groupByColumns(sql);
  if (gbCols && gbCols.size >= 3 && /\border\s+by\b/i.test(sql) && !hasLimit) {
    findings.push({
      code: "GROUP_BY_HIGH_DIM_NOLIMIT",
      message:
        "GROUP BY 维度 ≥ 3 且带 ORDER BY 但没有 LIMIT：高维分组的中间状态规模由数据决定、不可控。" +
        "加 LIMIT 截断（配合 ORDER BY ... DESC 取头部），或先降维到核心维度再逐步展开。",
    });
  }

  // Join 引用完整性（幻觉防护）：JOIN ON 里点号前缀必须指向 FROM/JOIN 中真实声明的表或别名。
  // advisory（不阻断）——模型偶尔会拼出不存在的表/别名做 JOIN，执行期才报 Unknown table，提前提示可省一轮重试。
  {
    // stripNoise 会把标识符反引号（ClickHouse 常见 `t1`）连同内容替换成空，故这里从 raw 重新预处理：
    // 去注释 + 去反引号但保留内部标识符（`t1`→t1）+ 字符串字面量归一，避免反引号标识符漏提取导致漏报。
    const sqlNb = stripComments(raw)
      .replace(/`([^`\\]|\\.)*`/g, "$1")
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const scope = new Set();
    for (const m of sqlNb.matchAll(/(?:from|join)\s+([`"]?)([\w.]+)\1(?:\s+(?:as\s+)?(?!join\b|on\b|where\b|group\b|order\b|having\b|limit\b|by\b|from\b)([`"]?)(\w+)\3)?/gi)) {
      const tbl = m[2];
      if (tbl) {
        scope.add(tbl.toLowerCase());
        const last = tbl.includes(".") ? tbl.slice(tbl.lastIndexOf(".") + 1) : tbl;
        scope.add(last.toLowerCase());
      }
      if (m[4]) scope.add(m[4].toLowerCase());
    }
    // CTE 名：WITH cte AS (...) / WITH RECURSIVE cte AS (...)
    for (const m of sqlNb.matchAll(/\bwith\s+(?:recursive\s+)?([`"]?)(\w+)\1\s+as\s*\(/gi)) {
      if (m[2]) scope.add(m[2].toLowerCase());
    }
    // 派生表 / 子查询别名：) AS alias / ) alias
    for (const m of sqlNb.matchAll(/\)\s+(?:as\s+)?([`"]?)(\w+)\1/gi)) {
      if (m[2]) scope.add(m[2].toLowerCase());
    }
    const dangling = new Set();
    for (const m of sqlNb.matchAll(/\bon\b\s+([\s\S]*?)(?=\bwhere\b|\bgroup\b|\bhaving\b|\border\b|\blimit\b|\)\s*$|,|$)/gi)) {
      const cond = m[1];
      for (const r of cond.matchAll(/([\w.]+)\.(\w+)/g)) {
        const prefix = r[1].toLowerCase();
        const last = prefix.includes(".") ? prefix.slice(prefix.lastIndexOf(".") + 1) : prefix;
        if (!scope.has(prefix) && !scope.has(last)) dangling.add(prefix);
      }
    }
    if (dangling.size) {
      findings.push({
        code: "JOIN_DANGLING_REF",
        message:
          `JOIN 条件引用了未在 FROM/JOIN 中声明的表或别名（${[...dangling].join("、")}）：` +
          "核对是否拼错了表名/别名，或漏写了某个 JOIN 的表。",
      });
    }
  }

  return findings;
}

/** 取 WHERE 子句（到下一个子句关键字为止），用于谓词形态判定。 */
function whereClauseOf(sql) {
  const m = /\bwhere\b/i.exec(sql);
  if (!m) return "";
  const rest = sql.slice(m.index + m[0].length);
  const stop = /\b(group\s+by|order\s+by|limit|having|union|window)\b/i.exec(rest);
  return stop ? rest.slice(0, stop.index) : rest;
}

/** GROUP BY 里的列名（小写）。`GROUP BY 1,2` 这种序号用法返回 null = 放弃按名判定。 */
function groupByColumns(sql) {
  const m = /\bgroup\s+by\b([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bhaving\b|\bunion\b|$)/i.exec(sql);
  if (!m) return null;
  const body = m[1];
  const parts = body.split(",").map((s) => s.trim());
  // 全是序号（GROUP BY 1,2）＝合法写法，按名判不了 → 返回 null 让调用方跳过
  if (parts.length > 1 && parts.every((p) => /^\d+$/.test(p))) return null;
  const out = new Set();
  for (const p of parts) {
    const c = p.replace(/[`"\s]/g, "").replace(/^[a-z_][\w$]*\./i, "").toLowerCase();
    if (/^[a-z_][\w$]*$/.test(c)) out.add(c);
  }
  return out;
}

/** SELECT 列表里的裸列（不在函数内、不是别名、不是序号/常量）。 */
function selectBareColumns(sql) {
  const from = /\bfrom\b/i.exec(sql);
  const head = from ? sql.slice(0, from.index) : sql;
  const sel = /\bselect\b([\s\S]*)$/i.exec(head);
  if (!sel) return [];
  const out = [];
  for (const part of splitTopLevel(sel[1].replace(/\bdistinct\b/gi, ""), ",")) {
    const p = part.trim();
    if (!p) continue;
    if (/\bas\b/i.test(p)) continue;
    if (/[(]/.test(p)) continue; // 聚合 / 函数 / 子查询
    if (/^\d+$/.test(p)) continue;
    if (/^[*+\-]/.test(p)) continue;
    const c = p.replace(/[`"\s]/g, "").replace(/^[a-z_][\w$]*\./i, "").toLowerCase();
    if (/^[a-z_][\w$]*$/.test(c)) out.push(c);
  }
  return [...new Set(out)];
}

/** SELECT 列表里 `AS 别名` 定义的别名（小写）。 */
function selectAliases(sql) {
  const from = /\bfrom\b/i.exec(sql);
  const head = from ? sql.slice(0, from.index) : sql;
  const out = new Set();
  for (const m of head.matchAll(/\bas\s+([a-z_][\w$]*)/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** 顶层逗号切分（跳过括号内与引号内的逗号）。 */
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 括号嵌套深度（近似"子查询嵌套层数"）。 */
function subqueryDepth(sql) {
  let depth = 0;
  let max = 0;
  for (const ch of sql) {
    if (ch === "(") {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  return max;
}

/**
 * 体检结论的一句话摘要（贴进执行结果顶部；无问题时返回空串）。
 * @param {SqlLintFinding[]} findings
 * @returns {string}
 */
export function lintSummary(findings) {
  if (!findings.length) return "";
  return (
    "（执行前体检提示——本次查询仍已执行，但有这些可以改的地方；下一次请注意）\n" +
    findings.map((f, i) => `${i + 1}. [${f.code}] ${f.message}`).join("\n")
  );
}