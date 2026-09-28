// 订单/工单示例数据源 MCP（stdio）：为「客服助手」演示真实的订单/工单取数与工单创建闭环。
// ⚠️ 定位：**示例（mock）数据源**——数据全部内存内置、进程重启即还原，不含任何真实用户数据。
// 后续接真实系统时**只改 .env 的 MCP_BUILTIN_SERVERS 对应条目**（换 command/url 与凭据），
// 工具契约（order_search / order_get / ticket_list / ticket_get / ticket_create）保持不变，
// 服务端与角色人设零改动。接真实后端时的只读/写边界见 docs/agent/support-data-source-plan.md。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function json(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

// ---- 示例数据（内存态；写操作只进内存，进程退出即消失）----
let orderSeq = 1005;
const ORDERS = [
  {
    order_id: "1001", user_id: "u_8001", item: "无线降噪耳机（示例商品）", amount: 499,
    status: "shipped", created_at: "2026-09-20 10:12:00",
    logistics: { carrier: "示例速运", tracking_no: "SF1000000001", status: "运输中", updated_at: "2026-09-24 18:30:00" },
  },
  {
    order_id: "1002", user_id: "u_8001", item: "机械键盘 87 键（示例商品）", amount: 329,
    status: "delivered", created_at: "2026-09-12 09:05:00",
    logistics: { carrier: "示例速运", tracking_no: "SF1000000002", status: "已签收", updated_at: "2026-09-15 14:02:00" },
  },
  {
    order_id: "1003", user_id: "u_8002", item: "便携咖啡机（示例商品）", amount: 899,
    status: "processing", created_at: "2026-09-26 20:41:00",
    logistics: { carrier: "", tracking_no: "", status: "拣货中", updated_at: "2026-09-26 21:00:00" },
  },
  {
    order_id: "1004", user_id: "u_8002", item: "桌面升降支架（示例商品）", amount: 599,
    status: "refunded", created_at: "2026-09-01 11:20:00",
    logistics: { carrier: "示例速运", tracking_no: "SF1000000004", status: "已退回", updated_at: "2026-09-08 16:45:00" },
  },
];

let ticketSeq = 5001;
const TICKETS = [
  {
    ticket_id: "5000", user_id: "u_8001", order_id: "1002", subject: "键盘部分按键失灵",
    status: "processing", created_at: "2026-09-22 15:30:00",
    timeline: [
      { at: "2026-09-22 15:30:00", text: "用户提交工单：部分按键失灵" },
      { at: "2026-09-23 09:10:00", text: "客服已受理，等待质检结论" },
    ],
  },
];

const STATUS_ALIASES = { shipped: "运输中", delivered: "已签收", processing: "处理中", refunded: "已退款", cancelled: "已取消" };

function findOrder(id) {
  return ORDERS.find((o) => o.order_id === String(id || "").trim());
}

const TOOLS = [
  {
    name: "order_search",
    description:
      "按条件检索订单（示例数据源）。返回命中的订单概要列表（订单号/用户/商品/金额/状态/下单时间）。" +
      "三个过滤条件都可选；全部缺省返回最近订单。查不到就返回空列表，如实告知用户。",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "按订单号精确匹配" },
        user_id: { type: "string", description: "按用户 id 过滤" },
        status: { type: "string", description: "按状态过滤：processing/shipped/delivered/refunded/cancelled" },
      },
    },
  },
  {
    name: "order_get",
    description: "查询单个订单详情（示例数据源）：商品/金额/状态/下单时间/物流承运方与运单号/物流状态与更新时间。订单号不存在时如实返回。",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string", description: "订单号" } },
      required: ["order_id"],
    },
  },
  {
    name: "ticket_list",
    description: "检索售后工单列表（示例数据源）：工单号/关联订单/主题/状态/创建时间。可按用户或状态过滤。",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "按用户 id 过滤" },
        order_id: { type: "string", description: "按关联订单号过滤" },
        status: { type: "string", description: "open/processing/resolved/closed" },
      },
    },
  },
  {
    name: "ticket_get",
    description: "查询单个工单详情（示例数据源）：主题/状态/关联订单/完整处理时间线。工单号不存在时如实返回。",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string", description: "工单号" } },
      required: ["ticket_id"],
    },
  },
  {
    name: "ticket_create",
    description:
      "创建售后工单（示例数据源，**写操作**：调用方会弹出确认卡，需用户确认后才执行）。" +
      "用户反馈商品/服务问题、要求跟进处理时使用；订单号可空。创建后返回工单号与受理时间线。",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "用户 id（可省略：给了 order_id 时自动从订单反查）" },
        order_id: { type: "string", description: "关联订单号（可空）" },
        subject: { type: "string", description: "工单主题（一句话概括问题）" },
        description: { type: "string", description: "问题描述（用户原话要点）" },
      },
      required: ["subject"],
    },
  },
];

