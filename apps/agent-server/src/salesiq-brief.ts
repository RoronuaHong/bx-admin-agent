// SalesIQ 会话简报（阶段三 Workflow 化，见 docs/agent/support-salesiq-plan.md §7.2）：
// 把「按 id 取会话详情 + 取逐句消息」两个 MCP 调用合成一个内置原子工具，服务端串行调用并裁剪字段，
// 坐席问「这条会话讲了啥」一步到位，省 2–3 轮调用与大量无关 JSON。
// 响应字段名以 Zoho 公开 API 文档为准（conversation-get-message-v2 / get-conversation-details-v2），
// 不在响应里猜字段；会话 id 的 path 字段名两个接口不一致（详情 conversation_id、消息 id），
// 由 inputSchema 运行时发现兜底（conversationIdField），发现不到再落回 "id"。

/** 一条会话最多回灌多少条消息：超出靠 more_data_available 提示，明细不硬灌上下文。 */
export const BRIEF_MESSAGE_CAP = 100;
/** 单条消息正文的截断长度。 */
const MESSAGE_TEXT_CAP = 400;
/** 解析失败时回退原文的截断长度。 */
const RAW_FALLBACK_CAP = 2000;

/**
 * 从工具 inputSchema 里发现「会话 id」的 path_variables 字段名：
 * 取 path_variables 下除 screenname 外的字段，优先 conversation_id / id，
 * 都没有时用第一个字段；schema 拿不到（未连接等）时落回 "id"。
 */
export function conversationIdField(schema: unknown): string {
  const props = (schema as { properties?: { path_variables?: { properties?: Record<string, unknown> } } } | null)
    ?.properties?.path_variables?.properties;
  const keys = props ? Object.keys(props).filter((key) => key !== "screenname") : [];
  if (!keys.length) return "id";
  return keys.find((key) => /^conversation_?id$/i.test(key)) || keys.find((key) => /^id$/i.test(key)) || keys[0];
}

/**
 * path_variables 里全部「会话 id」类键（id / conversation_id）。
 * portalid 等其余必填键由 pathDefaults 逐工具固定（Zoho 的工具分两族：
 * screenname 族与 portalid 族，见 docs/agent/support-salesiq-tools.md），
 * 组合工具只负责填会话 id，不能把一个工具发现的字段名挪给另一个工具用。
 */
