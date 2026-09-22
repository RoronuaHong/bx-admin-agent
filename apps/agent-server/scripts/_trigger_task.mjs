import { MongoClient } from "mongodb";
const c = new MongoClient("mongodb://127.0.0.1:27017");
await c.connect();
const db = c.db("bx_agent");
const now = Date.now();
const r = await db.collection("chat_schedules").updateOne(
  { id: "sched_7a70cf4b-acd" },
  { $set: { notifyChannelIds: ["dingtalk"], nextRunAt: now - 60000 } },
);
console.log("matched=", r.matchedCount, "modified=", r.modifiedCount, "nextRunAt=", now - 60000);
const doc = await db.collection("chat_schedules").findOne({ id: "sched_7a70cf4b-acd" });
console.log("notifyChannelIds=", JSON.stringify(doc.notifyChannelIds), "nextRunAt=", doc.nextRunAt);
await c.close();
