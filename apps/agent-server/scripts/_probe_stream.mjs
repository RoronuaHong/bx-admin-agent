// 临时探针：走完 /chat/stream 完整链路，验证默认模型代理是否可用。
const BASE = "http://localhost:8787";

async function main() {
  // 1) 拿匿名 session cookie
  const pre = await fetch(`${BASE}/chat/preferences`, { method: "GET" });
  const setCookie = pre.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  console.log("cookie:", cookie || "(none)");

  // 2) 发一条默认模型消息
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    // 不指定 model：走服务端默认（MODEL_PROVIDERS 第一个），换模型后本探针不用改。
    body: JSON.stringify({ text: "你好，用一句话介绍自己" }),
  });
  console.log("status:", res.status, res.statusText);
  const text = await res.text();
  console.log("=== RAW (前 1200 字) ===");
  console.log(text.slice(0, 1200));
  const types = [...text.matchAll(/"type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log("=== 事件 types ===", types.join(", "));
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
