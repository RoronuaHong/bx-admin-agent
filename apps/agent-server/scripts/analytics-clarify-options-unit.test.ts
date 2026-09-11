/**
 * Probe clarify options: keep (empty) + numbered labels (shared module).
 */
import assert from "node:assert/strict";
import {
  attachClarifyOptions,
  layoutClarifyOptions,
  parseProbeValuesForDim,
  withOptionNumbers,
} from "../src/analytics/clarify-options.ts";

const parsed = parseProbeValuesForDim(
  "contentLang: (empty), ta-IN, te-IN, ml-IN\nchannel: IndiaA",
  "contentLang",
);
assert.deepEqual(
  parsed.map((o) => o.id),
  ["(empty)", "ta-IN", "te-IN", "ml-IN"],
);
assert.equal(parsed[0]!.label, "英语（contentLang 为空）");

const numbered = withOptionNumbers(parsed);
assert.equal(numbered[0]!.label, "1. 英语（contentLang 为空）");
assert.equal(numbered[2]!.label, "3. te-IN");

const attached = attachClarifyOptions(
  "请确认要统计的具体内容语言列表（可多选）。请直接列出语言码（如 te-IN、ta-IN）。\n候选示例：ta-IN、te-IN、ml-IN",
  parsed,
  { multiSelect: true, slot: "contentLang" },
);
assert.match(attached.message, /1\. 英语（contentLang 为空）/);
assert.match(attached.message, /候选（可多选/);
assert.doesNotMatch(attached.message, /候选示例/);
assert.doesNotMatch(attached.message, /请直接列出/);
assert.equal(attached.clarifyOptions?.[1]?.id, "ta-IN");

const layout = attachClarifyOptions("请选择宽表或长表。", layoutClarifyOptions(), {
  multiSelect: false,
});
assert.match(layout.message, /候选（单选/);
assert.match(layout.message, /1\. 宽表/);
assert.deepEqual(
  layout.clarifyOptions?.map((o) => o.id),
  ["wide", "long"],
);

console.log("analytics-clarify-options-unit.test.ts OK");
