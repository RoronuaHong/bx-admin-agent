// 接地护栏单元验证（纯逻辑，不需要网络/真实模型）：
// 覆盖「零数据凭记忆作答」的决策矩阵、证据工具判定、以及 movie 角色的开关接线。
// 设计口径见 src/grounding.ts 头注释。
import { test, expect } from "vitest";
import {
  buildClaimExtractPrompt,
  buildGroundedFallbackSystem,
  buildGroundedFallbackUser,
  buildSupportPrompt,
  buildVerifyHint,
  CLAIM_EXTRACT_SYSTEM,
  DATA_NEED_SYSTEM,
  parseClaimExtraction,
  parseDataNeed,
  priorTopicMessages,
  probeAllowsRelease,
  buildVerifyPrompt,
  SUPPORT_SYSTEM,
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
  expect(VERIFY_HINT_TAIL).toContain("不要为了复核");
  expect(VERIFY_HINT_TAIL).toContain("方案自设");
  expect(VERIFY_HINT_TAIL).toContain("思考只写一行");
  expect(VERIFY_HINT_TAIL).not.toContain("请二选一");
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
  expect(DATA_NEED_SYSTEM).toContain("没有给出可核对的取值");
  expect(DATA_NEED_SYSTEM).toContain("还没取数");
  expect(DATA_NEED_SYSTEM).toContain("还在等工具返回");
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
  expect(system).toContain("不要说成取数失败");
  expect(buildGroundedFallbackSystem("客服助手")).toContain("客服助手");
});

test("[E4] 有上文的兜底：看得到话题，不复述作废数字；只开联网时数字标未核对", () => {
  const strict = buildGroundedFallbackSystem("通用助手", { hasPriorTopic: true });
  expect(strict).toContain("不要说自己看不到前文");
  expect(strict).toContain("只问那一项");
  expect(strict).toContain("被作废的那一版");
  expect(strict).toContain("80 字");
  expect(strict).not.toContain("未核对");
  const webOnly = buildGroundedFallbackSystem("通用助手", { hasPriorTopic: true, webOnly: true });
  expect(webOnly).toContain("未核对");
  expect(webOnly).toContain("没有业务数据源");
  expect(webOnly).not.toContain("80 字");
  const user = buildGroundedFallbackUser("吃的和喝的分别是什么", [
    { role: "user", content: "家里的狗 10 岁，40 到 50 斤" },
    { role: "assistant", content: "这是中型犬" },
  ]);
  expect(user).toContain("10 岁");
  expect(user).toContain("吃的和喝的分别是什么");
  expect(user).toContain("不包括刚才被作废的那一版数字");
  expect(buildGroundedFallbackUser("你好", [])).toBe("你好");
});

test("[E5] 上文只取本轮问题之前的对话，工具结果和本轮问题不带上", () => {
  const prior = priorTopicMessages(
    [
      { role: "user", content: "家里的狗 10 岁，40 到 50 斤" },
      { role: "assistant", content: "这是中型犬" },
      { role: "tool", content: "检索结果不该进话题" },
      { role: "user", content: "吃的和喝的分别是什么" },
      { role: "assistant", content: "作废草稿：每天 300 克" },
    ],
    "吃的和喝的分别是什么",
  );
  expect(prior.map((item) => item.content)).toEqual(["家里的狗 10 岁，40 到 50 斤", "这是中型犬"]);
  expect(probeAllowsRelease("no_data")).toBe(true);
  expect(probeAllowsRelease("unavailable")).toBe(true);
  expect(probeAllowsRelease("unavailable", { unattended: true })).toBe(false);
  expect(probeAllowsRelease("data")).toBe(false);
  expect(probeAllowsRelease(null)).toBe(false);
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

// ---- 两阶段核验（对齐 CoVe：验证环节看不到草稿）----

test("[L] parseClaimExtraction：只认数组，解析失败返回 null（= 抽取不可用，调用方不阻断）", () => {
  expect(parseClaimExtraction('{"claims":["共 30 条"],"sources":["mcp__x__y"]}')).toEqual({
    claims: ["共 30 条"],
    sources: ["mcp__x__y"],
  });
  // 无断言是合法结果（本轮没有可核验的东西），不是不可用。
  expect(parseClaimExtraction('{"claims":[],"sources":[]}')).toEqual({ claims: [], sources: [] });
  // 缺 sources 不该让整次抽取报废。
  expect(parseClaimExtraction('{"claims":["A"]}')).toEqual({ claims: ["A"], sources: [] });
  // 围栏与前后缀容忍（和核验判定同一套稳健解析）。
  expect(parseClaimExtraction('结果：\n```json\n{"claims":["A"]}\n```')!.claims).toEqual(["A"]);
  expect(parseClaimExtraction("")).toBeNull();
  expect(parseClaimExtraction("抱歉我做不到")).toBeNull();
  expect(parseClaimExtraction('{"claims":')).toBeNull();
  expect(parseClaimExtraction('{"claims":"不是数组"}')).toBeNull();
});

test("[M] 两阶段的输入边界：抽取只看回答，判定不回传回答（CoVe 的独立性）", () => {
  const draft = "数据核对完毕。共 30 条。以下为说明细节 MARKER-DRAFT-ONLY。";
  // 阶段一：只给回答，不给证据——抽取不该被证据带偏。
  const extract = buildClaimExtractPrompt(draft);
  expect(extract).toContain(draft);
  expect(extract).not.toContain("【来源");

  // 阶段二：只给「证据 + 断言」，绝不回传原回答全文。
  const support = buildSupportPrompt({
    question: "查一下数量",
    evidence: "【来源 fs_read】\n共 3 条",
    claims: ["共 30 条"],
  });
  expect(support).toContain("共 30 条"); // 断言本身必须在
  expect(support).toContain("【来源 fs_read】"); // 证据必须在
  expect(support).toContain("查一下数量"); // 对照基准必须在
  expect(support).not.toContain("MARKER-DRAFT-ONLY"); // 回归锚点：草稿正文不得进入判定环节
  // 两个阶段的口径都写死为「只输出一个 JSON」，避免核验器变成第二个自由写手。
  expect(CLAIM_EXTRACT_SYSTEM).toContain("仅输出一个 JSON 对象");
  expect(SUPPORT_SYSTEM).toContain("仅输出一个 JSON 对象");
  expect(CLAIM_EXTRACT_SYSTEM).toContain("宁可多抽");
  expect(SUPPORT_SYSTEM).not.toContain("回答里"); // 判定环节没有「回答」，只有断言
});

test("[K] consensusUnsupported：任一票不可用（null）→ 整体不可用，不阻断", () => {
  expect(consensusUnsupported([null])).toBeNull();
  expect(consensusUnsupported([["X"], null, ["X"]])).toBeNull();
  expect(consensusUnsupported([])).toBeNull();
});
