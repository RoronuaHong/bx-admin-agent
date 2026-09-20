// TokenHub「多轮工具循环」探针（只读，零业务词）：一个模型能不能真的当 agent 主力，取决于第二轮。
//
// 背景：单轮「带 tools 的请求能否出 tool_calls」只验证了第一跳。真实 agent 循环必然要**回灌工具结果**：
//   round1: user(+tools) → assistant.tool_calls
//   round2: assistant{tool_calls} + tool{结果} → 最终正文
// 实测踩过：某端点（kimi-k2.6）第一跳正常，第二跳直接 400
//   `thinking is enabled but reasoning_content is missing in assistant tool call message`
// —— 该端点默认开思考，回灌的 assistant 工具调用消息必须带 reasoning_content，否则整个工具循环在这里断掉，
// 表现为「检索到了数据，但最终回复空白」。本探针对可用模型逐个跑这两跳，并把「带上空 reasoning_content 是否放行」
// 一起测出来（决定修复方向是补字段还是换模型）。
//
// 跑法：
//   cd apps/agent-server
//   node scripts/_tokenhub-toolloop-probe.mjs                      # 默认测「单轮扫描里可用的模型」
//   node scripts/_tokenhub-toolloop-probe.mjs kimi-k2.6 glm-5.3
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(here, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const base = (env.MODEL_KIMI26_BASE_URL || "https://tokenhub.tencentmaas.com/v1").replace(/\/+$/, "");
const key = env.MODEL_KIMI26_API_KEY || "";
if (!key) {
  console.error("未在 .env 找到 MODEL_*_API_KEY");
  process.exit(2);
}

// 默认候选 = 2026-09-20 单轮扫描里「200 且出 tool_calls」的那些（换天/换额度后重跑单轮扫描再更新）。
const DEFAULT_CANDIDATES = [
  "kimi-k2.6", "kimi-k2.7-code-highspeed", "glm-5.3", "mimo-v2.5-pro", "glm-5v-turbo", "glm-5.3-flashx",
  "deepseek-v4-pro-202606", "deepseek-v4-flash-202605", "deepseek/deepseek-v4-flash-vision-exp",
  "hunyuan-t1-vision-20250916", "kimi-k3",
];
const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const candidates = asked.length ? asked : DEFAULT_CANDIDATES;
const CONCURRENCY = Math.max(1, Number(process.env.LOOP_CONCURRENCY || 3));
const TIMEOUT_MS = Math.max(10000, Number(process.env.LOOP_TIMEOUT_MS || 40000));

const TOOL = [
  {
    type: "function",
    function: {
      name: "probe_echo",
      description: "Echo one short string back. Use only when explicitly asked to test tool calling.",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
];
const SYSTEM = "You are a test harness. Follow the tool-calling requirement exactly.";

async function post(body) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON：保留原文用于报错 */
    }
    const code = /"code"\s*:\s*"?([\w.-]+)"?/.exec(text)?.[1] || "";
    const msg = (/"message"\s*:\s*"((?:[^"\\]|\\.){0,160})/.exec(text)?.[1] || "").replace(/\\"/g, '"');
    return { status: res.status, ms: Date.now() - startedAt, json, error: [code, msg].filter(Boolean).join(" ") };
  } catch (err) {
    return { status: -1, ms: Date.now() - startedAt, json: null, error: String(err?.message || err).slice(0, 120) };
  }
}

