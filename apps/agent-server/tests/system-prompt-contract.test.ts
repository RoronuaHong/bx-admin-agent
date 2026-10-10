// 系统提示契约（纯逻辑，不需要网络/真实模型）：
// 守住「同一条纪律只有一处措辞」的重构成果：通用纪律由 system-prompt 统一注入，
// 角色人设只保留角色特有内容。若再有人往人设里回填一份工具守则，这里会先红。
// 设计口径见 src/system-prompt.ts 与 src/roles.ts 头注释。
import { test, expect } from "vitest";
import { buildSystemPrompt, renderNowClock } from "../src/system-prompt.js";
import { getRole } from "../src/roles.js";

const TOOLING = {
  mcpToolCount: 0,
  builtinToolCount: 10,
  ready: [],
  unavailable: [],
  dropped: [],
  limit: 80,
};

// 通用工具纪律的关键短句（改 system-prompt.ts 时同步这里）：单一真相锚点。
const TOOL_RULE_MARKERS = ["只依据工具返回的真实结果", "引用外部结果时注明来源", "untrusted_content"];

test("[A] 有工具时：通用工具纪律对通用角色生效（含不可信内容定界规则）", () => {
  const { stable } = buildSystemPrompt({ role: "generic", withMemory: false, tooling: TOOLING });
  for (const marker of TOOL_RULE_MARKERS) expect(stable, `缺少：${marker}`).toContain(marker);
});

test("[B] 有工具时：角色人设与通用纪律同时存在，且各自只出现一次", () => {
  const { stable } = buildSystemPrompt({ role: "movie", withMemory: false, tooling: TOOLING });
  expect(stable).toContain(getRole("movie").label);
  for (const marker of TOOL_RULE_MARKERS) expect(stable, `缺少：${marker}`).toContain(marker);
  // 纪律不再被复制进人设：同一句话出现两次说明有人又回填了一份。
  expect(stable.split("回复面向最终结论").length - 1).toBe(1);
});

test("[C] 无工具时：不注入任何工具纪律（避免模型调用并不存在的工具）", () => {
  const { stable } = buildSystemPrompt({ role: "generic", withMemory: false });
  for (const marker of TOOL_RULE_MARKERS) expect(stable, `不该出现：${marker}`).not.toContain(marker);
});

test("[E] 意图行契约对所有角色生效（前端意图卡 + 计划可见性依赖）", () => {
  // 意图行：apps/web/src/pages/ChatPage.vue 的 INTENT_RE 解析「意图：…」前缀成意图卡。
  for (const role of ["generic", "movie", "support"]) {
    const { stable } = buildSystemPrompt({ role, withMemory: false, tooling: TOOLING });
    expect(stable, `${role} 缺少意图行`).toContain("意图：");
  }
});

test("[D] 角色人设只含角色特有内容：不含被下沉到通用层的守则", () => {
  const base = getRole("movie").basePrompt || "";
  expect(base).toContain("TMDb");
  expect(base).not.toContain("引用数据时注明来自哪次工具调用");
  expect(getRole("support").basePrompt || "").not.toContain("多步任务先拆解步骤再执行");
  expect(getRole("support").defaultMcpServers).toEqual(["zoho-salesiq"]);
  expect(getRole("support").basePrompt || "").toContain("ZohoSalesIQ_getConversationsList");
  expect(getRole("support").basePrompt || "").toContain("不要调用 order_search");
});

test("[G] 工具纪律含事实核验条款（有检索工具就先核实；核不到明说可能不准确；不追问外的细节）", () => {
  const { stable } = buildSystemPrompt({ role: "generic", withMemory: false, tooling: TOOLING });
  // 回归锚点：曾出现「手边有检索工具却零工具调用，把未经核实的细节用确定语气当事实说出」。
  expect(stable).toContain("先用它核实");
  expect(stable).toContain("可能不准确");
  expect(stable).toContain("没有问到");
});

test("[I] 技能索引按主体分流，不写句式或自称词表", () => {
  const { stable } = buildSystemPrompt({ role: "generic", withMemory: false, tooling: TOOLING });
  expect(stable).toContain("已连接的自有业务数据");
  expect(stable).toContain("外部主体的公开事实");
  expect(stable).toContain("一次检索能把读法分开");
  expect(stable).not.toContain("句首");
  expect(stable).not.toContain("我们 / 本公司");
  expect(stable).not.toContain("观影助手工作流");
  expect(stable).not.toContain("Zoho SalesIQ");
  const movie = buildSystemPrompt({ role: "movie", withMemory: false, tooling: TOOLING }).stable;
  const support = buildSystemPrompt({ role: "support", withMemory: false, tooling: TOOLING }).stable;
  expect(movie).toContain("TMDb");
  expect(movie).not.toContain("已连接的自有业务数据");
  expect(movie).not.toContain("外部主体的公开事实");
  expect(support).toContain("ZohoSalesIQ_getConversationsList");
  expect(support).not.toContain("已连接的自有业务数据");
  expect(support).toContain("PDF");
});

test("[H] 动态段带当前 Unix 毫秒，工具纪律要求按参数说明筛选", () => {
  const { stable, dynamic } = buildSystemPrompt({ role: "generic", withMemory: false, tooling: TOOLING });
  expect(stable).toContain("不要写进参数");
  expect(stable).toContain("count_list_by_time");
  expect(stable).toContain("不要改标成 UTC");
  expect(stable).toContain("run_tool_code");
  expect(stable).toContain("不要自己逐页翻列表");
  expect(dynamic).toContain("Unix 毫秒");
  expect(dynamic).toContain("用户时区未上报");
  expect(renderNowClock(1_790_000_000_000)).toContain("1790000000000");
  const local = renderNowClock(1_790_000_000_000, "Asia/Shanghai");
  expect(local).toContain("用户时区：Asia/Shanghai");
  expect(local).toContain("2026-09-21 22:13:20");
  expect(local).not.toContain("用户时区未上报");
});

test("[F] 观影人设写清「何时该调工具 / 何时不该调工具」（对齐工具描述与系统提示的分工）", () => {
  const base = getRole("movie").basePrompt || "";
  // 事实型问题：必须先取数（反编造的主约束）。
  expect(base).toContain("必须先调用观影工具");
  // 非数据轮次：明确不要调工具、且不要声称数据源故障（否则问候/超范围提问会被误答成系统故障）。
  expect(base).toContain("不要调用任何工具");
  expect(base).toContain("不要声称数据源故障");
  // 回归锚点：旧的「首轮系统会强制你先走一次工具通道」已随端点不兼容失效，不该留在人设里误导模型。
  expect(base).not.toContain("强制你先走一次工具通道");
});
