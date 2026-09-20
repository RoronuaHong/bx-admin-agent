// 观影角色「一轮到底慢在哪」的诊断脚本：按事件打时间戳，配合服务端日志时间戳可把耗时归到具体阶段。
//
// 用法（中文提问写死在文件末尾的 PROMPT 常量里，避免 PowerShell 传参乱码）：
//   node scripts/_movie-timing.mjs           # 跑默认提问
//   MOVIE_E2E_BASE=http://127.0.0.1:8787     # 指定实例
// 判读：
//   - 首个 `text` 事件的时间 = 用户实际等待时长（此前一直 loading）；
//   - 与服务端 `[chat:tools]`（每轮模型调用起点）、`[chat:grounding]`（护栏动作）日志时间戳对齐，
//     即可看出耗时落在「第几轮模型调用 / 分诊 / 兜底」的哪一段。
//   - 端点自身抖动很大（实测同一端点小请求 0.4s/次，但并发或负载高时会退化到 10-25s/次），
//     所以判断前后变化要看「调用次数与阶段」而不是单次墙钟时间。
const BASE = process.env.MOVIE_E2E_BASE || "http://127.0.0.1:8787";
const cookie = "bx_agent_oid=bx_movie_timing";
const PROMPT = process.env.MOVIE_TIMING_PROMPT || "我先休息了";

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const conv = await post("/chat/conversations", { agentId: "movie", title: "timing" });
const id = conv.body?.conversation?.id;
if (!id) {
  console.error(`建对话失败 HTTP ${conv.status}`);
  process.exit(2);
}

const res = await fetch(`${BASE}/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ conversationId: id, agentId: "movie", text: PROMPT }),
});
console.log(`[${at()}] POST /chat/stream → HTTP ${res.status}｜提问：${PROMPT}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let firstText = null;
let firstThinking = null;
let text = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n");
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    // 思考/正文增量很密，只记首个到达时间；其余事件逐条打印。
    if (ev.type === "thinking_delta") {
      firstThinking ??= at();
      continue;
    }
    if (ev.type === "text_delta") {
      firstText ??= at();
      text += ev.text;
      continue;
    }
    if (ev.type === "text") text = ev.text;
    const brief =
      ev.type === "tool_call"
        ? `${ev.name} ${String(ev.args || "").slice(0, 80)}`
        : ev.type === "tool_result"
          ? `${ev.name} ok=${ev.ok !== false}`
          : "";
    console.log(`[${at()}] ${ev.type}${brief ? `  ${brief}` : ""}${ev.type === "usage" ? `  ${JSON.stringify(ev).slice(0, 160)}` : ""}`);
  }
}
console.log(`\n首个思考增量：${firstThinking || "-"}｜首个正文增量：${firstText || "-"}｜结束：${at()}`);
console.log(`最终回复：${text.trim().replace(/\n+/g, " ").slice(0, 200) || "（空）"}`);
