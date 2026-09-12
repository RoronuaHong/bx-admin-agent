/**
 * Live conversation accuracy probe — multi-turn dialogues.
 * Run: node --import tsx ./scripts/analytics-conv-accuracy-probe.ts
 * Writes JSONL to .data/conv-accuracy-probe.jsonl
 */
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyticsAsk } from "../src/analytics/pipeline.js";
import type { AnalyticsAskResult } from "../src/analytics/types.js";

const clock = new Date("2026-09-11T12:00:00+08:00");
const ownerKey = "analytics:conv-accuracy-probe";
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../.data/conv-accuracy-probe.jsonl");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, "");

type Turn = {
  nl: string;
  prev?: boolean;
  expect?: {
    status?: Array<"ok" | "clarify" | "refuse" | "error">;
    turnKind?: string[];
    forbidClarifySlot?: string[];
    requireClarifySlot?: string;
    sqlMust?: RegExp[];
    sqlForbid?: RegExp[];
    channelsInSql?: string[];
    messageForbid?: RegExp[];
  };
};

type Dialog = { id: string; turns: Turn[] };

const dialogs: Dialog[] = [
  {
    id: "D1-baseline-day",
    turns: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按天观看人数",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/i, /uniq\s*\(\s*guid\s*\)/i, /toDate/i],
          forbidClarifySlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "D2-revise-foxa",
    turns: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25 按渠道观看人数",
        expect: { status: ["ok"], sqlMust: [/IndiaA/i] },
      },
      {
        nl: "FoxA呢？",
        prev: true,
        expect: {
          status: ["ok", "clarify"],
          turnKind: ["revise"],
          forbidClarifySlot: ["contentLang"],
          // if ok: both channels; if clarify: must be channel
        },
      },
    ],
  },
  {
    id: "D3-compare-two",
    turns: [
      {
        nl: "对比 IndiaA 和 FoxA 在 2026-08-19 至 2026-08-25 的观看人数，按渠道",
        expect: {
          status: ["ok"],
          sqlMust: [/IndiaA/i, /FoxA/i],
          channelsInSql: ["IndiaA", "FoxA"],
        },
      },
    ],
  },
  {
    id: "D4-ghost-then-real",
    turns: [
      {
        nl: "GhostZZZ 在 2026-08-19 至 2026-08-25 观看人数",
        expect: {
          status: ["clarify"],
          requireClarifySlot: "channel",
          sqlForbid: [/GhostZZZ/i],
        },
      },
      {
        nl: "那换成 IndiaA 吧",
        prev: true,
        expect: {
          status: ["ok", "clarify"],
          forbidClarifySlot: ["contentLang"],
        },
      },
    ],
  },
  {
    id: "D5-lang-then-channel-revise",
    turns: [
      {
        nl: "IndiaA 在 2026-08-19 至 2026-08-25，te-IN 观看人数按天",
        expect: {
          status: ["ok", "clarify"],
          sqlMust: [/IndiaA/i],
        },
      },
      {
        nl: "FoxA呢？",
        prev: true,
        expect: {
          status: ["ok", "clarify"],
          turnKind: ["revise"],
          forbidClarifySlot: ["contentLang"],
          messageForbid: [/请确认内容语言|contentLang/i],
        },
      },
    ],
  },
  {
    id: "D6-movie",
    turns: [
      {
        nl: "2026-08-19到2026-08-25，IndiaA 电影观看人数按天",
        expect: {
          status: ["ok", "clarify"],
          sqlMust: [/IndiaA/i],
        },
      },
    ],
  },
  {
    id: "D7-yoy-no-cwr",
    turns: [
      {
        nl: "2026-08-19到2026-08-25，各渠道观看人数的同比增长率",
        expect: {
          status: ["ok", "refuse"],
          // ok must have dual window; refuse is also acceptable historically
        },
      },
    ],
  },
  {
    id: "D8-short-followup-no-lang",
    turns: [
      {
        nl: "IndiaA 2026-08-19到2026-08-25 观看人数",
        expect: { status: ["ok"] },
      },
      {
        nl: "按天看看",
        prev: true,
        expect: {
          status: ["ok", "clarify"],
          forbidClarifySlot: ["contentLang", "channel"],
          sqlMust: [/toDate|watchDate|watch_date/i],
        },
      },
    ],
  },
];

