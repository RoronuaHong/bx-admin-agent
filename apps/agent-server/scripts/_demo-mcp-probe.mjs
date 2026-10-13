// 探针：验证 demo-mcp（HTTP StreamableHTTP 无状态）能否正常握手 + 列工具 + 调用。
// 用法：node scripts/_demo-mcp-probe.mjs [port]
const PORT = Number(process.argv[2] || 8911);
const BASE = `http://127.0.0.1:${PORT}/mcp`;

async function rpc(method, params, id) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    // 简易解析 SSE：取 data: 行里的 JSON
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d) return JSON.parse(d);
      }
    }
    return {};
  }
  return text ? JSON.parse(text) : {};
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "demo-probe", version: "1.0" },
}, 1);
console.log("initialize ok:", init.result?.serverInfo || init.result?.serverInfo?.name || "ok");

await rpc("notifications/initialized", {}, undefined);
const list = await rpc("tools/list", {}, 2);
console.log("tools:", (list.result?.tools || []).map((t) => t.name));

const call = await rpc("tools/call", { name: "demo_greet", arguments: { message: "全链路验证" } }, 3);
console.log("call demo_greet:", call.result?.content?.[0]?.text || call.error);
console.log("ALL OK");
