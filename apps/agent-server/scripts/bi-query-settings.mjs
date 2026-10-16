// BI 取数查询级资源护栏（纯函数，零副作用，便于单测；不依赖 Metabase MCP 服务端进程）。
//
// 为什么独立成模块：metabase-mcp.mjs 在 import 时会启动 stdio server、读环境变量，
// 直接 import 它会让 vitest 拉起一个常驻进程。把「可测试的逻辑」抽出来，测的是纯函数，
// 不触发任何副作用。
//
// 设计原则（与 sql-lint-common / sql-readonly-common 一致）：
//   · 本模块只做「加资源边界」与「把上游错误翻译成可操作提示」，**不改写 SQL 语义**——
//     改写等于替模型猜口径，违反红线；
//   · 这是第二道保险：即使 DBA 还没在 ClickHouse 给 metabase_user 配 profile（P0），
//     我们自己的查询也自带边界。任何一层生效即可。

/**
 * 默认查询级 ClickHouse 设置（从环境变量读，未配则走保守默认值）。
 * 阈值与 docs/agent/BI_HEAVY_QUERY_GUARDRAIL.md 的 P0 对齐，但略保守：
 *   · max_execution_time 默认 90s —— 小于 P0 的 120s，确保即使客户端没超时，
 *     服务端也会在 90s 砍掉「假超时」残留（根治 R3）；
 *   · max_bytes_before_external_group_by / _sort 默认 4GB —— 聚合/排序超阈值落盘，
 *     避免 OOM（ClickHouse 官方 KB 建议设为低于 max_memory_usage，给哈希表留余量）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultClickHouseSettings(env = process.env) {
  const num = (key, d) => {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === "") return d;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    max_execution_time: num("BI_CH_MAX_EXECUTION_TIME", 90),
    max_bytes_before_external_group_by: num("BI_CH_EXT_GROUP_BY_BYTES", 4_000_000_000),
    max_bytes_before_external_sort: num("BI_CH_EXT_SORT_BYTES", 4_000_000_000),
    // 结果集超阈值截断：'break' 静默截断（看板友好），或 'throw' 让超限报错而非给半截数据。
    // 仅截断物化行数，不影响聚合正确性；P0 profile 已设，此处补齐是「P0 没做时 P1 也兜住」的双保险。
    max_result_rows: num("BI_CH_MAX_RESULT_ROWS", 1_000_000),
    result_overflow_mode: (env["BI_CH_RESULT_OVERFLOW_MODE"] || "break").toString(),
    // 超 max_execution_time 直接中断（默认 throw，显式写出更稳；根治 R3「假超时」需配合 Metabase 超时对齐，见文档 6.1）。
    timeout_overflow_mode: (env["BI_CH_TIMEOUT_OVERFLOW_MODE"] || "throw").toString(),
    // 查询前基于规划估算执行时间的硬拦：超过则执行前直接拒绝（不先跑再爆），比 fail-open lint 更前一步（文档 6.5.1）。
    // 用 max_estimated_execution_time（ClickHouse 24.x 内建，基于成本估算的执行时间上限，单位秒）；
    // 注意 max_estimated_execution_cost 在 24.2 不存在（会触发 UNKNOWN_SETTING 让整条查询 400 失败），故不用。
    // 默认 0 = 不限制（关闭），避免误杀合法大查询；由运维/DBA 按经验开启一个保守阈值。
    max_estimated_execution_time: num("BI_CH_MAX_ESTIMATED_TIME", 0),
  };
}

/**
 * 把查询级 SETTINGS 追加到 SQL 末尾（ClickHouse 语法：SETTINGS 必须位于语句最后）。
 * 不改动原查询的语义——只补资源边界。返回新字符串；以下情况原样返回：
 *   · sql 为空或 settings 为空 → 原样返回；
 *   · SQL 已含 SETTINGS 子句 → 不重复追加（避免两个 SETTINGS 报语法错）；
 *   · 末尾多余分号会被剥掉；若以行注释 `--` 结尾，用换行隔离，避免 SETTINGS 被注释吃掉。
 * @param {string} sql
 * @param {Record<string, number|string>} [settings]
 * @returns {string}
 */
