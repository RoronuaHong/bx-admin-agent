# Metabase 数据分析 Agent — M1 实现计划

> **给实现 Agent：** 必须按任务逐步落地。推荐子技能：`superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤用复选框（`- [ ]`）跟踪。

**目标：** 交付 `/analytics` 端到端对话取数（经 Metabase）：时间解析 → Probe → SQL → lint/normalize/Verify → 并行执行 → 表格 + 来源栏时间回显；并提供 MCP/HTTP 门面（`analytics_ask`）供 OpenClaw/小龙虾接入——**不**用手维护的同义词表/指标公式表作为主路径。

**架构：** 配置驱动的 `analytics-bi` Worker + 自建 Metabase REST 客户端 + 确定性流水线编排（禁止自由 `call_api`）。语义层 JSON 只承载结构/护栏。Web 页复用聊天流式 UX 模式，但路由到 analytics 会话/Worker。OpenClaw 消费同一门面；内核仍在 agent-server。

**技术栈：** TypeScript、Hono（`apps/agent-server`）、Vue 3（`apps/web`）、Metabase REST（`/api/session`、`/api/dataset`）、既有 SSE 聊天模式、`tsx` 单测脚本、dotenv。

**规格：** `docs/superpowers/specs/2026-09-09-metabase-analytics-agent-design.md`（§6、§7、§4.2、§12 M1 / §12.1）。  
**不在范围（M2/M3）：** GATE CI 失败即红、soft-EX 全套、scan API、钉钉 `analytics` 类型、临时 Card 可视化（可选 stub OK）。

---

## 文件清单（新建 / 修改）

| 路径 | 职责 |
|------|------|
| `apps/agent-server/src/analytics/metabase-client.ts` | Session 登录 + `runNativeDataset` + 可选 explain |
| `apps/agent-server/src/analytics/semantic-layer.ts` | 加载/校验 pack JSON；表白名单；`required_filters`；`distinctCountFn` |
| `apps/agent-server/config/analytics/watch-detail.pack.json` | `elt_watch_detail` 示例 pack |
| `apps/agent-server/src/analytics/time-resolve.ts` | 时钟 + 时区 → `[start,end)` / 澄清 |
| `apps/agent-server/src/analytics/sql-guard.ts` | §7 解析检查 + §7.1 lint + §7.2 uniq 归一 |
| `apps/agent-server/src/analytics/verify.ts` | 粒度 / 维度 / 列 / 渠道 / 空语言 / LIMIT 1 |
| `apps/agent-server/src/analytics/pipeline.ts` | 编排 NL → 结果（Probe、LLM SQL、并行执行、改写） |
| `apps/agent-server/src/analytics/types.ts` | 共享类型（`AnalyticsAskResult`、slots 等） |
| `apps/agent-server/src/tools/analytics-tools.ts` | `metabase_*` + `analytics_ask` 执行器 |
| `apps/agent-server/src/config.ts` | 暴露 Metabase + analytics 环境变量 getter |
| `apps/agent-server/src/tools.ts` | 增加 `ToolDomain` `"analytics"`；注册到 `TOOL_DOMAIN` / `listAgentTools` / `runAgentTool` |
| `apps/agent-server/src/worker-registry.ts` | 注册 `analytics-bi` worker |
| `apps/agent-server/src/mcp.ts` | 在 `/mcp` 注册 analytics 工具 |
| `apps/agent-server/src/app.ts` | `POST /analytics/ask`（流式可后续加） |
| `apps/agent-server/scripts/analytics-*.test.ts` | 单测（时间、lint、normalize、verify） |
| `apps/agent-server/scripts/analytics-m1-smoke.mjs` | 经流水线的线上 Metabase 冒烟 |
| `apps/web/src/pages/AnalyticsAgentPage.vue` | 类聊天的 analytics UI |
| `apps/web/src/router.ts` / `agent-portal.ts` / `portal-permissions.ts` | 路由 + 门户卡片 |
| `apps/web/src/api.ts` | `askAnalytics(...)` 客户端 |

---

### Task 1：配置 + Metabase 客户端

**文件：**
- 新建：`apps/agent-server/src/analytics/metabase-client.ts`
- 新建：`apps/agent-server/src/analytics/types.ts`
- 修改：`apps/agent-server/src/config.ts`
- 测试：`apps/agent-server/scripts/analytics-metabase-client.test.ts`（单测：URL 拼接 / 脱敏——不必真实调用）

- [x] **步骤 1：增加配置 getter**

在 `apps/agent-server/src/config.ts` 中增加：

```ts
metabase: {
  get url() {
    return (process.env.METABASE_URL || "https://bi.vmovs.com").replace(/\/$/, "");
  },
  get username() {
    return (process.env.METABASE_USERNAME || process.env.METABASE_USER_EMAIL || "").trim();
  },
  get password() {
    return process.env.METABASE_PASSWORD || "";
  },
  get databaseId() {
    const n = Number(process.env.METABASE_DATABASE_ID || 2);
    return Number.isFinite(n) ? n : 2;
  },
  get distinctCountFn() {
    const v = (process.env.DISTINCT_COUNT_FN || "uniq").toLowerCase();
    return v === "uniqexact" ? "uniqExact" : "uniq";
  },
  get businessTimezone() {
    return process.env.ANALYTICS_BUSINESS_TIMEZONE || "Asia/Shanghai";
  },
},
```

- [x] **步骤 2：编写类型**

新建 `apps/agent-server/src/analytics/types.ts`：

```ts
export type DistinctCountFn = "uniq" | "uniqExact";

