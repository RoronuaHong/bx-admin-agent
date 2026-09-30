// 知识库权限过滤（§知识库 F15，src/rag/store.ts）：
// 命名空间只按**角色**隔离，回答不了「这份文档只给某些人看」。补一层文档级 ACL。
// 取向：缺省放行、显式收敛 —— 没写 ACL 的老文档照常可检索（不重建即丢数据），写了就必须命中。
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAll,
  ingest,
  listSources,
  resetCache,
  search,
  setRagDirForTest,
  visibleTo,
  type RagDoc,
} from "../src/rag/store.js";
import { extractAclFromFrontmatter } from "../src/rag/parsers.js";

let dir = "";
const OWNER_A = "country_a:alice";
const OWNER_B = "country_b:bob";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rag-acl-"));
  setRagDirForTest(dir);
  resetCache();
  clearAll();
});

afterEach(() => {
  resetCache();
  rmSync(dir, { recursive: true, force: true });
});

test("visibleTo：缺省放行，显式 ACL 必须命中，两维是「与」关系", () => {
  expect(visibleTo({ id: "1", title: "t", source: "s", text: "x", updatedAt: 1 })).toBe(true);

  const byOwner = { id: "2", title: "t", source: "s", text: "x", updatedAt: 1, acl: { owners: [OWNER_A] } } as RagDoc;
  expect(visibleTo(byOwner, { ownerKey: OWNER_A })).toBe(true);
  expect(visibleTo(byOwner, { ownerKey: OWNER_B })).toBe(false);
  // 没有身份就是看不见（不是「猜一下给看」）。
  expect(visibleTo(byOwner)).toBe(false);

  const byRole = { id: "3", title: "t", source: "s", text: "x", updatedAt: 1, acl: { roles: ["support"] } } as RagDoc;
  expect(visibleTo(byRole, { role: "support" })).toBe(true);
  expect(visibleTo(byRole, { role: "movie" })).toBe(false);

  const both = {
    id: "4",
    title: "t",
    source: "s",
    text: "x",
    updatedAt: 1,
    acl: { owners: [OWNER_A], roles: ["support"] },
  } as RagDoc;
  expect(visibleTo(both, { ownerKey: OWNER_A, role: "support" })).toBe(true);
  expect(visibleTo(both, { ownerKey: OWNER_A, role: "movie" })).toBe(false);
  expect(visibleTo(both, { ownerKey: OWNER_B, role: "support" })).toBe(false);

  // 空数组 = 没写这一维，不该把文档锁死。
  expect(visibleTo({ id: "5", title: "t", source: "s", text: "x", updatedAt: 1, acl: { owners: [] } } as RagDoc)).toBe(
    true,
  );
});

test("检索：不可见的文档不进召回（也不该影响排序）", async () => {
  await ingest([
    { id: "pub", title: "公开制度", source: "public.md", text: "考勤制度适用于全体员工" },
    {
      id: "sec",
      title: "受限薪酬",
      source: "secret.md",
      text: "考勤制度相关的薪酬细则仅内部可见",
      acl: { owners: [OWNER_A] },
    },
  ]);

  const asA = await search("考勤制度", 5, "generic", { ownerKey: OWNER_A, role: "generic" });
  expect(asA.length).toBe(2);

  const asB = await search("考勤制度", 5, "generic", { ownerKey: OWNER_B, role: "generic" });
  expect(asB.length).toBe(1);
  expect(asB[0]?.source).toBe("public.md");

  // 不带 viewer（老调用方）→ 受限文档不可见：缺省放行只对「没写 ACL」的文档成立。
  const anon = await search("考勤制度", 5, "generic");
  expect(anon.length).toBe(1);
});

test("列来源同样过滤：不能通过 knowledge_sources 侧漏受限文档的存在", async () => {
  await ingest([
    { id: "pub", title: "公开", source: "public.md", text: "内容" },
    { id: "sec", title: "受限", source: "secret.md", text: "内容", acl: { roles: ["support"] } },
  ]);
  expect(listSources("generic", { role: "support" }).map((s) => s.source).sort()).toEqual(["public.md", "secret.md"]);
  expect(listSources("generic", { role: "movie" }).map((s) => s.source)).toEqual(["public.md"]);
});

test("入库保留 ACL：同 id 覆盖后权限仍然生效", async () => {
  await ingest([{ id: "d", title: "t", source: "s.md", text: "第一版", acl: { owners: [OWNER_A] } }]);
  await ingest([{ id: "d", title: "t", source: "s.md", text: "第二版", acl: { owners: [OWNER_A] } }]);
  const hits = await search("第二版", 5, "generic", { ownerKey: OWNER_A });
  expect(hits.length).toBe(1);
  expect(await search("第二版", 5, "generic", { ownerKey: OWNER_B })).toEqual([]);
});

test("extractAclFromFrontmatter：文档自带权限声明解析", () => {
  const withAcl = `---
title: 内部薪酬制度
acl:
  owners:
    - country_a:alice
    - country_a:carol
  roles:
    - support
---

# 正文
内部薪酬计算细则...`;
  expect(extractAclFromFrontmatter(withAcl)).toEqual({
    owners: ["country_a:alice", "country_a:carol"],
    roles: ["support"],
  });

  // 无 acl 段 → undefined（公开）。
  expect(extractAclFromFrontmatter("---\ntitle: x\n---\n正文")).toBeUndefined();
  // 无 frontmatter → undefined。
  expect(extractAclFromFrontmatter("# 正文\n没有 frontmatter")).toBeUndefined();
  // 有 acl 但两维都空 → undefined（不锁死文档）。
  expect(extractAclFromFrontmatter("---\nacl:\n  owners: []\n---\n正文")).toBeUndefined();
  // 注释行被忽略，仍收集到有效条目。
  expect(extractAclFromFrontmatter("---\nacl:\n  roles:\n    # 暂未指定\n    - support\n---\nx").roles).toEqual([
    "support",
  ]);
});

test("入库闭环：frontmatter 声明 ACL 经解析后生效", async () => {
  const raw = `---
acl:
  owners:
    - ${OWNER_A}
---
内容：仅 A 可见的薪酬细则`;
  const acl = extractAclFromFrontmatter(raw)!;
  await ingest([{ id: "d", title: "t", source: "s.md", text: "内容：仅 A 可见的薪酬细则", acl }]);
  expect((await search("薪酬细则", 5, "generic", { ownerKey: OWNER_A })).length).toBe(1);
  expect(await search("薪酬细则", 5, "generic", { ownerKey: OWNER_B })).toEqual([]);
});
