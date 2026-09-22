// 轻量体检（工具通道）：对指定模型发一条带 tools 的请求，检查是否真的回 tool_calls。
// 只读、零业务词：探针工具名/描述都是协议级占位。
import { config as loadEnv } from "dotenv";

loadEnv({ path: "d:/Code/bx-admin-agent/apps/agent-server/.env" });

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "probe_echo",
    description: "Echo one short string back. Use only when explicitly asked to test tool calling.",
    parameters: {
      type: "object",
      properties: { note: { type: "string", description: "Any short string." } },
      required: ["note"],
      additionalProperties: false,
    },
  },
};

const ids = (process.env.MODEL_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean);
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const id of targets.length ? targets : ids) {
  const prefix = `MODEL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
  const name = process.env[`${prefix}NAME`] || "";
  const baseUrl = (process.env[`${prefix}BASE_URL`] || "").replace(/\/+$/, "");
  const key = process.env[`${prefix}API_KEY`] || "";
  if (!baseUrl || !key || !name) {
    console.log(`${id.padEnd(10)} ⚠ 配置不完整`);
    continue;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Call probe_echo with note=ping." }],
        tools: [PROBE_TOOL],
        tool_choice: "auto",
        max_tokens: 128,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    if (!res.ok) {
      console.log(`${id.padEnd(10)} ❌ http=${res.status} ${raw.replace(/\s+/g, " ").slice(0, 140)}`);
      continue;
    }
    const j = JSON.parse(raw);
    const calls = j?.choices?.[0]?.message?.tool_calls || [];
    const names = calls.map((c) => c?.function?.name).filter(Boolean);
    console.log(
      `${id.padEnd(10)} ${names.length ? "✅" : "⚠️ "} tool_calls=${names.length} ${JSON.stringify(names)} ${Date.now() - started}ms`,
    );
  } catch (err) {
    console.log(`${id.padEnd(10)} ❌ ${String(err?.message || err).slice(0, 140)}`);
  }
}
