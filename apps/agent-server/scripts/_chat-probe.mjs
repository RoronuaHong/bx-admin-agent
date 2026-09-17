// 临时脚本：走 HTTP 与 agent-server 对话，验证 MCP（YApi）工具是否被模型调用并回填真实数据。
// 用法：node scripts/_chat-probe.mjs "<问题>" [模型 id]
//      node scripts/_chat-probe.mjs --file <prompt.txt> [模型 id]   ← PowerShell 传中文会乱码时用这个
import "dotenv/config";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:8787";
const fromFile = process.argv[2] === "--file";
const promptFile = fromFile ? process.argv[3] : "";
const text = fromFile ? readFileSync(promptFile, "utf8").trim() : process.argv[2] || "YApi 上有哪些项目？";
const model = (fromFile ? process.argv[4] : process.argv[3]) || "";

let cookie = "";
async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  });
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}

await (await req("/models")).json();
const enabled = await (await req("/chat/mcp/servers", { method: "PUT", body: JSON.stringify({ enabled: ["yapi"] }) })).json();
console.log("mcp enabled:", JSON.stringify(enabled.enabled), "yapi tools:", enabled.available.find((s) => s.id === "yapi")?.tools);

const stream = await req("/chat/stream", {
  method: "POST",
  body: JSON.stringify({ text, ...(model ? { model } : {}) }),
});
if (!stream.ok || !stream.body) {
  console.error(`chat failed: HTTP ${stream.status} ${await stream.text()}`);
  process.exit(1);
}

const steps = [];
let answer = "";
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of stream.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "tool_call") steps.push(`CALL ${ev.name} ${ev.args || ""}`);
    else if (ev.type === "tool_result") steps.push(`  → ${ev.ok ? "ok" : "FAIL"} ${String(ev.text || "").slice(0, 300).replace(/\s+/g, " ")}`);
    else if (ev.type === "text") answer = ev.text;
    else if (ev.type === "text_delta") answer += ev.text;
    else if (ev.type === "model") steps.push(`model=${ev.label}`);
    else if (ev.type === "error") steps.push(`ERROR ${ev.message || JSON.stringify(ev.error)}`);
  }
}
console.log("--- steps ---");
console.log(steps.join("\n") || "(none)");
console.log("--- answer ---");
console.log(answer);
