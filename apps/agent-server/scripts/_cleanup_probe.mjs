// 清理探针残留（owner 前缀 probe_ 的任务与对话）。
import { MongoClient } from "mongodb";

const c = await MongoClient.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
const db = c.db(process.env.MONGO_DB_NAME || "bx_agent");
const ps = await db.collection("chat_schedules").find({ ownerKey: /^probe_/ }).toArray();
console.log(`probe schedules = ${ps.length}`);
for (const s of ps) {
  console.log(`  del ${s.id} name=${s.name} enabled=${s.enabled} nextRunAt=${s.nextRunAt || "-"}`);
  await db.collection("chat_schedules").deleteOne({ id: s.id });
}
const cs = await db.collection("chat_conversations").find({ ownerKey: /^probe_/ }).toArray();
console.log(`probe conversations = ${cs.length}`);
for (const x of cs) {
  console.log(`  del ${x.id} msgs=${(x.messages || []).length}`);
  await db.collection("chat_conversations").deleteOne({ id: x.id });
}
const rest = await db.collection("chat_schedules").find({}).toArray();
console.log(`剩余定时任务 = ${rest.length}`);
for (const s of rest) console.log(`  ${s.name || "?"} enabled=${s.enabled} nextRunAt=${s.nextRunAt || "-"}`);
await c.close();
console.log("cleanup done");
