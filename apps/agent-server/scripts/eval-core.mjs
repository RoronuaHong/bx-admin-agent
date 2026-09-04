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
 *   G3 无伪调用     tool span 名不命中调用方注入的伪调用黑名单
 *   G4 成本阈值     totalTokens 合计 ≤ maxTotalTokens
 *   G5 请求收束     run span 存在且有 endMs
 *   G6 业务期望     （可选）场景期望的工具调用确实发生（防「模型短路/幻觉直答
 *                   不调工具却正常收束」骗过 G1-G5；expectTools 为空则不检测）
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
 * @param {string[]} [opts.pseudoToolNames=[]] G3 伪调用黑名单（由调用方注入，
 *        本模块不内置任何工具名以保持通用；传空数组则跳过 G3 检测）
 * @param {string[]} [opts.expectTools=[]] G6 业务期望：场景必须发生这些工具调用
 *        （任一命中即过；防模型短路/幻觉直答不调工具却正常收束；空数组=不检测）
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
export function assertTraceGates(opts) {
  const {
    spans,
    maxLlmRounds = 8,
    maxTotalTokens = 60000,
    rejectMode = "observe",
    pseudoToolNames = [],
    expectTools = [],
  } = opts || {};
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

  // G3 无伪调用：调用方通过 pseudoToolNames 传入「不该以 tool span 出现的名字」，
  // 本模块不内置任何工具名（避免写死契约词，保持通用）。
  const pseudo = pseudoToolNames.length
    ? toolSpans.filter((s) => pseudoToolNames.some((n) => new RegExp(`^${n}$`, "i").test(s.name)))
    : [];
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

  // G6 业务期望：场景期望的工具调用确实发生（防「收束了但没干活」——模型短路或
  // 幻觉直答不调工具时，G1-G5 全部照样通过，只有这里能拦住）。任一期望命中即过。
  if (expectTools.length) {
    const hit = expectTools.find((n) => toolSpans.some((s) => new RegExp(`^${n}$`, "i").test(s.name)));
    out.push({
      name: "G6_expect_tool_called",
      ok: !!hit,
      detail: hit ? `hit=${hit}` : `none of [${expectTools.join(",")}] called（疑似短路/幻觉直答）`,
    });
  }

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
