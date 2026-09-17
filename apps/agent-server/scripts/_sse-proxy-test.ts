// 探针：经指定 BASE（默认 5173 代理）启用 bi 并发起 chat/stream，打印每个分块（NDJSON，一行一事件）的到达时间。
// 用于判断 vite 代理是否缓冲流式响应：分块实时到达=流式；最后一次性到达=被缓冲。
// 注意：node fetch 经 dev 代理可能被 SPA 中间件误拦返回空体，浏览器内探针更可靠。
import "dotenv/config";

const BASE = process.argv[2] || "http://localhost:5173";
let cookie = "";
async function call(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers as Record<string, string>) };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

const put = await call("/chat/mcp/servers", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: ["bi"] }),
});
console.log("[setup] PUT mcp/servers ->", put.status);

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const res = await call("/chat/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "日活表" }),
});
console.log("[stream] status", res.status, "ct=", res.headers.get("content-type"));
if (!res.ok || !res.body) {
  console.log("[stream] body:", await res.text().then((t) => t.slice(0, 200)).catch(() => "<none>"));
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let n = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  n++;
  console.log(`${at()} CHUNK#${n} (${value.length}B) ${dec.decode(value).slice(0, 70).replace(/\n/g, " ")}`);
}
console.log(`${at()} END total chunks=${n}`);