export interface DatasetResult {
  ok: boolean;
  cols: string[];
  rows: unknown[][];
  error?: string;
  ms?: number;
}

export interface TimeRange {
  start: string; // YYYY-MM-DD
  end: string;   // UX 上含末日；SQL 辅助函数需要时再转 [start,end)
  echo: string;  // 例如 "按 2026-08-19～25"
}

export interface AnalyticsSlots {
  time_range?: TimeRange;
  metrics: string[];
  dimensions: string[];
  filters: Record<string, string[]>;
  need_parallel?: boolean;
  clarify?: string;
}

export interface AnalyticsAskResult {
  status: "ok" | "clarify" | "refuse" | "error";
  message: string;
  timeEcho?: string;
  sqls?: string[];
  tables?: Array<{ title: string; cols: string[]; rows: unknown[][]; grain?: string }>;
  probeSummary?: string;
  error?: string;
}
```

- [x] **步骤 3：实现 Metabase 客户端**

新建 `apps/agent-server/src/analytics/metabase-client.ts`（对齐 `scripts/metabase-smoke.mjs`）：

```ts
import { config } from "../config.js";
import type { DatasetResult } from "./types.js";

let cachedSession: { id: string; at: number } | null = null;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function login(): Promise<string> {
  if (cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) return cachedSession.id;
  const { url, username, password } = config.metabase;
  if (!username || !password) throw new Error("METABASE_USERNAME/PASSWORD missing");
  const resp = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await resp.json()) as { id?: string };
  if (!resp.ok || !data?.id) throw new Error(`Metabase login ${resp.status}`);
  cachedSession = { id: data.id, at: Date.now() };
  return data.id;
}

