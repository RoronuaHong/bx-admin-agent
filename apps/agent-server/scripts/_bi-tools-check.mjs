// BI（Metabase）适配器冒烟（只读）：走**我们自己的** MCP hub 与 .env 配置，
// 验证「配置 → 连接 → 工具清单 → 只读注解 → 元数据取证 → 字段取值域」整条链路。
// 只调元数据类工具，不执行任何 SQL（run_native_query 不在本脚本范围内）。
//
// 跑法：cd apps/agent-server && node --import tsx scripts/_bi-tools-check.mjs
import "dotenv/config";

const { loadServers } = await import("../src/mcp/config.js");
const { collectToolsDetailed, callMcpTool } = await import("../src/mcp/hub.js");
const { resolveToolRisk } = await import("../src/risk.js");

const BI = "bi";
const server = loadServers().find((s) => s.id === BI);
if (!server) {
  console.log(`FAIL：.env 的 MCP_BUILTIN_SERVERS 里没有 id=${BI} 的服务器`);
  process.exit(1);
}
if (!process.env.BI_BASE_URL || !process.env.BI_API_KEY) {
  console.log("SKIP：未配置 BI_BASE_URL / BI_API_KEY（在 apps/agent-server/.env 填写后重跑）");
  process.exit(0);
}

// 适配器暴露的全部工具；除执行任意 SQL 的那个外，其余都应声明只读注解。
const EXEC_TOOL = "run_native_query";
const EXPECT = [
  "list_databases",
  "get_database_schema",
  "get_field_values",
  "search",
  "list_cards",
  "get_card",
  "list_dashboards",
  "get_dashboard",
  EXEC_TOOL,
];
const READ_ONLY_EXPECT = EXPECT.filter((name) => name !== EXEC_TOOL);

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `：${detail}` : ""}`);
  if (!ok) failed += 1;
};

const collected = await collectToolsDetailed([BI]);
const ready = collected.ready.find((item) => item.id === BI);
const unavailable = collected.unavailable.map((item) => `${item.id}(${item.reason})`).join("|");
console.log(`连接：connected=${Boolean(ready)} 工具数=${ready?.tools ?? 0} 不可用=${unavailable || "-"}`);
if (!ready) {
  console.log("\n=== bi-tools FAIL（BI 未连接：先检查 .env 的 BI_BASE_URL / BI_API_KEY） ===");
  process.exit(1);
}

const byTool = new Map(collected.tools.map((tool) => [tool.tool, tool]));
console.log(`工具清单（${collected.tools.length}）：${collected.tools.map((tool) => tool.tool).join("、")}`);
check(
  EXPECT.every((name) => byTool.has(name)) && collected.tools.length === EXPECT.length,
  "工具清单与适配器一致",
  `期望 ${EXPECT.length} 个 / 实际 ${collected.tools.length} 个，缺=${EXPECT.filter((name) => !byTool.has(name)).join(",") || "-"}`,
);
// 只读工具应同时声明 readOnlyHint 与 idempotentHint（幂等 → 失败可安全重试）。
const missingAnnotation = READ_ONLY_EXPECT.filter(
  (name) => byTool.get(name)?.annotations?.readOnlyHint !== true || byTool.get(name)?.annotations?.idempotentHint !== true,
);
check(
  missingAnnotation.length === 0,
  "只读工具已声明 readOnlyHint + idempotentHint",
  missingAnnotation.join(",") || `${READ_ONLY_EXPECT.length}/${READ_ONLY_EXPECT.length}`,
);
check(byTool.get(EXEC_TOOL)?.annotations?.readOnlyHint !== true, `${EXEC_TOOL} 未声明只读（执行任意 SQL，交由服务端定级）`);

// 风险级别：新工具必须在服务器配置里显式定级，否则走「未知」兜底＝每次调用都弹确认卡。
const readVerdict = resolveToolRisk(`mcp__${BI}__get_field_values`);
check(
  readVerdict.level === "read" && readVerdict.source === "tool-config",
  "get_field_values 已在服务器配置里定为 read",
  `level=${readVerdict.level} source=${readVerdict.source}`,
);
const execVerdict = resolveToolRisk(`mcp__${BI}__${EXEC_TOOL}`);
check(execVerdict.level !== "read", `${EXEC_TOOL} 不是 read（按配置定级）`, `level=${execVerdict.level} source=${execVerdict.source}`);

// 1) 元数据：表清单（带表描述 / 字段名预览）→ 指定表取字段（描述 / 外键指向 / 去重值个数等取证信息）
const dbs = await callMcpTool(`mcp__${BI}__list_databases`, {});
let dbId = null;
try {
  const arr = JSON.parse(dbs.text);
  dbId = Array.isArray(arr) ? (arr.find((d) => typeof d?.id === "number")?.id ?? null) : null;
} catch {
  /* 下面统一报错 */
}
check(Number.isFinite(dbId), "list_databases 返回可用数据库", dbs.text.slice(0, 160));
if (!Number.isFinite(dbId)) {
  console.log("\n=== bi-tools FAIL（前置步骤未通过） ===");
  process.exit(1);
}

const listed = await callMcpTool(`mcp__${BI}__get_database_schema`, { database_id: dbId, include_fields: true });
let listedJson = null;
try {
  listedJson = JSON.parse(listed.text);
} catch {
  /* 下面统一报错 */
}
const tables = Array.isArray(listedJson?.tables) ? listedJson.tables : [];
check(tables.length > 0, "表清单可用", `totalTables=${listedJson?.totalTables} matched=${listedJson?.matched}`);
check(
  tables.some((t) => Array.isArray(t.fields) && t.fields.length > 0),
  "include_fields 真的回字段名（不是只给数量）",
  `示例：${tables[0]?.table} → ${(tables[0]?.fields || []).slice(0, 6).join(",") || "-"}`,
);

// 表清单的 search 过滤（此前未覆盖）：用一个通用字母作子串，验证「过滤生效且不越过总数」。
const searched = await callMcpTool(`mcp__${BI}__get_database_schema`, { database_id: dbId, search: "e" });
let searchedJson = null;
try {
  searchedJson = JSON.parse(searched.text);
} catch {
  /* 下面报错 */
}
check(
  (searchedJson?.matched ?? 0) > 0 && (searchedJson?.matched ?? 0) <= (searchedJson?.totalTables ?? 0),
  "search 过滤生效",
  `matched=${searchedJson?.matched}/${searchedJson?.totalTables}`,
);

// 挑字段最多的表做取证覆盖统计（挑第一张容易命中只有 1 个字段的临时表，计数无参考价值）。
const target =
  tables
    .filter((t) => Array.isArray(t.fields) && t.fields.length > 0)
    .sort((a, b) => (b.fields?.length || 0) - (a.fields?.length || 0))[0] || tables[0];
const detail = await callMcpTool(`mcp__${BI}__get_database_schema`, { database_id: dbId, table: target.table });
let detailJson = null;
try {
  detailJson = JSON.parse(detail.text);
} catch {
  /* 下面统一报错 */
}
const fields = Array.isArray(detailJson?.fields) ? detailJson.fields : [];
check(fields.length > 0, `指定表返回字段（${target.table}）`, `fieldCount=${detailJson?.fieldCount}`);
const withDesc = fields.filter((f) => f.description).length;
const withRef = fields.filter((f) => f.references).length;
const withDistinct = fields.filter((f) => typeof f.distinctValues === "number").length;
console.log(
  `  取证信息覆盖：字段 ${fields.length} / 带描述 ${withDesc} / 带外键指向 ${withRef} / 带去重值个数 ${withDistinct}` +
    "（计数为 0 也合法：实例本身可能没写描述、也没指纹统计）",
);
check(fields.every((f) => typeof f.name === "string" && typeof f.type === "string"), "字段结构稳定（name/type）");

// 2) 取值域：换表 / 换字段探测（实例间差异大：字段取值缓存未开启时要走聚合查询兜底，
//    单字段也可能因类型不支持而取不到——所以「能取到即通过」，并把最后一次原始返回打出来便于定位）
const probeTables = tables
  .filter((t) => Array.isArray(t.fields) && t.fields.length)
  .sort((a, b) => (b.fields?.length || 0) - (a.fields?.length || 0))
  .slice(0, 4);
let gotValues = null;
let lastError = "";
for (const probe of probeTables) {
  for (const fieldName of (probe.fields || []).slice(0, 2)) {
    const res = await callMcpTool(`mcp__${BI}__get_field_values`, {
      database_id: dbId,
      table: probe.table,
      field: fieldName,
      limit: 20,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      /* 非 JSON：当作错误文本留档 */
    }
    if (Array.isArray(parsed?.values) && parsed.values.length) {
      gotValues = { table: probe.table, field: fieldName, parsed };
      break;
    }
    if (!lastError && res.text) lastError = res.text.replace(/\s+/g, " ").slice(0, 200);
  }
  if (gotValues) break;
}
if (gotValues) {
  const { table: probedTable, field, parsed } = gotValues;
  console.log(`\n[get_field_values] ${probedTable}.${field} → source=${parsed.source} 取值数=${parsed.values.length}`);
  console.log(`  ${JSON.stringify(parsed.values.slice(0, 8))}`);
  const empty = parsed.values.filter((v) => v.value === null || v.value === "");
  if (empty.length) console.log(`  含空值/空串 ${empty.length} 项——会被显式标注，不需要再靠猜`);
}
// 3) `sample` 参数必须真的接进工具：请求 5 行取样 → 走 group-by 时必须回报 scanLimit=5 且标注 approximate。
//    （曾经漏把它写进解构参数，传了却被静默忽略，所以这里固化成断言，不靠肉眼 review。）
if (gotValues) {
  const res = await callMcpTool(`mcp__${BI}__get_field_values`, {
    database_id: dbId,
    table: gotValues.table,
    field: gotValues.field,
    limit: 20,
    sample: 5,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    /* 下面报错 */
  }
  if (parsed?.source === "group-by") {
    check(
      parsed.scanLimit === 5 && parsed.approximate === true,
      "sample 参数已生效（scanLimit 回显 + approximate 标注）",
      `scanLimit=${parsed.scanLimit} approximate=${parsed.approximate}`,
    );
  } else {
    console.log(`  note 该字段走实例缓存路径（source=${parsed?.source || "-"}），无扫描步骤 → sample 不适用（预期行为）`);
  }
}
check(
  Boolean(gotValues),
  "get_field_values 取到取值分布",
  gotValues
    ? `${gotValues.table}.${gotValues.field} source=${gotValues.parsed.source}`
    : `试过的表 / 字段都没取到；最后一次返回：${lastError || "-"}`,
);

// 7) 负向用例：拼 SQL 之前的防线必须拦住——非法标识符 / 不存在的表 / 不存在的字段都要如实报错，
//    既不执行、也不编造（标识符白名单是这一条的核心）。
const badCases = [
  { label: "非法表名（防拼串）", args: { database_id: dbId, table: "t; DROP TABLE x", field: "any" } },
  { label: "不存在的表", args: { database_id: dbId, table: "no_such_table_xyz", field: "any" } },
  { label: "不存在的字段", args: { database_id: dbId, table: target.table, field: "no_such_field_xyz" } },
];
for (const item of badCases) {
  const res = await callMcpTool(`mcp__${BI}__get_field_values`, item.args);
  check(res.isError === true, `${item.label} → 如实报错`, res.text.replace(/\s+/g, " ").slice(0, 120));
}

// 8) 纵深防御：多语句必须在执行前被拒（数据源侧最小权限；单条语句的读写由服务端闸门判定）。
const multi = await callMcpTool(`mcp__${BI}__${EXEC_TOOL}`, { database_id: dbId, query: "SELECT 1; SELECT 2" });
check(multi.isError === true, "多语句被拒（不执行）", multi.text.replace(/\s+/g, " ").slice(0, 120));

console.log(failed === 0 ? "\n=== bi-tools PASS ===" : `\n=== bi-tools FAIL（${failed} 项） ===`);
process.exit(failed === 0 ? 0 : 1);
