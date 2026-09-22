import { MongoClient } from "mongodb";

const c = new MongoClient("mongodb://127.0.0.1:27017");
await c.connect();
const db = c.db("bx_agent");
const cols = await db.listCollections().toArray();
console.log("collections:", cols.map((x) => x.name).join(", "));
for (const name of ["schedules", "chatSchedules", "schedule"]) {
  try {
    const n = await db.collection(name).countDocuments();
    console.log(`  ${name}: ${n} docs`);
    if (n > 0) {
      const docs = await db.collection(name).find({}).limit(3).toArray();
      console.log("  sample:", JSON.stringify(docs, null, 2).slice(0, 1200));
    }
  } catch (e) {
    console.log(`  ${name}: err ${e.message}`);
  }
}
await c.close();
