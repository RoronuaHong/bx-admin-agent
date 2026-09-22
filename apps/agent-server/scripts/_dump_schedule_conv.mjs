import { MongoClient } from "mongodb";
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGO_DB_NAME || "bx_agent";
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 3000 }).connect();
const db = client.db(dbName);

const schedules = await db.collection("chat_schedules").find({}).toArray();
console.log("=== 定时任务 ===");
for (const s of schedules) {
  console.log({
    id: s.id,
    conversationId: s.conversationId,
    ownerKey: s.ownerKey,
    name: s.name,
    notifyChannelIds: s.notifyChannelIds,
    lastStatus: s.lastStatus,
    lastDelivery: s.lastDelivery,
  });
}

console.log("\n=== 这些 conversationId 对应的会话内容 ===");
for (const s of schedules) {
  const conv = await db.collection("chat_conversations").findOne({ id: s.conversationId });
  if (!conv) {
    console.log(`[缺失] ${s.conversationId} 不存在！`);
    continue;
  }
  const msgs = conv.messages || [];
  const withCharts = msgs.filter((m) => (m.charts && m.charts.length) || (m.chart));
  console.log(`[${s.conversationId}] owner=${conv.ownerKey} agentId=${conv.agentId || "generic"} messages=${msgs.length} 含图表消息=${withCharts.length}`);
}
await client.close();
