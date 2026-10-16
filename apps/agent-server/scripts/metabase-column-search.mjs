// 跨库列级检索的纯模块（MCP 适配器 import 即用；测试可直接 import，不连 stdio）。
//
// 根因：BI 归因类问题（如"退订归因"）需要跨多张表/多个库拼出关联列，但现有工具只能一次看一张表的
// schema，模型无从发现"某张表里其实有 unsubscribe_reason / cancel_reason 这类列"，于是以"库里没有"收尾。
// 该工具直接查后端系统目录（ClickHouse 的 system.columns），一次扫出所有库所有表里匹配某模式的列，
// 让模型能定位跨库关联列、再写 JOIN/聚合 SQL。SQL 由本模块按参数安全拼装，不靠业务词写死。

const MAX_PATTERN = 100;

/**
 * 拼装跨库列检索 SQL。ClickHouse 系统目录 system.columns 跨整个集群可见（任意 database_id 连接都能查）。
 * @param {string} pattern 列名/注释的模糊匹配词（子串）
 * @param {object} [opts]
 * @param {number} [opts.limit=200] 返回上限
 * @returns {{ok:true,sql:string}|{ok:false,error:string}}
 */
export function buildColumnSearchSql(pattern, opts = {}) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return { ok: false, error: "pattern 必须是非空字符串（要找的列名/注释子串）" };
  }
  const trimmed = pattern.trim().slice(0, MAX_PATTERN);
  // 注入防护：ClickHouse 字符串字面量用单引号，内部单引号翻倍转义；反斜杠同样转义。
  const safe = trimmed.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 1000) : 200;
  const sql =
    "SELECT database, table, name, type, comment\n" +
    "FROM system.columns\n" +
    `WHERE (name ILIKE '%${safe}%' OR comment ILIKE '%${safe}%')\n` +
    "ORDER BY database, table, name\n" +
    `LIMIT ${limit}`;
  return { ok: true, sql };
}
