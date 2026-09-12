/**
 * Complex / multi-turn live checks for AskState + context budget.
 * Run: node --import tsx scripts/analytics-context-budget-complex.ts
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import type { AnalyticsAskResult } from "../src/analytics/types.js";
import type { AskState } from "../src/analytics/ask-state.js";
import type { ConversationTurn } from "../src/analytics/conversation-structure.js";

const clock = new Date("2026-09-12T12:00:00+08:00");
const modelId = process.env.ANALYTICS_VERIFY_MODEL || "glm5";
const ownerKey = `analytics:ctx-complex:${Date.now()}`;

type Expect = {
  status?: Array<"ok" | "clarify" | "refuse" | "error">;
  forbidSlot?: string[];
  requireSlot?: string;
  sqlMust?: RegExp[];
  sqlForbid?: RegExp[];
  minSqls?: number;
  turnKind?: string[];
  metricId?: string;
  opsInclude?: string[];
  channels?: { include?: string[]; exclude?: string[] };
  forbidSqlAlways?: RegExp[];
};

type Step = { nl: string; expect: Expect };

type Chain = { id: string; steps: Step[] };

const chains: Chain[] = [
  {
    id: "union-replace-yoy",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /2026-08-19/], forbidSlot: ["contentLang"] },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/IndiaA/, /FoxA/, /2026-08-19/],
          forbidSlot: ["contentLang", "time_range", "metric"],
          channels: { include: ["IndiaA", "FoxA"] },
        },
      },
      {
        nl: "换成 FoxA",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /2026-08-19/],
          sqlForbid: [/IndiaA/],
          forbidSlot: ["contentLang", "time_range"],
          channels: { include: ["FoxA"], exclude: ["IndiaA"] },
        },
      },
      {
        nl: "同比呢？",
        expect: {
          status: ["ok"],
          sqlMust: [/FoxA/, /2025-08-19/, /2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "mixed-grain-then-india-only",
    steps: [
      {
        nl: "八月二十到二十一印度A按天观看人数，同时FoxA按语言观看人数",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /FoxA/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "只要印度A那条",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/],
          sqlForbid: [/FoxA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "movie-then-foxa-keep-type",
    steps: [
      {
        nl: "2026-08-19到2026-08-25，IndiaA 电影观看人数按天",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /movieType/, /\b1\b/],
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /movieType/, /2026-08-19/],
          forbidSlot: ["contentLang", "time_range", "metric"],
        },
      },
    ],
  },
  {
    id: "alias-then-compare-then-day",
    steps: [
      {
        nl: "印度A 在 2026-08-19 至 2026-08-25 按渠道观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/], forbidSlot: ["contentLang"] },
      },
      {
        nl: "和 FoxA 比一下",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /FoxA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "按天呢？",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA|FoxA/, /toDate\(lastWatchTime\)|watchDate|watch_date/i],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "progress-layout-then-foxa",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25，te-IN 和 ta-IN 最大观看进度平均值，按天渠道",
        expect: {
          status: ["clarify"],
          requireSlot: "result_layout",
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "宽表",
        expect: {
          status: ["ok"],
          sqlMust: [/sumIf|avgIf|countIf/i, /te-IN/, /ta-IN/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /te-IN/, /ta-IN/],
          forbidSlot: ["contentLang", "time_range", "metric"],
        },
      },
    ],
  },
  {
    id: "ghost-replace-then-union",
    steps: [
      {
        nl: "GhostZZZ 在 2026-08-19 至 2026-08-25 观看人数",
        expect: { status: ["clarify"], requireSlot: "channel", sqlForbid: [/GhostZZZ/] },
      },
      {
        nl: "换成 IndiaA",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /2026-08-19/],
          sqlForbid: [/GhostZZZ/],
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /FoxA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "yoy-then-india-only",
    steps: [
      {
        nl: "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
        expect: {
          status: ["ok"],
          metricId: "uniq_users",
          opsInclude: ["yoy"],
          sqlMust: [/2025-08-19/, /2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "只看 IndiaA",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /2025-08-19/, /2026-08-19/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "time-revise-then-foxa",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/2026-08-19/, /2026-08-25/] },
      },
      {
        nl: "改成 8月20到21",
        expect: {
          status: ["ok"],
          sqlMust: [/2026-08-20/, /2026-08-21/, /IndiaA/],
          sqlForbid: [/2026-08-19/],
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          sqlMust: [/FoxA/, /2026-08-20/, /2026-08-21/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
];

function sqlBlob(r: AnalyticsAskResult): string {
  return (r.sqls || []).join("\n");
}

function channelBlob(r: AnalyticsAskResult): string {
  const asked = r.askState?.filters?.channel || r.askState?.requested?.channels || [];
  return `${asked.join(",")}\n${sqlBlob(r)}`;
}

function judge(r: AnalyticsAskResult, exp: Expect): string[] {
  const issues: string[] = [];
  if (exp.status && !exp.status.includes(r.status)) {
    issues.push(`status=${r.status} not in ${exp.status.join("|")}`);
  }
  if (exp.requireSlot && r.clarifySlot !== exp.requireSlot) {
    issues.push(`slot=${r.clarifySlot} want ${exp.requireSlot}`);
  }
  if (exp.forbidSlot && r.clarifySlot && exp.forbidSlot.includes(r.clarifySlot)) {
    issues.push(`spurious_slot=${r.clarifySlot}`);
  }
  if (exp.turnKind && (!r.turnKind || !exp.turnKind.includes(r.turnKind))) {
    issues.push(`turnKind=${r.turnKind || "-"} not in ${exp.turnKind.join("|")}`);
  }
  if (exp.metricId && r.status === "ok" && r.askState?.metricId !== exp.metricId) {
    issues.push(`metricId=${r.askState?.metricId} want ${exp.metricId}`);
  }
  if (exp.opsInclude && r.status === "ok") {
    const ops = r.askState?.ops || [];
    for (const op of exp.opsInclude) {
      if (!ops.includes(op)) issues.push(`ops_missing:${op}`);
    }
  }
  const sql = sqlBlob(r);
  for (const re of exp.forbidSqlAlways || []) {
    if (re.test(sql)) issues.push(`sql_forbidden_always:${re}`);
  }
  if (r.status === "ok") {
    for (const re of exp.sqlMust || []) {
      if (!re.test(sql)) issues.push(`sql_missing:${re}`);
    }
    for (const re of exp.sqlForbid || []) {
      if (re.test(sql)) issues.push(`sql_forbidden:${re}`);
    }
    if (exp.minSqls && (r.sqls || []).length < exp.minSqls) {
      issues.push(`sqls=${(r.sqls || []).length}<${exp.minSqls}`);
    }
    const ch = channelBlob(r);
    for (const c of exp.channels?.include || []) {
      if (!new RegExp(c, "i").test(ch)) issues.push(`channel_missing:${c}`);
    }
    for (const c of exp.channels?.exclude || []) {
      if (new RegExp(`'${c}'`, "i").test(sql)) issues.push(`channel_kept:${c}`);
    }
  }
  return issues;
}

const rows: Array<{ id: string; pass: boolean; detail: string }> = [];

for (const chain of chains) {
  const messages: ConversationTurn[] = [];
  let prevAskState: AskState | undefined;
  let lastSlot: string | undefined;
  let lastOptionIds: string[] | undefined;
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i]!;
    const t0 = Date.now();
    let r: AnalyticsAskResult;
    try {
      r = await analyticsAsk(step.nl, {
        clock,
        modelId,
        ownerKey: `${ownerKey}:${chain.id}`,
        prevAskState,
        lastClarifySlot: lastSlot,
        clarifyOptionIds: lastOptionIds,
        messages: messages.length ? [...messages, { role: "user", text: step.nl }] : undefined,
      });
    } catch (e) {
      rows.push({
        id: `${chain.id}#${i + 1}`,
        pass: false,
        detail: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    messages.push({ role: "user", text: step.nl });
    messages.push({ role: "assistant", text: r.message || r.status });
    if (r.askState) prevAskState = r.askState;
    lastSlot = r.clarifySlot;
    lastOptionIds = (r.clarifyOptions || []).map((o) => o.id);

    const issues = judge(r, step.expect);
    // 只要印度A那条：ok 时不应再出现 FoxA
    if (chain.id === "mixed-grain-then-india-only" && i === 1 && r.status === "ok") {
      const sql = sqlBlob(r);
      if (/FoxA/i.test(sql)) issues.push("still_has_FoxA");
      if (!/IndiaA/i.test(sql)) issues.push("lost_IndiaA");
    }
    if (chain.id === "progress-layout-then-foxa" && i === 2 && r.status === "ok") {
      const sql = sqlBlob(r);
      if (!/FoxA/i.test(sql)) issues.push("foxa_missing_after_layout");
    }
    const pass = issues.length === 0;
    rows.push({
      id: `${chain.id}#${i + 1}:${step.nl.slice(0, 28)}`,
      pass,
      detail: pass
        ? `${r.status}/${r.turnKind || "-"}/${r.clarifySlot || "-"} sqls=${(r.sqls || []).length} ${Date.now() - t0}ms`
        : `${issues.join("; ")} | ${r.status}/${r.turnKind || "-"}/${r.clarifySlot || "-"} ${(r.message || r.error || "").slice(0, 100)} ${Date.now() - t0}ms`,
    });
    if (!pass && r.status === "error") break;
  }
}

const failed = rows.filter((r) => !r.pass);
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
}
console.log(JSON.stringify({ failed: failed.length, total: rows.length, ok: failed.length === 0 }));
process.exit(failed.length === 0 ? 0 : 1);
