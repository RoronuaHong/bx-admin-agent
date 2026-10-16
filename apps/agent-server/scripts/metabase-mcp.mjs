// Metabase MCP 适配器（stdio）：把 Metabase REST API 暴露为 MCP 工具。
// 鉴权：请求头 X-API-Key（Metabase API Key，无 Bearer 前缀）。
// 配置来源：环境变量 BI_BASE_URL + BI_READONLY_API_KEY（生产必须）。开发环境可回落 BI_API_KEY。
// 接口形状按实例自带 OpenAPI（GET /api/docs/openapi.json）核对；要点：
//   - 仪表盘详情的卡片数组字段是 dashcards（旧版才是 ordered_cards）；
//   - 数据库元数据用 skip_fields=true 只取表清单，避免一次吐出全部表的所有字段；
//   - POST /api/dataset 可能返回 202 + status，需判 data.cols 是否存在。
//   - 元数据里本可用的「描述 / 语义类型 / 外键指向 / 指纹统计」必须映射出来：丢掉它们，
//     模型就只能靠字段名猜语义（把真实存在的取值当成脏数据）。取证能力是取数正确性的前提。
import "dotenv/config";
import { resolveMetabaseKey } from "./metabase-key.mjs";
import { DETAIL_HINT, detailMode, projectRows } from "./metabase-concise.mjs";
import { LatencyWindow, deriveAdaptiveTimeoutMs } from "./adaptive-timeout.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.BI_BASE_URL || "").replace(/\/+$/, "");
// 凭据：优先只读账号。生产没有 BI_READONLY_API_KEY 时不回落管理员 Key。
// 换 Key 只是让适配器以只读身份访问；真正的只读边界仍须由数据库账号强制
// （专用角色 + 只 GRANT SELECT），见 docs/text2sql-text2api-plan.md 的 P1-1。
const { key: KEY, blocked: KEY_BLOCKED } = resolveMetabaseKey(process.env);
// 进程内查询缓存（文档 6.5.2）：同 db + 同 SQL + 同 limit 的重复取数直接命中，不再下发 ClickHouse。
// 治 R4「反复换口径 / 重试同一重查询」。短 TTL + 仅缓存成功结果，重启即清空，不持久化。
const queryCache = createQueryCacheFromEnv(process.env);

/**
 * 单次请求超时（默认 60s，可配 BI_TIMEOUT_MS；BI 查询 legitimately 慢时用 env 调大）。
 * 最佳实践：外部调用必须有界——否则一个挂住的查询会占住整个 stdio 连接，
 * 表现为「模型卡住不动」且没有任何可诊断信息。超时后 fail-closed 并返回可操作提示。
 * **局限**：客户端 abort 只是「不再等」，数据库上的那条 SQL 仍在跑；要真正掐断需在 DB 层设
 * statement_timeout。所以这条防的是「agent 会话被拖死」，不是「数据库被拖死」。
 *
 * 第 6 批（对标 AWS「超时值按误超时率反推」）：固定值对多维聚合必然误超时（实测 30002ms 被打断），
 * 但把默认值拍大又会让挂死的查询拖更久。取中：按**实测成功延迟的 p95 × 2** 自适应派生，
 * 保底 = 配置值、封顶 = `BI_TIMEOUT_MAX_MS`。样本只收成功的查询（超时的真实耗时未知，
 * 收进来会污染分布）；冷启动无样本时按配置值走。派生逻辑在 metabase-query-timeout.mjs（纯函数可测）。
 */
const TIMEOUT_MS = Number(process.env.BI_TIMEOUT_MS || 60_000);
const TIMEOUT_MAX_MS = Math.max(TIMEOUT_MS, Number(process.env.BI_TIMEOUT_MAX_MS || 120_000));
const queryLatency = new LatencyWindow(Number(process.env.BI_LATENCY_WINDOW || 50));
let effectiveTimeoutMs = TIMEOUT_MS;
/** 当前生效的超时阈值；派生值变化时打一行日志——「为什么这次等了 60s」必须可解释。 */
function currentTimeoutMs() {
  const next = deriveAdaptiveTimeoutMs({
    configuredMs: TIMEOUT_MS,
    samples: queryLatency.snapshot(),
    maxMs: TIMEOUT_MAX_MS,
  });
  if (next !== effectiveTimeoutMs) {
    console.error(
      `[bi-metabase] 超时阈值自适应：${effectiveTimeoutMs}ms → ${next}ms（近期成功 p95 派生，样本 ${queryLatency.size} 条）`,
    );
    effectiveTimeoutMs = next;
  }
  return next;
}

