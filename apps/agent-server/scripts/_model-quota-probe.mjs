// 模型额度探针（只读、零业务词）：逐个给 MODEL_PROVIDERS 里的模型打一个最小请求，
// 判定「还有额度 / 额度已耗尽（402 · 401008）/ 其它错误」，并给出可直接替换的 MODEL_PROVIDERS 行。
//
// 为什么需要它：402（401008 免费额度耗尽）是**终局失败**，服务端只在重试/切换候选时打日志，
// 终局失败查不到记录（实测：用户看到的 kimi27hs 402 在日志里完全没有对应行）。
// 与其从日志反推，不如逐个探一次——把「哪些模型还能用」变成一次可复现的对照实验。
//
// 跑法（不需要起服务端，只走模型端点）：
//   cd apps/agent-server
//   node scripts/_model-quota-probe.mjs                 # 探 MODEL_PROVIDERS 全部
//   node scripts/_model-quota-probe.mjs kimi27hs ds4pro # 只探指定模型 id
//
// 判读：200 = 可用；402/401008 = 额度耗尽（应清理）；其它 4xx/5xx = 端点或参数问题（需分辨，
// 不要与「额度耗尽」混为一谈）。
await import("../src/load-env.js");
const { listModels, getModel } = await import("../src/config.js");

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const models = (only.length ? only.map((id) => getModel(id)) : listModels()).filter(Boolean);
if (!models.length) {
  console.error("没有可探测的模型（检查 MODEL_PROVIDERS 与参数）");
  process.exit(2);
}

const DEAD = [];
const ALIVE = [];
const OTHER = [];

for (const model of models) {
  const base = String(model.baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const startedAt = Date.now();
  let status = 0;
  let detail = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey || ""}` },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4,
        stream: false,
        // 关掉 thinking：部分端点拒绝「关了思考又强制工具」这类组合，这里只测额度，不引入额外变量。
      }),
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    const text = await res.text().catch(() => "");
    if (!res.ok) detail = text.slice(0, 220).replace(/\s+/g, " ");
  } catch (err) {
    status = -1;
    detail = String(err?.message || err).slice(0, 160);
  }
  const ms = Date.now() - startedAt;

  // 额度耗尽判定：HTTP 402 或错误体里的 401008（免费体验额度已耗尽）。
  const quotaDead = status === 402 || /401008|quota for the service has been exhausted/i.test(detail);
  if (status === 200) {
    ALIVE.push(model);
    console.log(`[ALIVE] ${model.id.padEnd(10)} ${model.name.padEnd(38)} 200  ${ms}ms`);
  } else if (quotaDead) {
    DEAD.push(model);
    console.log(`[DEAD ] ${model.id.padEnd(10)} ${model.name.padEnd(38)} ${status}  额度耗尽（401008）  ${ms}ms`);
  } else {
    OTHER.push(model);
    console.log(`[OTHER] ${model.id.padEnd(10)} ${model.name.padEnd(38)} ${status}  ${ms}ms\n         ↳ ${detail}`);
  }
}

console.log(`\n可用 ${ALIVE.length} / 额度耗尽 ${DEAD.length} / 其它错误 ${OTHER.length}`);
if (ALIVE.length) console.log(`\n可用的 MODEL_PROVIDERS（按探测顺序）：\nMODEL_PROVIDERS=${ALIVE.map((m) => m.id).join(",")}`);
if (DEAD.length) console.log(`\n建议清理（额度耗尽）：${DEAD.map((m) => m.id).join(", ")}`);
if (OTHER.length) console.log(`\n需人工分辨（非额度问题，勿连带删除）：${OTHER.map((m) => m.id).join(", ")}`);
process.exitCode = ALIVE.length ? 0 : 1;
