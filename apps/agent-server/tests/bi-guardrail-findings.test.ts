// 按 docs/agent/REVIEW_FINDINGS_2026-10-17.md 的审查发现，用**纯函数模拟输入**逐条坐实问题。
// 全程不连接真实 BI 库、不发起任何网络调用——只用构造好的 SQL 字符串 / 错误文本 / env 走本地判据函数。
//
// 说明：以下用例断言的是「**期望的正确行为**」。当前代码存在缺陷时用例会**失败（红）**——
// 这正是本文件的价值：把审查发现用可执行的方式钉住；缺陷修复后用例自动转绿（回归保护）。
import { test, expect } from "vitest";
import { lintSql } from "../scripts/sql-lint-common.mjs";
import {
  classifyUpstreamError,
  defaultClickHouseSettings,
  appendClickHouseSettings,
} from "../scripts/bi-query-settings.mjs";

const codes = (sql: string) => lintSql(sql).map((f) => f.code);

// ---------------------------------------------------------------- P0-2
// 我们自己注入的 SETTINGS 若不被目标 ClickHouse 支持，报错必须被识别并给出可操作下一步。
// 当前 classifyUpstreamError 只认 241/307/394 → 返回 null → 模型被引导去"改 SQL/查字段名"，归因方向相反。
test("[F-P0-2] UNKNOWN_SETTING(Code 115) 必须被识别为资源类错误", () => {
  const err =
    "Code: 115. DB::Exception: Setting max_estimated_execution_cost is neither a builtin setting " +
    "nor started with the prefix 'SQL_' registered for user-defined settings: Maybe you meant " +
    "['max_estimated_execution_time']. (UNKNOWN_SETTING) (version 24.2.1.2248 (official build))";
  const hint = classifyUpstreamError(err);
  expect(hint).toBeTruthy();
  expect(String(hint)).toMatch(/setting|SETTINGS|设置/i);
});

// ---------------------------------------------------------------- P0-3
// 结果集超限若用 break = 静默截断 → 计数/金额系统性偏小且零提示（"静默给错数"比报错更危险）。
test("[F-P0-3] result_overflow_mode 默认不得为 break", () => {
  expect(defaultClickHouseSettings({}).result_overflow_mode).not.toBe("break");
});

test("[F-P0-3b] 追加 SETTINGS 后不得出现静默截断", () => {
  const out = appendClickHouseSettings("SELECT 1", defaultClickHouseSettings({}));
  expect(out).not.toMatch(/result_overflow_mode\s*=\s*'break'/);
});

// ---------------------------------------------------------------- P0-5
// 线上事故形态正是 uniqExactIf(guid, …)，但正则只匹配 uniq exact → 护栏对真实事故形态失效。
test("[F-P0-5] uniqExactIf 变体必须触发 HEAVY_EXACT_AGG_NOWINDOW", () => {
  const sql = "SELECT uniqExactIf(guid, country = 91) AS dau FROM film_report.elt_active_guid";
  expect(codes(sql)).toContain("HEAVY_EXACT_AGG_NOWINDOW");
});

// ---------------------------------------------------------------- P0-4
// hasDateWindow 只认 'YYYY-MM-DD'：DateTime 写法（toDateTime('... 08:00:00')）整条不识别 →
// 有界短窗被判成"无窗"，误报 HEAVY（与 hasDateWindow 修复的初衷相反）。
test("[F-P0-4] DateTime 有界短窗不应误报 HEAVY", () => {
  const sql =
    "SELECT uniqExact(guid) AS dau FROM t WHERE d >= toDateTime('2026-10-15 08:00:00') " +
    "AND d < toDateTime('2026-10-16 08:00:00') GROUP BY 1";
  expect(codes(sql)).not.toContain("HEAVY_EXACT_AGG_NOWINDOW");
});

// ---------------------------------------------------------------- P1-1
// `=` 等值被当作"单日窗"（span=0）是对的，但正则把 `!=` 也当等值 → 非窗口条件凭空造出一个窗 → 漏报 HEAVY。
test("[F-P1-1] d != '日期' 不是窗口条件，重聚合仍应报 HEAVY", () => {
  const sql = "SELECT uniqExact(guid) AS dau FROM t WHERE d != '2026-10-15'";
  expect(codes(sql)).toContain("HEAVY_EXACT_AGG_NOWINDOW");
});

// ---------------------------------------------------------------- P1-2
// GROUP BY 只含序号（GROUP BY 1）时应放弃判定（避免误报），当前返回空 Set（对象为真）→ 全部裸列被判 missing。
test("[F-P1-2] GROUP BY 1（序号写法）不应误报 GROUP_BY_SELECT_MISMATCH", () => {
  const sql = "SELECT a, count() AS n FROM t GROUP BY 1";
  expect(codes(sql)).not.toContain("GROUP_BY_SELECT_MISMATCH");
});
