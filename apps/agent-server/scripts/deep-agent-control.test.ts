// Deep Agent 控制逻辑单元验证（纯逻辑，不需要网络/真实模型）。
// 验证「路线 B」deep agent 的决策大脑：子代理工具收窄、同轮去重签名、跨轮 Doom Loop 熔断、工具数上限截断。
// 跑法：cmd /c "cd /d <repo>\apps\agent-server && node --import tsx scripts/deep-agent-control.test.ts"
process.env.MCP_MAX_TOOLS = "3"; // 把工具数上限压到 3，方便验证截断

const {
  resolveSubagentTools,
  toolCallSignature,
  LoopGuard,
  selectMcpToolSpecs,
} = await import("../src/chat.js");

type FakeTool = { serverId: string; name: string; description?: string; inputSchema?: unknown };

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const tools: FakeTool[] = [
  { serverId: "bi", name: "mcp__bi__list" },
  { serverId: "bi", name: "mcp__bi__get" },
  { serverId: "crm", name: "mcp__crm__search" },
  { serverId: "doc", name: "mcp__doc__read" },
];

console.log("[A] resolveSubagentTools（Deep Agent 子代理工具收窄）");
{
  const r = resolveSubagentTools(tools as never, []);
  check("空 servers = 继承主代理全部工具", r.tools.length === 4 && !r.error, JSON.stringify(r));

  const r2 = resolveSubagentTools(tools as never, ["bi"]);
  check(
    "指定 bi = 只保留 bi 下工具（2 个）",
    r2.tools.length === 2 && r2.tools.every((t) => t.serverId === "bi"),
    JSON.stringify(r2.tools.map((t) => t.serverId)),
  );

  const r3 = resolveSubagentTools(tools as never, ["bi", "crm"]);
  check("多服务器并集", r3.tools.length === 3, `len=${r3.tools.length}`);

  const r4 = resolveSubagentTools(tools as never, ["nonexist"]);
  check("给了不存在的服务器 → 返回 error 让模型纠正", !!r4.error && r4.tools.length === 0, JSON.stringify(r4));
}

console.log("[B] toolCallSignature（同轮去重指纹）");
{
  const a = toolCallSignature("call_api", '{"op":"get","id":1}');
  const b = toolCallSignature("call_api", '{"id":1,"op":"get"}'); // 键序不同
  check("参数键序不同仍判为同一调用（canonical JSON）", a === b, `${a} vs ${b}`);

  const c = toolCallSignature("call_api", '{"op":"get","id":2}');
  check("参数值不同 → 不同指纹", a !== c);

  const d = toolCallSignature("fs_write", '{"op":"get","id":1}');
  check("工具名不同 → 不同指纹", a !== d);

  const e = toolCallSignature("x", "不是合法json");
  const f = toolCallSignature("x", "不是合法json");
  check("非法 JSON 退化为原文比较（仍稳定）", e === f && e.startsWith("x::"));
}

console.log("[C] LoopGuard（跨轮 Doom Loop 熔断）");
{
  const g = new LoopGuard(3);
  check("第1轮相同指纹：未熔断", g.record(['call_api::{"id":1}']) === false);
  check("第2轮相同指纹：未熔断", g.record(['call_api::{"id":1}']) === false);
  check("第3轮相同指纹：达阈值熔断", g.record(['call_api::{"id":1}']) === true);

  const g2 = new LoopGuard(3);
  g2.record(['a::1']);
  g2.record(['b::2']); // 不同指纹 → 重置连击
  check("指纹变化重置连击", g2.record(['b::2']) === false);
  check("重新累计到阈值才熔断", g2.record(['b::2']) === true);

  const g3 = new LoopGuard(3);
  g3.record([]); // 空轮不计入
  g3.record([]);
  check("空轮不累计连击", g3.record(['z::9']) === false);
}

console.log("[D] selectMcpToolSpecs（工具数上限截断）");
{
  const many: FakeTool[] = Array.from({ length: 6 }, (_, i) => ({ serverId: `s${i}`, name: `mcp__s${i}__t` }));
  const r = selectMcpToolSpecs(many as never);
  check("超出上限只取前 3 个", r.specs.length === 3, `len=${r.specs.length}`);
  check("被裁的服务器进入 droppedServers", r.droppedServers.length === 3, JSON.stringify(r.droppedServers));
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
if (fail) process.exit(1);
