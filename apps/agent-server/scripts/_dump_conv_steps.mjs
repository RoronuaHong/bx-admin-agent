// 倒出指定对话最近几轮消息里的工具调用步骤（steps），用于核对定时任务那轮到底调了什么工具。
import { MongoClient } from "mongodb";

const CONV = process.argv[2] || "conv_1789958040402_k0l0kz";
const TAIL = Number(process.argv[3] || 4);

const c = await MongoClient.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
const db = c.db(process.env.MONGO_DB_NAME || "bx_agent");
const conv = await db.collection("chat_conversations").findOne({ id: CONV });
if (!conv) {
  console.log("no conversation");
  process.exit(1);
}
const msgs = conv.messages || [];
console.log(`conv=${CONV} msgCount=${msgs.length}`);
for (const m of msgs.slice(-TAIL)) {
  const at = m.at ? new Date(m.at).toISOString() : "-";
  console.log(`\n===== role=${m.role} at=${at} steps=${Array.isArray(m.steps) ? m.steps.length : 0}`);
  console.log(`--- text: ${String(m.text || "").replace(/\s+/g, " ").slice(0, 220)}`);
  for (const s of m.steps || []) {
    const name = s?.name || s?.tool || s?.toolName || s?.type || "?";
    let arg = s?.input ?? s?.args ?? s?.arguments ?? s?.params ?? "";
    arg = typeof arg === "string" ? arg : JSON.stringify(arg);
    const out = s?.output ?? s?.result ?? "";
    const outStr = typeof out === "string" ? out : JSON.stringify(out);
    console.log(`  • ${name}  args=${String(arg).slice(0, 200)}`);
    if (outStr) console.log(`      result=${outStr.replace(/\s+/g, " ").slice(0, 240)}`);
  }
}
await c.close();
