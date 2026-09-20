// 模型网关 tool_choice 兼容性探针（只读、零业务词）：确认某个 OpenAI 兼容端点接受哪些 tool_choice 取值。
//
// 为什么需要它：`forceToolCall`（roles.ts）依赖端点尊重 `tool_choice: "required"`，但各网关/模型兼容性不一致
// （Anthropic 文档明示部分模型对 any/tool 直接返回 400）。chat.ts 的降级逻辑只在运行时发现，排查时看不出
// 「到底是 tool_choice 不兼容，还是这次请求另有问题」——本探针把这件事变成一次可复现的对照实验。
//
// 跑法（需先起服务端无关；只走模型端点）：
//   cd apps/agent-server
//   node scripts/_model-toolchoice-probe.mjs                 # 默认 MODEL_PROVIDERS 第一个模型
//   node scripts/_model-toolchoice-probe.mjs kimi26          # 指定模型 id
//   node scripts/_model-toolchoice-probe.mjs kimi26 required # 只测一个取值
//
// 判读：某取值返回 4xx（如 400 invalid_request_error / rejected by ... component）= 该端点不接受该取值，
// 运行时会自动降级 auto 并重试；返回 200 且 tool_calls 非空 = 该取值被接受且生效。
await import("../src/load-env.js");
const { listModels, getModel, defaultModel } = await import("../src/config.js");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// 探针工具：名字与描述都是协议级占位（无业务词），只用来观察端点是否接受强制通道。
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
const VARIANTS = [
  { id: "auto", value: "auto" },
  { id: "required", value: "required" },
  { id: "named", value: { type: "function", function: { name: "probe_echo" } } },
  { id: "none", value: "none" },
];

const modelId = args[0] || defaultModel()?.id;
const only = args[1];
const model = getModel(modelId);
if (!model) {
  console.error(`未找到模型 ${modelId}；当前可用：${listModels().map((m) => m.id).join(", ") || "（无）"}`);
  process.exit(2);
}
if (model.provider !== "openai") {
  console.error(`本探针只覆盖 OpenAI 兼容端点，模型 ${model.id} 的 provider=${model.provider}`);
  process.exit(2);
}

const base = String(model.baseUrl || "").replace(/\/+$/, "");
const url = `${base}/chat/completions`;
const variants = only ? VARIANTS.filter((v) => v.id === only) : VARIANTS;
console.log(`[tool_choice 探针] 模型 ${model.id}（${model.name}）→ ${url}\n`);

for (const variant of variants) {
  const body = {
    model: model.name,
    messages: [
      { role: "system", content: "You are a test harness. Follow the tool-calling requirement exactly." },
      { role: "user", content: "Call the probe_echo tool with note set to \"ping\"." },
    ],
    tools: [PROBE_TOOL],
    tool_choice: variant.value,
    stream: false,
    max_tokens: 256,
  };
  const startedAt = Date.now();
  let status = 0;
  let detail = "";
  let calls = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey || ""}` },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    if (res.ok) {
      try {
        const parsed = JSON.parse(text);
        calls = parsed?.choices?.[0]?.message?.tool_calls?.length || 0;
      } catch {
        detail = text.slice(0, 200);
      }
    } else {
      detail = text.slice(0, 260).replace(/\s+/g, " ");
    }
  } catch (err) {
    status = -1;
    detail = String(err?.message || err).slice(0, 200);
  }
  const ms = Date.now() - startedAt;
  const verdict =
    status === 200
      ? `200 接受（tool_calls=${calls}${variant.id === "none" || variant.id === "auto" ? "，不强制时可为 0" : ""}）`
      : `${status} 不支持 / 失败`;
  console.log(`- tool_choice=${variant.id.padEnd(9)} ${verdict}  ${ms}ms${detail ? `\n    ↳ ${detail}` : ""}`);
}
