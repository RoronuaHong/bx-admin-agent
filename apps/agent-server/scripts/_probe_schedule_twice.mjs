// 探针（双任务）：同一个对话上放两个一次性任务，验证三件事：
//   ① 第二个任务到点时第一个还在跑 → 是否走「排队补跑」而不是空过（nextRunAt 钉住 + lastNote 写排队）
//   ② 补跑时对话已有上一期完整结论 → 是否仍**重新取数**（toolCalls 里应出现 BI 查询）
//   ③ 无人值守产出的图表是否落进了对话快照（charts 落库）
// 不勾通知通道（不推钉钉）；跑完自行清理。
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";

const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const OWNER = "probe_sched_owner_2";
const PROMPT =
  "INGoogle8,INGoogle10两个渠道、不同新增用户来源的新增用户数，监测每天这两个渠道的不同新增用户来源的结构变化与各来源的同比变化";
const TRACE_FILE = "d:/Code/bx-admin-agent/apps/agent-server/.data/traces/runs-202609.jsonl";
const OUT = "d:/Code/bx-admin-agent/apps/agent-server/_probe2_result.txt";
const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

async function api(path, init) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}owner=${encodeURIComponent(OWNER)}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { raw: text.slice(0, 200) } };
  }
}

const conv = (await api("/chat/conversations", { method: "POST", body: JSON.stringify({ title: "probe-queue" }) }))
  .data?.conversation?.id;
if (!conv) {
  log("建对话失败");
  process.exit(1);
}
log(`probe conversation = ${conv}`);

async function addSchedule(name, at) {
  const r = await api("/chat/schedules", {
    method: "POST",
    body: JSON.stringify({ conversationId: conv, prompt: PROMPT, name, onceAt: at, mcpServers: ["bi"] }),
  });
  return r.data?.schedule?.id;
}
const t0 = Date.now();
const idA = await addSchedule("probe-A", t0 + 5000);
const idB = await addSchedule("probe-B", t0 + 35000);
log(`probe-A = ${idA}  onceAt=+5s`);
log(`probe-B = ${idB}  onceAt=+35s（预期：A 还在跑 → 排队补跑）`);

let sawQueue = null;
let stopped = null;
const deadline = Date.now() + 25 * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const list = (await api("/chat/schedules")).data?.schedules || [];
  const a = list.find((x) => x.id === idA);
  const b = list.find((x) => x.id === idB);
  const st = (await api(`/chat/task/status?conversationId=${encodeURIComponent(conv)}`)).data;
  const at = new Date().toISOString().slice(11, 19);
  log(
    `  [${at}] running=${st?.running} | A: ${a?.lastStatus || "-"} ${a?.lastNote ? "note=" + a.lastNote : ""} | B: ${
      b?.lastStatus || "-"
    } ${b?.lastNote ? "note=" + b.lastNote : ""}`,
  );
  if (b?.lastNote && b.lastNote.includes("排队等待补跑") && !sawQueue) {
    sawQueue = { at, nextRunAt: b.nextRunAt, note: b.lastNote };
    log(`  ★ 观察到排队补跑：nextRunAt=${b.nextRunAt ? new Date(b.nextRunAt).toISOString() : null}`);
  }
  if (a?.lastStatus && b?.lastStatus) {
    stopped = { a, b };
    break;
  }
}
log("");
log("===== 结果 =====");
log(`排队补跑是否发生：${sawQueue ? "是 → " + JSON.stringify(sawQueue) : "否（B 可能没赶上 A 的运行窗口）"}`);
log(`A: status=${stopped?.a?.lastStatus} note=${JSON.stringify(stopped?.a?.lastNote)} delivery=${stopped?.a?.lastDelivery ? "有" : "无"}`);
log(`B: status=${stopped?.b?.lastStatus} note=${JSON.stringify(stopped?.b?.lastNote)} delivery=${stopped?.b?.lastDelivery ? "有" : "无"}`);
log(`B nextRunAt=${stopped?.b?.nextRunAt ?? "已清空（一次性任务跑完停用）"}`);

// run trace
try {
  const rows = readFileSync(TRACE_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.conversationId === conv);
  log("");
  log(`===== 该对话的 run trace（${rows.length} 轮）=====`);
  for (const r of rows) {
    log(
      `  model=${r.model} rounds=${r.rounds} toolCalls=${r.toolCalls} dur=${Math.round(r.durationMs / 1000)}s status=${r.status}` +
        (r.error ? ` error=${String(r.error).slice(0, 80)}` : ""),
    );
  }
} catch (err) {
  log(`读 trace 失败：${String(err?.message || err)}`);
}

// 对话快照：每轮工具 + 正文长度 + 图表数
const mc = await MongoClient.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
const db = mc.db(process.env.MONGO_DB_NAME || "bx_agent");
const docc = await db.collection("chat_conversations").findOne({ id: conv });
log("");
log("===== 对话快照（assistant 轮）=====");
for (const m of (docc?.messages || []).filter((x) => x.role === "assistant")) {
  const tools = [...new Set((m.steps || []).map((s) => s?.name).filter(Boolean))];
  const bi = tools.filter((t) => String(t).startsWith("mcp__bi__"));
  log(
    `  正文=${String(m.text || "").length}字 图表=${(m.charts || []).length}张 BI取数调用=${bi.length} ${JSON.stringify(bi)}`,
  );
  log(`     正文开头: ${String(m.text || "").replace(/\s+/g, " ").slice(0, 120)}`);
}
await mc.close();

await api(`/chat/schedules/${encodeURIComponent(idA)}`, { method: "DELETE" });
await api(`/chat/schedules/${encodeURIComponent(idB)}`, { method: "DELETE" });
await api(`/chat/conversations/${encodeURIComponent(conv)}`, { method: "DELETE" });
log("");
log("已清理探针任务与探针对话");
const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, lines.join("\n"), "utf-8");
