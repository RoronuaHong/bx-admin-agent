// 观影画像维护小工具（运维/自检用）。
//   node scripts/_movie-profiles.mjs list               列出现有画像概览
//   node scripts/_movie-profiles.mjs clean-test         删除自检产生的 owner（apicheck*/recscheck*）
//   node scripts/_movie-profiles.mjs clear <ownerKey>   删除指定 owner 的画像
import "dotenv/config";
import { MongoClient } from "mongodb";

const URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "movie_profiles";

const client = await new MongoClient(URI, { serverSelectionTimeoutMS: 3000 }).connect();
const coll = client.db(DB).collection(COLL);
const mode = process.argv[2] || "list";

function brief(d) {
  return {
    ownerKey: d.ownerKey,
    history: d.history?.length || 0,
    seen: d.seen?.length || 0,
    dislikes: (d.feedback || []).filter((f) => f.verdict === "dislike").length,
    watchlist: d.watchlist?.length || 0,
    recs: d.recs?.items?.length || 0,
    tags: d.tasteTags || [],
  };
}

if (mode === "list") {
  const docs = await coll.find({}).toArray();
  console.log(JSON.stringify(docs.map(brief), null, 2));
  console.log(`total=${docs.length}`);
} else if (mode === "clean-test") {
  const res = await coll.deleteMany({ ownerKey: { $regex: "^(apicheck|recscheck|tastecheck)" } });
  console.log(`deleted=${res.deletedCount}`);
} else if (mode === "clear") {
  const owner = process.argv[3];
  if (!owner) throw new Error("用法：clear <ownerKey>");
  const res = await coll.deleteOne({ ownerKey: owner });
  console.log(`deleted=${res.deletedCount} owner=${owner}`);
} else {
  throw new Error(`未知模式：${mode}`);
}

await client.close();