export function conversationIdKeys(schema: unknown): string[] {
  const props = (schema as { properties?: { path_variables?: { properties?: Record<string, unknown> } } } | null)
    ?.properties?.path_variables?.properties;
  if (!props) return ["id"];
  const keys = Object.keys(props).filter((key) => /^id$/i.test(key) || /^conversation_?id$/i.test(key));
  return keys.length ? keys : ["id"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function clip(value: unknown, cap = MESSAGE_TEXT_CAP): string {
  const line = text(value).replace(/\s+/g, " ");
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** 人员对象 → 展示名（name 优先，id 兜底）。 */
function personName(value: unknown): string {
  const p = asRecord(value);
  if (!p) return "";
  return text(p.name) || text(p.id);
}

function fmtTime(value: unknown): string {
  const raw = text(value);
  return raw ? `${raw}(ms)` : "";
}

/** 解析详情响应（{object:"conversations", data:{...}}），裁出坐席关心的字段。 */
export function briefDetailLines(detailText: string): string[] {
  const parsed = safeParse(detailText);
  const data = asRecord(asRecord(parsed)?.data) || asRecord(parsed);
  if (!data) return [];
  const lines: string[] = [];
  const status = text(data.status) || text(asRecord(data.chat_status)?.label);
  const department = text(asRecord(data.department)?.name);
  const attender = personName(data.attender);
  const owner = personName(data.owner);
  const visitor = asRecord(data.visitor);
  const meta = [
    status ? `状态: ${status}` : "",
    department ? `部门: ${department}` : "",
    attender ? `接待人: ${attender}` : "",
    owner && owner !== attender ? `所有者: ${owner}` : "",
    visitor
      ? `访客: ${[text(visitor.name) || text(visitor.user_id), text(visitor.country_code), text(visitor.channel_name)]
          .filter(Boolean)
          .join(" / ")}`
      : "",
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" | "));
  if (text(data.question)) lines.push(`初始问题: ${clip(data.question)}`);
  const times = [
    text(data.start_time) ? `开始 ${fmtTime(data.start_time)}` : "",
    text(data.attended_time) ? `接起 ${fmtTime(data.attended_time)}` : "",
    text(data.last_modified_time) ? `最后变更 ${fmtTime(data.last_modified_time)}` : "",
  ].filter(Boolean);
  if (times.length) lines.push(times.join(" | "));
  const last = asRecord(data.last_message_info);
  if (last) {
    const body = clip(asRecord(last.message)?.text);
    if (body) lines.push(`最后一条: [${text(last.type) || "text"}] ${personName(last.sender) || "?"} (${fmtTime(last.time)}): ${body}`);
  }
  const customer = asRecord(data.customer_info);
  if (customer && Object.keys(customer).length) {
    lines.push(
      `自定义信息: ${Object.entries(customer)
        .slice(0, 10)
        .map(([key, value]) => `${key}=${clip(value, 80)}`)
        .join("; ")}`,
    );
  }
  if (data.notes === true) lines.push("备注: 有内部备注（用 ZohoSalesIQ_getConversationsNotesList 查看）");
  return lines;
}

/** 解析消息响应（{object:"list", data:[...], more_data_available}），压成逐行转录。 */
export function briefMessageLines(msgText: string, cap = BRIEF_MESSAGE_CAP): string[] {
  const parsed = asRecord(safeParse(msgText));
  const rows = Array.isArray(parsed?.data) ? (parsed!.data as unknown[]) : null;
  if (!rows) return [];
  const lines: string[] = [];
  for (const row of rows.slice(0, cap)) {
    const msg = asRecord(row);
    if (!msg) continue;
    const sender = asRecord(msg.sender);
    const who = text(sender?.name) || text(sender?.type) || "?";
    const kind = text(sender?.type) || text(msg.type) || "";
    const body = clip(asRecord(msg.message)?.text);
    lines.push(`${text(msg.sequence_id) || lines.length + 1} [${kind}] ${who} (${fmtTime(msg.time)}): ${body}`);
  }
  if (parsed?.more_data_available === true) {
    lines.push(`（消息多于 ${Math.min(cap, rows.length)} 条未全部展开，more_data_available=true；需要更早的用 ZohoSalesIQ_getConversationMessages 按 from/to_time 取）`);
  }
  if (!rows.length) {
    lines.push("（消息列表为空：可能是保留策略裁剪、会话归档或渠道可见性限制，不等于访客没说过话）");
  }
  return lines;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rawFallback(label: string, raw: string): string {
  const clipped = raw.replace(/\s+/g, " ").slice(0, RAW_FALLBACK_CAP);
  return `（${label}响应无法按预期结构解析，原文截断）${clipped}`;
}

/**
 * 组合详情 + 消息两路响应为一段坐席可读的简报。
 * 任一路解析失败都不整体失败：能裁多少裁多少，剩下的回退原文截断。
 */
export function composeChatBrief(
  detailText: string,
  msgText: string,
  opts: { conversationId?: string; messagesError?: boolean } = {},
): string {
  const head = opts.conversationId ? `会话 ${opts.conversationId} 简报（详情 + 逐句消息）：` : "会话简报（详情 + 逐句消息）：";
  const detailLines = briefDetailLines(detailText);
  const msgLines = briefMessageLines(msgText);
  const parts: string[] = [head];
  parts.push(detailLines.length ? detailLines.join("\n") : rawFallback("会话详情", detailText));
  if (opts.messagesError) {
    parts.push(`（逐句消息获取失败：${msgText.replace(/\s+/g, " ").slice(0, 400)}）`);
  } else {
    parts.push(msgLines.length ? `消息：\n${msgLines.join("\n")}` : rawFallback("逐句消息", msgText));
  }
  return parts.join("\n");
}