function checkTurn(r: AnalyticsAskResult, expect?: Turn["expect"]): string[] {
  const issues: string[] = [];
  if (!expect) return issues;
  if (expect.status && !expect.status.includes(r.status as never)) {
    issues.push(`status=${r.status} want ${expect.status.join("|")}`);
  }
  if (expect.turnKind?.length && r.turnKind && !expect.turnKind.includes(r.turnKind)) {
    issues.push(`turnKind=${r.turnKind} want ${expect.turnKind.join("|")}`);
  }
  if (expect.forbidClarifySlot?.includes(r.clarifySlot || "")) {
    issues.push(`forbidClarifySlot hit: ${r.clarifySlot}`);
  }
  if (expect.requireClarifySlot && r.clarifySlot !== expect.requireClarifySlot) {
    issues.push(`clarifySlot=${r.clarifySlot} want ${expect.requireClarifySlot}`);
  }
  const sqlBlob = (r.sqls || []).join("\n");
  for (const re of expect.sqlMust || []) {
    if (r.status === "ok" && !re.test(sqlBlob)) issues.push(`sqlMust fail: ${re}`);
  }
  for (const re of expect.sqlForbid || []) {
    if (re.test(sqlBlob)) issues.push(`sqlForbid hit: ${re}`);
  }
  for (const ch of expect.channelsInSql || []) {
    if (r.status === "ok" && !new RegExp(ch, "i").test(sqlBlob)) {
      issues.push(`channel missing in sql: ${ch}`);
    }
  }
  for (const re of expect.messageForbid || []) {
    if (re.test(r.message || "")) issues.push(`messageForbid hit: ${re}`);
  }
  // D2 special: revise ok should include FoxA
  return issues;
}

let failedDialogs = 0;
const summary: Array<Record<string, unknown>> = [];

for (const d of dialogs) {
  let prevAskState: AnalyticsAskResult["askState"] | undefined;
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  let dialogOk = true;
  const turnLogs: unknown[] = [];

  for (let i = 0; i < d.turns.length; i++) {
    const t = d.turns[i]!;
    const t0 = Date.now();
    messages.push({ role: "user", text: t.nl });
    let r: AnalyticsAskResult;
    try {
      r = await analyticsAsk(t.nl, {
        clock,
        ownerKey: `${ownerKey}:${d.id}`,
        prevAskState: t.prev ? prevAskState : undefined,
        messages: [...messages],
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      turnLogs.push({ i, nl: t.nl, error: err, ms: Date.now() - t0 });
      dialogOk = false;
      break;
    }
    messages.push({ role: "assistant", text: r.message || r.status });
    if (r.askState) prevAskState = r.askState;

    let issues = checkTurn(r, t.expect);
    // dialog-specific soft checks
    if (d.id === "D2-revise-foxa" && i === 1) {
      if (r.status === "ok") {
        const sql = (r.sqls || []).join("\n");
        if (!/FoxA/i.test(sql) && !/FoxA/i.test(JSON.stringify(r.askState?.requested || {}))) {
          issues.push("revise ok but FoxA not in sql/requested");
        }
      } else if (r.status === "clarify" && r.clarifySlot !== "channel") {
        issues.push(`revise clarify slot=${r.clarifySlot}`);
      }
    }
    if (d.id === "D7-yoy-no-cwr" && r.status === "ok") {
      const sql = (r.sqls || []).join("\n");
      if (!/2025-08-19/.test(sql)) issues.push("yoy ok without prior-year window");
      if (/channel\s*=\s*'IndiaA'/i.test(sql) && !/各渠道|IN\s*\(/i.test(t.nl + sql)) {
        // forced single channel on 各渠道 is CWR-ish
        if (!/GROUP BY\s+channel/i.test(sql)) issues.push("yoy may have forced single channel");
      }
    }
    if (d.id === "D6-movie" && r.status === "ok") {
      const sql = (r.sqls || []).join("\n");
      if (!/movieType\s*=\s*1|movieType\s+IN\s*\([^)]*\b1\b/i.test(sql)) {
        issues.push("movie ok without movieType=1");
      }
    }
    if (d.id === "D5-lang-then-channel-revise" && i === 1 && r.status === "ok") {
      const sql = (r.sqls || []).join("\n");
      if (!/GROUP BY[\s\S]*channel/i.test(sql) && !/,\s*channel/i.test(sql)) {
        issues.push("multi-channel revise should group/select by channel");
      }
      if (!/FoxA/i.test(sql) || !/IndiaA/i.test(sql)) {
        issues.push("multi-channel revise sql missing IndiaA/FoxA");
      }
    }
    if (d.id === "D8-short-followup-no-lang" && i === 1) {
      if (r.turnKind && r.turnKind !== "revise" && r.turnKind !== "new_ask") {
        issues.push(`unexpected turnKind ${r.turnKind}`);
      }
      // Prefer revise; soft warn only logged in issues if sql wrong (already sqlMust)
    }

    if (issues.length) dialogOk = false;
    const row = {
      dialog: d.id,
      turn: i,
      nl: t.nl,
      ok: issues.length === 0,
      issues,
      status: r.status,
      turnKind: r.turnKind,
      clarifySlot: r.clarifySlot,
      askSummary: r.askSummary,
      defaultsNote: r.defaultsNote,
      requested: r.askState?.requested,
      sqlPreview: (r.sqls?.[0] || "").slice(0, 280),
      msg: (r.message || "").slice(0, 160),
      ms: Date.now() - t0,
      packVersion: r.packVersion,
    };
    turnLogs.push(row);
    appendFileSync(outPath, JSON.stringify(row) + "\n");
    console.log(JSON.stringify(row));
  }

  summary.push({ id: d.id, ok: dialogOk, turns: turnLogs.length });
  if (!dialogOk) failedDialogs++;
}

console.log(JSON.stringify({ summary, failedDialogs, outPath }, null, 2));
process.exit(failedDialogs ? 1 : 0);
