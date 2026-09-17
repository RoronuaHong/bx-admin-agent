// 多 MCP 服务器接入检查（回归脚本）。
// 覆盖：①多服务器聚合 + 工具顺序确定性 ②失败的服务器如实上报（不静默跳过）
//       ③工具数超限时不静默丢弃（回报被裁的服务器）④工具通道现状进系统提示
//       ⑤取消信号透传到 MCP 调用 ⑥连接失败冷却（挂掉的 server 不再拖慢每一轮）⑦多服务器并行连接
//       ⑧连接单飞（握手期的服务器不被当成空服务器）⑨确认门按工具注解判定
//       ⑩工具按需加载（阈值 + 检索排序）⑪子代理服务器白名单 ⑫空闲连接回收
// 用法：node --import tsx scripts/_mcp-multi-server-check.mjs
// 本文件既是 harness 也是 mock server（子进程用 "serve <kind>" 启动自己）。
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const isServe = process.argv[2] === "serve";

/** 子进程模式：扮演一个 stdio MCP server（kind: alpha / beta / broken / hang）。 */
async function runMockServer(kind) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  if (kind === "hang") {
    // 只挂起、不说 MCP：模拟「连上但无响应」的坏服务器（配合 timeoutMs 触发连接失败）。
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }
  // 握手慢的服务器：用于验证「连接中的服务器不被当成空服务器」（单飞）。
  if (kind === "slowstart") await new Promise((resolve) => setTimeout(resolve, 800));

  const server = new Server({ name: `mock-${kind}`, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (kind === "broken") throw new Error("mock: listTools 故意失败");
    const names =
      kind === "alpha" ? ["zzz_last", "aaa_first", "sleep"] : kind === "slowstart" ? ["two", "one"] : ["ping"];
    // alpha 的三个工具带不同注解，用于验证「确认门按注解判定」。
    const hints = {
      aaa_first: { readOnlyHint: true },
      zzz_last: { destructiveHint: true },
      sleep: { destructiveHint: false, idempotentHint: true },
    };
    return {
      tools: names.map((name) => ({
        name,
        description: `mock-${kind} 的工具 ${name}`,
        inputSchema: { type: "object", properties: {} },
        ...(kind === "alpha" ? { annotations: hints[name] || {} } : {}),
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "sleep") await new Promise((resolve) => setTimeout(resolve, 4000));
    return { content: [{ type: "text", text: `ok:${kind}:${request.params.name}` }] };
  });
  await server.connect(new StdioServerTransport());
}

let passed = 0;
let failed = 0;

function check(title, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS ${title}`);
  } else {
    failed += 1;
    console.log(`FAIL ${title}${detail ? ` — ${detail}` : ""}`);
  }
}

async function runHarness() {
  // 内置服务器（不落盘）—— 避免碰用户真实的 .data/mcp-servers.json。
  process.env.MCP_BUILTIN_SERVERS = JSON.stringify([
    { id: "beta", label: "Beta 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "beta"] },
    { id: "alpha", label: "Alpha 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "alpha"] },
    { id: "broken", label: "Broken 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "broken"] },
    { id: "dead", label: "Dead 服务", transport: "stdio", command: "bx-no-such-mcp-binary", args: [] },
    { id: "off", label: "Off 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "beta"], enabled: false },
    { id: "slowa", label: "SlowA 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "hang"], timeoutMs: 1500 },
    { id: "slowb", label: "SlowB 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "hang"], timeoutMs: 1500 },
    { id: "slowc", label: "SlowC 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "hang"], timeoutMs: 1500 },
    { id: "slowstart", label: "SlowStart 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "slowstart"], timeoutMs: 10_000 },
    { id: "slowstart2", label: "SlowStart2 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "slowstart"], timeoutMs: 10_000 },
    { id: "confirming", label: "Confirming 服务", transport: "stdio", command: process.execPath, args: [SELF, "serve", "beta"], requireConfirm: true },
  ]);
  process.env.MCP_MAX_TOOLS = "2"; // 便于验证「超限不静默丢弃」
  process.env.MCP_IDLE_TIMEOUT_MS = "1200"; // 便于验证「空闲回收」

  const hub = await import("../src/mcp/hub.ts");
  const { resolveSubagentTools, searchMcpTools, selectMcpToolSpecs, toolSearchEnabled, toolCallSignature, LoopGuard } = await import("../src/chat.ts");
  const { buildSystemPrompt } = await import("../src/system-prompt.ts");

  // ---- ① 聚合 + 顺序确定性（乱序传入 + 重复 id + 两侧空白）----
  const all = await hub.collectToolsDetailed(["beta", "alpha", "beta", " alpha "]);
  const names = all.tools.map((tool) => tool.name);
  check(
    "① 多服务器聚合：工具按 serverId→工具名确定性排序",
    JSON.stringify(names) ===
      JSON.stringify(["mcp__alpha__aaa_first", "mcp__alpha__sleep", "mcp__alpha__zzz_last", "mcp__beta__ping"]),
    JSON.stringify(names),
  );
  check("① ready 顺序确定（alpha,beta）", all.ready.map((item) => item.id).join(",") === "alpha,beta");
  check("① 重复 id 只连一次", all.ready.length === 2 && all.unavailable.length === 0);

  // ---- ② 失败/异常服务器如实上报 ----
  const bad = await hub.collectToolsDetailed(["broken", "dead", "ghost", "off"]);
  const reasonOf = (id) => bad.unavailable.find((item) => item.id === id)?.reason || "";
  check("② 缺席服务器全部上报（4 个）", bad.unavailable.length === 4, JSON.stringify(bad.unavailable));
  check("② 工具清单失败与连接失败区分", reasonOf("broken").startsWith("工具清单获取失败"),
    reasonOf("broken"));
  check("② 连接失败带原因", reasonOf("dead").startsWith("连接失败"), reasonOf("dead"));
  check("② 未配置的服务器上报", reasonOf("ghost") === "服务端未配置该服务器", reasonOf("ghost"));
  check("② 被禁用的服务器上报", reasonOf("off") === "已在服务端禁用", reasonOf("off"));
  check("② 可用的服务器仍照常提供工具", bad.ready.length === 0 && bad.tools.length === 0);

  // ---- ③ 工具数超限：回报被裁的服务器，不静默丢弃 ----
  const selection = selectMcpToolSpecs(all.tools);
  check("③ 超限按顺序截断到上限", selection.specs.length === 2, String(selection.specs.length));
  check("③ 被裁服务器被回报", selection.droppedServers.join(",") === "alpha,beta",
    selection.droppedServers.join(","));

  // ---- ④ 工具通道现状进系统提示（稳定段不被污染）----
  const prompt = buildSystemPrompt({
    tooling: {
      mcpToolCount: selection.specs.length,
      builtinToolCount: 6,
      ready: all.ready,
      unavailable: bad.unavailable,
      dropped: ["Beta 服务"],
      limit: 2,
    },
  });
  check("④ 动态段含不可用原因", prompt.dynamic.includes("工具清单获取失败") && prompt.dynamic.includes("连接失败"));
  check("④ 动态段含裁剪说明", prompt.dynamic.includes("单次工具数上限"));
  check("④ 稳定段不含工具现状（缓存前缀干净）", !prompt.stable.includes("工具通道现状"));

  // ---- ⑤ 取消信号透传到 MCP 调用 ----
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const cancelled = await hub.callMcpTool("mcp__alpha__sleep", {}, controller.signal);
  const elapsed = Date.now() - started;
  clearTimeout(timer);
  check(`⑤ abort 能中断在途 MCP 调用（${elapsed}ms，工具本身 4000ms）`, cancelled.isError && elapsed < 2000,
    JSON.stringify(cancelled));

  // ---- ⑧ 连接中的服务器不被误判为「空服务器」（单飞）----
  const pendingConnect = hub.connect("slowstart");
  const during = await hub.collectToolsDetailed(["slowstart"]);
  await pendingConnect;
  check(
    "⑧ 握手期间读到的工具清单完整（不是 0 个）",
    during.ready.length === 1 && during.ready[0].tools === 2 && during.unavailable.length === 0,
    JSON.stringify(during),
  );
  const [parallelA, parallelB] = await Promise.all([hub.connect("slowstart2"), hub.connect("slowstart2")]);
  check(
    "⑧ 并发 connect 复用同一次连接过程（单飞）",
    parallelA === parallelB && parallelA?.tools.length === 2,
    `${parallelA?.tools.length} / same=${parallelA === parallelB}`,
  );

  // ---- ⑥ 连接失败冷却：挂掉的服务器不再拖慢每一轮 ----
  const t1 = Date.now();
  await hub.connect("slowc");
  const first = Date.now() - t1;
  const t2 = Date.now();
  await hub.connect("slowc");
  const second = Date.now() - t2;
  check(`⑥ 首次连接失败耗时 ≈ 超时（${first}ms）`, first >= 1200, String(first));
  check(`⑥ 冷却窗口内重试立即返回（${second}ms）`, second < 60, String(second));

  // ---- ⑦ 多服务器并行连接（不是串行等超时）----
  const t3 = Date.now();
  await hub.collectToolsDetailed(["slowa", "slowb"]);
  const parallel = Date.now() - t3;
  check(`⑦ 两个坏服务器并行连接 ≈ 1 次超时（${parallel}ms，串行需 >2800ms）`, parallel < 2600, String(parallel));

  // ---- ⑨ 确认门按工具注解判定（服务器级 requireConfirm 优先）----
  await hub.collectToolsDetailed(["alpha", "confirming"]);
  const confirmOf = (name) => hub.toolNeedsConfirm(name);
  check("⑨ 服务器级 requireConfirm 优先（整台服务器都确认）", confirmOf("mcp__confirming__ping") === true);
  check("⑨ readOnlyHint=true → 不确认", confirmOf("mcp__alpha__aaa_first") === false);
  check("⑨ destructiveHint=true → 确认", confirmOf("mcp__alpha__zzz_last") === true);
  check("⑨ destructiveHint=false → 不确认", confirmOf("mcp__alpha__sleep") === false);
  check("⑨ 工具未找到 → 不确认", confirmOf("mcp__alpha__nope") === false);
  const reasonDestructive = hub.confirmReasonOf("mcp__alpha__zzz_last") || "";
  const reasonServerLevel = hub.confirmReasonOf("mcp__confirming__ping") || "";
  check("⑨ 确认原因可解释（区分注解与服务器配置）",
    reasonDestructive.includes("破坏性") && reasonServerLevel.includes("需确认"),
    `${reasonDestructive} / ${reasonServerLevel}`);
  process.env.MCP_CONFIRM_STRICT = "on";
  check("⑨ 严格口径：无注解工具转为需确认", confirmOf("mcp__beta__ping") === true);
  check("⑨ 严格口径：显式非破坏性仍不确认", confirmOf("mcp__alpha__sleep") === false);
  process.env.MCP_CONFIRM_STRICT = "off";
  check("⑨ 恢复默认口径：无注解工具不确认", confirmOf("mcp__beta__ping") === false);

  // ---- ⑩ 工具按需加载：阈值判定 + 检索排序 ----
  check(
    "⑩ auto 阈值：未超窗口比例时全量注入",
    toolSearchEnabled({ contextWindow: 1000 }, 50) === false,
  );
  check(
    "⑩ auto 阈值：超出窗口 10% 时改按需加载",
    toolSearchEnabled({ contextWindow: 1000 }, 200) === true,
  );
  // 按需加载模式下的系统提示：只给「索引（仅名称）」+ 检索引导。
  const deferredPrompt = buildSystemPrompt({
    tooling: {
      mcpToolCount: 0,
      totalMcpTools: all.tools.length,
      builtinToolCount: 7,
      ready: all.ready,
      unavailable: [],
      dropped: [],
      limit: 80,
      deferred: true,
      searchToolName: "search_tools",
      catalog: [{ id: "alpha", label: "Alpha 服务", tools: ["aaa_first", "sleep", "zzz_last"] }],
    },
  });
  check("⑩ 按需模式提示含检索引导", deferredPrompt.dynamic.includes("search_tools"));
  check(
    "⑩ 按需模式提示含工具索引（仅名称）",
    deferredPrompt.dynamic.includes("Alpha 服务") && deferredPrompt.dynamic.includes("aaa_first"),
  );
  check(
    "⑩ 按需模式不再宣称 schema 已注入",
    !deferredPrompt.dynamic.includes("本次已注入：MCP 工具"),
  );
  const exact = searchMcpTools(all.tools, "alpha zzz");
  check("⑩ 检索：工具名命中排在前面", exact[0]?.tool.name === "mcp__alpha__zzz_last",
    JSON.stringify(exact.map((hit) => hit.tool.name)));
  check("⑩ 检索：服务器名也能命中", searchMcpTools(all.tools, "beta").some((hit) => hit.tool.serverId === "beta"));
  check("⑩ 检索：空查询不返回结果（要求模型给关键词）", searchMcpTools(all.tools, "   ").length === 0);
  check("⑩ 检索：无命中返回空", searchMcpTools(all.tools, "zzzz_not_exist").length === 0);
  check("⑩ 检索：limit 生效", searchMcpTools(all.tools, "mock", 1).length === 1);

  // ---- ⑪ 子代理服务器白名单（只给子代理需要的工具）----
  const restricted = resolveSubagentTools(all.tools, ["beta"]);
  check("⑪ 白名单只保留指定服务器", restricted.tools.length === 1 && restricted.tools[0].serverId === "beta",
    JSON.stringify(restricted.tools.map((tool) => tool.name)));
  const inherited = resolveSubagentTools(all.tools, []);
  check("⑪ 空白名单 = 继承全部工具", inherited.tools.length === all.tools.length && !inherited.error);
  const bogus = resolveSubagentTools(all.tools, ["nope"]);
  check("⑪ 白名单无匹配时报错并列出可用服务器",
    Boolean(bogus.error) && bogus.error.includes("alpha"),
    bogus.error || "");

  // ---- ⑫ 空闲连接回收（stdio 子进程不常驻）----
  await hub.collectToolsDetailed(["alpha"]); // 刚用过 → 不应被回收
  const notYet = await hub.reclaimIdleConnections();
  check("⑫ 未超空闲阈值不回收", !notYet.includes("alpha"), notYet.join(","));
  const sleeping = hub.callMcpTool("mcp__alpha__sleep", {}); // 4s 在途调用
  await new Promise((resolve) => setTimeout(resolve, 100));
  const busyReclaim = await hub.reclaimIdleConnections(Date.now() + 60_000);
  check("⑫ 在途调用的连接不被回收", !busyReclaim.includes("alpha"), busyReclaim.join(","));
  await sleeping;
  const idleReclaim = await hub.reclaimIdleConnections(Date.now() + 60_000);
  check("⑫ 超阈值空闲连接被回收", idleReclaim.includes("alpha"), idleReclaim.join(","));
  const reconnected = await hub.connect("alpha");
  check("⑫ 回收后自动重连拿回工具", reconnected?.tools.length === 3, String(reconnected?.tools.length));

  // ---- ⑬ 同轮去重签名（key 顺序无关 + 语义相等）----
  const sigSameA = toolCallSignature("mcp__x__q", '{"b":2,"a":1}');
  const sigSameB = toolCallSignature("mcp__x__q", '{"a":1,"b":2}');
  check("⑬ 参数 key 顺序不同视为同一调用", sigSameA === sigSameB, `${sigSameA} vs ${sigSameB}`);
  check("⑬ name 不同视为不同调用",
    toolCallSignature("mcp__x__q", "{}") !== toolCallSignature("mcp__y__q", "{}"));
  check("⑬ 参数值不同视为不同调用",
    toolCallSignature("f", '{"a":1}') !== toolCallSignature("f", '{"a":2}'));
  check("⑬ 非法 JSON 退化为原文比较（不抛错）", typeof toolCallSignature("f", "{bad") === "string");

  // ---- ⑭ 跨轮 Doom Loop 熔断（连续同指纹触发，指纹变化/空轮重置）----
  const g1 = new LoopGuard(3);
  check("⑭ 首轮不触发", g1.record(["mcp__x__q::{}"]) === false);
  check("⑭ 第二轮连续相同不触发", g1.record(["mcp__x__q::{}"]) === false);
  check("⑭ 第三轮连续相同触发熔断", g1.record(["mcp__x__q::{}"]) === true);
  const g2 = new LoopGuard(3);
  g2.record(["a::{}"]);
  g2.record(["b::{}"]); // 不同指纹打断连击
  check("⑭ 指纹变化重置连击", g2.record(["b::{}"]) === false);
  const g3 = new LoopGuard(3);
  check("⑭ 空轮不计入连击", g3.record([]) === false && g3.record(["a::{}"]) === false);

  await hub.disconnectAll();

  console.log(`\nPASS=${passed} FAIL=${failed}`);
  process.exitCode = failed ? 1 : 0;
}

if (isServe) await runMockServer(process.argv[3] || "alpha");
else await runHarness();
