// 临时排查脚本：打印定时任务最近一次产出文本（用于核对投递内容）。
// 用法：node scripts/_dump_last_result.mjs [对话 id]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { MongoClient } = require("mongodb");

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGO_DB_NAME || "bx_agent";
const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

const only = process.argv[2];
if (only) {
  const conv = await db.collection("chat_conversations").findOne({ id: only });
  const msgs = (conv && conv.messages) || [];
  console.log(`conv=${only} count=${msgs.length} keys=${Object.keys(conv || {}).join(",")}`);
  msgs.forEach((m, i) => {
    const t = String(m.text || m.content || "");
    console.log(`--- [${i}] role=${m.role} len=${t.length} charts=${(m.charts || m.chart ? 1 : 0)}`);
    console.log(t.slice(0, 400).replace(/\n/g, " | "));
  });
  await client.close();
  process.exit(0);
}

const schedules = await db.collection("chat_schedules").find({}).toArray();
for (const s of schedules) {
  console.log(`\n=== ${s.id} name=${s.name} status=${s.lastStatus} delivery=${JSON.stringify(s.lastDelivery || null)}`);
  console.log(`conversationId=${s.conversationId}`);
  const conv = await db.collection("chat_conversations").findOne({ id: s.conversationId });
  const msgs = (conv && conv.messages) || [];
  const last = msgs.filter((m) => m.role === "assistant").slice(-1)[0];
  const text = (last && (last.text || last.content)) || "";
  console.log(`lastAssistantLen=${text.length}`);
  console.log(String(text).slice(0, 600));
}
await client.close();