const server = new Server({ name: "order-mock-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // MCP SDK 把工具入参放在 req.params.arguments（不是 req.params.args）；
  // 这里改名解构，否则 args 永远是 {}，导致 order_id 等参数取不到（mock 一直返回「未找到」）。
  const { name, arguments: args = {} } = req.params || {};
  switch (name) {
    case "order_search": {
      let list = ORDERS;
      if (args.order_id) list = list.filter((o) => o.order_id === String(args.order_id).trim());
      if (args.user_id) list = list.filter((o) => o.user_id === String(args.user_id).trim());
      if (args.status) list = list.filter((o) => o.status === String(args.status).trim().toLowerCase());
      return json({
        total: list.length,
        note: "示例数据源（mock）：数据为演示用内存数据",
        orders: list.map((o) => ({
          order_id: o.order_id, user_id: o.user_id, item: o.item, amount: o.amount,
          status: STATUS_ALIASES[o.status] || o.status, created_at: o.created_at,
        })),
      });
    }
    case "order_get": {
      const rawId = String(args.order_id || "").trim();
      if (!rawId) {
        // 缺 order_id 是调用方参数缺失，不是「查不到」：给明确的结构化错误，避免模型把 undefined 当单号。
        return json({ found: false, order_id: "", message: "缺少 order_id 参数，无法查询（示例数据源仅含 1001-1004）", note: "示例数据源（mock）" }, true);
      }
      const o = findOrder(rawId);
      if (!o) {
        // 查不到是正常结果而非错误：给结构化的 found:false，模型才能自然转述「没有这单」。
        return json({
          found: false,
          order_id: rawId,
          message: `订单 ${rawId} 不存在（示例数据源仅含 1001-1004）`,
          note: "示例数据源（mock）",
        });
      }
      return json({
        note: "示例数据源（mock）：数据为演示用内存数据",
        ...o,
        status: STATUS_ALIASES[o.status] || o.status,
      });
    }
    case "ticket_list": {
      let list = TICKETS;
      if (args.user_id) list = list.filter((t) => t.user_id === String(args.user_id).trim());
      if (args.order_id) list = list.filter((t) => t.order_id === String(args.order_id).trim());
      if (args.status) list = list.filter((t) => t.status === String(args.status).trim().toLowerCase());
      return json({ total: list.length, note: "示例数据源（mock）", tickets: list });
    }
    case "ticket_get": {
      const t = TICKETS.find((x) => x.ticket_id === String(args.ticket_id).trim());
      if (!t) return json({ error: `工单 ${String(args.ticket_id)} 不存在` }, true);
      return json({ note: "示例数据源（mock）", ...t });
    }
    case "ticket_create": {
      const subject = String(args.subject || "").trim();
      if (!subject) return json({ error: "ticket_create 需要 subject（一句话概括问题）" }, true);
      const orderId = args.order_id ? String(args.order_id).trim() : "";
      // user_id 可省略：给了订单号就从订单反查归属；都没有才落 unknown（真实系统接好后由鉴权上下文提供）。
      let userId = String(args.user_id || "").trim();
      if (!userId && orderId) {
        const o = findOrder(orderId);
        if (o) userId = o.user_id;
      }
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      const ticket = {
        ticket_id: String(ticketSeq++),
        user_id: userId || "unknown",
        order_id: orderId,
        subject,
        description: String(args.description || "").trim(),
        status: "open",
        created_at: now,
        timeline: [{ at: now, text: `用户提交工单：${subject}` }],
      };
      TICKETS.push(ticket);
      return json({ note: "示例数据源（mock）：工单仅存于内存，重启即消失", ...ticket });
    }
    default:
      return json({ error: `未知工具 ${name}` }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
