// 接地护栏单元验证（纯逻辑，不需要网络/真实模型）：
// 覆盖「零数据凭记忆作答」的决策矩阵、证据工具判定、以及 movie 角色的开关接线。
// 设计口径见 src/grounding.ts 头注释。
import { test, expect } from "vitest";
import {
  buildGroundedFallbackSystem,
  buildVerifyHint,
  DATA_NEED_SYSTEM,
  parseDataNeed,
  buildVerifyPrompt,
  consensusUnsupported,
  decideGrounding,
  GROUNDING_HINT,
  isGroundingEvidenceTool,
  MAX_UNSUPPORTED_CLAIMS,
  parseUnsupportedClaims,
  shouldRunVerification,
  UNGROUNDED_REPLY,
  VERIFY_HINT_HEAD,
  VERIFY_HINT_TAIL,
  VERIFY_SYSTEM,
} from "../src/grounding.js";
import { getRole } from "../src/roles.js";

const base = { enabled: true, enforceGrounding: true, evidenceCalls: 0, retries: 0, maxRetries: 1 };

test("[A] decideGrounding：零证据 → 先纠正，纠正用尽 → 拒答", () => {
  expect(decideGrounding(base)).toBe("retry");
  expect(decideGrounding({ ...base, retries: 1 })).toBe("block");
  // 重试上限为 0：首次即拒答（不允许任何未接地内容上屏）。
  expect(decideGrounding({ ...base, maxRetries: 0 })).toBe("block");
});

test("[B] decideGrounding：有证据一律放行（纠正次数已用尽也不误伤）", () => {
  expect(decideGrounding({ ...base, evidenceCalls: 1 })).toBe("pass");
  expect(decideGrounding({ ...base, evidenceCalls: 3, retries: 5 })).toBe("pass");
});

test("[C] decideGrounding：总开关/角色未声明时不参与（通用角色行为不变）", () => {
  expect(decideGrounding({ ...base, enabled: false })).toBe("pass");
  expect(decideGrounding({ ...base, enforceGrounding: false })).toBe("pass");
  expect(decideGrounding({ ...base, enforceGrounding: undefined })).toBe("pass");
  expect(decideGrounding({ ...base, enabled: false, retries: 9 })).toBe("pass");
});

test("[D] isGroundingEvidenceTool：外部数据工具算证据，记账/工作区工具不算", () => {
  // 数据源工具（含 MCP 命名空间工具、读工作区/知识库的工具）→ 证据
  expect(isGroundingEvidenceTool("mcp__movie__movies_search")).toBe(true);
  expect(isGroundingEvidenceTool("mcp__bi__list")).toBe(true);
  expect(isGroundingEvidenceTool("fs_read")).toBe(true); // 可读回被卸载的工具结果
  expect(isGroundingEvidenceTool("search_knowledge")).toBe(true);
  expect(isGroundingEvidenceTool("task")).toBe(true);
  // 计划 / 工作区写入类 → 不构成「拿到了事实数据」
  for (const name of ["write_todos", "fs_write", "fs_edit", "fs_ls", "search_tools"]) {
    expect(isGroundingEvidenceTool(name)).toBe(false);
  }
  // 空名不误判为证据
  expect(isGroundingEvidenceTool("")).toBe(false);
});

test("[E] 纠正提示是两支口径：需要数据的取数、本就不需要数据的如实直答（且不得声称数据源故障）", () => {
  expect(GROUNDING_HINT.trim().length).toBeGreaterThan(0);
  // 取数路径仍要写明（否则弱模型会直接放弃取数）。
  expect(GROUNDING_HINT).toContain("函数调用");
  // 非取数路径必须存在：问候/闲聊/超范围提问不该被逼着"为了凑证据去调无关工具"。
  expect(GROUNDING_HINT).toContain("不需要外部数据");
  // 两条路径共同的红线：不得编造。
  expect(GROUNDING_HINT).toContain("编造");
  // 回归锚点：本轮根本没发起取数时，不许让模型声称数据源故障（这正是「问候被回成数据源故障」的根因）。
  expect(GROUNDING_HINT).toContain("不要声称数据源故障");
  // 回归锚点：纠正提示不许被复述进正文（实测出现过「我选②改写回答…」被当答案开头）。
  expect(GROUNDING_HINT).toContain("不要复述");
  expect(VERIFY_HINT_TAIL).toContain("不要复述");
});

