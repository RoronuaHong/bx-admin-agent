/**
 * tool_result 上屏截断保护（chat.ts 主循环与 workflow-orchestrate.ts 兜底编排共用）。
 *
 * 结构化 JSON 必须整体上屏：前端展开工具卡片要展示完整合法的 JSON，
 * 中途截断会让用户看到无法解析的残文（如 `"rawInput": "查`）。
 * 仅对超长非结构化文本兜底截断到 TRUNCATE_TEXT_LIMIT，避免长 grep/代码结果刷屏。
 */
export const TRUNCATE_TEXT_LIMIT = 1200;

export function truncateToolResultForUi(content: string): string {
  const t = content.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return content;
    } catch {
      /* 非完整 JSON（如带前缀的半截文本），走文本截断 */
    }
  }
  return content.slice(0, TRUNCATE_TEXT_LIMIT);
}

/**
 * 思考过程摘要（对齐 DeepSeek「深度思考」折叠）：把一次工具调用转成人类可读的一行描述，
 * 作为 reasoning 事件流向前端。仅取工具名 + 关键入参，不编造模型未产生的思维链。
 */
export function describeCallForReasoning(call: { name: string; input: Record<string, unknown> }): string {
  const input = call.input || {};
  const op = input.operation ? String(input.operation) : "";
  const path = input.path ? String(input.path) : "";
  const name = call.name;
  if (name === "call_api") {
    const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
    const bits: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      bits.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
    const head = op || path || "接口";
    const tail = bits.length ? `（${bits.slice(0, 6).join("，")}）` : "";
    return `调用接口 ${head}${tail}`;
  }
  if (name === "search_api_module") {
    const q = input.query ? String(input.query) : "";
    return q ? `检索模块：${q}` : "检索可用模块";
  }
  if (name === "submit_understood_intent") {
    const m = input.module ? String(input.module) : "";
    const o = input.operation ? String(input.operation) : "";
    return `理解意图${m ? `：模块 ${m}` : ""}${o ? `，操作 ${o}` : ""}`;
  }
  if (name === "request_clarification") {
    return "向用户追问以收敛需求";
  }
  if (name === "render_table") {
    return "将结果渲染为表格";
  }
  if (name === "normalize_output") {
    return "规范化输出格式";
  }
  // 通用兜底：工具名 + 首个有意义入参
  const firstVal = Object.entries(input).find(([, v]) => v !== undefined && v !== null && v !== "");
  const extra = firstVal ? `（${firstVal[0]}=${typeof firstVal[1] === "object" ? JSON.stringify(firstVal[1]) : String(firstVal[1]).slice(0, 40)}）` : "";
  return `调用工具 ${name}${extra}`;
}