async function mb(path, { method = "GET", body, query = false } = {}) {
  if (KEY_BLOCKED) {
    return {
      ok: false,
      status: 0,
      text: "生产环境未配置 BI_READONLY_API_KEY，已拒绝使用管理员 Key。请配置只读账号后再连 BI。",
    };
  }
  if (!BASE || !KEY) {
    return { ok: false, status: 0, text: "未配置 BI_BASE_URL 或 BI_API_KEY（在 apps/agent-server/.env 填写）。" };
  }
  const timeout = currentTimeoutMs();
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": KEY },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // 超时/网络错误统一塞进 data（字符串）：调用方原有 `[status] data` 的渲染无需改动即可显示人话。
    //
    // 文案口径（对标 Anthropic《Writing effective tools for agents》）：错误要**可操作**——
    // 说清「这次没拿到数据」「能不能原样重试」「下一步按什么顺序改」，而不是只告诉运维去调哪个旋钮。
    // 零业务词：只给通用取数动作，不出现任何具体库/表/字段/指标名。
    const aborted = err?.name === "TimeoutError" || err?.name === "AbortError";
    const text = aborted
      ? [
          `查询超时（${timeout}ms），本次没有拿到数据。原样重试不会更快——先改查询，再重试：`,
          "① 缩小范围：更短的时间窗、或去掉一个维度，确认能跑通再逐段放大；",
          "② 先量级后明细：只做分组计数（不取明细列）确认规模，再决定要不要取明细；",
          "③ 增加过滤条件，减少要扫描的行数；",
          "④ 先看服务端有没有已验证的现成查询（list_cards / get_card）能直接替代这次手写查询。",
          "若这几步都试过仍超时，说明这个口径本身太重，应如实告诉用户「这个范围查不动，请缩小范围或分两次查」。",
        ].join("\n")
      : [
          `请求失败：${String(err?.message || err)}`,
          "本次没有拿到数据。可以换个更小的范围或更窄的过滤后重试；若反复失败，",
          "先用 list_cards / get_card 看有没有现成的已验证查询，并在回答里如实说明这次取数没有成功。",
        ].join("\n");
    return { ok: false, status: 0, text, data: text };
  }
  // 成功延迟进样本（仅 query 类调用：元数据 GET 混进来会把 p95 稀释到失真的低值）。
  if (query && res.ok) queryLatency.record(Date.now() - startedAt);
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

// ---- 只读 SQL 硬校验（纵深防御，口径来自单一可信来源 scripts/sql-readonly-common.mjs）----
// 即便本适配器拿到的是管理员 Key，也只转发只读查询——把「贴只读标签的核武器」风险降到最低。
// 判定逻辑不再在此内联：直接 import 服务端那一份**唯一**实现，两侧物理共用同一段代码，杜绝漂移。
// 首词白名单 + 全文黑名单 + 危险构造（写文件 / 读文件 / 改库配置）。fail-closed：不明朗一律拒绝。
// 局限：这是代码层约束；Key 一旦泄露、攻击者直连 Metabase API 即可绕过。真正的只读边界仍须 DB/账号层 GRANT SELECT。
import { isReadOnlySql } from "./sql-readonly-common.mjs";
// 静态体检（查表/聚合语句的效率实践）：与只读判定同一个「共享单源」思路——两侧共用一份，
// 杜绝漂移。fail-open，只提示不拦（误杀合法探索语句比慢一点更糟）。
import { lintSql, lintSummary } from "./sql-lint-common.mjs";
import { appendClickHouseSettings, defaultClickHouseSettings, classifyUpstreamError } from "./bi-query-settings.mjs";
import { createQueryCacheFromEnv } from "./bi-query-cache.mjs";
import { buildColumnSearchSql } from "./metabase-column-search.mjs";

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

// ---- 取数执行核心（run_native_query / execute_sql / query 共用，单一实现防漂移）----
// 只读硬校验 + 多语句拦截 + 执行渲染集中在此；任何「执行 SQL」的入口都必须经它，
// 不允许再各自内联一份（那正是 src/sql-readonly-common.mjs 注释里警示的漂移来源）。
// 口径护栏：拦截已知会产出错误业务结论的取数方式。弱模型会无视 skill 里的软性提示，
// 故此处做硬拒绝（与只读校验同一失败通道，fail-closed），逼模型改用正确口径，
// 而不是替它改写 SQL（改写等于猜口径，且会掩盖模型的能力缺口）。
function checkCaliber(sql) {
  // ① 国家维度：禁止用 IP/网络代理列，必须用 elt_user_full.countryCode
  if (/\bipcountrycode\b/i.test(sql) || /\bnetworkcountryiso\b/i.test(sql)) {
    return {
      ok: false,
      error:
        "口径错误：国家维度不能用 ipCountryCode / networkCountryIso 这类代理列（来自 elt_app_params 关联，匹配稀疏、语义是「登录 IP 所在国」而非「账号所属国」）。" +
        "请改用 elt_user_full.countryCode（数值口径：91=印度、55=巴西），无需 JOIN elt_app_params，直接按该列分组即可。",
    };
  }
  // ② 会员存量：禁止用 elt_user_full_history.vipExpireDay>0 的设备级快照替代会员表
  if (/\belt_user_full_history\b/i.test(sql) && /\bvipexpireday\b/i.test(sql)) {
    return {
      ok: false,
      error:
        "口径错误：会员存量不能用 elt_user_full_history.vipExpireDay>0 的设备级快照（会漏算/多算、且无去重账号语义，趋势必然失真）。" +
        "请改用 elt_user_vip_info 的「去重账号」口径：vipType=2 且 startDate<=统计日 且 endDate>=统计日，uniqExact(uid) 得当日有效会员数；按日存量需逐日扫描该表。",
    };
  }
  return { ok: true };
}

