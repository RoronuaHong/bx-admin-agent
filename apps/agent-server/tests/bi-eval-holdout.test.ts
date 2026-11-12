// 评测防泄题（留一法）：孪生卡片识别、留出文件读写、评测模式闸门与列表过滤。
// 回归背景：题目 = 卡片标题，BI 工具能按标题搜到原卡片、get_golden_set 直接给出期望 SQL，评测测的是检索而非能力。
import { test, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOLDOUT_ENV,
  CALIBER_DISABLE_ENV,
  holdoutCardIds,
  writeHoldout,
  clearHoldout,
  heldOutCardIds,
  evalGateRefusal,
  evalHiddenTools,
  caliberDisabled,
  hideHeldOut,
  cardIdArg,
} from "../scripts/bi-eval-holdout.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bi-holdout-"));
const file = path.join(dir, "holdout.json");
const env = { [HOLDOUT_ENV]: file };
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const cases = [
  { id: 1, question: "会员国籍", expected_sql: "SELECT a FROM t" },
  { id: 2, question: "会员国籍 副本", expected_sql: "select   a\nfrom t" },
  { id: 3, question: "会员 国籍", expected_sql: "SELECT b FROM t" },
  { id: 4, question: "别的", expected_sql: "SELECT c FROM t" },
];

test("孪生卡片：编译后 SQL 相同（忽略空白大小写）或标题相同（忽略空白）都一并留出", () => {
  expect(holdoutCardIds(cases, 1).sort()).toEqual([1, 2, 3]);
  expect(holdoutCardIds(cases, 4)).toEqual([4]);
  expect(holdoutCardIds(cases, 99)).toEqual([99]);
});

test("留出文件读写：写入后可读到，清空后为空集", () => {
  writeHoldout(file, { caseId: 1, cardIds: [1, 2] });
  expect([...heldOutCardIds(env)].sort()).toEqual([1, 2]);
  clearHoldout(file);
  expect(heldOutCardIds(env).size).toBe(0);
});

test("未开评测模式：闸门全部放行，列表不过滤", () => {
  expect(evalGateRefusal("get_golden_set", {}, {})).toBe(null);
  expect(hideHeldOut([{ id: 1 }], "id", {})).toEqual([{ id: 1 }]);
});

test("评测模式：禁用 get_golden_set；按 id 取/跑留出卡片被拒；其它卡片放行", () => {
  writeHoldout(file, { caseId: 125, cardIds: [125] });
  expect(evalGateRefusal("get_golden_set", {}, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("get_card", { card_id: 125 }, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("execute_query", { question_id: 125 }, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("query", { question_id: "125" }, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("construct_query", { question_id: 125 }, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("read_resource", { type: "card", id: 125 }, env)).toContain("[eval-holdout]");
  expect(evalGateRefusal("read_resource", { type: "table", id: 125 }, env)).toBe(null);
  expect(evalGateRefusal("get_card", { card_id: 126 }, env)).toBe(null);
  expect(evalGateRefusal("run_native_query", { query: "SELECT 1" }, env)).toBe(null);
});

test("评测模式：列表输出剔除留出卡片", () => {
  writeHoldout(file, { caseId: 125, cardIds: [125] });
  expect(hideHeldOut([{ id: 125 }, { id: 7 }], "id", env)).toEqual([{ id: 7 }]);
  expect(hideHeldOut([{ card_id: 125 }, { card_id: 8 }], "card_id", env)).toEqual([{ card_id: 8 }]);
});

test("题目改成自然语言后：孪生卡片仍按保留的 cardTitle 识别", () => {
  const rewritten = [
    { id: 1, cardTitle: "会员国籍", question: "会员按国籍的分布如何？", expected_sql: "SELECT a FROM t" },
    { id: 2, cardTitle: "会员国籍", question: "完全不同的另一句提问", expected_sql: "SELECT b FROM t" },
    { id: 3, cardTitle: "别的", question: "另一个问题？", expected_sql: "SELECT c FROM t" },
  ];
  expect(holdoutCardIds(rewritten, 1).sort()).toEqual([1, 2]);
});

test("cardIdArg：各工具的卡片 id 参数", () => {
  expect(cardIdArg("get_related_cards", { card_id: 3 })).toBe(3);
  expect(cardIdArg("execute_query", { question_id: 4 })).toBe(4);
  expect(cardIdArg("search", { query: "x" })).toBe(null);
});

test("P3 A/B 开关：不是评测模式时不生效，误配进生产 .env 不会关掉线上工具", () => {
  const prodEnv = { [CALIBER_DISABLE_ENV]: "1" };
  expect(caliberDisabled(prodEnv)).toBe(false);
  expect([...evalHiddenTools(prodEnv)]).toEqual([]);
  expect(evalGateRefusal("get_caliber_context", { query: "会员存量" }, prodEnv)).toBe(null);
  expect([...evalHiddenTools({})]).toEqual([]);
});

test("P3 A/B 开关：评测模式下隐藏并拒绝口径图工具，get_golden_set 仍禁用", () => {
  const off = { [HOLDOUT_ENV]: file, [CALIBER_DISABLE_ENV]: "TRUE" };
  expect(caliberDisabled(off)).toBe(true);
  expect([...evalHiddenTools(off)].sort()).toEqual(["get_caliber_context", "get_golden_set"]);
  expect(evalGateRefusal("get_caliber_context", { query: "会员存量" }, off)).toContain("[eval-holdout]");
  expect(evalGateRefusal("get_golden_set", {}, off)).toContain("[eval-holdout]");
  expect(evalGateRefusal("run_native_query", { query: "SELECT 1" }, off)).toBe(null);
});

test("P3 A/B 开关：未设或设为 0 时口径图照常可用", () => {
  expect(caliberDisabled({ [HOLDOUT_ENV]: file, [CALIBER_DISABLE_ENV]: "0" })).toBe(false);
  expect([...evalHiddenTools(env)]).toEqual(["get_golden_set"]);
  expect(evalGateRefusal("get_caliber_context", { query: "会员存量" }, env)).toBe(null);
});