export async function runNativeDataset(sql: string, databaseId = config.metabase.databaseId): Promise<DatasetResult> {
  const t0 = Date.now();
  const session = await login();
  const resp = await fetch(`${config.metabase.url}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": session,
    },
    body: JSON.stringify({ type: "native", database: databaseId, native: { query: sql } }),
  });
  const data = (await resp.json()) as {
    status?: string;
    error?: string;
    data?: { rows?: unknown[][]; cols?: Array<{ name?: string; display_name?: string }> };
  };
  const ms = Date.now() - t0;
  if (!resp.ok || data?.status === "failed") {
    return { ok: false, cols: [], rows: [], error: String(data?.error || resp.status), ms };
  }
  const cols = (data?.data?.cols ?? []).map((c) => c.name || c.display_name || "");
  return { ok: true, cols, rows: data?.data?.rows ?? [], ms };
}
```

- [x] **步骤 4：对线上 Metabase 跑冒烟（手动）**

运行：`cd apps/agent-server && node scripts/metabase-smoke.mjs`  
期望：登录 OK + 可选 SELECT 1 OK（需 `.env`）。

- [x] **步骤 5：提交**

```bash
git add apps/agent-server/src/config.ts apps/agent-server/src/analytics/
git commit -m "feat(analytics): add Metabase client and config getters for M1"
```

---

### Task 2：语义层 pack 加载器

**文件：**
- 新建：`apps/agent-server/config/analytics/watch-detail.pack.json`
- 新建：`apps/agent-server/src/analytics/semantic-layer.ts`
- 测试：`apps/agent-server/scripts/analytics-semantic-layer.test.ts`

- [x] **步骤 1：先写失败测试**

```ts
// apps/agent-server/scripts/analytics-semantic-layer.test.ts
import assert from "node:assert/strict";
import { loadAnalyticsPack, assertTableAllowed } from "../src/analytics/semantic-layer.js";

const pack = loadAnalyticsPack("watch-detail");
assert.equal(pack.datasource.engine, "clickhouse");
assert.ok(pack.tables.some((t) => t.name === "elt_watch_detail"));
assert.throws(() => assertTableAllowed(pack, "secret_table"), /whitelist/i);
console.log("analytics-semantic-layer.test.ts OK");
```

- [x] **步骤 2：跑测试 — 期望 FAIL（模块尚不存在）**

运行：`cd apps/agent-server && npx tsx scripts/analytics-semantic-layer.test.ts`  
期望：找不到模块 / pack。

- [x] **步骤 3：编写 pack JSON**

新建 `apps/agent-server/config/analytics/watch-detail.pack.json`：

```json
{
  "version": "2026-09-09.1",
  "id": "watch-detail",
  "datasource": {
    "engine": "clickhouse",
    "metabaseDatabaseId": 2
  },
  "tables": [
    {
      "name": "elt_watch_detail",
      "fields": [
        "lastWatchTime",
        "channel",
        "contentLang",
        "watchSecond",
        "guid",
        "movieType"
      ]
    }
  ],
  "probeDimensions": ["channel", "contentLang"],
  "required_filters": ["time_range"],
  "time": {
    "businessTimezone": "Asia/Shanghai",
    "missingYearDefault": "clock_year"
  },
  "guards": {
    "distinctCountFn": "uniq",
    "maxRows": 5000,
    "maxProbeRounds": 3,
    "maxRewriteRounds": 2,
    "parallelism": 4,
    "defaultMovieTypes": [1, 2, 3, 4, 10, 11]
  },
  "examples": [
    {
      "nl": "IndiaA 按天观看人数",
      "sqlHint": "SELECT toDate(lastWatchTime) AS d, uniq(guid) AS users FROM elt_watch_detail WHERE channel='IndiaA' AND toDate(lastWatchTime) BETWEEN {start} AND {end} AND movieType IN (1,2,3,4,10,11) GROUP BY d"
    }
  ]
}
```

- [x] **步骤 4：实现加载器**

```ts
// apps/agent-server/src/analytics/semantic-layer.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AnalyticsPack {
  version: string;
  id: string;
  datasource: { engine: string; metabaseDatabaseId: number };
  tables: Array<{ name: string; fields: string[] }>;
  probeDimensions: string[];
  required_filters: string[];
  time: { businessTimezone: string; missingYearDefault: string };
  guards: {
    distinctCountFn: "uniq" | "uniqExact";
    maxRows: number;
    maxProbeRounds: number;
    maxRewriteRounds: number;
    parallelism: number;
    defaultMovieTypes: number[];
  };
  examples: Array<{ nl: string; sqlHint: string }>;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics");

export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack {
  const raw = readFileSync(join(root, `${id}.pack.json`), "utf8");
  return JSON.parse(raw) as AnalyticsPack;
}

export function assertTableAllowed(pack: AnalyticsPack, table: string): void {
  if (!pack.tables.some((t) => t.name === table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
}
```

- [x] **步骤 5：跑测试 — 期望 PASS**

运行：`cd apps/agent-server && npx tsx scripts/analytics-semantic-layer.test.ts`

- [x] **步骤 6：提交**

```bash
git add apps/agent-server/config/analytics apps/agent-server/src/analytics/semantic-layer.ts apps/agent-server/scripts/analytics-semantic-layer.test.ts
git commit -m "feat(analytics): add watch-detail semantic pack loader"
```

---

### Task 3：时间解析（§6.3）

**文件：**
- 新建：`apps/agent-server/src/analytics/time-resolve.ts`
- 测试：`apps/agent-server/scripts/analytics-time-resolve.test.ts`

- [x] **步骤 1：先写失败测试**

```ts
import assert from "node:assert/strict";
import { resolveTimeRange } from "../src/analytics/time-resolve.js";

const clock = new Date("2026-09-09T12:00:00+08:00");

{
  const r = resolveTimeRange("八月十九到二十五", clock, "Asia/Shanghai");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.range.start, "2026-08-19");
    assert.equal(r.range.end, "2026-08-25");
  }
}
{
  const r = resolveTimeRange("最近看一下人数", clock, "Asia/Shanghai");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.clarify, /最近|时间|日期/);
}
console.log("analytics-time-resolve.test.ts OK");
```

- [x] **步骤 2：跑测 — 期望 FAIL**

- [x] **步骤 3：实现最小解析器**

至少支持：
- `M月D日` / `M月D到D` / `M月D到M月D`，缺少年份时用 `businessTimezone` 下时钟年份
- ISO `YYYY-MM-DD` 成对
- 模糊「最近」→ `{ ok:false, clarify }`

```ts
export type ResolveOk = { ok: true; range: { start: string; end: string; echo: string } };
export type ResolveClarify = { ok: false; clarify: string };
export type ResolveResult = ResolveOk | ResolveClarify;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function resolveTimeRange(nl: string, clock: Date, _tz: string): ResolveResult {
  if (/最近/.test(nl) && !/\d{1,2}\s*月/.test(nl) && !/\d{4}-\d{2}-\d{2}/.test(nl)) {
    return { ok: false, clarify: "「最近」无法定界，请给出具体起止日期（例如 8月19日到25日）。" };
  }
  const year = clock.getFullYear();
  const iso = [...nl.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]);
  if (iso.length >= 2) {
    return { ok: true, range: { start: iso[0], end: iso[1], echo: `按 ${iso[0]}～${iso[1]}` } };
  }
  const m = nl.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*(?:到|至|-)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*(?:日|号)?/);
  if (m) {
    const m1 = Number(m[1]);
    const d1 = Number(m[2]);
    const m2 = m[3] ? Number(m[3]) : m1;
    const d2 = Number(m[4]);
    const start = `${year}-${pad(m1)}-${pad(d1)}`;
    const end = `${year}-${pad(m2)}-${pad(d2)}`;
    return { ok: true, range: { start, end, echo: `按 ${start}～${end}` } };
  }
  const single = nl.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/);
  if (single) {
    const start = `${year}-${pad(Number(single[1]))}-${pad(Number(single[2]))}`;
    return { ok: true, range: { start, end: start, echo: `按 ${start}` } };
  }
  return { ok: false, clarify: "请提供分析的日期范围（例如 2026-08-19 到 2026-08-25）。" };
}
```

- [x] **步骤 4：跑测 — 期望 PASS**

- [x] **步骤 5：提交**

```bash
git add apps/agent-server/src/analytics/time-resolve.ts apps/agent-server/scripts/analytics-time-resolve.test.ts
git commit -m "feat(analytics): deterministic time resolve for missing-year NL"
```

---

### Task 4：SQL 护栏 — lint + distinctCountFn 归一（§7 / §7.1 / §7.2）

**文件：**
- 新建：`apps/agent-server/src/analytics/sql-guard.ts`
- 测试：`apps/agent-server/scripts/analytics-sql-guard.test.ts`

- [x] **步骤 1：测试覆盖**

1. 拒绝 `INSERT` / 多语句 `;`
2. 标记 `lastWatchTime = '2026-08-20'`
3. NL 未允许去空时，标记 `contentLang != ''`
4. NL 未只要 Top1 时，标记 `LIMIT 1`
5. 默认 `uniq` 时，将 `uniqExact(` 归一为 `uniq(`
6. 抽出的表名必须在白名单（简单正则 `FROM\s+(\w+)`）

- [x] **步骤 2：实现 `lintSql(sql, nl, pack)` + `normalizeDistinctCount(sql, fn)` + `assertReadonlySingleSelect(sql)`**

关键行为须对齐规格 §7.1：

```ts
export function normalizeDistinctCount(sql: string, fn: "uniq" | "uniqExact"): string {
  if (fn === "uniq") return sql.replace(/\buniqExact\s*\(/gi, "uniq(");
  return sql.replace(/\buniq\s*\(/gi, "uniqExact(").replace(/\buniqExactExact\s*\(/gi, "uniqExact(");
}

export function lintSql(sql: string, nl: string): string[] {
  const issues: string[] = [];
  if (/;/.test(sql.trim().replace(/;+\s*$/, ""))) issues.push("multi_statement");
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql)) issues.push("non_readonly");
  if (/lastWatchTime\s*=\s*'?\d{4}-\d{2}-\d{2}'?/i.test(sql)) issues.push("datetime_eq_date_string");
  const allowDropEmpty = /不要没标|排除空|不要空语言/.test(nl);
  if (!allowDropEmpty && /contentLang\s*(!=|<>)\s*''/i.test(sql)) issues.push("forbid_exclude_empty_lang");
  if (/limit\s+1\b/i.test(sql) && !/只要第|第一名|top\s*1/i.test(nl)) issues.push("avoid_limit_1_unless_asked");
  return issues;
}
```

- [x] **步骤 3：测试 PASS → 提交**

```bash
git commit -m "feat(analytics): SQL lint and distinctCountFn AST normalize"
```

---

### Task 5：Verify 辅助（粒度 / 渠道 / 并行拆分）

**文件：**
- 新建：`apps/agent-server/src/analytics/verify.ts`
- 测试：`apps/agent-server/scripts/analytics-verify.test.ts`

- [x] **步骤 1：测试**

- NL 含「按天」→ SQL 必须含 `toDate(lastWatchTime)` 与 `GROUP BY`
- 单渠道 NL「印度A」且无 FoxA/GoGo → 每条 SQL 须含 `IndiaA`
- 拆分辅助：文本用 `\n---\n` 分隔 SELECT → `string[]` 长度为 2

- [x] **步骤 2：实现 → PASS → 提交**

```bash
git commit -m "feat(analytics): grain/channel verify and multi-SQL split"
```

---

### Task 6：流水线编排 + `analytics_ask`

**文件：**
- 新建：`apps/agent-server/src/analytics/pipeline.ts`
- 修改：模型聊天辅助 — 复用 `apps/agent-server/src/` 既有 LLM 调用模式（定位 `chat.ts` 使用的 `chatCompletions` / model router；导入同一底层客户端——**禁止**另起一套 HTTP 栈）
- 测试：`apps/agent-server/scripts/analytics-pipeline-unit.test.ts`（可 mock Metabase + LLM；至少测模糊时间澄清且无网络）

**流水线算法（必须遵循规格 §6）：**

1. 加载 pack  
2. `resolveTimeRange` — 失败则返回 `{ status:'clarify', message }`  
3. 构建 system 提示（表字段、`toDate`、`uniq`、movieType 默认、并行 `---` 规则、**无同义词映射表**）  
4. 可选 Probe：对每个 `pack.probeDimensions` 经 `runNativeDataset` 跑 Top-N DISTINCT（限制轮次）  
5. LLM 生成 SQL（注入已解析的 ISO 日期）  
6. 每条 SQL：表白名单 → lint → normalizeDistinctCount → verify  
7. lint/verify 失败：结构化改写 ≤ `maxRewriteRounds`（反馈 = issue 码 + 先前 SQL）。**禁止**无约束「EX 不对就改写」。  
8. `Promise.all` 执行 SQL（上限 `parallelism`）  
9. 全部空结果 → 带年份提示做一次空结果改写  
10. 返回带 tables + `timeEcho` + sqls + probeSummary 的 `AnalyticsAskResult`  

- [x] **步骤 1：实现 `export async function analyticsAsk(nl: string, opts?: { clock?: Date; packId?: string }): Promise<AnalyticsAskResult>`**

- [x] **步骤 2：单测澄清路径**

```ts
import assert from "node:assert/strict";
import { analyticsAsk } from "../src/analytics/pipeline.js";
const r = await analyticsAsk("最近人均多久", { clock: new Date("2026-09-09T12:00:00+08:00") });
assert.equal(r.status, "clarify");
```

- [x] **步骤 3：线上冒烟（本任务可选）** — 完整线上留给 Task 10

- [x] **步骤 4：提交**

```bash
git commit -m "feat(analytics): NL pipeline with probe, lint, parallel execute"
```

---

### Task 7：注册工具 + Worker + MCP + HTTP 门面

**文件：**
- 新建：`apps/agent-server/src/tools/analytics-tools.ts`
- 修改：`apps/agent-server/src/tools.ts` — 向 `ToolDomain` 增加 `"analytics"`；映射工具名；接入 `runAgentTool`
- 修改：`apps/agent-server/src/worker-registry.ts` — 增加 `analytics-bi`
- 修改：`apps/agent-server/src/mcp.ts` — 注册工具
- 修改：`apps/agent-server/src/app.ts` — `POST /analytics/ask`

- [x] **步骤 1：扩展 ToolDomain**

```ts
export type ToolDomain =
  | "backend-api"
  | "knowledge"
  | "finance"
  | "customer-service"
  | "database"
  | "analytics"
  | "common";
```

加入 `TOOL_DOMAIN`：

```ts
metabase_run_dataset: "analytics",
metabase_run_question: "analytics",
metabase_explain_estimate: "analytics",
analytics_ask: "analytics",
render_table: /* 保持原 domain，或经 worker 白名单双开 — 推荐 worker 白名单含 render_table */,
request_clarification: "common",
```

说明：`render_table` 在 map 中仍属 `backend-api`；analytics worker 的 `toolWhitelist` 包含 `"render_table"`、`"request_clarification"`、`"analytics_ask"`、`"metabase_run_dataset"` 等。

- [x] **步骤 2：Worker 条目**

```ts
{
  id: "analytics-bi",
  domain: "analytics",
  label: "Metabase 数据分析",
  toolWhitelist: [
    "analytics_ask",
    "metabase_run_dataset",
    "metabase_run_question",
    "metabase_explain_estimate",
    "render_table",
    "summarize_chart_data",
    "export_dataset",
    "request_clarification",
  ],
  systemPrompt:
    "[workflow/worker] Analytics BI。只通过 analytics_ask / metabase_* 取数；禁止 call_api；日期必须用已 resolve 区间；异 grain 多 SQL 用 --- 分隔。",
  writeConfirmPolicy: "always",
}
```

- [x] **步骤 3：HTTP 门面**

```ts
// in app.ts
app.post("/analytics/ask", async (c) => {
  // 鉴权与 /chat/stream 相同（session cookie）
  const body = await c.req.json<{ text: string }>();
  const result = await analyticsAsk(String(body.text || ""));
  return c.json(result);
});
```

- [x] **步骤 4：MCP 注册** `analytics_ask` + `metabase_run_dataset`，走既有 `registerTool` → `runAgentTool` 模式

- [x] **步骤 5：手动 curl**

```bash
# 服务启动 + 登录 cookie 后
curl -s -X POST http://127.0.0.1:PORT/analytics/ask -H "Content-Type: application/json" --cookie "..." -d "{\"text\":\"八月二十到二十一印度A按天观看人数\"}"
```

期望 JSON：`status:ok` 或 `clarify`，字段符合 `AnalyticsAskResult`。

- [x] **步骤 6：提交**

```bash
git commit -m "feat(analytics): wire analytics-bi worker, MCP tools, and /analytics/ask"
```

---

### Task 8：Web `/analytics` 页面

**文件：**
- 新建：`apps/web/src/pages/AnalyticsAgentPage.vue`
- 修改：`apps/web/src/router.ts`
- 修改：`apps/web/src/agent-portal.ts`
- 修改：`apps/web/src/portal-permissions.ts`
- 修改：`apps/web/src/api.ts`

- [x] **步骤 1：API 辅助**

```ts
export async function askAnalytics(text: string): Promise<AnalyticsAskResult> {
  const resp = await fetch("/agent/analytics/ask", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) throw new Error(`analytics ask ${resp.status}`);
  return resp.json();
}
```

确认 Vite/代理已把 `/agent/*` 转到 agent-server（与聊天相同）。

- [x] **步骤 2：页面 UI（最小但真实工作台）**

- 标题：数据分析 Agent  
- 输入框 + 发送  
- 展示 `timeEcho` / 澄清文案  
- 用既有 `ResultTable`（可复用）或简单 HTML 表渲染每个 `tables[]`  
- SQL 放在 `<details>` 折叠  

最终页**不要**用 `AgentPlaceholderPage` — M1 要求真实对话。

- [x] **步骤 3：门户**

增加卡片 `key: "analytics"`，`href: "/analytics"`（或 `/agents/analytics` — **按规格优先 `/analytics`**）。同步更新 `PortalEntryKey` 联合类型与权限白名单，门控方式对齐 `viewing`。

- [x] **步骤 4：浏览器手动检查** — 登录 → 打开 `/analytics` → 问一条带日期的问题 → 见表格或澄清

- [x] **步骤 5：提交**

```bash
git commit -m "feat(web): add /analytics page for Metabase analytics agent"
```

---

### Task 9：OpenClaw / 小龙虾门面文档 + 白名单说明

**文件：**
- 新建：`docs/analytics/openclaw-connect.md`（短运维说明）
- 修改：设计稿 §4.2 已就绪 — 本文档链过去即可

- [x] **步骤 1：写运维步骤**

```markdown
# 将 OpenClaw（小龙虾）接入 Analytics M1

1. 确认 agent-server `/mcp` 已暴露 `analytics_ask`。
2. `openclaw mcp add analytics --url <HTTP MCP 或 stdio 命令>`
3. Agent `tools.allow`：`["analytics_ask"]`（不要混进 `call_api`）。
4. 验证：在 OpenClaw 会话中问「八月二十到二十一印度A按天人数」。
```

- [x] **步骤 2：提交**

```bash
git commit -m "docs(analytics): OpenClaw connect notes for M1 facade"
```

---

### Task 10：M1 冒烟脚本 + package.json 测试钩子

**文件：**
- 新建：`apps/agent-server/scripts/analytics-m1-smoke.mjs`
- 修改：`apps/agent-server/package.json` — 增加 `test:analytics`（跑 Task 2–5 单测；也可在 Task 11 统一接线）

- [x] **步骤 1：冒烟用例（线上 Metabase）**

至少 3 条：

1. 模糊「最近」→ clarify  
2. `八月二十到二十一印度A按天观看人数` → ok，≥1 行，SQL 含 `toDate`  
3. 多表/并行问（IndiaA 按天 + FoxA 按语言）→ 执行 ≥2 条 SQL  

打印判定；任一失败则 `exit 1`。

- [x] **步骤 2：运行**

```bash
cd apps/agent-server && node scripts/analytics-m1-smoke.mjs
```

（Windows 也可用：`.\node_modules\.bin\tsx.cmd scripts\analytics-m1-smoke.mjs`）

期望：在有 `.env` 凭证时 3/3 通过。

- [x] **步骤 3：提交**

```bash
git commit -m "test(analytics): M1 smoke eval for clarify, single, and parallel SQL"
```

---

### Task 11：把单测接到 `package.json` + M1 验收清单

- [x] **步骤 1：增加 npm script**

```json
"test:analytics": "tsx scripts/analytics-semantic-layer.test.ts && tsx scripts/analytics-time-resolve.test.ts && tsx scripts/analytics-sql-guard.test.ts && tsx scripts/analytics-verify.test.ts"
```

（实现时可一并纳入 `analytics-metabase-client.test.ts`、`analytics-pipeline-unit.test.ts`。）

若稳定且快，可选追加到既有 `"test"`。

- [x] **步骤 2：M1 验收清单（手动）**

详见 `docs/analytics/m1-acceptance.md`：

- [ ] 有权限用户可打开 `/analytics`  
- [ ] 缺日期 /「最近」会澄清，且不调 Metabase 执行  
- [ ] 带日期 NL 返回表格 + 时间回显 + SQL 折叠  
- [ ] 模型输出的 `uniqExact` 在执行前被归一  
- [ ] 并行 NL 返回 ≥2 张结果表  
- [ ] `POST /analytics/ask` 可用  
- [ ] MCP `analytics_ask` 在 `/mcp` 可列出/调用  
- [ ] analytics worker 白名单无 `call_api`  

- [x] **步骤 3：若还有脚本接线，最终提交**

```bash
git commit -m "chore(analytics): add test:analytics script and M1 acceptance notes"
```

---

## 规格覆盖自检

| 规格 M1 项 | 任务 |
|------------|------|
| `/analytics` 对话 | Task 8 |
| 时间解析 | Task 3 |
| Probe | Task 6 |
| 生成 SQL | Task 6 |
| §7.2 归一 | Task 4 |
| §7 / §7.1 lint | Task 4 |
| 天/维/列 Verify | Task 5–6 |
| 多 SQL 并行 | Task 5–6 |
| 仅结构化改写 | Task 6 |
| 无手维护指标/同义词表 | Task 2 pack + 提示词 |
| 缺日期澄清 | Task 3 + 6 |
| 来源栏时间回显 | Task 6 + 8 |
| MCP/HTTP 门面 + `analytics_ask` | Task 7（+9 OpenClaw） |
| 种子冒烟 | Task 10 |
| OpenClaw 任意工具面经门面接入 | Task 7 + 9 |

**明确延后：** M2 GATE CI 失败即红、完整 EX harness、M3 scan/告警、临时 Card 可视化、Best-of-N。

## 占位扫描

无 TBD/TODO 步骤；线上 Metabase 步骤依赖 `.env`（已文档化）。LLM 客户端必须复用既有 agent-server 模型辅助 — 实现者在 Task 6 定位共享模块（在 `apps/agent-server/src` 下搜索 `chat/completions`）。

---

## 执行交接

计划已保存至 `docs/superpowers/plans/2026-09-09-metabase-analytics-agent-m1.md`。

**两种执行方式：**

1. **子 Agent 驱动（推荐）** — 每任务新子 Agent，任务间复审  
2. **本会话内联执行** — 本会话按 executing-plans 检查点推进  

**当前状态（2026-09-09）：** Tasks 1–11 代码已落地；单元测试与 3/3 冒烟通过。产品验收清单见 `docs/analytics/m1-acceptance.md`，仍需人工勾选。
