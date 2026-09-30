// Deep Agent 控制逻辑单元验证（纯逻辑，不需要网络/真实模型）。
// 验证「路线 B」deep agent 的决策大脑：子代理工具收窄、同轮去重签名、跨轮 Doom Loop 熔断、工具数上限截断。
// 阈值 MCP_MAX_TOOLS=3 在 vitest.config.ts 的 test.env 中固定。
import { test, expect } from "vitest";
import {
  forcedToolChoiceSupported,
  markForcedToolChoiceUnsupported,
  resolveSubagentTools,
  toolCallSignature,
  LoopGuard,
  selectMcpToolSpecs,
  prefetchDeferredTools,
  argsWithinToolSchema,
} from "../src/chat.js";

type FakeTool = { serverId: string; name: string; description?: string; inputSchema?: unknown };

const tools: FakeTool[] = [
  { serverId: "bi", name: "mcp__bi__list" },
  { serverId: "bi", name: "mcp__bi__get" },
  { serverId: "crm", name: "mcp__crm__search" },
  { serverId: "doc", name: "mcp__doc__read" },
];

test("[A] resolveSubagentTools（子代理工具收窄）", () => {
  const r = resolveSubagentTools(tools as never, []);
  expect(r.tools.length).toBe(4);
  expect(r.error).toBeFalsy();

  const r2 = resolveSubagentTools(tools as never, ["bi"]);
  expect(r2.tools.length).toBe(2);
  expect(r2.tools.every((t) => t.serverId === "bi")).toBe(true);

  const r3 = resolveSubagentTools(tools as never, ["bi", "crm"]);
  expect(r3.tools.length).toBe(3);

  const r4 = resolveSubagentTools(tools as never, ["nonexist"]);
  expect(r4.error).toBeTruthy();
  expect(r4.tools.length).toBe(0);
});

test("[B] toolCallSignature（同轮去重指纹）", () => {
  const a = toolCallSignature("call_api", '{"op":"get","id":1}');
  const b = toolCallSignature("call_api", '{"id":1,"op":"get"}'); // 键序不同
  expect(a).toBe(b);

  const c = toolCallSignature("call_api", '{"op":"get","id":2}');
  expect(a).not.toBe(c);

  const d = toolCallSignature("fs_write", '{"op":"get","id":1}');
  expect(a).not.toBe(d);

  const e = toolCallSignature("x", "不是合法json");
  const f = toolCallSignature("x", "不是合法json");
  expect(e).toBe(f);
  expect(e.startsWith("x::")).toBe(true);
});

test("[C] LoopGuard（跨轮 Doom Loop 熔断）", () => {
  const g = new LoopGuard(3);
  expect(g.record(['call_api::{"id":1}'])).toBe(false);
  expect(g.record(['call_api::{"id":1}'])).toBe(false);
  expect(g.record(['call_api::{"id":1}'])).toBe(true);

  const g2 = new LoopGuard(3);
  g2.record(['a::1']);
  g2.record(['b::2']); // 不同指纹 → 重置连击
  expect(g2.record(['b::2'])).toBe(false);
  expect(g2.record(['b::2'])).toBe(true);

  const g3 = new LoopGuard(3);
  g3.record([]); // 空轮不计入
  g3.record([]);
  expect(g3.record(['z::9'])).toBe(false);
});

test("[D] selectMcpToolSpecs（工具数上限截断）", () => {
  const many: FakeTool[] = Array.from({ length: 6 }, (_, i) => ({ serverId: `s${i}`, name: `mcp__s${i}__t` }));
  const r = selectMcpToolSpecs(many as never);
  expect(r.specs.length).toBe(3);
  expect(r.droppedServers.length).toBe(3);
});

