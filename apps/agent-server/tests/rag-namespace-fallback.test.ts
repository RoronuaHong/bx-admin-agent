// KB 命名空间回落（客服助手完工项）：读路径（search / listSources）在「角色专属语料为空」时
// 回落公共语料 generic；写路径（sourceHashes）不回落——否则 --namespace X 首次入库会被
// generic 的同源指纹跳过。隔离方向不破：generic 检索永不合并其它角色语料。
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest, search, listSources, sourceHashes, setRagDirForTest, resetCache } from "../src/rag/store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-ns-fallback-"));
setRagDirForTest(dir);
resetCache();

afterAll(() => {
  resetCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 直接写索引文件构造语料（绕过 embedding，纯词法检索即可验证）。 */
function writeDocs(docs: Array<{ id: string; source: string; title: string; text: string; namespace?: string }>): void {
  const idx = {
    updatedAt: Date.now(),
    docs: docs.map((d) => ({ ...d, updatedAt: Date.now() })),
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx), "utf8");
  resetCache(); // 强制下次读盘
}

const GENERIC_DOC = {
  id: "hr/attendance.md#0",
  source: "hr/attendance.md",
  title: "考勤制度",
  text: "员工上班迟到超过三十分钟的，按旷工半日处理，并影响当月全勤奖金。",
};
const SUPPORT_DOC = {
  id: "support/refund.md#0",
  source: "support/refund.md",
  title: "退款流程",
  text: "用户申请退款需在收货后七天内发起，客服审核通过后原路退回，三个工作日内到账。",
};

describe("rag 命名空间回落（读路径回落、写路径不回落）", () => {
  it("[A] 角色专属语料为空 → search 回落 generic 公共语料（客服能查到公司文档）", async () => {
    writeDocs([GENERIC_DOC]);
    const hits = await search("迟到怎么处理", 5, "support");
    expect(hits.length).toBe(1);
    expect(hits[0]!.source).toBe("hr/attendance.md");
  });

  it("[B] 角色入库专属语料后 → 停用回落，只搜专属语料（不与 generic 合并）", async () => {
    writeDocs([GENERIC_DOC, { ...SUPPORT_DOC, namespace: "support" }]);
    const hits = await search("退款几天到账", 5, "support");
    expect(hits.length).toBe(1);
    expect(hits[0]!.source).toBe("support/refund.md");
  });

  it("[C] generic 检索不合并其它角色语料（隔离方向不破）", async () => {
    writeDocs([GENERIC_DOC, { ...SUPPORT_DOC, namespace: "support" }]);
    const hits = await search("退款几天到账", 5, "generic");
    expect(hits).toEqual([]);
  });

  it("[D] listSources 同样回落：专属为空列公共库，入库后只列专属", async () => {
    writeDocs([GENERIC_DOC]);
    expect(listSources("support").map((s) => s.source)).toEqual(["hr/attendance.md"]);
    writeDocs([GENERIC_DOC, { ...SUPPORT_DOC, namespace: "support" }]);
    expect(listSources("support").map((s) => s.source)).toEqual(["support/refund.md"]);
  });

  it("[E] sourceHashes 不回落：专属为空时不得借 generic 指纹跳过首次入库", () => {
    writeDocs([GENERIC_DOC]);
    expect(sourceHashes("support").size).toBe(0);
    // ingest 走写路径：namespace 参数原样落盘（不写 generic）
  });

  it("[F] ingest 落盘 namespace 原样（写路径不受回落影响）", async () => {
    const n = await ingest([{ id: "x.md", title: "T", source: "x.md", text: "内容一", hash: "h1", namespace: "support" }]);
    expect(n).toBe(1);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    const doc = raw.docs.find((d: { id: string }) => d.id === "x.md#0");
    expect(doc.namespace).toBe("support");
    // 历史未打 namespace 字段的文档归 generic：由 matchesNamespace 的向后兼容分支承担（[A] 隐式覆盖）
  });
});
