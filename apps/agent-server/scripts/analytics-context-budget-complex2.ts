/**
 * Harder consecutive live checks (batch 2).
 * Run: node --import tsx scripts/analytics-context-budget-complex2.ts
 */
import "dotenv/config";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import { saveAnalyticsPrefs } from "../src/analytics/analytics-prefs.js";
import type { AnalyticsAskResult } from "../src/analytics/types.js";
import type { AskState } from "../src/analytics/ask-state.js";
import type { ConversationTurn } from "../src/analytics/conversation-structure.js";

const clock = new Date("2026-09-12T12:00:00+08:00");
const modelId = process.env.ANALYTICS_VERIFY_MODEL || "glm5";
const ownerKey = `analytics:ctx-complex2:${Date.now()}`;

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
  forbidSqlAlways?: RegExp[];
  deliveryMust?: RegExp;
};

type Step = { nl: string; expect: Expect };
type Chain = { id: string; steps: Step[] };

const chains: Chain[] = [
  {
    id: "avg-then-foxa-then-uniq",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 人均观看时长按天",
        expect: {
          status: ["ok"],
          metricId: "avg_watch_second_per_user",
          sqlMust: [/IndiaA/, /watchSecond/],
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /watchSecond/, /2026-08-19/],
          forbidSlot: ["contentLang", "time_range", "metric"],
        },
      },
      {
        nl: "改成观看人数",
        expect: {
          status: ["ok"],
          metricId: "uniq_users",
          sqlMust: [/uniq\s*\(\s*guid\s*\)/i, /FoxA|IndiaA/],
          sqlForbid: [/watchSecond\s*\/\s*nullIf/i],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "lang-set-pick-then-foxa",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 三种小语种观看人数按天",
        expect: { status: ["clarify"], requireSlot: "contentLang" },
      },
      {
        nl: "te-IN、ta-IN",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /te-IN/, /ta-IN/],
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
    id: "bare-completion-ground-then-foxa",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 完播率按天",
        expect: { status: ["clarify"], requireSlot: "metric" },
      },
      {
        nl: "最大观看进度平均值",
        expect: {
          status: ["ok"],
          metricId: "avg_max_progress",
          sqlMust: [/maxWatchProgress/i],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /maxWatchProgress/i],
          forbidSlot: ["contentLang", "time_range", "metric"],
        },
      },
    ],
  },
  {
    id: "mom-replace-then-shift-window",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 观看人数的环比",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /2026-08-12/, /2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "换成 FoxA",
        expect: {
          status: ["ok"],
          sqlMust: [/FoxA/, /2026-08-12/, /2026-08-19/],
          sqlForbid: [/IndiaA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "改成 8月1日到7日",
        expect: {
          status: ["ok"],
          sqlMust: [/FoxA/, /2026-08-01/, /2026-08-07/],
          sqlForbid: [/2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "vague-time-mid-then-resume",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /2026-08-19/] },
      },
      {
        nl: "改成上周到本周",
        expect: { status: ["clarify"], requireSlot: "time_range" },
      },
      {
        nl: "2026-08-20到2026-08-21",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /2026-08-20/, /2026-08-21/],
          sqlForbid: [/2026-08-19/],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "yoy-movie-then-foxa",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 电影观看人数同比",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /movieType/, /2025-08-19/, /2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
      {
        nl: "FoxA呢？",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/FoxA/, /movieType/, /2025-08-19/],
          forbidSlot: ["contentLang", "time_range", "metric"],
        },
      },
    ],
  },
  {
    id: "five-turn-stack",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/], forbidSlot: ["contentLang"] },
      },
      {
        nl: "FoxA呢？",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /FoxA/], forbidSlot: ["contentLang", "metric"] },
      },
      {
        nl: "只要电影",
        expect: {
          status: ["ok"],
          sqlMust: [/movieType/, /FoxA|IndiaA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "按渠道",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/channel/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
      {
        nl: "同比呢？",
        expect: {
          status: ["ok"],
          sqlMust: [/2025-08-19/, /2026-08-19/],
          minSqls: 2,
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "split-then-foxa-only",
    steps: [
      {
        nl: "八月二十到二十一印度A和FoxA各自按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /FoxA/], minSqls: 2 },
      },
      {
        nl: "换成 FoxA",
        expect: {
          status: ["ok"],
          sqlMust: [/FoxA/, /2026-08-20/],
          sqlForbid: [/IndiaA/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "brazil-then-replace",
    steps: [
      {
        nl: "巴西A 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: {
          status: ["clarify"],
          requireSlot: "channel",
          forbidSlot: ["contentLang"],
          forbidSqlAlways: [/巴西A/, /BrazilA/i],
        },
      },
      {
        nl: "换成 IndiaA",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /2026-08-19/],
          sqlForbid: [/巴西A/, /BrazilA/i],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "brazil-compare-no-silent",
    steps: [
      {
        nl: "对比 IndiaA 和巴西A 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
        expect: {
          status: ["clarify"],
          requireSlot: "channel",
          forbidSqlAlways: [/巴西A/, /BrazilA/i],
        },
      },
    ],
  },
  {
    id: "filme-tela-uv",
    steps: [
      {
        nl: "FilmeTela 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: {
          status: ["ok"],
          sqlMust: [/FilmeTela/, /uniq\s*\(\s*guid\s*\)/i],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "indiaB-no-silent",
    steps: [
      {
        nl: "对比 IndiaA 和 IndiaB 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
        expect: {
          status: ["clarify"],
          requireSlot: "channel",
          forbidSqlAlways: [/IndiaB/],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "india2-delivery",
    steps: [
      {
        nl: "对比 IndiaA 和 India2 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/, /India2/],
          deliveryMust: /India2/,
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "clear-lang",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 te-IN 和 ta-IN 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /te-IN/, /ta-IN/], forbidSlot: ["contentLang"] },
      },
      {
        nl: "不要语言筛选",
        expect: {
          status: ["ok"],
          turnKind: ["revise"],
          sqlMust: [/IndiaA/],
          sqlForbid: [/te-IN/, /ta-IN/],
          forbidSlot: ["contentLang", "time_range"],
        },
      },
    ],
  },
  {
    id: "new-ask-cut",
    steps: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 te-IN 按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/, /te-IN/] },
      },
      {
        nl: "GoGo 在 2026-08-20 至 2026-08-21 按天观看人数",
        expect: {
          status: ["ok"],
          turnKind: ["new_ask", "revise"],
          sqlMust: [/GoGo/, /2026-08-20/, /2026-08-21/],
          sqlForbid: [/IndiaA/, /te-IN/],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "disable-defaults",
    steps: [
      {
        nl: "2026-08-19到2026-08-25按天观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/], forbidSlot: ["contentLang"] },
      },
      {
        nl: "本轮不用默认渠道。2026-08-19到2026-08-25按天观看人数",
        expect: {
          status: ["ok"],
          sqlForbid: [/channel\s*=\s*'IndiaA'/i],
          forbidSlot: ["contentLang"],
        },
      },
    ],
  },
];

function sqlBlob(r: AnalyticsAskResult): string {
  return (r.sqls || []).join("\n");
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
    issues.push(`turnKind=${r.turnKind || "-"}`);
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
  if (exp.deliveryMust && r.status === "ok") {
    const asked = r.askState?.requested?.channels || r.askState?.filters?.channel || [];
    const tableBlob = (r.tables || [])
      .flatMap((t) => t.rows || [])
      .map((row) => row.join("|"))
      .join("\n");
    const blob = `${asked.join(",")}\n${r.message || ""}\n${tableBlob}`;
    if (!exp.deliveryMust.test(blob)) issues.push(`delivery_missing:${exp.deliveryMust}`);
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
  }
  return issues;
}

const rows: Array<{ id: string; pass: boolean; detail: string }> = [];

for (const chain of chains) {
  const messages: ConversationTurn[] = [];
  let prevAskState: AskState | undefined;
  let lastSlot: string | undefined;
  let lastOptionIds: string[] | undefined;
  if (chain.id === "disable-defaults") {
    saveAnalyticsPrefs(`${ownerKey}:${chain.id}`, {
      version: 1,
      updatedAt: Date.now(),
      defaultChannels: ["IndiaA"],
    });
  }
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
    const extra: string[] = [];
    if (chain.id === "bare-completion-ground-then-foxa" && i === 2 && r.status === "ok") {
      if (!/FoxA/i.test(sqlBlob(r))) extra.push("foxa_missing");
    }
    const issues = [...judge(r, step.expect), ...extra];
    rows.push({
      id: `${chain.id}#${i + 1}:${step.nl.slice(0, 28)}`,
      pass: issues.length === 0,
      detail:
        issues.length === 0
          ? `${r.status}/${r.turnKind || "-"}/${r.clarifySlot || "-"} sqls=${(r.sqls || []).length} ${Date.now() - t0}ms`
          : `${issues.join("; ")} | ${r.status}/${r.turnKind || "-"}/${r.clarifySlot || "-"} ${(r.message || r.error || "").slice(0, 120)} ${Date.now() - t0}ms`,
    });
    if (r.status === "error") break;
  }
}

const failed = rows.filter((r) => !r.pass);
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
console.log(JSON.stringify({ failed: failed.length, total: rows.length, ok: failed.length === 0 }));
process.exit(failed.length === 0 ? 0 : 1);
