// P1.1：M-Schema 惰性取值充实（doc §11.5）。
//
// 背景：本仓库 ClickHouse 后端的 Metabase 不填 fingerprint.type.values，M-Schema 的取值域只能
// 回落到字段 description 里的手写枚举，而 T4 实测证明这些枚举会过期（clientType 描述 1/2/4/6，
// 真实是 1/4/0/5）。本模块在调用方**显式**要求时（get_database_schema 的 with_values=true）
// 只对「看起来像枚举」的少数字段跑一次取样 DISTINCT，用实测值覆盖过期描述。
//
// 护栏：默认不启用（零额外延迟）；候选字段数有上限；取样行数有上限；并发有上限；结果带 TTL 缓存，
// 失败也缓存（不反复撞超时）；任何单字段失败都只回落、不影响整张表的 M-Schema。
import { pickEnumFields } from "./metabase-mschema.mjs";

const IDENT = /^[A-Za-z0-9_$]+$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SCAN_ROWS = 200000;
const MAX_VALUES = 30;

export function createLiveValueCache() {
  return new Map();
}

function qualifiedName(table) {
  const name = String(table?.name || "");
  const schema = table?.schema && table.schema !== "public" ? String(table.schema) : "";
  if (!IDENT.test(name) || (schema && !IDENT.test(schema))) return null; // 拼进 SQL 前先挡住非法标识符
  return schema ? `\`${schema}\`.\`${name}\`` : `\`${name}\``;
}

/** 单字段实测去重值：先取样再 DISTINCT，避免大表全表分组把请求拖到超时。NULL/空串保留（它们是真实取值）。 */
export async function fetchLiveFieldValues(mb, { databaseId, table, field, scanRows = SCAN_ROWS, maxValues = MAX_VALUES }) {
  const qname = qualifiedName(table);
  const col = String(field?.name || "");
  if (!qname || !IDENT.test(col)) return null;
  const scan = Math.min(Math.max(Number(scanRows) || SCAN_ROWS, 1), SCAN_ROWS);
  const cap = Math.min(Math.max(Number(maxValues) || MAX_VALUES, 1), MAX_VALUES);
  const sql =
    `SELECT DISTINCT \`${col}\` AS value FROM (SELECT \`${col}\` FROM ${qname} LIMIT ${scan}) AS s ` +
    `ORDER BY 1 LIMIT ${cap}`;
  const res = await mb("/dataset", {
    method: "POST",
    body: { database: databaseId, type: "native", native: { query: sql } },
    query: true,
  });
  if (!res?.ok || !Array.isArray(res.data?.data?.rows)) return null;
  return res.data.data.rows.map((r) => r[0] ?? null);
}

/**
 * 批量填充实测取值。返回 { overrides: Map<字段名, 值[]>, stats }，overrides 可直接传给 renderTableMSchema。
 * cache 由调用方持有（跨工具调用复用），key = databaseId|schema.table|field。
 */
export async function fillLiveValues({
  mb,
  databaseId,
  table,
  maxFields = 8,
  cache = createLiveValueCache(),
  ttlMs = DEFAULT_TTL_MS,
  concurrency = 3,
  now = Date.now,
} = {}) {
  const overrides = new Map();
  const candidates = pickEnumFields(table?.fields, maxFields);
  const stats = { candidates: candidates.length, attempted: 0, succeeded: 0, fromCache: 0, noValues: 0 };
  const keyPrefix = `${databaseId}|${table?.schema || ""}.${table?.name || ""}|`;
  const width = Math.max(1, Math.min(Number(concurrency) || 3, 8));
  for (let i = 0; i < candidates.length; i += width) {
    const batch = candidates.slice(i, i + width);
    const vals = await Promise.all(
      batch.map(async (f) => {
        const key = keyPrefix + f.name;
        const hit = cache.get(key);
        if (hit && now() - hit.ts < ttlMs) {
          stats.fromCache++;
          return hit.values;
        }
        stats.attempted++;
        let values = null;
        try {
          values = await fetchLiveFieldValues(mb, { databaseId, table, field: f });
        } catch {
          values = null;
        }
        cache.set(key, { ts: now(), values });
        return values;
      }),
    );
    batch.forEach((f, k) => {
      const v = vals[k];
      if (Array.isArray(v) && v.length) {
        overrides.set(f.name, v);
        stats.succeeded++;
      } else if (v === null) {
        stats.noValues++;
      }
    });
  }
  return { overrides, stats };
}
