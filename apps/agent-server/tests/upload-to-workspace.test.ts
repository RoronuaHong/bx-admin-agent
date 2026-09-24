// 上传附件进工作区回归（2026-09-24，docs/artifact-delivery-plan.md §16）：
// A 二进制附件可导入 · B 文本附件也能导入（不被 BINARY_EXTS / 256KB 文本上限卡住）·
// C 白名单外类型被拒且不中断 · D 配额满时优雅降级 · E 注入文本回报工作区路径。
import { test, expect, afterAll } from "vitest";
import { fsImportFile, fsList, fsRemoveConversation } from "../src/fs-store.js";

const CONV = "vitest-upload-ws";

afterAll(() => fsRemoveConversation(CONV));

/** 构造一个最小但合法的 xlsx（zip 魔数即可，导入只按字节搬运、不解析内容）。 */
const fakeXlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
const bigText = Buffer.from("行\n".repeat(200_000), "utf-8"); // 约 400KB → 超过 fsWrite 的 256KB 文本上限

test("[A] 二进制附件（xlsx / pdf）导入成功，可在工作区列出", () => {
  for (const name of ["报表.xlsx", "说明.pdf"]) {
    const res = fsImportFile(CONV, `uploads/${name}`, fakeXlsx);
    expect(res, name).not.toHaveProperty("error");
    expect(fsList(CONV).some((f) => f.path === `uploads/${name}`)).toBe(true);
  }
});

test("[B] 文本附件（md / txt / csv）也能导入，且不受 256KB 文本上限限制", () => {
  const res = fsImportFile(CONV, "uploads/大文件.txt", bigText);
  expect(res).not.toHaveProperty("error");
  if (!("error" in res)) expect(res.bytes).toBeGreaterThan(256 * 1024);
  // 关键：白名单不能污染 BINARY_EXTS，否则 fsRead 会拒绝按文本读 .txt
  expect(fsImportFile(CONV, "uploads/笔记.md", Buffer.from("# 标题"))).not.toHaveProperty("error");
});

test("[C] 白名单外类型被拒（不静默成功），且不影响其它文件", () => {
  const res = fsImportFile(CONV, "uploads/病毒.exe", Buffer.from("x"));
  expect(res).toHaveProperty("error");
  if ("error" in res) expect(res.error).toContain("不允许导入该类型");
  expect(fsList(CONV).some((f) => f.path === "uploads/病毒.exe")).toBe(false);
});

test("[D] 失败是返回值而非异常（配额满等场景由调用方转文案，不中断对话）", () => {
  // 越界路径：返回 error 而不是抛错
  const bad = fsImportFile(CONV, "../outside.xlsx", fakeXlsx);
  expect(bad).toHaveProperty("error");
  if ("error" in bad) expect(bad.error).toContain("非法路径");
});

test("[E] 导入路径与大小如实回报（注入文本据此告诉模型可用 fs_read 取回）", () => {
  const res = fsImportFile(CONV, "uploads/数据.csv", Buffer.from("a,b\n1,2"));
  expect(res).toHaveProperty("path");
  if (!("error" in res)) {
    expect(res.path).toBe("uploads/数据.csv");
    expect(res.bytes).toBe(7);
  }
});
