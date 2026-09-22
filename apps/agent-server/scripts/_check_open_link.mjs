// 复现「点击打开对话看不到内容」：分别模拟
//   A) 无 cookie + 带 owner 参数（期望：能看到目标对话）
//   B) 有陈旧 cookie + 带 owner 参数（怀疑：owner 参数被压制 → 看不到）
const BASE = process.env.AGENT_BASE_URL || "http://127.0.0.1:8787";
const OWNER = process.argv[2] || "253fdd3a-7891-45fd-997c-3b5d1277421b";
const CONV = process.argv[3] || "conv_1789958040402_k0l0kz";

async function probe(label, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}/chat/conversations?owner=${encodeURIComponent(OWNER)}`, { headers });
  const text = await res.text();
  let ids = [];
  try {
    ids = (JSON.parse(text).conversations || []).map((c) => c.id);
  } catch {
    ids = [`<非法 JSON: ${text.slice(0, 120)}>`];
  }
  console.log(`--- ${label}`);
  console.log(`    HTTP ${res.status}  条数=${ids.length}`);
  console.log(`    目标对话可见=${ids.includes(CONV)}`);
  console.log(`    ids=${ids.join(", ")}`);
  const sc = res.headers.get("set-cookie") || "";
  const oid = /bx_agent_oid=([^;]+)/.exec(sc);
  console.log(`    回写 owner cookie=${oid ? oid[1] : "(无)"}`);
  return ids.includes(CONV);
}

const a = await probe("A) 无 cookie + owner 参数", "");
const b = await probe("B) 陈旧 cookie + owner 参数", "bx_agent_oid=deadbeef-1234-5678-90ab-cdef12345678");
console.log("");
console.log(`结论：A=${a ? "可见" : "不可见"}  B=${b ? "可见" : "不可见"}`);
