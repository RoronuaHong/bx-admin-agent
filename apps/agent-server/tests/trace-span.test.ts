// span 级追踪（llm / tool 分层，src/trace.ts）：
// run 级说「这次运行怎么样」，轮级说「每轮做了什么」，都回答不了「时间花在哪一次调用上」。
// 这里覆盖：按 runId 分文件 append-only、按时间正序读回、以及归属校验用的 run 回查。
import { test, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSpanTrace, findRunTrace, listSpanTraces, setTraceDirForTest } from "../src/trace.js";

// 落盘目录指向临时目录：测试产物不写进真实 .data/traces（否则真实目录被测试文件堆满，
// 保留期清理还会把它们当孤儿删掉，真实排障数据与测试数据混在一起无法分辨）。
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-span-"));
  setTraceDirForTest(dir);
});
afterAll(() => {
  setTraceDirForTest();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("span 按 runId 分文件落盘，读回保持写入顺序（调用链要看顺序）", () => {
  const runId = `run_span_${randomUUID()}`;
  appendSpanTrace({ runId, at: 1000, kind: "llm", name: "m1", durationMs: 500, ok: true, tokens: 120 });
  appendSpanTrace({ runId, at: 1500, kind: "tool", name: "t1", durationMs: 80, ok: true });
  appendSpanTrace({ runId, at: 1580, kind: "tool", name: "t2", durationMs: 30, ok: false, error: "超时" });

  const spans = listSpanTraces(runId);
  expect(spans.map((s) => s.kind)).toEqual(["llm", "tool", "tool"]);
  expect(spans[0]?.name).toBe("m1");
  expect(spans[0]?.tokens).toBe(120);
  expect(spans[2]?.ok).toBe(false);
  expect(spans[2]?.error).toBe("超时");
});

test("不存在的 runId 返回空数组（不是报错）", () => {
  expect(listSpanTraces(`run_missing_${randomUUID()}`)).toEqual([]);
  expect(findRunTrace(`run_missing_${randomUUID()}`)).toBeUndefined();
  // 空 runId 不该去扫盘。
  expect(findRunTrace("")).toBeUndefined();
});

test("llm span 记录失败原因（保留错误文本，便于看是不是模型侧抖动）", () => {
  const runId = `run_span_${randomUUID()}`;
  const long = "x".repeat(500);
  appendSpanTrace({ runId, at: 1, kind: "llm", name: "m1", durationMs: 10, ok: false, error: long.slice(0, 200) });
  const span = listSpanTraces(runId)[0]!;
  expect(span.ok).toBe(false);
  expect((span.error || "").length).toBe(200);
});
