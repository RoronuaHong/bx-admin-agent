// Metabase MCP 适配器（stdio）：把 Metabase REST API 暴露为 MCP 工具。
// 鉴权：请求头 X-API-Key（Metabase API Key，无 Bearer 前缀）。
// 配置来源：环境变量 BI_BASE_URL（实例地址）+ BI_API_KEY（API Key），由父进程继承 / .env 注入。
// 接口形状按实例自带 OpenAPI（GET /api/docs/openapi.json）核对；要点：
//   - 仪表盘详情的卡片数组字段是 dashcards（旧版才是 ordered_cards）；
//   - 数据库元数据用 skip_fields=true 只取表清单，避免一次吐出全部表的所有字段；
//   - POST /api/dataset 可能返回 202 + status，需判 data.cols 是否存在。
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.BI_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.BI_API_KEY || "";

async function mb(path, { method = "GET", body } = {}) {
  if (!BASE || !KEY) {
    return { ok: false, status: 0, text: "未配置 BI_BASE_URL 或 BI_API_KEY（在 apps/agent-server/.env 填写）。" };
  }
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
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
      "查看数据库的表结构。默认只返回表清单（可用 search 过滤表名）；指定 table 时返回该表的字段（name/type）。写 SQL 前用它确认表名与字段名。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）" },
        table: { type: "string", description: "表名（精确匹配，可写 schema.table）；给了就返回该表字段" },
        search: { type: "string", description: "按表名子串过滤（不区分大小写），仅在未指定 table 时生效" },
        include_fields: { type: "boolean", description: "表清单里是否附带字段（默认 false；表多时不要开）" },
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
        return json({
          table: hit.name,
          schema: hit.schema,
          fields: (hit.fields || []).map((f) => ({
            name: f.name,
            type: f.base_type,
            ...(f.semantic_type ? { semantic: f.semantic_type } : {}),
          })),
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
          // 只有真的取回了字段时才报数量（skip_fields 模式下字段为空数组，报 0 会误导）。
          ...(include_fields === true && Array.isArray(t.fields) ? { fieldCount: t.fields.length } : {}),
        })),
        ...(matched.length > cap ? { note: `仅列出前 ${cap} 张，可用 search 过滤或用 table 精确查看某张表` } : {}),
      });
    },
  },
  {
    name: "run_native_query",
    description: "在指定数据库执行原生 SQL（SELECT 等），返回行列文本。最多返回 limit 行（默认 200），超长自动截断。",
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
      const r = await mb("/dataset", {
        method: "POST",
        body: { database: database_id, type: "native", native: { query } },
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
        lines.push(row.map((v) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v))).join("\t"));
      }
      if (truncated) lines.push(`…(已截断，共 ${allRows.length} 行，仅显示前 ${limit} 行)`);
      return json(lines.join("\n"));
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return json(`未知工具：${req.params.name}`, true);
  try {
    return await tool.run(req.params.arguments || {});
  } catch (err) {
    return json(`工具执行失败：${String(err?.message || err)}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[bi-metabase] stdio MCP server started");
