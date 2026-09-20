// 真实模型下的「歧义澄清」行为验证（不依赖 HTTP 服务：直接用 harness 跑完整一轮对话）。
// 场景一：关键用词存在多个说得通的解释 → 期望模型先澄清（出现 clarification_required）；
// 场景二：请求已足够明确 → 期望模型不反问、直接执行（防过度反问）。
// 运行：node --import tsx scripts/_clarify-live-check.mjs [模型id]
// 说明：模型行为有随机性，结果如实输出（不伪装通过）；跑完会删除本次验证用的会话记录。
// 必须最先加载 .env（MODEL_PROVIDERS 等在 import chat/config 前就位）。
import "../src/load-env.js";
import { chatStream } from "../src/chat.js";
import { createConversation, deleteConversation, patchConversation } from "../src/conversations.js";
import { answerConfirmation } from "../src/confirm.js";

const MODEL = process.argv[2] || process.env.AGENT_MODEL || "";
let failed = 0;
let skipped = 0;

function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`);
  if (!ok) failed += 1;
}

/** 模型额度/服务不可用（402/401008 等）：行为断言无信息量，如实 SKIP 而不是 FAIL。 */
const MODEL_DOWN = /40[12]|401008|quota|额度|未开通|rate.?limit/i;
function skipIfModelDown(seen, name) {
  if (seen.error && MODEL_DOWN.test(seen.error)) {
    skipped += 1;
    console.log(`SKIP ${name} · 模型不可用（${seen.error.slice(0, 80)}）`);
    return true;
  }
  return false;
}

/**
 * 跑一轮对话。进入「工具模式」必须勾选一个 MCP 服务器（toolMode = 勾选数 > 0）；
 * 这里用一个占位 id：连不上不影响内置工具注入（工具通道现状会如实告知模型）。
 * 收到澄清即模拟用户点选（默认第一个选项）。
 */
async function run(text, tag, { pick = 0 } = {}) {
  const convId = `__clarify-live-${tag}-${Date.now()}`;
  await createConversation({ id: convId, title: "clarify-live" });
  await patchConversation(convId, { mcpServers: ["placeholder"], ...(MODEL ? { model: MODEL } : {}) });

  const seen = { clarify: null, toolCalls: [], text: "", error: "", ms: 0 };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    for await (const ev of chatStream(convId, text, { sessionId: convId }, controller.signal)) {
      if (ev.type === "clarification_required") {
        seen.clarify = {
          question: ev.question,
          options: ev.options || [],
          missingField: ev.missingField,
          whyItMatters: ev.whyItMatters,
        };
        const options = ev.options || [];
        if (options.length) answerConfirmation(ev.ticket, convId, true, options[Math.min(pick, options.length - 1)].label);
        continue;
      }
      if (ev.type === "tool_call") seen.toolCalls.push(ev.name);
      else if (ev.type === "text") seen.text += ev.text;
      else if (ev.type === "error") seen.error = `${ev.code || ""} ${ev.message || ""}`.trim();
    }
  } catch (err) {
    seen.error = String(err?.message || err);
  } finally {
    clearTimeout(timer);
    seen.ms = Date.now() - t0;
  }
  await deleteConversation(convId).catch(() => {});
  return seen;
}

function describe(seen) {
  const tools = seen.toolCalls.length ? `工具[${[...new Set(seen.toolCalls)].join(",")}]` : "无工具调用";
  const tail = (seen.text || "").replace(/\s+/g, " ").slice(0, 120);
  return `${(seen.ms / 1000).toFixed(1)}s · ${tools} · 澄清=${seen.clarify ? "有" : "无"}${seen.error ? ` · 错误=${seen.error}` : ""} · 回复=${tail}`;
}

// ── 场景一：一词多解（不指定唯一指代）→ 应先澄清 ──────────────────────────────
const ambiguous = await run("科比去哪了", "ambiguous");
if (skipIfModelDown(ambiguous, "歧义请求先澄清")) {
  skipIfModelDown(ambiguous, "澄清后仍能收束出正文");
} else if (ambiguous.clarify) {
  report(
    "歧义请求先澄清",
    true,
    `问「${ambiguous.clarify.question}」选项=${ambiguous.clarify.options.map((o) => o.label).join(" | ")}` +
      `${ambiguous.clarify.missingField ? ` · 待定项=${ambiguous.clarify.missingField}` : ""}` +
      `${ambiguous.clarify.whyItMatters ? ` · 理由=${ambiguous.clarify.whyItMatters}` : ""}`,
  );
  report("澄清后仍能收束出正文", Boolean(ambiguous.text.trim()), describe(ambiguous));
} else {
  report("歧义请求先澄清", false, describe(ambiguous));
}

// ── 场景二：请求已明确 → 不应反问 ─────────────────────────────────────────────
const explicit = await run("用一句话解释什么是光合作用", "explicit");
if (!skipIfModelDown(explicit, "明确请求不反问")) {
  report("明确请求不反问", !explicit.clarify, describe(explicit));
}

const summary = `${failed} FAIL${skipped ? ` / ${skipped} SKIP` : ""}`;
console.log(`=== clarify-live ${failed === 0 ? "ALL PASS" : summary} ===`);
if (failed) process.exitCode = 1;
