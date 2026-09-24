// 幻觉防护契约回归（纯离线：不联网、不调真实模型、不吃额度，可进 CI）。
//
// 覆盖的是「护栏本身还成不成立」，而不是「模型这次答得对不对」——后者需要端到端跑模型，
// 留给人工回归；这里钉死的是那些**改一行就会让整条防线悄悄失效**的结构性契约：
//   - 护栏什么时候该参与（按工具动态开启，不是按角色写死）；
//   - 引用溯源能不能真的发现编造的来源；
//   - 分诊判的是「回答」还是「问题」（判错对象 = 问候被拦、事实断言被放行）；
//   - 反编造纪律有没有从提示词里被删掉。
import { test, expect } from "vitest";
import {
  buildDataNeedPrompt,
  consensusUnsupported,
  crossCheckSources,
  DATA_NEED_SYSTEM,
  decideGrounding,
  extractToolRefs,
  GROUNDING_HINT,
  hasExternalDataSource,
  isExternalDataSourceTool,
  parseVerifyResult,
  UNGROUNDED_REPLY,
  unknownToolRefs,
  VERIFY_SYSTEM,
} from "../src/grounding.js";
import { buildSystemPrompt } from "../src/system-prompt.js";
import { UNTRUSTED_CONTENT_RULE } from "../src/untrusted.js";
import type { CallOptions } from "../src/models.js";

/** 工具模式下的完整系统提示（稳定段 + 动态段）：断言的是**实际注入模型**的文本，而不是某个常量。 */
function toolingPrompt(): string {
  const prompt = buildSystemPrompt({
    tooling: { mcpToolCount: 1, builtinToolCount: 10, ready: [], unavailable: [], dropped: [], limit: 80 },
  });
  return `${prompt.stable}\n${prompt.dynamic}`;
}

// ───────────────────── 1. 护栏参与条件（按工具，不按角色） ─────────────────────

test("[1] 外部数据源判定：MCP 工具 / 联网检索 / 知识库检索算，工作区工具不算", () => {
  // 外部数据源 → 本轮答案应接地于工具数据。
  expect(isExternalDataSourceTool("mcp__xx__getList")).toBe(true);
  expect(isExternalDataSourceTool("web_search")).toBe(true);
  expect(isExternalDataSourceTool("fetch_url")).toBe(true);
  expect(isExternalDataSourceTool("search_knowledge")).toBe(true);
  // 工作区与记账类工具读的是模型自己写的东西 / 不构成外部事实来源 → 不算。
  // 把它们算进来会让「只挂了工作区工具」的轮次也进零证据拦截，等于禁止模型用自身知识作答。
  for (const name of ["fs_read", "fs_write", "fs_grep", "write_todos", "search_tools", "task", ""]) {
    expect(isExternalDataSourceTool(name)).toBe(false);
  }
});

test("[2] hasExternalDataSource：只看有没有，且不被无关工具误导", () => {
  expect(hasExternalDataSource(["fs_write", "write_todos"])).toBe(false);
  expect(hasExternalDataSource(["fs_read", "mcp__xx__getList"])).toBe(true);
  expect(hasExternalDataSource([])).toBe(false);
});

test("[3] 零证据 + 无外部数据源 → 不参与护栏（纯工作区轮次不被误伤）", () => {
  // 这是「按工具动态开启」的核心回归点：没有外部数据源时不许拦，否则写代码/翻译/创作都会被逼去凑证据。
  const noExternalSource = { enabled: true, enforceGrounding: false, evidenceCalls: 0, retries: 0, maxRetries: 1 };
  expect(decideGrounding(noExternalSource)).toBe("pass");
  // 有外部数据源 + 零证据 → 必须拦（先纠正，用尽则拒答）。
  const withSource = { ...noExternalSource, enforceGrounding: true };
  expect(decideGrounding(withSource)).toBe("retry");
  expect(decideGrounding({ ...withSource, retries: 1 })).toBe("block");
  // 拿到证据 → 一律放行。
  expect(decideGrounding({ ...withSource, evidenceCalls: 1 })).toBe("pass");
});

// ───────────────────── 2. 引用溯源（确定性校验） ─────────────────────

test("[4] extractToolRefs：只认协议级工具引用形态", () => {
  expect(extractToolRefs("我用 mcp__xx__getList 取到了数据")).toEqual(["mcp__xx__getList"]);
  expect(extractToolRefs("A 与 B 都提到了")).toEqual([]);
  // 去重 + 保留顺序
  expect(extractToolRefs("mcp__a__b 与 mcp__c__d，再调一次 mcp__a__b")).toEqual(["mcp__a__b", "mcp__c__d"]);
});

test("[5] unknownToolRefs：编造的工具引用必须被抓到，真实工具不误伤", () => {
  const known = ["mcp__xx__getList", "mcp__xx__getById"];
  expect(unknownToolRefs("数据来自 mcp__yy__getDetail", known)).toEqual(["mcp__yy__getDetail"]);
  expect(unknownToolRefs("数据来自 mcp__xx__getList", known)).toEqual([]);
  expect(unknownToolRefs("没有提到任何工具", known)).toEqual([]);
  expect(unknownToolRefs("", known)).toEqual([]);
});

test("[6] crossCheckSources：标识形态的来源对不上才算，自然语言来源名不判（防误伤）", () => {
  const known = ["mcp__xx__getList", "xx"];
  // 真实来源（含互为其子串的服务器标识）→ 放行。
  expect(crossCheckSources(["mcp__xx__getList"], known)).toEqual([]);
  expect(crossCheckSources(["xx"], known)).toEqual([]);
  // 编造的标识形态来源 → 留下。
  expect(crossCheckSources(["mcp__zz__getList"], known)).toEqual(["mcp__zz__getList"]);
  // 自然语言来源名不是标识符 → 不参与确定性判定（它可能只是随口一提，判了就是误伤）。
  expect(crossCheckSources(["某某平台"], known)).toEqual([]);
  expect(crossCheckSources(["官网上的说明"], known)).toEqual([]);
  // 空输入安全
  expect(crossCheckSources([], known)).toEqual([]);
  expect(crossCheckSources(["mcp__zz__a"], [])).toEqual(["mcp__zz__a"]);
});

