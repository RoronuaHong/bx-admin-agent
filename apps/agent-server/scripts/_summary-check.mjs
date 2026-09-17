// 冒烟：上下文压缩（LLM 摘要 + 水位线）走真实链路。
// 做法：直接往 Mongo 插入一条带超预算 context 的对话 → 流式一轮 → 断言 usage.summarized 与
//       conversation.summary/summaryCovered；再流一轮验证摘要被复用（不重复压缩）。
// 跑法：node scripts/_summary-check.mjs [base]
import { MongoClient } from "mongodb";

const BASE = process.argv[2] || process.env.AGENT_BASE_URL || "http://localhost:8787";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";

let cookie = "";
async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

async function streamTurn(conversationId, text) {
  const res = await call("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, text }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "text_delta") events.push(e);
      } catch {}
    }
  }
  return events;
}

const filler = "这是一段用于撑大上下文的中文文本，内容并不重要。".repeat(30); // ≈ 660 字
const turns = [];
for (let i = 0; i < 120; i++) {
  turns.push({ role: "user", text: `第${i}轮提问：${filler}` });
  turns.push({ role: "assistant", text: `第${i}轮回答：${filler}` });
}

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection("chat_conversations");
const id = `conv_summary_${Date.now()}`;
await coll.insertOne({ id, title: "summary 冒烟", messages: [], context: turns, createdAt: Date.now(), updatedAt: Date.now() });

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

console.log("第 1 轮：超预算历史 → 触发压缩");
const e1 = await streamTurn(id, "只回复两个字：好的");
const u1 = e1.find((x) => x.type === "usage");
check("流式正常完成", e1.some((x) => x.type === "done"), JSON.stringify(e1.map((x) => x.type)));
check("usage 带摘要标记", u1?.summarized === true, JSON.stringify(u1));
const doc1 = await coll.findOne({ id });
check("摘要已持久化", Boolean(doc1?.summary), String(doc1?.summary || "").slice(0, 80));
check("水位线前移", (doc1?.summaryCovered || 0) > 0, `covered=${doc1?.summaryCovered}`);

console.log("第 2 轮：摘要被复用（不重复压缩）");
const summaryBefore = doc1.summary;
const coveredBefore = doc1.summaryCovered;
const e2 = await streamTurn(id, "再回复两个字：好的");
const u2 = e2.find((x) => x.type === "usage");
check("第二轮流式正常", e2.some((x) => x.type === "done"), JSON.stringify(e2.map((x) => x.type)));
check("第二轮仍带摘要", u2?.summarized === true, JSON.stringify(u2));
const doc2 = await coll.findOne({ id });
check("摘要未重复生成（内容一致）", doc2?.summary === summaryBefore, String(doc2?.summary || "").slice(0, 80));

console.log("清理");
await coll.deleteOne({ id });
await client.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
