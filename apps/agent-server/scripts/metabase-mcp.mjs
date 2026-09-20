// Metabase MCP 适配器（stdio）：把 Metabase REST API 暴露为 MCP 工具。
// 鉴权：请求头 X-API-Key（Metabase API Key，无 Bearer 前缀）。
// 配置来源：环境变量 BI_BASE_URL（实例地址）+ BI_API_KEY（API Key），由父进程继承 / .env 注入。
// 接口形状按实例自带 OpenAPI（GET /api/docs/openapi.json）核对；要点：
//   - 仪表盘详情的卡片数组字段是 dashcards（旧版才是 ordered_cards）；
//   - 数据库元数据用 skip_fields=true 只取表清单，避免一次吐出全部表的所有字段；
//   - POST /api/dataset 可能返回 202 + status，需判 data.cols 是否存在。
//   - 元数据里本可用的「描述 / 语义类型 / 外键指向 / 指纹统计」必须映射出来：丢掉它们，
//     模型就只能靠字段名猜语义（把真实存在的取值当成脏数据）。取证能力是取数正确性的前提。
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.BI_BASE_URL || "").replace(/\/+$/, "");
// 凭据：优先**只读账号**（`BI_READONLY_API_KEY`），没有才回落管理员 Key——保留回滚路径，不覆盖原配置。
// 定位要说清：换 Key 只是让「本适配器以只读身份访问」，真正的只读边界仍须由数据库/账号层强制
// （专用角色 + 只 GRANT SELECT），见 docs/text2sql-text2api-plan.md 的 P1-1。
const KEY = process.env.BI_READONLY_API_KEY || process.env.BI_API_KEY || "";

/**
 * 单次请求超时（默认 30s，可配 BI_TIMEOUT_MS；BI 查询 legitimately 慢时用 env 调大）。
 * 最佳实践：外部调用必须有界——否则一个挂住的查询会占住整个 stdio 连接，
 * 表现为「模型卡住不动」且没有任何可诊断信息。超时后 fail-closed 并返回可操作提示。
 * **局限**：客户端 abort 只是「不再等」，数据库上的那条 SQL 仍在跑；要真正掐断需在 DB 层设
 * statement_timeout。所以这条防的是「agent 会话被拖死」，不是「数据库被拖死」。
 */
const TIMEOUT_MS = Number(process.env.BI_TIMEOUT_MS || 30_000);