test("[E2] prefetchDeferredTools（点名优先，长问题不扣分，不超过上限）", () => {
  const zoho = {
    serverId: "zoho-salesiq",
    name: "mcp__zoho-salesiq__ZohoSalesIQ_getConversationsList",
    tool: "ZohoSalesIQ_getConversationsList",
    description: "List conversations",
    inputSchema: { type: "object" },
  };
  const other = {
    serverId: "zoho-salesiq",
    name: "mcp__zoho-salesiq__ZohoSalesIQ_getPortals",
    tool: "ZohoSalesIQ_getPortals",
    description: "List portals",
    inputSchema: { type: "object" },
  };
  const noise = Array.from({ length: 8 }, (_, i) => ({
    serverId: "other",
    name: `mcp__other__tool${i}`,
    tool: `tool${i}`,
    description: "unrelated catalog entry",
    inputSchema: { type: "object" },
  }));
  const question =
    "【数据预警】工具 ZohoSalesIQ_getConversationsList。范围 visitor.country_code = IN。时间窗口最近 60 分钟。异常条件窗口内印度对话条数。失败不要猜数不要估算不要出图。" +
    "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
  const named = prefetchDeferredTools([other, ...noise, zoho] as never, question, 5);
  expect(named[0]?.name).toBe(zoho.name);
  expect(named.length).toBeLessThanOrEqual(5);

  const capped = prefetchDeferredTools([zoho, other, ...noise] as never, "ZohoSalesIQ_getConversationsList 以及 portals", 2);
  expect(capped).toHaveLength(2);
  expect(capped[0]?.name).toBe(zoho.name);

  const described =
    "统计印度对话条数，用 getConversationsList，不要猜数。" + Array.from({ length: 40 }, () => "无关词组").join(" ");
  const filled = prefetchDeferredTools([other, ...noise, zoho] as never, described, 5);
  expect(filled.some((spec) => spec.name === zoho.name)).toBe(true);
});

test("[E3] argsWithinToolSchema：丢掉参数说明里没有的筛选字段，数字字符串改回数字", () => {
  const schema = {
    type: "object",
    properties: {
      path_variables: { type: "object", properties: { screenname: { type: "string" } } },
      query_params: {
        type: "object",
        properties: {
          from_time: { type: "integer" },
          to_time: { type: "integer" },
          index: { type: "integer" },
          limit: { type: "integer" },
        },
      },
    },
  };
  const out = argsWithinToolSchema(schema, {
    path_variables: { screenname: "castleapp" },
    query_params: { index: "0", limit: "99", from_time: "1790000000000", visitor_country_code: "IN" },
  }) as { query_params: Record<string, unknown> };
  expect(out.query_params.visitor_country_code).toBeUndefined();
  expect(out.query_params.from_time).toBe(1790000000000);
  expect(out.query_params.index).toBe(0);
  expect(out.query_params.limit).toBe(99);
});

test("[E] 强制工具通道端点记忆：被拒一次后不再尝试 required（未受影响/换端点仍可尝试）", () => {
  const model = { id: "probe-a", baseUrl: "https://gateway-a.example/v1" } as never;
  const other = { id: "probe-b", baseUrl: "https://gateway-b.example/v1" } as never;
  const sameIdOtherHost = { id: "probe-a", baseUrl: "https://gateway-c.example/v1" } as never;

  // 默认（未探测）→ 可尝试
  expect(forcedToolChoiceSupported(model)).toBe(true);
  markForcedToolChoiceUnsupported(model);
  // 同模型同端点 → 不再尝试（避免每轮首调白打一次 400）
  expect(forcedToolChoiceSupported(model)).toBe(false);
  // 其它模型 / 同 id 但换了端点 → 各自重新探测，不把 A 的结论套到 B
  expect(forcedToolChoiceSupported(other)).toBe(true);
  expect(forcedToolChoiceSupported(sameIdOtherHost)).toBe(true);
  // 幂等：重复标记不报错、状态不变
  markForcedToolChoiceUnsupported(model);
  expect(forcedToolChoiceSupported(model)).toBe(false);
});
