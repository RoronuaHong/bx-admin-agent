// 系统提示契约（纯逻辑，不需要网络/真实模型）：
// 守住「同一条纪律只有一处措辞」的重构成果：通用纪律由 system-prompt 统一注入，
// 角色人设只保留角色特有内容。若再有人往人设里回填一份工具守则，这里会先红。
// 设计口径见 src/system-prompt.ts 与 src/roles.ts 头注释。
import { test, expect } from "vitest";
import { buildSystemPrompt } from "../src/system-prompt.js";
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
});
