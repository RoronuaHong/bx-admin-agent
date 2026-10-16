// BI 查询级资源护栏（scripts/bi-query-settings.mjs）的判据回归。
// 纯函数单测：不拉起 Metabase MCP 服务、不碰网络。
import { test, expect } from "vitest";
import {
  appendClickHouseSettings,
  defaultClickHouseSettings,
  classifyUpstreamError,
} from "../scripts/bi-query-settings.mjs";

test("[S1] appendClickHouseSettings：正常追加、不改写语义、原 SQL 用于回显", () => {
  const sql = "SELECT a, uniqExact(g) FROM t WHERE d >= '2026-10-09' GROUP BY a";
  const out = appendClickHouseSettings(sql, { max_execution_time: 90, max_bytes_before_external_group_by: 4_000_000_000 });
  expect(out).toContain(sql);
  expect(out).toMatch(/SETTINGS max_execution_time=90, max_bytes_before_external_group_by=4000000000$/);
  // 只追加子句，不改原查询内容（去掉 SETTINGS 后应与原文一致）
  expect(out.replace(/\s*SETTINGS .*$/, "")).toBe(sql);
});

test("[S2] appendClickHouseSettings：剥掉尾部分号、并以换行隔离行尾注释", () => {
  expect(appendClickHouseSettings("SELECT 1;", { max_execution_time: 90 })).toBe("SELECT 1\nSETTINGS max_execution_time=90");
  // 以行注释结尾时，换行隔离，避免 SETTINGS 被注释吃掉
  const commented = appendClickHouseSettings("SELECT 1 -- tail", { max_execution_time: 90 });
  expect(commented).toContain("\nSETTINGS max_execution_time=90");
  expect(commented).not.toContain("-- tail SETTINGS");
});

test("[S3] appendClickHouseSettings：已含 SETTINGS 不重复追加；空设置原样返回", () => {
  const withSettings = "SELECT 1 SETTINGS max_execution_time=10";
  expect(appendClickHouseSettings(withSettings, { max_execution_time: 90 })).toBe(withSettings);
  expect(appendClickHouseSettings("SELECT 1", {})).toBe("SELECT 1");
  expect(appendClickHouseSettings("", { max_execution_time: 90 })).toBe("");
});

test("[S4] defaultClickHouseSettings：默认值与环境变量覆盖", () => {
  const d = defaultClickHouseSettings({
    BI_CH_MAX_EXECUTION_TIME: "45",
    BI_CH_EXT_GROUP_BY_BYTES: "1000000",
    BI_CH_MAX_RESULT_ROWS: "500000",
    BI_CH_RESULT_OVERFLOW_MODE: "throw",
    BI_CH_MAX_ESTIMATED_TIME: "300",
  });
  expect(d.max_execution_time).toBe(45);
  expect(d.max_bytes_before_external_group_by).toBe(1_000_000);
  expect(d.max_result_rows).toBe(500_000);
  expect(d.result_overflow_mode).toBe("throw");
  expect(d.max_estimated_execution_time).toBe(300);
  // 缺省走保守默认值（与 P0 profile 对齐，且略保守）
  const def = defaultClickHouseSettings({});
  expect(def.max_execution_time).toBe(90);
  expect(def.max_bytes_before_external_group_by).toBe(4_000_000_000);
  expect(def.max_bytes_before_external_sort).toBe(4_000_000_000);
  expect(def.max_result_rows).toBe(1_000_000);
  expect(def.result_overflow_mode).toBe("break");
  expect(def.timeout_overflow_mode).toBe("throw");
  expect(def.max_estimated_execution_time).toBe(0); // 默认关闭，避免误杀合法大查询
});

test("[S5] classifyUpstreamError：资源类错误码翻译成可操作提示", () => {
  const mem = classifyUpstreamError("DB::Exception: Memory limit (total) exceeded ... Code: 241");
  expect(mem).toContain("内存超限");
  expect(mem).toContain("uniq()");
  expect(mem).toContain("时间窗");

  const read = classifyUpstreamError("Code: 307, e.displayText() = Limit for rows or bytes to read exceeded, max bytes: 256.00 MiB");
  expect(read).toContain("扫描行数/字节超限");

  const cancel = classifyUpstreamError("Code: 394, e.displayText() = ... was cancelled");
  expect(cancel).toContain("查询被取消");
});

test("[S6] classifyUpstreamError：非资源类错误返回 null（回落通用文案）", () => {
  expect(classifyUpstreamError("Code: 62, Syntax error")).toBeNull();
  expect(classifyUpstreamError("")).toBeNull();
  expect(classifyUpstreamError(undefined)).toBeNull();
});

test("[S7] appendClickHouseSettings：字符串型值加引号、数字不加，新字段正常追加", () => {
  const out = appendClickHouseSettings("SELECT 1", {
    max_execution_time: 90,
    max_result_rows: 1_000_000,
    result_overflow_mode: "break",
    timeout_overflow_mode: "throw",
  });
  expect(out).toContain("max_execution_time=90");
  expect(out).toContain("max_result_rows=1000000");
  // 字符串值必须加单引号，否则 SQL 语法非法
  expect(out).toContain("result_overflow_mode='break'");
  expect(out).toContain("timeout_overflow_mode='throw'");
});

test("[S8] appendClickHouseSettings：数值 0 视为关闭/不限制不追加（止血 2026-10-16 线上回归）", () => {
  // 默认 settings 里 max_estimated_execution_time 等关闭项为 0，绝不能把 0 带进 SQL，
  // 否则会把 CK 不支持的 setting（或无效值）附上，触发 UNKNOWN_SETTING 让整条查询 400 失败。
  const appended = appendClickHouseSettings("SELECT 1", defaultClickHouseSettings({}));
  expect(appended).not.toMatch(/max_estimated_execution_cost/); // 旧名彻底不用
  expect(appended).not.toMatch(/=\s*0\b/); // 任何 =0 的设置都不应出现
  // 显式传 0 也跳过
  const out = appendClickHouseSettings("SELECT 1", { max_execution_time: 90, max_estimated_execution_time: 0 });
  expect(out).toContain("max_execution_time=90");
  expect(out).not.toContain("max_estimated_execution_time");
});
