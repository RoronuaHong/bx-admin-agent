const { MongoClient } = require("mongodb");
const { Cron } = require("croner");
(async () => {
  const c = await MongoClient.connect("mongodb://127.0.0.1:27017");
  const db = c.db("bx_agent");
  const col = db.collection("chat_schedules");
  const t = await col.findOne({ id: "sched_7a70cf4b-acd" });
  if (!t) { console.log("not found"); await c.close(); return; }
  const job = new Cron(t.cron || "0 11 1 * *");
  const next = job.nextRun();
  const nextMs = next ? next.getTime() : 0;
  const r = await col.updateOne({ id: t.id }, { $set: { enabled: true, nextRunAt: nextMs } });
  console.log("modified", r.modifiedCount, "cron", t.cron, "nextRunAt", new Date(nextMs).toISOString());
  await c.close();
})().catch((e) => console.error("ERR", e.message));
