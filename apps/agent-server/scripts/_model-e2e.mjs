// 一次性 E2E：通过服务端 /chat/stream 用指定模型跑一轮对话，验证模型链路。
// 用法：node scripts/_model-e2e.mjs <modelSlotId> [question]
import process from "node:process";

const model = process.argv[2] || "ornem3u";
const question = process.argv[3] || "用一句话介绍你自己，并说明你是什么模型。";
const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";

const res = await fetch(`${base}/chat/stream`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: question, model }),
});
const cookies = res.headers.getSetCookie?.() ?? [];
// 会话 cookie 需要回传（owner 派生自它）
const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
if (!res.ok && !cookieHeader) {
  console.error(`HTTP ${res.status}:`, (await res.text()).slice(0, 300));
  process.exit(1);
}

// SSE 读取（若 4xx 直接打印错误）
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, (await res.text()).slice(0, 300));
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let answer = "";
let modelEcho = "";
const start = Date.now();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const payload = line.trim();
    if (!payload.startsWith("{")) continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.type === "text" && typeof ev.text === "string") answer += ev.text;
      if (ev.type === "model" && ev.id) modelEcho = ev.id;
      if (ev.type === "error") answer += `\n[error] ${JSON.stringify(ev).slice(0, 200)}`;
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
}
console.log(`model=${modelEcho || "?"} elapsed=${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log(`answer(${answer.length} chars): ${answer.slice(0, 400)}`);
