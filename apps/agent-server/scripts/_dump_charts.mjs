// 倒出对话里各轮 assistant 消息的图表数据 + 文本摘要，用于核对「本轮图表数据是不是本轮真取到的」。
import { MongoClient } from "mongodb";

const CONV = process.argv[2] || "conv_1789958040402_k0l0kz";
const TAIL = Number(process.argv[3] || 2);

const c = await MongoClient.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
const db = c.db(process.env.MONGO_DB_NAME || "bx_agent");
const conv = await db.collection("chat_conversations").findOne({ id: CONV });
if (!conv) {
  console.log("no conversation");
  process.exit(1);
}
const msgs = (conv.messages || []).filter((m) => m.role === "assistant");
console.log(`conv=${CONV} assistant 消息数=${msgs.length}`);
for (const [i, m] of msgs.slice(-TAIL).entries()) {
  const charts = m.charts || (m.chart ? [m.chart] : []);
  const tools = [...new Set((m.steps || []).map((s) => s?.name || s?.tool || s?.type).filter(Boolean))];
  console.log(`\n===== assistant#${i}  图表数=${charts.length}`);
  console.log(`tools=${JSON.stringify(tools)}`);
  console.log(`text(${String(m.text || "").length}): ${String(m.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
  for (const ch of charts) {
    const spec = ch?.spec || ch;
    const data = spec?.data ?? spec?.series ?? spec?.values ?? null;
    const type = spec?.chartType || spec?.type || "";
    const title = String(spec?.title || "").slice(0, 40);
    const xKey = spec?.xKey || spec?.x || "";
    const yKeys = JSON.stringify(spec?.yKeys || spec?.y || []);
    console.log(`  • chart type=${type} title=${title} xKey=${xKey} yKeys=${yKeys}`);
    console.log(`    data=${JSON.stringify(data).slice(0, 420)}`);
  }
}
await c.close();
