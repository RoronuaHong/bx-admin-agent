// trace 保留期清理（src/trace.ts §10 #8）：
// 落盘随运行量增长，需按 TRACE_RETENTION_DAYS（默认 30 天）回收过期 run / rounds / spans 文件。
// 用临时目录隔离，直接验证 cleanupTraceDir 的裁剪与孤立文件回收语义。
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
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
    expect(r).toEqual({ expiredRuns: 0, deletedFiles: 0, legacyFiles: 0 });
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
    // 两份保留的明细也设成「陈旧」，使它们只能靠 runId 在保留期内（trace.ts:361）存活；
    // 否则 mtime 兜底（:369）会静默保住它们，删掉 :361 用例照样绿，那道门就无断言覆盖。
    // （现实中 run 仅 1 天新、明细 mtime 却 60 天前不自然，属刻意构造以隔离 :361。）
    const past = new Date(Date.now() - 60 * DAY);
    utimesSync(join(dir, "rounds-keep.jsonl"), past, past);
    utimesSync(join(dir, "spans-keep.jsonl"), past, past);
    // 待删的两份设为「陈旧」（mtime 超保留期）才进入孤儿回收；
    // 保留的两份靠 runId 在保留期内保住，与 mtime 无关。
    utimesSync(join(dir, "rounds-expire.jsonl"), past, past);
    utimesSync(join(dir, "spans-expire.jsonl"), past, past);
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
    // 必须显式把孤儿文件设成「陈旧」：孤儿回收要求 mtime 已超保留期
    //（新加的 mtime 兜底是为了保护「在途运行」的明细——那份明细的 run 记录还没落盘，
    //  文件却很新，不能因为它此刻不在 runs- 里就删掉）。
    const past = new Date(Date.now() - 60 * DAY);
    utimesSync(join(dir, "rounds-orphan.jsonl"), past, past);
    utimesSync(join(dir, "spans-orphan.jsonl"), past, past);
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

test("旧格式遗留 <uuid>.jsonl：过期按 mtime 回收，在期的保留", () => {
  const dir = tmp();
  try {
    const old = join(dir, "00075f7f-6b98-4813-8fb2-d9bb247ac251.jsonl");
    const fresh = join(dir, "001ad457-3785-499e-9b1b-aac345061215.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    // 把 old 的 mtime 推到保留期之外（60 天前），fresh 保持当下。
    const past = new Date(Date.now() - 60 * DAY);
    utimesSync(old, past, past);
    const r = cleanupTraceDir(dir, 30 * DAY);
    expect(r.legacyFiles).toBe(1);
    expect(r.deletedFiles).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("在途运行的明细不被误删（run 记录要运行结束才落盘，mtime 兜底）", () => {
  const dir = tmp();
  try {
    // 模拟：明细文件刚写（在途），但 runs- 文件里还没有这条 run 记录。
    const inFlight = join(dir, "spans-run_inflight.jsonl");
    writeFileSync(inFlight, "{}\n");
    // 一个真正的孤儿：很久没动过。
    const stale = join(dir, "rounds-run_gone.jsonl");
    writeFileSync(stale, "{}\n");
    const past = new Date(Date.now() - 60 * DAY);
    utimesSync(stale, past, past);
    // 在途文件保持当前 mtime（不手动改）。
    const r = cleanupTraceDir(dir, 30 * DAY);
    // 在途：必须保留——否则会出现「runs 里能看到这条 run，但 spans 端点返回空」且原因不可见。
    expect(existsSync(inFlight)).toBe(true);
    // 真正过期的孤儿：照删。
    expect(existsSync(stale)).toBe(false);
    expect(r.deletedFiles).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("可解析但 at 缺失的行按「宁可留痕」保留，不静默删除", () => {
  const dir = tmp();
  try {
    const ym = `${new Date(now).getFullYear()}${String(new Date(now).getMonth() + 1).padStart(2, "0")}`;
    // 一条没有 at 字段的 run（年龄未知），一条明确过期的 run。
    writeFileSync(
      join(dir, `runs-${ym}.jsonl`),
      `${JSON.stringify({ runId: "no-at", status: "success", durationMs: 1 })}\n${runLine("old", now - 60 * DAY)}\n`,
    );
    const r = cleanupTraceDir(dir, 30 * DAY);
    // 年龄未知的行必须保留，且与不可解析行同一待遇。
    const content = readFileSync(join(dir, `runs-${ym}.jsonl`), "utf-8");
    expect(content).toContain("no-at");
    expect(content).not.toContain("old");
    expect(r.expiredRuns).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不匹配任何已知形态的文件一律不动（如 analytics 子系统的 standalone 文件）", () => {
  const dir = tmp();
  try {
    const keep = join(dir, "analytics-standalone.jsonl");
    const notes = join(dir, "notes.json");
    writeFileSync(keep, "{}\n");
    writeFileSync(notes, "{}\n");
    const past = new Date(Date.now() - 365 * DAY);
    utimesSync(keep, past, past);
    utimesSync(notes, past, past);
    const r = cleanupTraceDir(dir, 1 * DAY);
    expect(r.legacyFiles).toBe(0);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(notes)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
