// 临时脚本：验证「空 assistant 轮」两道修复。用完即删。
//   (a) 写入口收口：appendContext 收到空 assistant 轮时要丢掉
//   (b) 边界自愈：直接把脏轮塞进 Mongo（绕过写入口）后，发真实请求仍应成功（不再 400）
await import("../src/load-env.js");
const { createConversation, appendContext, getConversation } = await import("../src/conversations.js");
const { MongoClient } = await import("mongodb");

const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const id = "poison_check_" + Date.now();

let cookie = "";
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (sc.length) {
    const parts = sc.map((c) => c.split(";")[0]).filter(Boolean);
    if (parts.length) cookie = parts.join("; ");
  }
  return res;
}

await createConversation({ id, title: "poison-check" });
await req("/chat/preferences");

// (a) 写入口收口
await appendContext(id, [
  { role: "user", text: "你好" },
  { role: "assistant", text: "   " },
]);
const afterA = await getConversation(id);
console.log(`(a) 写入口收口：写入 [user, 空 assistant] 后 context 轮数 = ${(afterA.context || []).length}（期望 1）`);
console.log(`    roles = ${JSON.stringify((afterA.context || []).map((t) => t.role))}`);

// (b) 边界自愈：绕过 appendContext，直接把脏轮写进 Mongo
const cli = new MongoClient(process.env.MONGO_URI || "mongodb://127.0.0.1:27017");
await cli.connect();
const coll = cli.db(process.env.MONGO_DB_NAME || "bx_agent").collection("chat_conversations");
await coll.updateOne({ id }, { $push: { context: { role: "assistant", text: "" } } });
const afterB = await getConversation(id);
console.log(`(b) 注入脏轮后 context 轮数 = ${(afterB.context || []).length}（含 1 条空 assistant）`);

// 带脏历史发真实请求：修复前必然 400「assistant must not be empty」，修复后应正常返回
const res = await req("/chat/stream", { method: "POST", body: JSON.stringify({ text: "用一句话说你好", conversationId: id }) });
if (!res.ok || !res.body) {
  console.log("(b) 请求失败：", res.status, await res.text().catch(() => ""));
  await cli.close();
  process.exit(2);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let err = null;
let text = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "error") err = ev.message || JSON.stringify(ev.error);
    if (ev.type === "text") text = ev.text;
  }
}
console.log(`(b) 带脏历史请求：错误=${err ? "有 → " + String(err).slice(0, 160) : "无"}；正文=${JSON.stringify(text.slice(0, 120))}`);

// 收尾：删掉本次验证用的对话
await coll.deleteOne({ id });
await cli.close();
console.log(err ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exitCode = err ? 1 : 0;