async function mb(path, { method = "GET", body } = {}) {
  if (!BASE || !KEY) {
    return { ok: false, status: 0, text: "未配置 BI_BASE_URL 或 BI_API_KEY（在 apps/agent-server/.env 填写）。" };
  }
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": KEY },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // 超时/网络错误统一塞进 data（字符串）：调用方原有 `[status] data` 的渲染无需改动即可显示人话。
    const aborted = err?.name === "TimeoutError" || err?.name === "AbortError";
    const text = aborted
      ? `请求超时（${TIMEOUT_MS}ms；可用 BI_TIMEOUT_MS 调大，并确认服务器配置的 timeoutMs 不小于它）`
      : `请求失败：${String(err?.message || err)}`;
    return { ok: false, status: 0, text, data: text };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

function json(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

// Metabase 列表接口有的返回裸数组、有的包成 { data: [...] }，统一取出数组。
function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

// ---- 只读 SQL 硬校验（纵深防御，与服务端 src/sql-readonly.ts 口径对齐）----
// 即便本适配器拿到的是管理员 Key，也只转发只读查询——把「贴只读标签的核武器」风险降到最低。
// 首词白名单 + 全文黑名单 + 危险构造（写文件 / 读文件 / 改库配置）。fail-closed：不明朗一律拒绝。
// 局限：这是代码层约束；Key 一旦泄露、攻击者直连 Metabase API 即可绕过。真正的只读边界仍须 DB/账号层 GRANT SELECT。
const RO_LEADING = ["select", "with", "show", "describe", "desc", "explain"];
const RO_DENY = /\b(insert|update|delete|drop|alter|create|truncate|merge|replace|upsert|grant|revoke|attach|detach|exec|execute|call|copy|load|set|reset)\b/;
const RO_DENY_PATTERNS = [/into\s+(out|dump)file/, /load_file\s*\(/, /pg_read_file\s*\(/, /writable_schema/];
function stripSqlComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}
/**
 * 是否可安全放行的单条只读查询（脱引号/注释后判定，避免字面量/注释里的关键字被误判）。
 * ⚠️ 口径一致性：服务端另有**权威判定** `src/sql-readonly.ts` 的 `isReadOnlySql`（经 src/risk.ts
 * 在工具抵达 MCP 之前再拦一道）。两处是刻意的纵深防御（适配器粗筛 + 服务端硬拒），
 * 但口径必须一致——修改本函数的白名单/黑名单/多语句规则时，必须同步修改 `src/sql-readonly.ts`。
 */
function isReadOnlySql(raw) {
  const sql = stripSqlComments(String(raw ?? ""))
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim();
  if (!sql) return false;
  const parts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 1) return false; // 多语句一律拒绝
  const lower = parts[0].toLowerCase();
  const first = lower.match(/^[a-z]+/)?.[0] || "";
  return RO_LEADING.includes(first) && !RO_DENY.test(lower) && !RO_DENY_PATTERNS.some((re) => re.test(lower));
}

// ---- 元数据映射：写查询之前的「取证」基础 ----

/** 表清单里带字段时，字段预览最多列多少个名字（够模型认路，不至于把输出撑爆）。 */
const FIELD_PREVIEW = 25;

/** 取值域兜底查询的默认取样行数 / 上限：大表全表分组会跑到调用超时，默认只看前若干行。 */
const SAMPLE_ROWS = 200_000;
const SAMPLE_MAX = 5_000_000;

/** 压成单行并截断：描述类文本经常很长，回灌模型前先瘦身。 */
function clipText(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 字段 id → "表.字段"：把外键指向解析成人可读引用，而不是一个裸 id。 */
function buildFieldIndex(tables) {
  const byId = new Map();
  for (const t of tables) {
    for (const f of t.fields || []) byId.set(f.id, `${t.name}.${f.name}`);
  }
  return byId;
}

/**
 * 指纹里的通用统计（Metabase fingerprint）：去重值个数 + NULL 占比。
 * 这两个数字能直接回答「这列是不是枚举 / 有没有大量空值」，是「别凭字段名猜语义」的第一手证据。
 */
function fingerprintHints(field) {
  const global = field?.fingerprint?.global;
  if (!global || typeof global !== "object") return {};
  const distinct = global["distinct-count"];
  const nil = global["nil%"];
  return {
    ...(typeof distinct === "number" ? { distinctValues: distinct } : {}),
    ...(typeof nil === "number" ? { nullRatio: Number(nil.toFixed(4)) } : {}),
  };
}

/** 字段的统一映射：名字/类型之外，带上描述、语义、外键指向与取值域线索（有才带，避免噪声）。 */
function mapField(field, fieldIndex) {
  const fk = field.fk_target_field_id ? fieldIndex.get(field.fk_target_field_id) : null;
  return {
    name: field.name,
    type: field.base_type,
    ...(field.semantic_type ? { semantic: field.semantic_type } : {}),
    ...(field.description ? { description: clipText(field.description, 200) } : {}),
    ...(fk ? { references: fk } : field.fk_target_field_id ? { references: `field#${field.fk_target_field_id}` } : {}),
    ...fingerprintHints(field),
  };
}

/** 单元格渲染：NULL 与空串必须**看得出来**（两者都是真实取值，不是「没有数据」）。 */
function renderCell(value) {
  if (value === null) return "NULL";
  if (value === "") return "''(空串)";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * 只读工具名单：用于声明 MCP 标准注解 readOnlyHint（服务端风险判定第 4 条据此免确认）。
 * 例外 `run_native_query` **不在名单里**——它执行任意 SQL，效果取决于传入的 SQL 文本，
 * 因此不声明只读，交由服务端按 toolRisks / 未知兜底决定是否需要用户确认（与 yapi 适配器同一原则：
 * 声明事实而非放行，服务端策略优先级高于工具自述）。
 */
const READ_ONLY_TOOLS = new Set([
  "list_databases",
  "get_database_schema",
  "get_field_values",
  "list_cards",
  "list_dashboards",
  "get_dashboard",
  "get_card",
  "search",
]);
// 只读工具天然幂等（`idempotentHint`，MCP 注解）：供客户端/网关判断失败后能否安全重试。
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

const TOOLS = [
  {
    name: "list_databases",
    description: "列出 Metabase 已连接的所有数据库（id / name / engine）。",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const r = await mb("/database");
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const rows = asList(r.data).map((d) => ({
        id: d.id,
        name: d.name,
        engine: d.engine,
        timezone: d.timezone,
        ...(d.is_sample === true ? { sample: true } : {}),
      }));
      return json(rows);
    },
  },
  {
    name: "get_database_schema",
    description:
      "查看数据库的表结构。默认只返回表清单（可用 search 过滤表名，带表描述）；指定 table 时返回该表的字段" +
      "（name / type / 描述 / 语义类型 / 外键指向 / 去重值个数）。写查询前用它确认表名、字段名与字段语义，不要凭字段名猜。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）" },
        table: { type: "string", description: "表名（精确匹配，可写 schema.table）；给了就返回该表字段" },
        search: { type: "string", description: "按表名子串过滤（不区分大小写），仅在未指定 table 时生效" },
        include_fields: { type: "boolean", description: "表清单里是否附带字段名预览（默认 false；表多时不要开）" },
      },
      required: ["database_id"],
    },
    async run({ database_id, table, search, include_fields }) {
      const wantFields = Boolean(table) || include_fields === true;
      // skip_fields 是官方参数：只取表清单时用它，避免一次拉回所有表的所有字段。
      const r = await mb(`/database/${database_id}/metadata${wantFields ? "" : "?skip_fields=true"}`);
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const tables = Array.isArray(r.data?.tables) ? r.data.tables : [];
      if (!tables.length) {
        return json(`数据库 ${database_id} 未返回表（可能元数据未同步或该 API Key 无权限）。`);
      }
      if (table) {
        const needle = String(table).trim().toLowerCase();
        const hit = tables.find((t) => {
          const bare = String(t.name || "").toLowerCase();
          const qualified = `${t.schema ? `${t.schema}.` : ""}${t.name}`.toLowerCase();
          return bare === needle || qualified === needle;
        });
        if (!hit) {
          const names = tables.map((t) => t.name).slice(0, 40);
          return json(
            `未找到表「${table}」。同库表名（前 40）：${names.join(", ")}${tables.length > 40 ? ` …共 ${tables.length} 张` : ""}`,
            true,
          );
        }
        // 字段索引在整库范围内建：外键指向可能落在别的表上，必须跨表解析。
        const fieldIndex = buildFieldIndex(tables);
        return json({
          table: hit.name,
          schema: hit.schema,
          ...(hit.description ? { description: clipText(hit.description, 400) } : {}),
          fieldCount: (hit.fields || []).length,
          fields: (hit.fields || []).map((f) => mapField(f, fieldIndex)),
        });
      }
      const matched = search
        ? tables.filter((t) => String(t.name || "").toLowerCase().includes(String(search).toLowerCase()))
        : tables;
      // 带字段时单表体积大得多，条数上限收紧，避免一次输出过大被截断。
      const cap = include_fields === true ? 20 : 80;
      return json({
        totalTables: tables.length,
        matched: matched.length,
        tables: matched.slice(0, cap).map((t) => ({
          table: t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name,
          ...(t.description ? { description: clipText(t.description, 160) } : {}),
          // 只有真的取回了字段时才报数量与名字（skip_fields 模式下字段为空数组，报 0 会误导）。
          // 只给 fieldCount 而不给名字，对模型等于没有信息——这里给一段字段名预览。
          ...(include_fields === true && Array.isArray(t.fields)
            ? {
                fieldCount: t.fields.length,
                fields: t.fields.slice(0, FIELD_PREVIEW).map((f) => f.name),
                ...(t.fields.length > FIELD_PREVIEW ? { fieldsTruncated: true } : {}),
              }
            : {}),
        })),
        ...(matched.length > cap ? { note: `仅列出前 ${cap} 张，可用 search 过滤或用 table 精确查看某张表` } : {}),
      });
    },
  },
  {
    name: "get_field_values",
    description:
      "查看某字段的取值分布（去重值 + 出现次数）。写过滤 / 分组条件之前先用它确认合法取值与空值语义：" +
      "取值里若存在空串或某个默认值，说明它是真实存在的取值，不能当成脏数据顺手排除。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）" },
        table: { type: "string", description: "表名（精确匹配，可写 schema.table）" },
        field: { type: "string", description: "字段名（精确匹配，不区分大小写）" },
        limit: { type: "number", description: "最多返回多少个取值，按出现次数从多到少（默认 50）" },
        sample: {
          type: "number",
          description:
            "取样行数上限：传了就走「带出现次数」的统计路径，默认 200000 行（大表全表分组会超时，所以只扫前 N 行），" +
            "传 0 = 全表精确统计（可能很慢）。不传则优先用实例缓存的取值列表（最快，但不含出现次数）",
        },
      },
      required: ["database_id", "table", "field"],
    },
    async run({ database_id, table, field, limit = 50, sample }) {
      // 标识符白名单校验：表名 / 字段名会拼进兜底 SQL，只放行安全字符（含 schema.table 形式）。
      const ident = (v) => /^[A-Za-z0-9_$]+$/.test(String(v ?? "").trim());
      const parts = String(table ?? "").trim().split(".");
      if (!parts.length || !parts.every(ident) || !ident(field)) {
        return json("表名或字段名不合法：只允许字母、数字、下划线、$（表名可用 schema.table 形式）。", true);
      }
      const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);

      const r = await mb(`/database/${database_id}/metadata`);
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const tables = Array.isArray(r.data?.tables) ? r.data.tables : [];
      const needle = String(table).trim().toLowerCase();
      const hit = tables.find((t) => {
        const bare = String(t.name || "").toLowerCase();
        const qualified = `${t.schema ? `${t.schema}.` : ""}${t.name}`.toLowerCase();
        return bare === needle || qualified === needle;
      });
      if (!hit) return json(`未找到表「${table}」。请先用 get_database_schema 确认表名（可带 search 过滤）。`, true);
      const want = String(field).trim().toLowerCase();
      const col = (hit.fields || []).find((f) => String(f.name || "").toLowerCase() === want);
      if (!col) {
        const names = (hit.fields || []).map((f) => f.name).slice(0, 60);
        return json(`表「${hit.name}」没有字段「${field}」。该表字段（最多列 60）：${names.join(", ")}`, true);
      }

      const hints = {
        table: hit.schema && hit.schema !== "public" ? `${hit.schema}.${hit.name}` : hit.name,
        field: col.name,
        type: col.base_type,
        ...(col.semantic_type ? { semantic: col.semantic_type } : {}),
        ...(col.description ? { description: clipText(col.description, 200) } : {}),
        ...fingerprintHints(col),
      };

      // 路径 1：实例已缓存的字段取值（列表型字段才有，最省一次查询，但**没有出现次数**）。
      // 显式传了 sample 就跳过它、直接走带计数的路径——否则「想看次数」这个诉求没有出口。
      if (sample === undefined && col.has_field_values && col.has_field_values !== "nil") {
        const listed = await mb(`/field/${col.id}/values`);
        if (listed.ok) {
          const raw = Array.isArray(listed.data?.values) ? listed.data.values : [];
          const values = raw
            .map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : v))
            .slice(0, cap)
            .map((v) => (v && typeof v === "object" ? v : { value: v }));
          if (values.length) return json({ ...hints, source: "field-values", values });
        }
      }

      // 路径 2：最小聚合查询（去重值 + 出现次数）。
      // 大表上全表分组会跑到调用超时，所以默认**带取样上限**（子查询 + LIMIT，跨库通用写法不依赖方言）：
      // 取值集合与排序稳定，但计数在超大表上是样本估计——如实标注，不冒充精确值；要精确就传 sample=0。
      const scan = Number.isFinite(Number(sample)) ? Math.min(Math.max(Number(sample), 0), SAMPLE_MAX) : SAMPLE_ROWS;
      const qualified = hit.schema && hit.schema !== "public" ? `${hit.schema}.${hit.name}` : hit.name;
      const inner = `SELECT ${col.name} FROM ${qualified}${scan > 0 ? ` LIMIT ${scan}` : ""}`;
      const sql =
        `SELECT ${col.name} AS value, COUNT(*) AS occurrences FROM (${inner}) AS sampled ` +
        `GROUP BY value ORDER BY COUNT(*) DESC LIMIT ${cap}`;
      const res = await mb("/dataset", {
        method: "POST",
        body: { database: database_id, type: "native", native: { query: sql } },
      });
      const payload = res.data?.data;
      if (!res.ok || !payload || !Array.isArray(payload.cols)) {
        return json(
          {
            ...hints,
            source: "unavailable",
            note: "取不到取值分布：字段取值缓存未启用，且聚合查询未返回结果（可缩小范围后重试）。",
          },
          true,
        );
      }
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const values = rows.map((row) => ({ value: row[0] ?? null, occurrences: row[1] }));
      // 空值 / 空串必须显式点出来：它们是真实存在的取值，不是「没有数据」。
      const hasEmpty = rows.some((row) => row[0] === null || row[0] === "");
      const notes = [
        ...(hasEmpty ? ["取值里包含 NULL 或空串——它们是真实存在的取值，排除之前先确认业务含义。"] : []),
        ...(scan > 0 ? [`计数基于最多 ${scan} 行取样（要全表精确统计请传 sample=0，大表可能很慢）。`] : []),
      ];
      return json({
        ...hints,
        source: "group-by",
        sql,
        ...(scan > 0 ? { approximate: true, scanLimit: scan } : { exact: true }),
        values,
        ...(notes.length ? { note: notes.join(" ") } : {}),
        ...(rows.length >= cap ? { truncated: `只取出现次数最多的 ${cap} 个取值，可能还有更多` } : {}),
      });
    },
  },
  {
    name: "run_native_query",
    description:
      "在指定数据库执行原生 SQL（仅只读：SELECT / WITH / SHOW / EXPLAIN 等），返回行列文本。最多返回 limit 行（默认 200），超长自动截断。" +
      "写操作（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/…）会被本工具直接拒绝，无法经此改库。" +
      "写复杂 SQL 前可先用 list_cards / get_card / search 看看有没有现成的已验证查询，避免重复写 SQL；" +
      "只接受单条语句。回复时请给出实际执行的 SQL 与口径说明（用了哪些字段、哪些过滤条件）：" +
      "最危险的失效不是报错，而是「跑通了但口径错、数字看着还挺合理」——展示出来才可被核对。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）" },
        query: { type: "string", description: "原生 SQL 语句" },
        limit: { type: "number", description: "返回行数上限（默认 200）" },
      },
      required: ["database_id", "query"],
    },
    async run({ database_id, query, limit = 200 }) {
      // 单语句约束（数据源侧的纵深防御）：多语句一律拒绝，不执行。
      // 单条语句是读是写由服务端风险闸门判定（src/risk.ts 用 src/sql-readonly.ts 判定后决定是否弹确认卡），
      // 这里只额外堵住「一次塞多条」这个没有正当用途的口子。
      const sql = String(query ?? "").trim().replace(/;+\s*$/, "");
      if (!sql) return json("SQL 为空。", true);
      // 多语句判定只看「引号外 / 注释外」的分号：字符串/标识符里的分号（如 WHERE note='a;b'）
      // 不算多语句。与 src/sql-readonly.ts 的判定口径对齐，避免误杀合法单条查询。
      const bare = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n\r]*/g, " ")
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""')
        .replace(/`[^`]*`/g, "``");
      if (bare.includes(";")) return json("不接受多语句：一次只能执行一条 SQL。", true);

      // 只读硬校验（纵深防御）：只转发 SELECT/WITH/SHOW/EXPLAIN 等只读查询；写操作在这里就被拦下，
      // 不依赖服务端确认闸门——哪怕持有管理员 Key，也无法经本工具改库。
      if (!isReadOnlySql(sql)) {
        return json("只接受只读查询（SELECT / WITH / SHOW / EXPLAIN 等），写操作（INSERT/UPDATE/DELETE/DROP/…）被拒绝。", true);
      }

      const r = await mb("/dataset", {
        method: "POST",
        body: { database: database_id, type: "native", native: { query: sql } },
      });
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const payload = r.data?.data;
      if (!payload || !Array.isArray(payload.cols)) {
        // 异步查询：可能先返回 status=running（HTTP 202），此时没有 cols/rows。
        const state = r.data?.status ? `status=${r.data.status}` : "响应中缺少 data.cols";
        return json(`查询未返回结果（${state}，HTTP ${r.status}）。请稍后重试或缩小查询范围。`, true);
      }
      const cols = payload.cols.map((c) => c.display_name || c.name);
      const allRows = Array.isArray(payload.rows) ? payload.rows : [];
      const truncated = allRows.length > limit;
      const rows = allRows.slice(0, limit);
      const lines = [cols.join("\t")];
      for (const row of rows) {
        // NULL 与空串区分渲染（同 renderCell）：两者都是真实取值，不要混成「空」。
        lines.push(row.map(renderCell).join("\t"));
      }
      if (truncated) lines.push(`…(已截断，共 ${allRows.length} 行，仅显示前 ${limit} 行)`);
      // G17 结果合理性展示：回显实际执行的 SQL，便于核对口径（join 路径 / 过滤条件是否漏）。
      // 提示注入防护在 chat.ts 层仍会把整段包进 untrusted 定界；这里回显的是模型自己提交的 SQL，无新增不可信面。
      const echo = `-- 实际执行的 SQL（仅供核对口径，不要重复执行）：\n${sql}`;
      return json(`${echo}\n\n${lines.join("\n")}`);
    },
  },
  {
    name: "list_cards",
    description: "列出 Metabase 已保存的提问（Questions / 卡片）：id / name / 数据库 / 集合。可用 search 过滤名称。",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "按名称子串过滤（不区分大小写）" },
        limit: { type: "number", description: "最多返回条数（默认 50）" },
      },
    },
    async run({ search, limit = 50 } = {}) {
      const r = await mb("/card");
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      let rows = asList(r.data).map((c) => ({
        id: c.id,
        name: c.name,
        database: c.database_id,
        collection: c.collection?.name ?? c.collection_id ?? null,
        ...(c.query_type ? { queryType: c.query_type } : {}),
      }));
      if (search) {
        const needle = String(search).toLowerCase();
        rows = rows.filter((x) => String(x.name || "").toLowerCase().includes(needle));
      }
      return json({ total: rows.length, cards: rows.slice(0, limit) });
    },
  },
  {
    name: "list_dashboards",
    description: "列出 Metabase 仪表盘（Dashboards）：id / name / 集合。可用 search 过滤名称。",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string", description: "按名称子串过滤（不区分大小写）" } },
    },
    async run({ search } = {}) {
      // 注：官方 OpenAPI 把 GET /api/dashboard 标为 deprecated，但当前版本仍可用且返回裸数组。
      const r = await mb("/dashboard");
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      let rows = asList(r.data).map((d) => ({
        id: d.id,
        name: d.name,
        collection: d.collection?.name ?? d.collection_id ?? null,
      }));
      if (search) {
        const needle = String(search).toLowerCase();
        rows = rows.filter((x) => String(x.name || "").toLowerCase().includes(needle));
      }
      return json(rows);
    },
  },
  {
    name: "get_dashboard",
    description: "获取某个仪表盘详情（标题、包含的卡片 id/名称/可视化类型）。",
    inputSchema: {
      type: "object",
      properties: { dashboard_id: { type: "number", description: "仪表盘 id（来自 list_dashboards）" } },
      required: ["dashboard_id"],
    },
    async run({ dashboard_id }) {
      const r = await mb(`/dashboard/${dashboard_id}`);
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      // 卡片数组字段：v0.5x+ 用 dashcards（ordered_cards 已被移除，仅老版本存在）。
      const raw = Array.isArray(r.data?.dashcards)
        ? r.data.dashcards
        : Array.isArray(r.data?.ordered_cards)
          ? r.data.ordered_cards
          : [];
      const cards = raw.map((dc) => ({
        card_id: dc.card?.id ?? dc.card_id ?? null,
        name: dc.card?.name ?? dc.visualization_settings?.text ?? null,
        visualization: dc.card?.display ?? null,
        ...(dc.dashboard_tab_id ? { tab: dc.dashboard_tab_id } : {}),
      }));
      return json({ id: r.data.id, name: r.data.name, tabs: (r.data.tabs || []).length, cards });
    },
  },
  {
    name: "get_card",
    description:
      "获取某个已保存提问（卡片）的详情，并尽量给出其**原生 SQL**（MBQL 卡片由服务端编译成 SQL）；编译失败时才退回原始查询定义。",
    inputSchema: {
      type: "object",
      properties: { card_id: { type: "number", description: "卡片 id（来自 list_cards / search）" } },
      required: ["card_id"],
    },
    async run({ card_id }) {
      // legacy-mbql=true：把 dataset_query 统一成 {database,type,query}，便于编译成 SQL。
      const legacy = await mb(`/card/${card_id}?legacy-mbql=true`);
      const card = legacy.ok ? legacy.data : (await mb(`/card/${card_id}`)).data;
      if (!card) return json(`[${legacy.status}] ${JSON.stringify(legacy.data)}`, true);
      const dq = card.dataset_query || {};
      let sql = null;
      if (typeof dq.native?.query === "string") {
        sql = dq.native.query; // 原生卡片
      } else if (dq.type === "query" && dq.query) {
        // MBQL → 原生 SQL（POST /api/dataset/native，只编译不执行）
        const compiled = await mb("/dataset/native", {
          method: "POST",
          body: { database: dq.database, type: "query", query: dq.query },
        });
        if (compiled.ok && typeof compiled.data?.query === "string") sql = compiled.data.query;
      }
      return json({
        id: card.id,
        name: card.name,
        description: card.description,
        database: card.database_id,
        display: card.display,
        queryType: dq.type ?? card.query_type,
        ...(sql ? { sql } : { query: dq }),
      });
    },
  },
  {
    name: "search",
    description:
      "按关键词搜索 Metabase 资产（表 / 提问 / 仪表盘 / 集合等），用于写 SQL 前先定位数据在哪张表、哪个卡片里。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词（表名、指标名等）" },
        models: {
          type: "array",
          items: { type: "string" },
          description: "限定类型：table / card / dashboard / collection 等（可多选）",
        },
        limit: { type: "number", description: "最多返回条数（默认 20）" },
      },
      required: ["query"],
    },
    async run({ query, models, limit = 20 }) {
      const qs = new URLSearchParams({ q: String(query ?? "") });
      if (Array.isArray(models)) for (const item of models) qs.append("models", String(item));
      const r = await mb(`/search?${qs.toString()}`);
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const rows = asList(r.data).map((x) => ({
        model: x.model ?? x.model_name,
        id: x.id,
        name: x.name,
        ...(x.database_name ? { database: x.database_name } : {}),
        ...(x.table_name ? { table: x.table_name } : {}),
      }));
      return json({ total: r.data?.total ?? rows.length, results: rows.slice(0, limit) });
    },
  },
];

const server = new Server(
  { name: "bi-metabase", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// 自检：名单里的名字必须真实存在（改名后忘了同步只会「少宣告一次」，不会把执行类工具误宣告成只读）。
for (const name of READ_ONLY_TOOLS) {
  if (!TOOLS.some((tool) => tool.name === name)) {
    console.error(`[bi-metabase] READ_ONLY_TOOLS 含未知工具名：${name}（该条只读声明已忽略）`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
    ...(READ_ONLY_TOOLS.has(name) ? { annotations: READ_ONLY_ANNOTATIONS } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params.name || "");
  const tool = TOOLS.find((t) => t.name === name);
  // stdio 传输下 stdout 是协议通道，日志只能走 stderr（不会污染协议帧）。
  const startedAt = Date.now();
  if (!tool) {
    console.error(`[bi-metabase] tool=${name} 未知工具`);
    return json(`未知工具：${name}`, true);
  }
  try {
    const res = await tool.run(req.params.arguments || {});
    console.error(`[bi-metabase] tool=${name} ${Date.now() - startedAt}ms ${res.isError ? "error" : "ok"}`);
    return res;
  } catch (err) {
    console.error(`[bi-metabase] tool=${name} ${Date.now() - startedAt}ms 异常：${String(err?.message || err)}`);
    return json(`工具执行失败：${String(err?.message || err)}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[bi-metabase] stdio MCP server started");
