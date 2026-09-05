/**
 * 多语种闲聊 + 业务读实例矩阵（含回复内容抽样）。
 * 语种：zh / en / fr / ru / ja / ko / pt-BR / hi
 *   EVAL_COUNTRY=… EVAL_USER=… EVAL_PASS=… EVAL_MODEL=hy4 pnpm exec tsx scripts/i18n-chit-biz-matrix.mjs
 */

import { writeFileSync } from "node:fs";
import { getRun, latestRunId } from "../src/trace.ts";
import { assertTraceGates, summarize } from "./eval-core.mjs";

const BASE = process.env.AGENT_BASE_URL || "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  {
    id: "zh",
    label: "中文",
    chit: "你好",
    biz: "用户列表前3页",
    // 期望回复含汉字
    replyHas: /[\u4e00-\u9fff]/,
  },
  {
    id: "en",
    label: "英语",
    chit: "Hello",
    biz: "Show the first 3 pages of the user list",
    // 混合语种允许（如夹带产品中文名）；只要求正文含目标语字符
    replyHas: /[A-Za-z]{3,}/,
  },
  {
    id: "fr",
    label: "法语",
    chit: "Bonjour",
    biz: "Affiche les 3 premières pages de la liste des utilisateurs",
    replyHas: /[A-Za-zÀ-ÿ]{3,}/,
  },
  {
    id: "ru",
    label: "俄语",
    chit: "Привет",
    biz: "Покажи первые 3 страницы списка пользователей",
    replyHas: /[\u0400-\u04FF]{3,}/,
  },
  {
    id: "ja",
    label: "日语",
    chit: "こんにちは",
    biz: "ユーザー一覧の最初の3ページを表示して",
    replyHas: /[\u3040-\u30ff\u4e00-\u9fff]/,
  },
  {
    id: "ko",
    label: "韩语",
    chit: "안녕하세요",
    biz: "사용자 목록의 처음 3페이지를 보여줘",
    replyHas: /[\uAC00-\uD7A3]{2,}/,
  },
  {
    id: "pt-BR",
    label: "葡萄牙语(巴西)",
    chit: "Olá",
    biz: "Mostre as primeiras 3 páginas da lista de usuários",
    replyHas: /[A-Za-zÀ-ÿ]{3,}/,
  },
  {
    id: "hi",
    label: "印地语",
    chit: "नमस्ते",
    biz: "उपयोगकर्ता सूची के पहले 3 पेज दिखाएं",
    replyHas: /[\u0900-\u097F]{2,}/,
  },
];

async function login() {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: process.env.EVAL_COUNTRY,
      username: process.env.EVAL_USER,
      password: process.env.EVAL_PASS,
    }),
  });
  const c = resp.headers.get("set-cookie")?.split(";")[0];
  if (!c) throw new Error(`login failed status=${resp.status}`);
  return c;
}

async function chat(cookie, text) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text, model: process.env.EVAL_MODEL || "hy4" }),
  });
  if (resp.status !== 200 || !resp.body) {
    return { events: [], durMs: Date.now() - t0, fetchErr: `status=${resp.status}` };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { events, durMs: Date.now() - t0 };
}

function finalText(events) {
  // 取最后一条非空 text；若全空则拼接所有 text_delta / text
  const texts = events.filter((e) => e.type === "text" && e.text).map((e) => e.text);
  if (texts.length) return texts[texts.length - 1];
  const deltas = events.filter((e) => e.type === "text_delta" && e.text).map((e) => e.text);
  return deltas.join("");
}

function traceMetrics(runId) {
  const spans = runId ? getRun(runId) : [];
  const llm = spans.filter((s) => s.kind === "llm");
  return {
    rounds: llm.length,
    emptyRounds: llm.filter((s) => !s.usage).length,
    tokens: llm.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0),
    tools: spans.filter((s) => s.kind === "tool").map((s) => s.name),
  };
}

function langOk(text, c) {
  // 混合语种（目标语 + 其它语夹杂）一律算对齐；仅拒绝空回复或不含任何目标语字符的纯错语种。
  if (!text || !text.trim()) return false;
  if (c.replyHas && !c.replyHas.test(text)) return false;
  return true;
}

function snippet(t, n = 160) {
  return JSON.stringify(String(t || "").replace(/\n/g, " ").slice(0, n));
}

