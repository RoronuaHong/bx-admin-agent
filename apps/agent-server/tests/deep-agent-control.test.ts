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
