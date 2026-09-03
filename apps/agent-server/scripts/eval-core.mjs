/**
 * 评测核心（通用，不依赖任何具体 Agent / 登录 / cookie / 业务词）。
 *
 * 设计原则（对齐「通用」要求）：
 * - 本文件只认 trace.ts 的通用 span 结构（run/llm/tool/route + usage + status），
 *   不认识任何业务模块名、不认识任何 worker 语义、不发任何 HTTP 请求。
 * - 业务项目（bx-admin-agent 或其他 Agent）只负责：①怎么触发一次真实请求；
 *   ②把产生的 runId 传进来；③声明要不要启用 G2（越权防护，取决于该 Agent
 *   是否有「执行层越权拒绝」机制）。
 * - 断言函数纯函数化，返回 {name, ok, detail}，方便接 CI / 落库 / 多框架复用。
 *
 * 红线（任何 LLM Agent 通用）：
 *   G1 轮次不爆炸   llm span 数 ≤ maxLlmRounds
 *   G2 越权防护     （可选）出现 reject span 时结构正确；或该 Agent 强制要求至少出现一次
 *   G3 无伪调用     tool span 无 submit 这类伪调用名
 *   G4 成本阈值     totalTokens 合计 ≤ maxTotalTokens
 *   G5 请求收束     run span 存在且有 endMs
 */

/**
 * 对一次 trace run 的 span 列表跑全部红线断言。
 * @param {object} opts
 * @param {Array} opts.spans        trace.ts getRun() 返回的 span 数组
 * @param {number} [opts.maxLlmRounds=8]      G1 阈值
 * @param {number} [opts.maxTotalTokens=60000] G4 阈值
 * @param {"enforce"|"observe"|"off"} [opts.rejectMode="observe"]
 *        enforce = 该 Agent 必有越权场景，reject span 必须 >0 且结构正确
 *        observe = 有 reject 才校验结构（默认，通用安全 Agent 适用）
 *        off     = 不校验 G2（无越权防护机制的 Agent）
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
export function assertTraceGates(opts) {
  const { spans, maxLlmRounds = 8, maxTotalTokens = 60000, rejectMode = "observe" } = opts || {};
  const out = [];

  const runSpan = spans.find((s) => s.kind === "run");
  const llmSpans = spans.filter((s) => s.kind === "llm");
  const toolSpans = spans.filter((s) => s.kind === "tool");
  const rejected = toolSpans.filter((s) => s.status === "reject");

  // G5 请求成功收束
  out.push({
    name: "G5_run_completed",
    ok: !!runSpan && !!runSpan.endMs,
    detail: runSpan ? `dur=${runSpan.durationMs}ms model=${runSpan.model || "?"}` : "no run span",
  });

  // G1 轮次不爆炸
  const rounds = llmSpans.length;
  out.push({
    name: "G1_llm_rounds_le",
    ok: rounds <= maxLlmRounds,
    detail: `rounds=${rounds} ≤ ${maxLlmRounds}`,
  });

  // G2 越权防护（按 rejectMode）
  if (rejectMode === "enforce") {
    const ok = rejected.length > 0 && rejected.every((s) => !!s.note);
    out.push({
      name: "G2_reject_enforced",
      ok,
      detail: `rejected=${rejected.length} ${rejected.map((r) => r.name).join(",")}`,
    });
  } else if (rejectMode === "observe") {
    if (rejected.length > 0) {
      const ok = rejected.every((s) => !!s.note);
      out.push({
        name: "G2_reject_observed",
        ok,
        detail: `rejected=${rejected.length} ${rejected.map((r) => r.name).join(",")}`,
      });
    } else {
      out.push({ name: "G2_reject(N/A)", ok: true, detail: "无越权事件，跳过" });
    }
  }
  // off: 不产出 G2

  // G3 无伪调用（通用：伪调用名是协议层概念 submit/call_api 写成文本才会出现，
  // 正常函数调用通道里 tool span 名不会是 submit；此处用通用黑名单）
  const pseudo = toolSpans.filter((s) => /^submit$/i.test(s.name));
  out.push({
    name: "G3_no_pseudo_tool",
    ok: pseudo.length === 0,
    detail: pseudo.length ? `found=${pseudo.map((p) => p.name).join(",")}` : "clean",
  });

  // G4 成本阈值
  const totalTokens = llmSpans.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0);
  out.push({
    name: "G4_token_budget_le",
    ok: totalTokens <= maxTotalTokens,
    detail: `tokens=${totalTokens} ≤ ${maxTotalTokens}`,
  });

  return out;
}

/** 汇总：返回 {pass, total, rate, failed}。failed 为空数组表示全过。 */
export function summarize(results) {
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  return {
    pass,
    total,
    rate: total ? Number(((pass / total) * 100).toFixed(1)) : 0,
    failed: results.filter((r) => !r.ok),
  };
}
