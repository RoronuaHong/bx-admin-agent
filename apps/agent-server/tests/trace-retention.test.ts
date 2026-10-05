// trace 保留期清理（src/trace.ts §10 #8）：
// 落盘随运行量增长，需按 TRACE_RETENTION_DAYS（默认 30 天）回收过期 run / rounds / spans 文件。
// 用临时目录隔离，直接验证 cleanupTraceDir 的裁剪与孤立文件回收语义。
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTraceDir, getTraceRetentionMs } from "../src/trace.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "trace-ret-"));
}

function runLine(runId: string, at: number): string {
  return JSON.stringify({ runId, at, status: "success", durationMs: 1 });
}

test("保留期关闭（<=0）时不清理", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "runs-202001.jsonl"), runLine("r1", 1) + "\n");
    const r = cleanupTraceDir(dir, 0);
    expect(r).toEqual({ expiredRuns: 0, deletedFiles: 0 });
    expect(existsSync(join(dir, "runs-202001.jsonl"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("整月早于保留期起点的 runs 文件被整体删除（不逐条统计）", () => {
  const dir = tmp();
  try {
    // 当前月与两个旧月：保留期 1 天 → 远月整文件删。
    writeFileSync(join(dir, "runs-202001.jsonl"), runLine("old", now - 365 * DAY) + "\n");
    const r = cleanupTraceDir(dir, 1 * DAY);
    expect(r.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, "runs-202001.jsonl"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("保留期内月度文件逐行裁剪：过期 run 删除、在期 run 保留", () => {
  const dir = tmp();
  try {
    const ym = `${new Date(now).getFullYear()}${String(new Date(now).getMonth() + 1).padStart(2, "0")}`;
    const keep = runLine("keep", now - 1 * DAY);
    const expire = runLine("expire", now - 60 * DAY);
    writeFileSync(join(dir, `runs-${ym}.jsonl`), `${keep}\n${expire}\n`);
    // 无孤立 rounds/spans，仅验证裁剪。
    const r = cleanupTraceDir(dir, 30 * DAY);
    expect(r.expiredRuns).toBe(1);
    const content = readFileSync(join(dir, `runs-${ym}.jsonl`), "utf-8");
    expect(content).toContain("keep");
    expect(content).not.toContain("expire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("过期的 rounds/spans 文件被回收，在期的保留", () => {
  const dir = tmp();
  try {
    const ym = `${new Date(now).getFullYear()}${String(new Date(now).getMonth() + 1).padStart(2, "0")}`;
    // keep 在保留期内 → activeRunIds 含 keep；expire 过期 → 其 rounds/spans 应被删。
    writeFileSync(join(dir, `runs-${ym}.jsonl`), `${runLine("keep", now - 1 * DAY)}\n${runLine("expire", now - 60 * DAY)}\n`);
    writeFileSync(join(dir, "rounds-keep.jsonl"), "{}");
    writeFileSync(join(dir, "spans-keep.jsonl"), "{}");
    writeFileSync(join(dir, "rounds-expire.jsonl"), "{}");
    writeFileSync(join(dir, "spans-expire.jsonl"), "{}");
    const r = cleanupTraceDir(dir, 30 * DAY);
    expect(r.expiredRuns).toBe(1);
    expect(existsSync(join(dir, "rounds-keep.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "spans-keep.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "rounds-expire.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "spans-expire.jsonl"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("孤儿 rounds/spans（无对应 run 记录）被回收", () => {
  const dir = tmp();
  try {
    const ym = `${new Date(now).getFullYear()}${String(new Date(now).getMonth() + 1).padStart(2, "0")}`;
    writeFileSync(join(dir, `runs-${ym}.jsonl`), runLine("live", now - 1 * DAY) + "\n");
    writeFileSync(join(dir, "rounds-orphan.jsonl"), "{}");
    writeFileSync(join(dir, "spans-orphan.jsonl"), "{}");
    const r = cleanupTraceDir(dir, 30 * DAY);
    expect(r.deletedFiles).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(dir, "rounds-orphan.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "spans-orphan.jsonl"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTraceRetentionMs：默认 30 天，环境变量按天覆盖，<=0 关闭", () => {
  const prev = process.env.TRACE_RETENTION_DAYS;
  try {
    delete process.env.TRACE_RETENTION_DAYS;
    expect(getTraceRetentionMs()).toBe(30 * DAY);
    process.env.TRACE_RETENTION_DAYS = "7";
    expect(getTraceRetentionMs()).toBe(7 * DAY);
    process.env.TRACE_RETENTION_DAYS = "0";
    expect(getTraceRetentionMs()).toBe(0);
  } finally {
    if (prev === undefined) delete process.env.TRACE_RETENTION_DAYS;
    else process.env.TRACE_RETENTION_DAYS = prev;
  }
});
