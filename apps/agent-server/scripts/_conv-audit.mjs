// 综合审计：①对话回复中的 SQL 宽搜索 ②analytics 评测 verdict 分布 ③运营 .err 高频问题
import { MongoClient } from "mongodb";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnv() {
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();

const out = { sqlConvs: [], verdictStats: {}, errIssues: {} };

// ---------- 1. 对话回复 SQL 宽搜索 ----------
const client = new MongoClient(process.env.MONGO_URI || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 3000 });
await client.connect();
const db = client.db(process.env.MONGO_DB_NAME || "bx_agent");
const coll = db.collection("chat_conversations");
let convWithSql = 0;
const cur = coll.find({});
for await (const doc of cur) {
  const asst = (doc.messages || []).filter((m) => m.role === "assistant" && typeof m.text === "string");
  if (!asst.length) continue;
  let hit = 0;
  for (const m of asst) {
    const t = m.text || "";
    if (/\bSELECT\b[\s\S]{0,1500}?\bFROM\b/i.test(t) || /```sql/i.test(t)) hit++;
  }
  if (hit > 0) {
    convWithSql++;
    out.sqlConvs.push({ conv: String(doc._id), agent: doc.agentId || doc.role || "general", sqlMsgs: hit, totalAsst: asst.length });
  }
}
out.convWithSql = convWithSql;
await client.close();

// ---------- 2. analytics 评测 verdict 分布 ----------
const aDir = fileURLToPath(new URL("../.data/analytics/", import.meta.url));
const files = readdirSync(aDir).filter((f) => f.endsWith(".jsonl"));
for (const f of files) {
  const lines = readFileSync(join(aDir, f), "utf8").split("\n").filter(Boolean);
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln);
      if (o.verdict) {
        out.verdictStats[o.verdict] = (out.verdictStats[o.verdict] || 0) + 1;
      }
    } catch {}
  }
}

// ---------- 3. .err 高频运营问题 ----------
const errFiles = readdirSync(aDir).filter((f) => f.endsWith(".err"));
const errCounts = {};
for (const f of errFiles) {
  const txt = readFileSync(join(aDir, f), "utf8");
  const lines = txt.split("\n").filter(Boolean);
  for (const ln of lines) {
    let key = null;
    if (/免费.*额度|free trial quota|401008/.test(ln)) key = "模型额度耗尽(401008)级联降级";
    else if (/超整体预算|budget/.test(ln)) key = "超出运行预算(budget)";
    else if (/thinking 参数|不接受 thinking/.test(ln)) key = "端点不支持 thinking 参数";
    else if (/MissingSessionID|not supported/.test(ln)) key = "模型不可用(MissingSessionID/not supported)";
    else if (/ERROR|错误|异常/.test(ln)) key = "其它错误行";
    if (key) errCounts[key] = (errCounts[key] || 0) + 1;
  }
}
out.errIssues = errCounts;
out.errFileCount = errFiles.length;

writeFileSync(new URL("../.data/conv-audit-summary.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