/** 跑两跳：第一跳出 tool_calls → 第二跳回灌（可选带 reasoning_content）→ 看能否拿到正文。 */
async function probe(model) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: 'Call the probe_echo tool with note set to "ping".' },
  ];
  const r1 = await post({ model, messages, tools: TOOL, tool_choice: "auto", stream: false, max_tokens: 256 });
  const call = r1.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (r1.status !== 200 || !call) {
    return { model, r1, r2: null, r2b: null, verdict: r1.status === 200 ? "不出 tool_calls" : "不可用" };
  }
  const assistant = {
    role: "assistant",
    content: r1.json?.choices?.[0]?.message?.content || "",
    tool_calls: [{ id: call.id || "call_probe", type: "function", function: call.function }],
  };
  const toolMsg = { role: "tool", tool_call_id: call.id || "call_probe", content: "ping-ok" };
  // 第二跳：按本仓客户端当前的回灌形态（不带 reasoning_content）
  const r2 = await post({
    model,
    messages: [...messages, assistant, toolMsg],
    tools: TOOL,
    tool_choice: "auto",
    stream: false,
    max_tokens: 256,
  });
  // 第二跳的对照：补一个空 reasoning_content（判断「是不是只缺这个字段」）
  const r2b = await post({
    model,
    messages: [...messages, { ...assistant, reasoning_content: "" }, toolMsg],
    tools: TOOL,
    tool_choice: "auto",
    stream: false,
    max_tokens: 256,
  });
  const text2 = r2.json?.choices?.[0]?.message?.content || "";
  // 变体 C：assistant 消息**带正文**（模型常先说一句「我来查一下」再发起工具调用）——实测这类形态更容易触发
  // 网关的 thinking 校验（`thinking is enabled but reasoning_content is missing in assistant tool call message`）。
  const r2c = await post({
    model,
    messages: [...messages, { ...assistant, content: "Let me check that." }, toolMsg],
    tools: TOOL,
    tool_choice: "auto",
    stream: false,
    max_tokens: 256,
  });
  // 变体 D：assistant 的 content 用 **null**（本仓客户端当前就是这么发的：`content: turn.content || null`，
  // 见 models.ts 的 toOpenAiMessages）。怀疑点：某些网关的 thinking 校验只对 `content: null` 报
  // `reasoning_content is missing`，而空串 "" 能过。
  const r2d = await post({
    model,
    messages: [...messages, { ...assistant, content: null }, toolMsg],
    tools: TOOL,
    tool_choice: "auto",
    stream: false,
    max_tokens: 256,
  });
  // 变体 E：**流式**回灌（本仓客户端实际走 SSE：stream:true）。怀疑点：thinking 校验只拦流式路径。
  const r2e = await post({
    model,
    messages: [...messages, assistant, toolMsg],
    tools: TOOL,
    tool_choice: "auto",
    stream: true,
    max_tokens: 256,
  });
  const verdict =
    r2e.status !== 200
      ? "流式（stream:true）回灌工具结果被拒 → 工具循环会在流式路径断掉"
      : r2d.status !== 200
      ? "content:null 形态被拒（本仓客户端当前正用这个形态）→ 改发空串即可"
      : r2.status !== 200
      ? r2b.status === 200
        ? "第二跳缺 reasoning_content → 补空字段可放行"
        : "第二跳 400：工具循环会断"
      : r2c.status !== 200
        ? "仅「assistant 带正文」的工具回合会 400（需按此形态加固）"
        : `可跑工具循环${text2.trim() ? "" : "（第二跳正文为空，需注意空回复）"}`;
  return { model, r1, r2, r2b, r2c, r2d, r2e, verdict };
}

const out = [];
let cursor = 0;
async function worker() {
  while (cursor < candidates.length) {
    const model = candidates[cursor++];
    const r = await probe(model);
    out.push(r);
    console.log(
      `[${r.r2?.status === 200 ? "OK  " : "warn"}] ${model.padEnd(38)} round1=${r.r1.status}` +
        ` round2=${r.r2?.status ?? "-"} +reasoning=${r.r2b?.status ?? "-"} +content=${r.r2c?.status ?? "-"}` +
        ` +null=${r.r2d?.status ?? "-"} +stream=${r.r2e?.status ?? "-"}` +
        ` ${String(r.r2?.ms ?? r.r1.ms).padStart(6)}ms  → ${r.verdict}`,
    );
    if (r.r2e && r.r2e.status !== 200 && r.r2e.error) console.log(`         ↳ stream 回灌：${r.r2e.error}`);
    if (r.r2 && r.r2.status !== 200 && r.r2.error) console.log(`         ↳ ${r.r2.error}`);
    else if (r.r2c && r.r2c.status !== 200 && r.r2c.error) console.log(`         ↳ round2+content: ${r.r2c.error}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()));

console.log("\n===== 汇总 =====");
for (const r of out) console.log(`  ${r.model.padEnd(38)} ${r.verdict}`);
const good = out.filter((r) => r.r2?.status === 200);
console.log(`\n能跑完整工具循环（两跳都 200）：${good.length}/${out.length}${good.length ? " → " + good.map((r) => r.model).join(", ") : ""}`);
process.exit(0);
