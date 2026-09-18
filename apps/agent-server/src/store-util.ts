// 共享存储工具：.data 目录锚定 + 原子写 JSON（临时文件 + rename，避免半写文件）。
// 各持久化模块（memory / session / mcp-config）共用，消除重复的 .data 路径拼装与原子写逻辑。
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 运行时数据目录（.data），各持久化文件以此为锚解析，避免按文件深度拼 `..` 的脆弱写法。 */
export const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".data");

/**
 * 原子写 JSON：先写临时文件再 rename（rename 在同文件系统上是原子操作，避免进程崩溃留下半写文件）。
 * 写入失败只告警不抛出，持久化失败不应阻断主流程。
 */
export function atomicWriteJson(
  path: string,
  data: unknown,
  opts: { pretty?: boolean; logLabel?: string } = {},
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, undefined, opts.pretty === false ? undefined : 2), "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[${opts.logLabel || "store"}] 写入失败：${String((err as Error)?.message || err)}`);
  }
}