if (!process.env.EVAL_COUNTRY || !process.env.EVAL_USER || !process.env.EVAL_PASS) {
  console.error("missing EVAL_COUNTRY/EVAL_USER/EVAL_PASS");
  process.exit(2);
}

const rows = [];
let chitPass = 0;
let bizPass = 0;

for (const c of CASES) {
  // ---- chit ----
  {
    const cookie = await login();
    const before = latestRunId();
    const { events, durMs, fetchErr } = await chat(cookie, c.chit);
    const runId = latestRunId() !== before ? latestRunId() : before;
    const m = traceMetrics(runId);
    const text = finalText(events);
    const done = events.some((e) => e.type === "done");
    const calledBiz = (m.tools || []).some((t) => /call_api|search_api_module|grep_codebase/i.test(t));
    const okLang = langOk(text, c);
    const ok = !fetchErr && done && text.trim().length > 0 && okLang && !calledBiz;
    if (ok) chitPass += 1;
    const row = {
      lang: c.id,
      label: c.label,
      kind: "chit",
      ok,
      okLang,
      calledBiz,
      rounds: m.rounds,
      tokens: m.tokens,
      durMs,
      tools: (m.tools || []).join(",") || "-",
      reply: text,
    };
    rows.push(row);
    console.log(
      [
        ok ? "PASS" : "FAIL",
        "chit",
        c.id,
        `lang=${okLang}`,
        `bizTool=${calledBiz}`,
        `rounds=${m.rounds}`,
        `dur=${durMs}ms`,
        `reply=${snippet(text)}`,
      ].join(" | "),
    );
    await sleep(1500);
  }

  // ---- biz ----
  {
    const cookie = await login();
    const before = latestRunId();
    const { events, durMs, fetchErr } = await chat(cookie, c.biz);
    const runId = latestRunId() !== before ? latestRunId() : before;
    const m = traceMetrics(runId);
    const spans = getRun(runId);
    const gates = assertTraceGates({ spans, rejectMode: "observe", expectTools: ["call_api"] });
    const s = summarize(gates);
    const tables = events.filter((e) => e.type === "table").length;
    const text = finalText(events);
    const okLang = langOk(text, c) || (tables >= 1 && text.trim().length === 0); // 有表无文：语言项记 soft
    const dataOk = tables >= 1;
    const gatesOk = s.pass === s.total;
    const ok = !fetchErr && gatesOk && dataOk;
    if (ok) bizPass += 1;
    const row = {
      lang: c.id,
      label: c.label,
      kind: "biz",
      ok,
      okLang: Boolean(text.trim()) ? langOk(text, c) : null,
      gates: `${s.pass}/${s.total}`,
      tables,
      rounds: m.rounds,
      empty: m.emptyRounds,
      tokens: m.tokens,
      durMs,
      tools: (m.tools || []).join(",") || "-",
      reply: text,
      gateFails: gates.filter((g) => !g.ok).map((g) => `${g.name}:${g.detail}`),
    };
    rows.push(row);
    console.log(
      [
        ok ? "PASS" : "FAIL",
        "biz",
        c.id,
        `gates=${s.pass}/${s.total}`,
        `tables=${tables}`,
        `lang=${row.okLang === null ? "n/a(empty)" : row.okLang}`,
        `rounds=${m.rounds}`,
        `empty=${m.emptyRounds}`,
        `dur=${durMs}ms`,
        `tools=${row.tools}`,
        `reply=${snippet(text)}`,
      ].join(" | "),
    );
    for (const g of row.gateFails) console.log(`       - ${g}`);
    await sleep(2500);
  }
}

const summary = {
  model: process.env.EVAL_MODEL || "hy4",
  chit: `${chitPass}/${CASES.length}`,
  biz: `${bizPass}/${CASES.length}`,
  rows: rows.map((r) => ({
    ...r,
    reply: (r.reply || "").slice(0, 240),
  })),
};
const modelTag = (process.env.EVAL_MODEL || "hy4").replace(/[^a-z0-9_-]/gi, "");
writeFileSync(`_i18n-matrix-${modelTag}.json`, JSON.stringify(summary, null, 2), "utf8");
console.log(`\n======== SUMMARY chit=${chitPass}/${CASES.length} biz=${bizPass}/${CASES.length} ========`);
process.exit(chitPass === CASES.length && bizPass === CASES.length ? 0 : 1);
