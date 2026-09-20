// 「这个端点怎么关思考」探针（只读）：各 OpenAI 兼容网关关闭思考的参数写法不一致，逐个试出来。
//
// 背景：思考类端点在多轮/长提示下，思考 token 会显著拉大首字延迟；而关闭方式各家不同
// （`enable_thinking` / `thinking:{type:"disabled"}` / `chat_template_kwargs` / `reasoning_effort`），
// 传错还会被当成未知字段直接 400。本探针把「哪种写法被接受、关掉后思考是否归零、延迟降多少」一次测清。
//
// 实测（2026-09-20，TokenHub kimi-k2.6）：只有 `thinking:{type:"disabled"}` 被接受且思考归零
// （769ms vs 基线 1363ms，思考字符 0 vs 68）；`enable_thinking:false` 与 `chat_template_kwargs` 被静默忽略，
// `reasoning_effort:minimal` 被接受但更慢（7.3s）。该结论已用在 `CallOptions.disableThinking`（内部辅助调用）。
//
// 跑法：
//   cd apps/agent-server
//   node scripts/_model-thinking-probe.mjs                    # 默认用 .env 里 MODEL_KIMI26_* 端点
//   PROBE_MODEL=glm-5.3 node scripts/_model-thinking-probe.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(here, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const base = env.MODEL_KIMI26_BASE_URL || "https://tokenhub.tencentmaas.com/v1";
const key = env.MODEL_KIMI26_API_KEY || "";
const model = process.env.PROBE_MODEL || env.MODEL_KIMI26_NAME || "kimi-k2.6";
const url = `${base.replace(/\/+$/, "")}/chat/completions`;

const VARIANTS = [
  { name: "baseline（不传任何参数）", extra: {} },
  { name: "enable_thinking:false", extra: { enable_thinking: false } },
  { name: 'thinking:{type:"disabled"}', extra: { thinking: { type: "disabled" } } },
  { name: "chat_template_kwargs.enable_thinking=false", extra: { chat_template_kwargs: { enable_thinking: false } } },
  { name: "reasoning_effort:minimal", extra: { reasoning_effort: "minimal" } },
];

const PROMPT = "用一句话回答：1+1 等于几？";
console.log(`[thinking 探针] ${model} → ${url}\n`);

for (const v of VARIANTS) {
  const startedAt = Date.now();
  let status = 0;
  let reasoningChars = 0;
  let content = "";
  let note = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], stream: true, max_tokens: 512, ...v.extra }),
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    if (!res.ok) {
      note = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta;
            reasoningChars += (delta?.reasoning || delta?.reasoning_content || "").length;
            content += delta?.content || "";
          } catch {
            /* 忽略非 JSON 行（心跳等） */
          }
        }
      }
    }
  } catch (err) {
    status = -1;
    note = String(err?.message || err).slice(0, 120);
  }
  console.log(
    `- ${v.name.padEnd(44)} status=${status} ${String(Date.now() - startedAt).padStart(6)}ms 思考字符=${reasoningChars} 正文=${content.trim().slice(0, 30) || "（空）"}` +
      (note ? `\n    ↳ ${note}` : ""),
  );
}
process.exit(0);