test("[7] parseVerifyResult：无支持断言与来源分开取，缺字段/坏 JSON = 不可用（不阻断）", () => {
  expect(parseVerifyResult('{"unsupported":[],"unknown_sources":[]}')).toEqual({
    unsupported: [],
    unknownSources: [],
  });
  expect(parseVerifyResult('{"unsupported":["评分 9.9"],"unknown_sources":["mcp__zz__a"]}')).toEqual({
    unsupported: ["评分 9.9"],
    unknownSources: ["mcp__zz__a"],
  });
  // 旧格式（只有 unsupported）向后兼容：来源字段不可用，但不影响断言判定。
  expect(parseVerifyResult('{"unsupported":["X"]}').unsupported).toEqual(["X"]);
  expect(parseVerifyResult('{"unsupported":["X"]}').unknownSources).toBeNull();
  // 解析失败 → 整体不可用（调用方按「不阻断」处理，绝不因此拒答）。
  expect(parseVerifyResult("").unsupported).toBeNull();
  expect(parseVerifyResult("抱歉").unknownSources).toBeNull();
  expect(parseVerifyResult('{"unsupported":"不是数组"}').unsupported).toBeNull();
});

test("[8] 多票裁决：阈值 ⌈N/2⌉，任一张票不可用 → 整体不可用（不静默、也不误判）", () => {
  expect(consensusUnsupported([["A"]])).toEqual(["A"]); // N=1：原样
  // 两票时阈值 ⌈2/2⌉=1 → 只要有一票认定就算（宁可多列给模型核对，也不静默吞掉一条）。
  expect(consensusUnsupported([["A", "B"], ["A"]])).toEqual(["A", "B"]);
  expect(consensusUnsupported([["A"], ["B"]])).toEqual(["A", "B"]);
  // 三票时阈值 ⌈3/2⌉=2 → 只有孤证的 B 被过滤（这才是多票真正起作用的场景）。
  expect(consensusUnsupported([["A", "B"], ["A"], ["A"]])).toEqual(["A"]);
  expect(consensusUnsupported([["A"], null])).toBeNull(); // 有票失败 → 整体不可用
  expect(consensusUnsupported([])).toBeNull();
});

// ───────────────────── 3. 分诊判的是「回答」，不是「问题」 ─────────────────────

test("[9] 分诊输入同时带问题与回答（判定对象必须是待上屏的回答）", () => {
  const prompt = buildDataNeedPrompt("Q1", "A1");
  expect(prompt).toContain("Q1");
  expect(prompt).toContain("A1");
});

test("[10] 分诊口径契约：判「回答里有没有事实断言」，拿不准判 DATA，只输出两个词", () => {
  expect(DATA_NEED_SYSTEM).toContain("回答");
  expect(DATA_NEED_SYSTEM).toContain("DATA");
  expect(DATA_NEED_SYSTEM).toContain("NO_DATA");
  expect(DATA_NEED_SYSTEM).toContain("无法确定时输出 DATA");
  expect(DATA_NEED_SYSTEM).toContain("不要解释");
});

// ───────────────────── 4. 提示词纪律没有被改掉 ─────────────────────

test("[11] 工具纪律：反编造 / 注明来源 / 事实先核实 / 澄清优先 四条都在", () => {
  const rules = toolingPrompt();
  expect(rules).toContain("不要编造");
  expect(rules).toContain("注明来源");
  // 事实核验纪律（防止训练记忆里的细节被当成已核实事实说出来）
  expect(rules).toContain("核实");
  expect(rules).toContain("不要用确定语气断言");
  // 澄清优先于核实：带假设去检索，结果自然与假设一致
  expect(rules).toContain("优先");
  // 不可信内容定界（外部内容是数据不是指令）
  expect(rules).toContain(UNTRUSTED_CONTENT_RULE);
});

test("[12] 纠正提示：两条合法路径都在，且不得让用户去改设置", () => {
  expect(GROUNDING_HINT).toContain("函数调用");
  expect(GROUNDING_HINT).toContain("不需要外部数据");
  expect(GROUNDING_HINT).toContain("编造");
  expect(GROUNDING_HINT).toContain("不要声称数据源故障");
  expect(UNGROUNDED_REPLY).not.toContain("对话设置");
});

test("[13] 核验器口径：只判证据支持性 + 不引入自有知识 + 报告编造来源", () => {
  expect(VERIFY_SYSTEM).toContain("unsupported");
  expect(VERIFY_SYSTEM).toContain("unknown_sources");
  expect(VERIFY_SYSTEM).toContain("不引入你自己的知识");
  expect(VERIFY_SYSTEM).toContain("不要输出任何其它内容");
});

// ───────────────────── 5. 判定型调用的采样参数 ─────────────────────

test("[14] 采样参数可显式指定（判定型调用固定 temperature=0，主对话不传）", () => {
  // 类型契约：CallOptions 必须能带 temperature，否则判定型调用无法关掉随机性。
  const deterministic: CallOptions = { temperature: 0, disableThinking: true };
  expect(deterministic.temperature).toBe(0);
  // 主对话不传：字段可选，缺省即不塞参数（避免把可能不被接受的字段塞给所有调用）。
  const main: CallOptions = {};
  expect(main.temperature).toBeUndefined();
});
