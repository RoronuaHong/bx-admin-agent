// TokenHub 模型可用性 + 函数调用能力扫描（只读，零业务词）。
//
// 为什么需要：`GET /v1/models` 返回的是**平台目录**，不代表当前 key 有额度（实测同一 key 下有的服务 200、
// 有的回 402/401008「免费额度已耗尽/未开通」）。选默认模型 / 排查「页面报 402」时，要的是「现在真能跑、
// 且能出 tool_calls」的那几个，而不是目录长度。
//
// 跑法：
//   cd apps/agent-server
//   node scripts/_tokenhub-model-sweep.mjs                     # 默认候选（文本类 LLM 名单）
//   node scripts/_tokenhub-model-sweep.mjs glm-5.3 kimi-k3    # 只测指定模型
//   SWEEP_CONCURRENCY=6 node scripts/_tokenhub-model-sweep.mjs
//
// 判读：
//   200 + tool_calls=1  → 可用且函数调用生效（可做 agent 主力模型）
//   200 + tool_calls=0  → 可用但不按提示出工具调用（弱工具纪律，慎选）
//   200 + required=200  → 端点接受 tool_choice=required（首轮强制通道可用，见 chat.ts 的 forcedToolChoiceSupported）
//   402 / 401008        → 未开通 / 免费额度耗尽
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "..", ".env");
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
// 复用已配置模型条目里的 base/key（同一网关账号，key 相同）——按 MODEL_<ID>_ 前缀通用取第一个，
// 不绑定具体模型 id（换/删模型后脚本不该失效）。
const baseKey = Object.keys(env).find((k) => k.endsWith("_BASE_URL") && k.startsWith("MODEL_"));
const keyKey = Object.keys(env).find((k) => k.endsWith("_API_KEY") && k.startsWith("MODEL_"));
const base = (env.MODEL_SWEEP_BASE_URL || (baseKey ? env[baseKey] : "") || "https://tokenhub.tencentmaas.com/v1").replace(/\/+$/, "");
const key = env.MODEL_SWEEP_API_KEY || (keyKey ? env[keyKey] : "");
if (!key) {
  console.error("未在 .env 找到 MODEL_*_API_KEY");
  process.exit(2);
}

// 默认候选：从 /v1/models 目录里挑「文本 / 通用 LLM」类（排除语音、图像、视频、3D、embedding 等）。
const DEFAULT_CANDIDATES = [
  "hy4-preview", "hy3", "hy-role",
  "glm-5.3-flashx", "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo",
  "deepseek/deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731",
  "deepseek-v4-pro-202606", "deepseek-v4-flash-202605", "deepseek/deepseek-v4-flash-vision-exp",
  "kimi-k3", "kimi-k2.8-preview", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5",
  "minimax-m3", "minimax-m2.7", "mimo-v2.5-pro", "qwen3.5-plus", "qwen3.5-flash",
  "hy-vision-2.0-instruct", "hunyuan-t1-vision-20250916", "youtu-vita",
];
const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const candidates = asked.length ? asked : DEFAULT_CANDIDATES;
const CONCURRENCY = Math.max(1, Number(process.env.SWEEP_CONCURRENCY || 4));
const TIMEOUT_MS = Math.max(5000, Number(process.env.SWEEP_TIMEOUT_MS || 25000));

// 探针工具：协议级占位（无业务词），只用来观察端点是否按提示产出 tool_calls。
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

async function probe(model, toolChoice) {
  const body = {
    model,
    messages: [
      { role: "system", content: "You are a test harness. Follow the tool-calling requirement exactly." },
      { role: "user", content: 'Call the probe_echo tool with note set to "ping".' },
    ],
    tools: [PROBE_TOOL],
    tool_choice: toolChoice,
    stream: false,
    max_tokens: 256,
  };
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = Date.now() - startedAt;
    let calls = 0;
    let note = "";
    if (res.ok) {
      try {
        calls = JSON.parse(text)?.choices?.[0]?.message?.tool_calls?.length || 0;
      } catch {
        note = "响应非 JSON";
      }
    } else {
      const code = /"code"\s*:\s*"?([\w.-]+)"?/.exec(text)?.[1] || "";
      const msg = /"message"\s*:\s*"([^"]{0,80})/.exec(text)?.[1] || "";
      note = [res.status, code, msg].filter(Boolean).join(" ");
    }
    return { status: res.status, ms, calls, note };
  } catch (err) {
    return { status: -1, ms: Date.now() - startedAt, calls: 0, note: String(err?.message || err).slice(0, 80) };
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < candidates.length) {
    const model = candidates[cursor++];
    const auto = await probe(model, "auto");
    // 只有可用的模型才继续测「强制通道」——不可用模型再打一次只是浪费一次 4xx。
    const required = auto.status === 200 ? await probe(model, "required") : null;
    results.push({ model, auto, required });
    const mark = auto.status === 200 ? (auto.calls ? "OK  " : "warn") : "down";
    console.log(
      `[${mark}] ${model.padEnd(38)} auto=${auto.status} calls=${auto.calls} ${String(auto.ms).padStart(5)}ms` +
        (required ? ` | required=${required.status}` : "") +
        (auto.note ? `\n         ↳ ${auto.note}` : ""),
    );
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()));

const usable = results.filter((r) => r.auto.status === 200);
const toolReady = usable.filter((r) => r.auto.calls > 0);
const forcedOk = usable.filter((r) => r.required && r.required.status === 200);
console.log("\n===== 汇总 =====");
console.log(`可用（200）：${usable.length}/${results.length}｜其中按提示真的出了 tool_calls：${toolReady.length}`);
console.log(`可用且接受 tool_choice=required：${forcedOk.length}${forcedOk.length ? " → " + forcedOk.map((r) => r.model).join(", ") : ""}`);
console.log(`可用模型（按延迟升序）：`);
for (const r of [...usable].sort((a, b) => a.auto.ms - b.auto.ms)) {
  console.log(`  - ${r.model.padEnd(38)} ${String(r.auto.ms).padStart(5)}ms calls=${r.auto.calls} required=${r.required?.status ?? "-"}`);
}
const down = results.filter((r) => r.auto.status !== 200);
if (down.length) {
  console.log(`不可用：`);
  for (const r of down) console.log(`  - ${r.model.padEnd(38)} ${r.auto.status} ${r.auto.note}`);
}
process.exit(0);
