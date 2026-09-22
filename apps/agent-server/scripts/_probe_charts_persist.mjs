// 探针：验证「无人值守（无订阅者）跑出的图表是否落进对话快照」。
// 用最便宜的出图 prompt（一次 render_chart，几秒钟），跑完核对快照里的 charts 字段。
import { MongoClient } from "mongodb";

const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const OWNER = "probe_charts_owner";
const PROMPT = "把 1、2、3 这三个数字画成柱状图";

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

const convId = (await api("/chat/conversations", { method: "POST", body: JSON.stringify({ title: "probe-charts" }) }))
  .data?.conversation?.id;
if (!convId) {
  console.log("建对话失败");
  process.exit(1);
}
console.log(`conversation = ${convId}`);
const sch = (
  await api("/chat/schedules", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, prompt: PROMPT, name: "probe-charts", onceAt: Date.now() + 5000 }),
  })
).data?.schedule?.id;
console.log(`schedule = ${sch}`);

let done = null;
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const s = ((await api("/chat/schedules")).data?.schedules || []).find((x) => x.id === sch);
  if (s?.lastStatus && s?.lastRunAt) {
    done = s;
    break;
  }
}
console.log(`status=${done?.lastStatus} note=${JSON.stringify(done?.lastNote)}`);

const mc = await MongoClient.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
const db = mc.db(process.env.MONGO_DB_NAME || "bx_agent");
const conv = await db.collection("chat_conversations").findOne({ id: convId });
for (const m of (conv?.messages || []).filter((x) => x.role === "assistant")) {
  const charts = m.charts || [];
  console.log(
    `assistant: 正文=${String(m.text || "").length}字 图表=${charts.length}张 steps=${(m.steps || []).length}` +
      ` chartTypes=${JSON.stringify(charts.map((c) => c.chartType))}`,
  );
  if (charts[0]) console.log(`  chart[0].data=${JSON.stringify(charts[0].data).slice(0, 160)}`);
}
await mc.close();

await api(`/chat/schedules/${encodeURIComponent(sch)}`, { method: "DELETE" });
await api(`/chat/conversations/${encodeURIComponent(convId)}`, { method: "DELETE" });
console.log("cleaned");