function assertSql(input) {
  const sql = String(input ?? "").trim().replace(/;+\s*$/, "");
  if (!sql) return { ok: false, error: "SQL 为空。" };
  // 多语句判定只看「引号外 / 注释外」的分号，与 src/sql-readonly.ts 口径对齐，避免误杀合法单条查询。
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``");
  if (bare.includes(";")) return { ok: false, error: "不接受多语句：一次只能执行一条 SQL。" };
  if (!isReadOnlySql(sql)) {
    return { ok: false, error: "只接受只读查询（SELECT / WITH / SHOW / EXPLAIN 等），写操作（INSERT/UPDATE/DELETE/DROP/…）被拒绝。" };
  }
  const caliber = checkCaliber(sql);
  if (!caliber.ok) return { ok: false, error: caliber.error };
  return { ok: true, sql };
}

async function runSql(database_id, sql, limit = 200) {
  const check = assertSql(sql);
  if (!check.ok) return json(check.error, true);
  // 查询级资源护栏（P1）：在执行 SQL 末尾追加 SETTINGS（聚合/排序超阈值落盘、服务端超时掐断）。
  // 这是第二道保险——即使 DBA 还没给 metabase_user 配 profile（P0），我们自己的查询也自带边界。
  // 不改写 SQL 语义：原 SQL 仍用于回显与静态体检，只有发往 ClickHouse 的那份带 SETTINGS。
  const execSql = appendClickHouseSettings(check.sql, defaultClickHouseSettings());
  // 结果缓存去重（文档 6.5.2）：相同 db + SQL + limit 的重复取数直接命中，跳过下游 POST /dataset。
  const cached = queryCache.get(database_id, check.sql, limit);
  if (cached) {
    console.error(`[bi-metabase] 命中查询缓存，跳过重复下发（db=${database_id}，cache size=${queryCache.size()}）`);
    return cached;
  }
  const r = await mb("/dataset", {
    method: "POST",
    body: { database: database_id, type: "native", native: { query: execSql } },
    query: true, // 成功耗时进自适应超时样本池（第 6 批）
  });
  if (!r.ok) {
    const upstream = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    // 资源类错误码（241 内存 / 307 扫描上限 / 394 超时）翻译成可操作提示；其它回落通用文案。
    const classified = classifyUpstreamError(upstream);
    const guidance = classified ?? [
      "本次没有拿到数据。按这个顺序改：",
      "① 对照报错里的字段/表名，用 get_database_schema 复核真实结构（别猜列名）；",
      "② 去掉可疑的函数/聚合，换成基础列先跑通，再逐个加回来；",
      "③ 加上明确的过滤条件缩小扫描范围。",
      "同一句原样重试不会成功；改不动就在回答里如实说明这个口径查不出来。",
    ].join("\n");
    return json(`[${r.status}] 查询被上游拒绝：${upstream}\n\n${guidance}`, true);
  }
  const payload = r.data?.data;
  if (!payload || !Array.isArray(payload.cols)) {
    const upstreamErr = typeof r.data?.error === "string" ? r.data.error : "";
    const classified = classifyUpstreamError(`${upstreamErr} ${JSON.stringify(r.data?.error ?? "")}`);
    // Metabase 偶尔把错误包进 200 响应的 error 字段（而非 4xx），这里补一道识别。
    if (upstreamErr) {
      return json(
        `[${r.status}] 查询未返回结果：${upstreamErr}\n\n${classified ?? "本次没有拿到数据。缩小查询范围或稍后重试；若反复失败，在回答里如实说明这个口径查不出来。"}`,
        true,
      );
    }
    const state = r.data?.status ? `status=${r.data.status}` : "响应中缺少 data.cols";
    return json(`查询未返回结果（${state}，HTTP ${r.status}）。请稍后重试或缩小查询范围。`, true);
  }
  const cols = payload.cols.map((c) => c.display_name || c.name);
  const allRows = Array.isArray(payload.rows) ? payload.rows : [];
  const truncated = allRows.length > limit;
  const rows = allRows.slice(0, limit);
  const lines = [cols.join("\t")];
  for (const row of rows) lines.push(row.map(renderCell).join("\t")); // NULL 与空串区分渲染：都是真实取值
  if (truncated) lines.push(`…(已截断，共 ${allRows.length} 行，仅显示前 ${limit} 行)`);
  const echo = `-- 实际执行的 SQL（仅供核对口径，不要重复执行）：\n${check.sql}`;
  // 静态体检结论回灌（fail-open：照常执行，但把"可以怎么改"一并给模型，让它下次写对）。
  // 不静默改写 SQL——改写等于替模型猜口径；只提示。
  const lint = lintSummary(lintSql(check.sql));
  const result = json(`${lint ? `${lint}\n\n` : ""}${echo}\n\n${lines.join("\n")}`);
  // 结果缓存去重（文档 6.5.2）：成功结果才入缓存，失败路径不缓存。
  queryCache.set(database_id, check.sql, limit, result);
  return result;
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
  "search_columns", // 跨库列级检索（查 system.columns 系统目录，只读）
  "list_cards",
  "list_dashboards",
  "get_dashboard",
  "get_card",
  "search",
  "execute_query", // 执行已保存卡片（只读结果）
  "construct_query", // 仅构造/校验查询，不执行
  "read_resource", // 仅读取资产元数据
]);
// 说明：execute_sql / query 也走只读闸门（runSql），但它们执行「任意 SQL」，
// 与 run_native_query 同理不在此名单——是否放行由服务端风险策略（toolRisks / 未知兜底）决定，
// 工具自述不替服务端做放行决策（见上方注释「声明事实而非放行」）。
// 只读工具天然幂等（`idempotentHint`，MCP 注解）：供客户端/网关判断失败后能否安全重试。
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