test("[E2] 确定性兜底文案：如实说没取到，但不把责任推给用户去改设置", () => {
  expect(UNGROUNDED_REPLY.trim().length).toBeGreaterThan(0);
  // 回归锚点：旧文案让用户「在对话设置里确认数据源已连接」——对「本轮本来不需要数据」的轮次是误导。
  expect(UNGROUNDED_REPLY).not.toContain("数据源已连接");
  expect(UNGROUNDED_REPLY).not.toContain("对话设置");
});

test("[J] 数据需求分诊：NO_DATA 必须先判（含 DATA 子串），识别不出返回 null（调用方按 DATA 保守处理）", () => {
  expect(parseDataNeed("DATA")).toBe("data");
  expect(parseDataNeed("NO_DATA")).toBe("no_data");
  expect(parseDataNeed("no_data\n")).toBe("no_data");
  expect(parseDataNeed("NO-DATA")).toBe("no_data");
  expect(parseDataNeed("NO DATA")).toBe("no_data");
  expect(parseDataNeed("结论：NO_DATA")).toBe("no_data");
  expect(parseDataNeed("我认为是 DATA")).toBe("data");
  expect(parseDataNeed("hmm")).toBeNull();
  expect(parseDataNeed("")).toBeNull();
  // 分诊提示的契约：只输出两个词之一；拿不准时选 DATA（保守方向 = 宁可多跑一轮重试）
  expect(DATA_NEED_SYSTEM).toContain("DATA");
  expect(DATA_NEED_SYSTEM).toContain("NO_DATA");
  expect(DATA_NEED_SYSTEM).toContain("无法确定时输出 DATA");
});

test("[E3] 受约束的诚实兜底提示：带角色名、禁止外部事实断言、允许自报身份、禁止提及内部机制", () => {
  const system = buildGroundedFallbackSystem("观影助手");
  expect(system).toContain("观影助手");
  // 零编造的硬约束：明确禁止外部事实性内容 + 禁止提及工具/数据源等内部机制。
  expect(system).toContain("外部");
  expect(system).toContain("数据源");
  expect(system).toContain("不要提及");
  // 回归锚点：身份自我介绍必须被允许——否则「你是谁」会被兜底成「身份问题我暂无法回答」（实测踩过）。
  expect(system).toContain("角色身份");
  expect(system).toContain("不要回避身份问题");
  // 长度约束存在（兜底话术不该变成第二段长回答）。
  expect(system).toContain("80 字");
  expect(buildGroundedFallbackSystem("客服助手")).toContain("客服助手");
});

test("[F] 角色接线：movie 开启接地护栏，通用角色不参与", () => {
  expect(getRole("movie").enforceGrounding).toBe(true);
  expect(getRole("movie").forceToolCall).toBe(true);
  expect(getRole("generic").enforceGrounding).toBeUndefined();
  expect(getRole("unknown-role").enforceGrounding).toBeUndefined();
});

// ---- 事后核验（Chain-of-Verification 最小版）----

const verifyBase = { enabled: true, enforceGrounding: true, evidenceChars: 100, verifications: 0, maxVerifications: 1 };

test("[G] shouldRunVerification：只在「有证据 + 角色声明 + 开关开 + 未用尽」时核验", () => {
  expect(shouldRunVerification(verifyBase)).toBe(true);
  expect(shouldRunVerification({ ...verifyBase, verifications: 1 })).toBe(false); // 次数用尽不重复核验
  expect(shouldRunVerification({ ...verifyBase, evidenceChars: 0 })).toBe(false); // 无证据 → 谁都不空转
  expect(shouldRunVerification({ ...verifyBase, enabled: false })).toBe(false);
  expect(shouldRunVerification({ ...verifyBase, enforceGrounding: undefined })).toBe(false);
  expect(shouldRunVerification({ ...verifyBase, enforceGrounding: false })).toBe(false);
  expect(shouldRunVerification({ ...verifyBase, maxVerifications: 0 })).toBe(false);
});

