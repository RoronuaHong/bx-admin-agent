// 一次性数据修复：把对话里「已失效的模型 id」统一改写成「自动」。
//
// 背景：MODEL_PROVIDERS 重组时多个模型被挪出配置，但对话级 model 字段没有校验，
// 悬空 id 直接落库——运行期会被 getModel 跳过（静默回落默认模型），
// 前端选择器也查不到标签（退化成「选择模型」空壳）。
// 落库校验已补（src/conversations.ts 的 sanitizeModelId），本脚本清历史脏数据。
//
// 用法（默认 dry-run 只列不改）：
//   node --import tsx scripts/fix-stale-conversation-models.mjs
//   node --import tsx scripts/fix-stale-conversation-models.mjs --run
import { MongoClient } from "mongodb";

await import("../src/load-env.js");
const { listModels } = await import("../src/config.js");

const apply = process.argv.includes("--run");
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGO_DB_NAME || "bx_agent";
const valid = new Set(listModels().map((m) => m.id));

const client = new MongoClient(uri);
await client.connect();
const coll = client.db(dbName).collection("chat_conversations");

const stale = await coll
  .find({ model: { $type: "string", $ne: "", $ne: "auto" } })
  .project({ id: 1, title: 1, model: 1 })
  .toArray();
const bad = stale.filter((doc) => !valid.has(String(doc.model || "").trim()));

console.log(`模型注册表（${valid.size}）：${[...valid].join(", ") || "(空)"}`);
console.log(`存了具体模型的对话 ${stale.length} 个，其中失效 ${bad.length} 个`);
for (const doc of bad) console.log(`  - ${doc.id}  model=${doc.model}  title=${JSON.stringify(doc.title || "")}`);

if (!apply) {
  console.log("dry-run：未改任何数据；确认无误后加 --run 执行。");
} else if (bad.length) {
  const result = await coll.updateMany({ _id: { $in: bad.map((doc) => doc._id) } }, { $set: { model: "auto" } });
  console.log(`已改写 ${result.modifiedCount} 个对话的 model → auto`);
} else {
  console.log("没有需要修复的数据。");
}

await client.close();
