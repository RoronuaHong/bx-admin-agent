// 一次性探针：对 OpenCode Zen 免费模型做轻量能力评估（工具通道 + 推理 + 延迟）
// 用法：node scripts/_zen-free-eval.mjs
// 结果打印为表格式 JSON，不做任何持久化。
//
// 免费档身份闸门（2026-11-16）：网关只认 OpenCode 客户端请求头（User-Agent opencode/1.18.0+ 与
// x-opencode-* 四件套），缺任一组被拒（"OpenCode 1.18.0 or newer is required to use the free tier"）。
// 这里按客户端形态注入；API_KEY 留空时按免费池凭据 `Bearer public` 发送。
import { randomUUID } from "node:crypto";

const BASE = process.env.ZEN_BASE || "https://opencode.ai/inference/openai/v1";
// 当前 Zen 端点接受空 Bearer（免费档回落 public）；若开始要求 workspace key，在此填入
const KEY = process.env.ZEN_API_KEY || "";
const CLIENT_VERSION = (process.env.ZEN_CLIENT_VERSION || "1.18.18").trim();
const uid = () => randomUUID().replace(/-/g, "").slice(0, 24);
const IDENTITY_HEADERS = {
  "User-Agent": `opencode/${CLIENT_VERSION}`,
  "x-opencode-client": "desktop",
  "x-opencode-project": "global",
  "x-opencode-session": `ses_${uid()}`,
  "x-opencode-request": `msg_${uid()}`,
};

const MODELS = process.env.ZEN_MODELS
  ? process.env.ZEN_MODELS.split(",").map((s) => s.trim()).filter(Boolean)
  : [
  // 2026-11-16 实测目录（GET /zen/v1/models）；目录轮换很快，跑之前建议先拉一遍最新列表。
  "big-pickle",
  "beam-free",
  "deepseek-v4.1-flash-free",
  "flint-40b-free",
  "glm-5.3-flash-free",
  "iceman-free",
  "inkling-2-small-free",
  "longcat-2.5-free",
  "minimax-m3.1-flash-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询指定城市的实时天气",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "城市名" } },
        required: ["city"],
      },
    },
  },
];

// 鸡兔同笼变体：6 头 16 脚 → 鸡 4 兔 2。答案可机器判定。
const RIDDLE =
  "一个农场里只有鸡和兔，共 6 个头、16 只脚。鸡和兔各有几只？只输出最终答案，格式：鸡=X只，兔=Y只";

async function chat(model, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEY ? { Authorization: `Bearer ${KEY}` } : { Authorization: "Bearer public" }),
        ...IDENTITY_HEADERS,
      },
      body: JSON.stringify({ model, ...body }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, ms, status: res.status, error: text.slice(0, 200) };
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    if (data.error) {
      return { ok: false, ms, status: res.status, error: `upstream: ${JSON.stringify(data.error).slice(0, 200)}` };
    }
    return {
      ok: true,
      ms,
      finish: data.choices?.[0]?.finish_reason,
      toolCalls: msg.tool_calls ?? null,
      content: (msg.content ?? "").slice(0, 300),
      reasoning: (msg.reasoning ?? msg.reasoning_content ?? "").slice(0, 120),
      usage: data.usage ?? null,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

function judgeRiddle(text) {
  const m = text.match(/鸡\s*=\s*(\d+)\D+兔\s*=\s*(\d+)/);
  if (!m) return { parsed: false };
  const [ji, tu] = [Number(m[1]), Number(m[2])];
  return { parsed: true, correct: ji === 4 && tu === 2, ji, tu };
}

function judgeToolCall(r) {
  if (!r.ok) return { pass: false, why: r.error ?? "http error" };
  const tc = r.toolCalls?.[0];
  if (!tc) return { pass: false, why: `finish=${r.finish} 无 tool_calls，正文：${r.content?.slice(0, 80)}` };
  const name = tc.function?.name;
  let args = {};
  try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* ignore */ }
  const cityOk = /上海/.test(args.city ?? "");
  return { pass: name === "get_weather" && cityOk, name, city: args.city };
}

const results = [];
for (const model of MODELS) {
  const row = { model };
  // 探针 1：工具通道
  const t1 = await chat(model, {
    messages: [{ role: "user", content: "上海今天天气如何？必须调用工具查询。" }],
    tools: TOOLS,
    max_tokens: 2048,
  });
  row.tool = judgeToolCall(t1);
  row.toolMs = t1.ms;
  if (!t1.ok) row.toolError = t1.error;

  // 探针 2：推理
  const t2 = await chat(model, {
    messages: [{ role: "user", content: RIDDLE }],
    max_tokens: 4096,
  });
  row.riddleMs = t2.ms;
  if (!t2.ok) {
    row.riddle = { pass: false, why: t2.error ?? `http ${t2.status}` };
  } else {
    const j = judgeRiddle(t2.content ?? "");
    row.riddle = { pass: j.parsed && j.correct, ...j, raw: (t2.content ?? "").slice(0, 120) };
  }
  results.push(row);
  console.error(`[done] ${model} tool=${row.tool.pass} riddle=${row.riddle.pass} ms=${row.toolMs}/${row.riddleMs}`);
}

console.log(JSON.stringify(results, null, 2));