test("[H] parseUnsupportedClaims：稳健解析（围栏/前后缀/异常都不过度反应）", () => {
  expect(parseUnsupportedClaims('{"unsupported":[]}')).toEqual([]);
  expect(parseUnsupportedClaims('{"unsupported":["A 出生于 1970 年","评分 9.9"]}')).toEqual([
    "A 出生于 1970 年",
    "评分 9.9",
  ]);
  // 围栏 + 解释性前后缀：取首个 { 到末个 }
  expect(parseUnsupportedClaims('好的，结果如下：\n```json\n{"unsupported":["X"]}\n```\n以上。')).toEqual(["X"]);
  // 空白条目被过滤，避免回灌空条目
  expect(parseUnsupportedClaims('{"unsupported":["  ", "", "Y"]}')).toEqual(["Y"]);
  // 回灌条目数有上限（核验结果也要受上下文预算约束）
  const many = JSON.stringify({ unsupported: Array.from({ length: 50 }, (_, i) => `c${i}`) });
  expect(parseUnsupportedClaims(many)!.length).toBe(MAX_UNSUPPORTED_CLAIMS);
  // 解析失败 = 核验不可用（null），调用方不阻断作答
  expect(parseUnsupportedClaims("")).toBeNull();
  expect(parseUnsupportedClaims("抱歉，我无法完成")).toBeNull();
  expect(parseUnsupportedClaims('{"unsupported":')).toBeNull();
  expect(parseUnsupportedClaims('{"other":[]}')).toBeNull();
  expect(parseUnsupportedClaims('{"unsupported":"不是数组"}')).toBeNull();
  expect(parseUnsupportedClaims("[1,2,3]")).toBeNull();
});

test("[I] 核验提示组装：问题/证据/回答三段齐全，回灌提示含头尾与条目", () => {
  const prompt = buildVerifyPrompt({ question: "Q", evidence: "E", answer: "A" });
  expect(prompt).toContain("Q");
  expect(prompt).toContain("E");
  expect(prompt).toContain("A");
  const hint = buildVerifyHint("[untrusted_content kind=\"verification_claims\"]\n- X\n[/untrusted_content]");
  expect(hint.startsWith(VERIFY_HINT_HEAD)).toBe(true);
  expect(hint.endsWith(VERIFY_HINT_TAIL)).toBe(true);
  expect(hint).toContain("- X");
  // 核验器口径写死为「只判证据支持性」，不得变成第二个自由写手
  expect(VERIFY_SYSTEM).toContain("unsupported");
  expect(VERIFY_SYSTEM).toContain("不要输出任何其它内容");
});

// ---- 多票裁决（降低核验器自身误判）----

test("[J] consensusUnsupported：多数票认定才作废，N=1 退化为单次逻辑", () => {
  // N=1：出现即认定
  expect(consensusUnsupported([["X"]])).toEqual(["X"]);
  // N=3：出现 2 次（≥⌈3/2⌉=2）→ 认定；只出现 1 次的丢弃
  expect(consensusUnsupported([["X", "Y"], ["X"], ["X"]])).toEqual(["X"]);
  // N=3：出现 1 次的均丢弃 → 空
  expect(consensusUnsupported([["X"], ["Y"], ["Z"]])).toEqual([]);
  // 同一次里重复条目只算 1 票（去重后计票）
  expect(consensusUnsupported([["X", "X"], ["X"]])).toEqual(["X"]);
  // 3 票中只出现 1 次的被丢弃
  expect(consensusUnsupported([["X"], ["Y"], ["Y"]])).toEqual(["Y"]);
});

test("[K] consensusUnsupported：任一票不可用（null）→ 整体不可用，不阻断", () => {
  expect(consensusUnsupported([null])).toBeNull();
  expect(consensusUnsupported([["X"], null, ["X"]])).toBeNull();
  expect(consensusUnsupported([])).toBeNull();
});