// 判定 SQL 是否已含 SETTINGS 子句——只在「去注释 + 去字符串字面量」的文本上判，
// 否则 SELECT 里名为 settings 的列 / 字面量里的 "settings" 会被误判成已声明而**跳过护栏**（假阴性）。
function alreadyHasSettings(sql) {
  const stripped = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return /\bsettings\b/i.test(stripped);
}

export function appendClickHouseSettings(sql, settings) {
  if (!sql) return "";
  if (!settings || typeof settings !== "object") return sql;
  if (alreadyHasSettings(sql)) return sql; // 已声明，不重复
  const clauses = [];
  for (const [k, v] of Object.entries(settings)) {
    // 数值 0 视为「关闭/不限制」：不追加。否则会把 CK 不支持的 setting（或无效值）带上，
    // 触发 UNKNOWN_SETTING 让整条查询 400 失败（见 2026-10-16 线上回归：max_estimated_execution_cost=0 被追加）。
    if (v === undefined || v === null || v === "" || v === 0) continue;
    // 字符串值（如 result_overflow_mode='break'）必须加引号，否则 SQL 语法非法；
    // 数字值（max_execution_time 等）不加引号，保持原行为。
    const val = typeof v === "string" ? `'${v}'` : v;
    clauses.push(`${k}=${val}`);
  }
  if (!clauses.length) return sql;
  const stripped = String(sql).replace(/;+\s*$/, "").replace(/\s+$/, "");
  return `${stripped}\nSETTINGS ${clauses.join(", ")}`;
}

/**
 * 把上游（Metabase / ClickHouse）返回的错误文本翻译成**可操作**的下一步（对标
 * Anthropic《Writing effective tools》）。只识别资源类错误码；其它返回 null，由调用方回落通用文案。
 * 零业务词：只讲取数动作（缩窗 / 降基数 / 预聚合 / 降维度），不出现具体库表指标名。
 * @param {string} text
 * @returns {string|null}
 */
export function classifyUpstreamError(text) {
  if (!text) return null;
  const t = String(text);
  if (/Code:\s*241|Memory limit\s*\(total\)\s*exceeded/i.test(t)) {
    return [
      "推断：内存超限（Code 241）——这条 SQL 占用的内存超过了数据库给本账号的上限，被强制中断。先改查询，再重试：",
      "① 降基数：高基数列的精确去重 uniqExact(...) 内存 ∝ 去重值数 × 线程数；若只要趋势/看板类指标，改用近似 uniq()（误差约 1~2%，结果量级一致）；",
      "② 缩时间窗：把 WHERE 里的时间范围收窄（先 1~3 天跑通，再逐段放大），别一上来扫几十天；",
      "③ 预聚合：能用已聚合表或现成卡片就别扫明细宽表——先看 list_cards / get_card 有没有现成查询；",
      "④ 降维度：GROUP BY 维度过多会放大中间状态，先少维度、并加 LIMIT 截断。",
      "原样重试只会再爆一次内存；按上面顺序收敛后再跑。",
    ].join("\n");
  }
  if (/Code:\s*307|Limit for rows or bytes to read exceeded/i.test(t)) {
    return [
      "推断：扫描行数/字节超限（Code 307）——这次查询要读的数据超过了允许上限。",
      "① 收窄时间窗与过滤条件，减少要扫描的行数；",
      "② 只取需要的列（不要 SELECT *），先做分组计数确认规模，再取明细；",
      "③ 优先用现成的聚合卡片（list_cards / get_card）替代手写全扫。",
    ].join("\n");
  }
  if (/Code:\s*394|TIMEOUT|timeout/i.test(t)) {
    return [
      "推断：查询被取消（Code 394 / 超时）——很可能因为执行太久被客户端或上游掐断。",
      "① 缩小范围、加过滤、降维度后重试；",
      "② 先用轻量聚合（count / 单列 group by）确认量级，再决定要不要取明细。",
    ].join("\n");
  }
  return null;
}
