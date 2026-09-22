import { MongoClient } from "mongodb";
const c = new MongoClient("mongodb://127.0.0.1:27017");
await c.connect();
const db = c.db("bx_agent");
const docs = await db.collection("chat_schedules").find({ name: "测试-1" }).toArray();
console.log(JSON.stringify(docs, null, 2));
await c.close();