const TOOLS = [
  {
    name: "list_databases",
    description: `列出 Metabase 已连接的所有数据库（id / name / engine）。${DETAIL_HINT}`,
    inputSchema: {
      type: "object",
      properties: { detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT } },
    },
    async run({ detail } = {}) {
      const r = await mb("/database");
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const rows = asList(r.data).map((d) => ({
        id: d.id,
        name: d.name,
        engine: d.engine,
        timezone: d.timezone,
        ...(d.is_sample === true ? { sample: true } : {}),
      }));
      // concise：id/name/engine 就够定位；detailed 才带时区与样本标记。
      const p = projectRows(rows, { detail, keys: ["id", "name", "engine"], cap: 50 });
      return json({
        databases: p.rows,
        ...(p.note ? { note: p.note } : {}),
        ...(p.mode === "concise" ? { detail: "concise" } : {}),
      });
    },
  },
  {
    name: "get_database_schema",
    description:
      "查看数据库的表结构。默认只返回表清单（可用 search 过滤表名，带表描述）；指定 table 时返回该表的字段" +
      "（name / type / 描述 / 语义类型 / 外键指向 / 去重值个数）。写查询前用它确认表名、字段名与字段语义，不要凭字段名猜。" +
      DETAIL_HINT,
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）" },
        table: { type: "string", description: "表名（精确匹配，可写 schema.table）；给了就返回该表字段" },
        search: { type: "string", description: "按表名子串过滤（不区分大小写），仅在未指定 table 时生效" },
        include_fields: { type: "boolean", description: "表清单里是否附带字段名预览（默认 false；表多时不要开）" },
        detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT },
      },
      required: ["database_id"],
    },
    async run({ database_id, table, search, include_fields, detail }) {
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
        // concise：字段按上限截断（name/type 是认路的最小集，描述/语义/外键/指纹仍保留——那是「别猜语义」的证据）；
        // detailed：不截断（调用方显式要全量）。
        const p = projectRows((hit.fields || []).map((f) => mapField(f, fieldIndex)), {
          detail,
          cap: 60,
          hint: "可用 search 过滤别的表，或对关注字段单独用 get_field_values 看取值",
        });
        return json({
          table: hit.name,
          schema: hit.schema,
          ...(hit.description ? { description: clipText(hit.description, 400) } : {}),
          fieldCount: (hit.fields || []).length,
          fields: p.rows,
          ...(p.note ? { note: p.note } : {}),
        });
      }
      const matched = search
        ? tables.filter((t) => String(t.name || "").toLowerCase().includes(String(search).toLowerCase()))
        : tables;
      // 带字段时单表体积大得多，条数上限收紧，避免一次输出过大被截断。
      // concise 用收紧上限；detailed 放宽（显式要全量时就该给全量）。
      const cap = include_fields === true ? 20 : 80;
      const effectiveCap = detailMode(detail) === "detailed" ? cap * 3 : cap;
      const p = projectRows(
        matched.map((t) => ({
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
        { detail, cap: effectiveCap, hint: "可用 search 过滤表名，或用 table 参数精确查看某张表" },
      );
      return json({
        totalTables: tables.length,
        matched: matched.length,
        tables: p.rows,
        ...(p.note ? { note: p.note } : {}),
        // 表名清单不是指标清单。模型看到 54 张业务表就宣布「没有净利润」时，跳过了已保存提问。
        ...(include_fields === true
          ? {}
          : {
              next:
                "这只是表名，不能据此断定没有某个指标。下一步用 search 或 list_cards 找已保存的提问，再用 table 参数看具体字段。",
            }),
      });
    },
  },
  {
    name: "search_columns",
    description:
      "跨库列级检索：按列名/注释子串，一次扫出整个集群里所有数据库、所有表中匹配的列" +
      "（database / table / name / type / comment），用于定位跨表关联列。" +
      "归因/关联类问题常需把分布在不同表里的关联列拼出来：先用本工具找到候选列，" +
      "再写 JOIN/聚合 SQL 取数，而不是凭表名猜。" +
      "查的是后端系统目录（system.columns），任意 database_id 连接都看得到全集群列，不需要逐库翻 schema。" +
      "在写跨表 JOIN / 聚合之前先用它定位关联列，而不是凭一张表的字段名猜别的表也有同名列。" +
      "pattern 是列名或注释的子串（不区分大小写），不要带通配符。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "任一数据库 id（来自 list_databases）；系统目录跨整个集群可见" },
        pattern: { type: "string", description: "要找的列名/注释子串，如 reason、status、user_id、amount" },
        limit: { type: "number", description: "返回上限（默认 200，最大 1000）" },
      },
      required: ["database_id", "pattern"],
    },
    async run({ database_id, pattern, limit }) {
      const built = buildColumnSearchSql(pattern, { limit });
      if (!built.ok) return json(built.error, true);
      return runSql(database_id, built.sql, Number(limit) > 0 ? Number(limit) : 200);
    },
  },
  {
    name: "get_field_values",
    description:
      "查看某字段的取值分布（去重值 + 出现次数）。写过滤 / 分组条件之前先用它确认合法取值与空值语义：" +
      "取值里若存在空串或某个默认值，说明它是真实存在的取值，不能当成脏数据顺手排除。" +
      DETAIL_HINT,
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
        detail: { type: "string", enum: ["concise", "detailed"], description: `${DETAIL_HINT}（detailed 才带出现次数与执行的 SQL）` },
      },
      required: ["database_id", "table", "field"],
    },
    async run({ database_id, table, field, limit = 50, sample, detail }) {
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
        query: true,
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
      // concise：只要取值本身（写过滤条件够用），出现次数/SQL/取样说明进 detailed——
      // 这个工具在事故里被单轮反复调，全量回灌是上下文膨胀的直接来源。
      const detailed = detailMode(detail) === "detailed";
      const p = detailed
        ? { rows: values, note: "" }
        : projectRows(values, { detail, keys: ["value"], cap, hint: "出现次数与执行的 SQL 请传 detail=detailed" });
      return json({
        ...hints,
        source: "group-by",
        ...(detailed ? { sql } : {}),
        ...(scan > 0 ? { approximate: true, scanLimit: scan } : { exact: true }),
        values: p.rows,
        ...(notes.length ? { note: notes.join(" ") } : {}),
        ...(p.note ? { truncated: p.note } : {}),
      });
    },
  },
  {
    name: "run_native_query",
    description:
      "在指定数据库执行原生 SQL（仅只读：SELECT / WITH / SHOW / EXPLAIN 等），返回行列文本。最多返回 limit 行（默认 200），超长自动截断。" +
      "写操作（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/…）会被本工具直接拒绝，无法经此改库。" +
      "写复杂 SQL 前可先用 list_cards / get_card / search 看看有没有现成的已验证查询，避免重复写 SQL；" +
      "只接受单条语句。**一次问清、一条取全**：把需要的维度 / 过滤 / 聚合写进同一条 SQL，" +
      "不要为同一个问题反复往返（先用带 LIMIT 的小查询证伪假设，再跑完整聚合）；" +
      "回复时请给出实际执行的 SQL 与口径说明（用了哪些字段、哪些过滤条件）：" +
      "最危险的失效不是报错，而是「跑通了但口径错、数字看着还挺合理」——展示出来才可被核对。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "数据库 id（来自 list_databases）。本实例分析数仓为 METABASE_DATABASE_ID（默认 2），业务查询都用它；缺省或填 1（Metabase 自带样例库）会自动落到数仓。" },
        query: { type: "string", description: "原生 SQL 语句" },
        limit: { type: "number", description: "返回行数上限（默认 200）" },
      },
      required: ["database_id", "query"],
    },
    async run({ database_id, query, limit = 200 }) {
      // 本实例分析数仓在 METABASE_DATABASE_ID；模型偶尔误填 Metabase 自带样例库(=1)或漏填。
      // 没填或填成样例库(=1) 时落到数仓，避免「跑错库被只读闸门拒绝」。
      const wid = Number(process.env.METABASE_DATABASE_ID || 2);
      if (!database_id || database_id === 1) database_id = wid;
      // 复用统一取数核心（runSql）：只读校验 / 多语句拦截 / 执行渲染单一实现，避免与 execute_sql / query 漂移。
      return runSql(database_id, query, limit);
    },
  },
  {
    name: "list_cards",
    description: `列出 Metabase 已保存的提问（Questions / 卡片）：id / name / 数据库 / 集合。可用 search 过滤名称。${DETAIL_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "按名称子串过滤（不区分大小写）" },
        limit: { type: "number", description: "最多返回条数（默认 50）" },
        detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT },
      },
    },
    async run({ search, limit = 50, detail } = {}) {
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
      // concise：id/name 就够定位（定位到再用 get_card 看明细）；detailed 才带数据库/集合/查询类型。
      const p = projectRows(rows, {
        detail,
        keys: ["id", "name"],
        cap: Math.max(1, Number(limit) || 50),
        hint: "数据库 / 集合 / 查询类型请传 detail=detailed，或对某个 id 用 get_card 看明细",
      });
      return json({ total: p.total, cards: p.rows, ...(p.note ? { note: p.note } : {}) });
    },
  },
  {
    name: "list_dashboards",
    description: `列出 Metabase 仪表盘（Dashboards）：id / name / 集合。可用 search 过滤名称。${DETAIL_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "按名称子串过滤（不区分大小写）" },
        detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT },
      },
    },
    async run({ search, detail } = {}) {
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
      const p = projectRows(rows, { detail, keys: ["id", "name"], cap: 50, hint: "所属集合请传 detail=detailed" });
      return json({ total: p.total, dashboards: p.rows, ...(p.note ? { note: p.note } : {}) });
    },
  },
  {
    name: "get_dashboard",
    description: `获取某个仪表盘详情（标题、包含的卡片 id/名称/可视化类型）。${DETAIL_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: { type: "number", description: "仪表盘 id（来自 list_dashboards）" },
        detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT },
      },
      required: ["dashboard_id"],
    },
    async run({ dashboard_id, detail }) {
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
      // concise：card_id/name（够定位去 get_card）；detailed 才带可视化类型与分页 tab。
      const p = projectRows(cards, { detail, keys: ["card_id", "name"], cap: 40, hint: "可视化类型请传 detail=detailed" });
      return json({
        id: r.data.id,
        name: r.data.name,
        tabs: (r.data.tabs || []).length,
        cards: p.rows,
        ...(p.note ? { note: p.note } : {}),
      });
    },
  },
  {
    name: "get_card",
    description:
      "获取某个已保存提问（卡片）的详情，并尽量给出其**原生 SQL**（MBQL 卡片由服务端编译成 SQL）；编译失败时才退回原始查询定义。" +
      DETAIL_HINT +
      "（SQL 只在 detailed 模式返回——它通常是本工具最占体积的一段，认路阶段不需要它。）",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "number", description: "卡片 id（来自 list_cards / search）" },
        detail: { type: "string", enum: ["concise", "detailed"], description: DETAIL_HINT },
      },
      required: ["card_id"],
    },
    async run({ card_id, detail }) {
      // legacy-mbql=true：把 dataset_query 统一成 {database,type,query}，便于编译成 SQL。
      const legacy = await mb(`/card/${card_id}?legacy-mbql=true`);
      const card = legacy.ok ? legacy.data : (await mb(`/card/${card_id}`)).data;
      if (!card) return json(`[${legacy.status}] ${JSON.stringify(legacy.data)}`, true);
      const dq = card.dataset_query || {};
      // concise：只回元信息，不编译也不回 SQL——「这卡片存在、在哪个库、大概怎么查」已经够认路。
      if (detailMode(detail) !== "detailed") {
        const p = projectRows(
          [
            {
              id: card.id,
              name: card.name,
              database: card.database_id,
              display: card.display,
              queryType: dq.type ?? card.query_type,
            },
          ],
          { detail, cap: 1, hint: "" },
        );
        return json({ ...p.rows[0], hint: "要看它的原生 SQL / 完整定义请传 detail=detailed" });
      }
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
  {
    name: "execute_query",
    description:
      "执行一个已保存的 Metabase 提问（卡片）并返回结果行列。适合直接用 list_cards / search 找到的现成、已验证查询，避免重复写 SQL。" +
      "取数阶梯里它是首选入口：已有现成提问时优先用它，不要自己重写 SQL。" +
      "可带 parameters 传入卡片变量。只读：卡片本质是已存查询，执行不会改变数据。",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "number", description: "卡片 id（来自 list_cards / search）" },
        parameters: {
          type: "array",
          items: { type: "object" },
          description: "卡片参数（[{ type, target, value }]），无参数可不传",
        },
        limit: { type: "number", description: "返回行数上限（默认 200）" },
      },
      required: ["question_id"],
    },
    async run({ question_id, parameters, limit = 200 }) {
      const body = { ignore_cache: false, ...(Array.isArray(parameters) ? { parameters } : {}) };
      const r = await mb(`/card/${question_id}/query`, { method: "POST", body, query: true });
      if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
      const payload = r.data?.data;
      if (!payload || !Array.isArray(payload.cols)) {
        const state = r.data?.status ? `status=${r.data.status}` : "响应中缺少 data.cols";
        return json(`查询未返回结果（${state}，HTTP ${r.status}）。请稍后重试或检查卡片。`, true);
      }
      const cols = payload.cols.map((c) => c.display_name || c.name);
      const allRows = Array.isArray(payload.rows) ? payload.rows : [];
      const truncated = allRows.length > limit;
      const rows = allRows.slice(0, limit);
      const lines = [cols.join("\t")];
      for (const row of rows) lines.push(row.map(renderCell).join("\t"));
      if (truncated) lines.push(`…(已截断，共 ${allRows.length} 行，仅显示前 ${limit} 行)`);
      return json(lines.join("\n"));
    },
  },
  {
    name: "execute_sql",
    description:
      "在指定数据库执行原生 SQL（仅只读，与 run_native_query 同一只读闸门：写操作被直接拒绝），返回行列文本。" +
      "与 run_native_query 等价，作为高层取数入口的底层执行器；只在 construct_query 校验过、且没有现成提问（execute_query）时才用它。",
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
      return runSql(database_id, query, limit);
    },
  },
  {
    name: "query",
    description:
      "高层取数入口：给定 question_id 就执行已保存提问，给定 database_id + sql 就执行原生 SQL（只读闸门同 run_native_query）。" +
      "一个工具覆盖「现成查询」与「手写 SQL」两种取数方式，减少在多个工具间切换。有现成提问时优先走 execute_query；" +
      "只在确定要手写 SQL、且不确定走卡片还是原生 SQL 时才用它。只读校验在该入口内部统一执行。",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "number", description: "执行已保存卡片（优先于 sql）" },
        database_id: { type: "number", description: "执行原生 SQL 时的库 id" },
        sql: { type: "string", description: "原生 SQL（与 question_id 二选一）" },
        parameters: { type: "array", items: { type: "object" }, description: "卡片参数" },
        limit: { type: "number", description: "返回行数上限（默认 200）" },
      },
    },
    async run({ question_id, database_id, sql, parameters, limit = 200 }) {
      if (question_id != null) {
        const body = { ignore_cache: false, ...(Array.isArray(parameters) ? { parameters } : {}) };
        const r = await mb(`/card/${question_id}/query`, { method: "POST", body, query: true });
        if (!r.ok) return json(`[${r.status}] ${JSON.stringify(r.data)}`, true);
        const payload = r.data?.data;
        if (!payload || !Array.isArray(payload.cols)) {
          const state = r.data?.status ? `status=${r.data.status}` : "响应中缺少 data.cols";
          return json(`查询未返回结果（${state}，HTTP ${r.status}）。请稍后重试或检查卡片。`, true);
        }
        const cols = payload.cols.map((c) => c.display_name || c.name);
        const allRows = Array.isArray(payload.rows) ? payload.rows : [];
        const truncated = allRows.length > limit;
        const rows = allRows.slice(0, limit);
        const lines = [cols.join("\t")];
        for (const row of rows) lines.push(row.map(renderCell).join("\t"));
        if (truncated) lines.push(`…(已截断，共 ${allRows.length} 行，仅显示前 ${limit} 行)`);
        return json(lines.join("\n"));
      }
      if (database_id != null && sql != null) return runSql(database_id, sql, limit);
      return json("请提供 question_id（执行已保存提问），或 database_id + sql（执行原生 SQL）。", true);
    },
  },
  {
    name: "construct_query",
    description:
      "构造/校验一个取数查询但**不执行**：传入 database_id + sql 会校验其为只读并返回可直接交给 execute_sql / run_native_query 的原生查询对象；" +
      "传入 question_id 则返回该已保存提问的查询定义（MBQL 或原生）。用于「先确认口径再执行」，减少试错往返。写新 SQL 时先过这一步校验，再交给 execute_sql 执行。",
    inputSchema: {
      type: "object",
      properties: {
        database_id: { type: "number", description: "库 id（与 sql 配合）" },
        sql: { type: "string", description: "原生 SQL（与 question_id 二选一）" },
        question_id: { type: "number", description: "已保存卡片 id（与 sql 二选一）" },
      },
    },
    async run({ database_id, sql, question_id }) {
      if (question_id != null) {
        const legacy = await mb(`/card/${question_id}?legacy-mbql=true`);
        const card = legacy.ok ? legacy.data : (await mb(`/card/${question_id}`)).data;
        if (!card) return json(`[${legacy.status}] ${JSON.stringify(legacy.data)}`, true);
        return json({
          id: card.id,
          name: card.name,
          database: card.database_id,
          queryType: card.query_type ?? card.dataset_query?.type,
          dataset_query: card.dataset_query,
          note: "这是该提问的查询定义（未执行）。要取数请用 execute_query / query 传入同一 question_id。",
        });
      }
      if (sql != null) {
        const check = assertSql(sql);
        if (!check.ok) return json(check.error, true);
        // 校验阶段就把体检结论给出来：这是「执行前确认口径」的关键一环，
        // 模型在这里看到问题比自己执行后才发现要便宜得多。
        const lint = lintSummary(lintSql(check.sql));
        return json({
          ok: true,
          database: database_id,
          type: "native",
          native: { query: check.sql },
          ...(lint ? { lint } : {}),
          note: "已校验为只读，可直接交给 execute_sql / run_native_query 执行。",
        });
      }
      return json("请提供 question_id 或 sql 之一。", true);
    },
  },
  {
    name: "read_resource",
    description:
      "按类型读取一个 Metabase 资源（card / dashboard / collection / database / table）的元数据，返回结构化信息。" +
      "是 get_card / get_dashboard 的统一入口，并额外支持集合 / 库 / 表。写 SQL 前用它确认资产存在与结构，纯读取不改变数据。",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["card", "dashboard", "collection", "database", "table"],
          description: "资源类型",
        },
        // 类型是 union：card/dashboard/collection/database 用数字 id，而 table 用的是表名。
        // 声明成单一 number 会让模型照 schema 传数字 → 表查找必然落空（实测口径：表是按名字定位的）。
        id: {
          type: ["number", "string"],
          description:
            "card / dashboard / collection / database 传数字 id；table 传表名（可写 schema.table）。默认按 type 决定用哪一种。",
        },
        database_id: { type: "number", description: "仅 table 类型需要：所属库 id" },
      },
      required: ["type"],
    },
    async run({ type, id, database_id }) {
      if (type === "card") {
        const legacy = await mb(`/card/${id}?legacy-mbql=true`);
        const card = legacy.ok ? legacy.data : (await mb(`/card/${id}`)).data;
        if (!card) return json(`[${legacy.status}] 未找到卡片 ${id}`, true);
        return json({
          id: card.id,
          name: card.name,
          description: card.description,
          database: card.database_id,
          display: card.display,
          collection: card.collection_id,
          queryType: card.dataset_query?.type ?? card.query_type,
          hint: "要看原生 SQL 或完整定义，改用 get_card detail=detailed 或 construct_query。",
        });
      }
      if (type === "dashboard") {
        const r = await mb(`/dashboard/${id}`);
        if (!r.ok) return json(`[${r.status}] 未找到仪表盘 ${id}`, true);
        const raw = Array.isArray(r.data?.dashcards)
          ? r.data.dashcards
          : Array.isArray(r.data?.ordered_cards)
            ? r.data.ordered_cards
            : [];
        return json({
          id: r.data.id,
          name: r.data.name,
          tabs: (r.data.tabs || []).length,
          cards: raw.map((dc) => ({ card_id: dc.card?.id ?? dc.card_id ?? null, name: dc.card?.name ?? null })),
        });
      }
      if (type === "collection") {
        const r = await mb(`/collection/${id}`);
        if (!r.ok) return json(`[${r.status}] 未找到集合 ${id}`, true);
        return json({
          id: r.data.id,
          name: r.data.name,
          description: r.data.description,
          parent: r.data.parent_id ?? null,
          itemCount: r.data.item_count ?? null,
        });
      }
      if (type === "database") {
        const r = await mb(`/database/${id}`);
        if (!r.ok) return json(`[${r.status}] 未找到数据库 ${id}`, true);
        return json({ id: r.data.id, name: r.data.name, engine: r.data.engine, timezone: r.data.timezone });
      }
      if (type === "table") {
        if (database_id == null) return json("table 类型需要提供 database_id。", true);
        const r = await mb(`/database/${database_id}/metadata?skip_fields=true`);
        if (!r.ok) return json(`[${r.status}] 未找到库 ${database_id}`, true);
        const tables = Array.isArray(r.data?.tables) ? r.data.tables : [];
        const needle = String(id).trim().toLowerCase();
        const hit = tables.find((t) => {
          const bare = String(t.name || "").toLowerCase();
          const qualified = `${t.schema ? `${t.schema}.` : ""}${t.name}`.toLowerCase();
          return bare === needle || qualified === needle;
        });
        if (!hit) return json(`未找到表「${id}」。`, true);
        const fieldIndex = buildFieldIndex(tables);
        return json({
          table: hit.name,
          schema: hit.schema,
          ...(hit.description ? { description: clipText(hit.description, 400) } : {}),
          fieldCount: (hit.fields || []).length,
          fields: (hit.fields || []).map((f) => mapField(f, fieldIndex)),
        });
      }
      return json(`未知资源类型：${type}`, true);
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
