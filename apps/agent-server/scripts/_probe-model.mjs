import "dotenv/config";
const base = (process.env.MODEL_QWEN35FLASH_BASE_URL || "").replace(/\/+$/, "");
const key = process.env.MODEL_QWEN35FLASH_API_KEY || "";
const name = process.env.MODEL_QWEN35FLASH_NAME || "";
console.log("base=", base, "name=", name, "key?", !!key);

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 20000);
try {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: name, max_tokens: 32, stream: false, messages: [{ role: "user", content: "ping" }] }),
    signal: ctrl.signal,
  });
  console.log("status=", res.status);
  const txt = await res.text();
  console.log("body=", txt.slice(0, 600));
} catch (e) {
  console.log("ERROR", e.name, e.message);
} finally {
  clearTimeout(timer);
}
