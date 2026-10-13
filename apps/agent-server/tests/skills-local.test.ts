import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "vitest";

const prevDataDir = process.env.SKILL_DATA_DIR;
let dataDir = "";

async function api() {
  return import("../src/skills.js");
}

function zipStored(name: string, data: Buffer, method: 0 | 8 = 0): Buffer {
  const payload = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([local, nameBuf, payload]);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "bx-skills-"));
  process.env.SKILL_DATA_DIR = dataDir;
  const { invalidateSkillCache } = await api();
  invalidateSkillCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.SKILL_DATA_DIR;
  else process.env.SKILL_DATA_DIR = prevDataDir;
  const { invalidateSkillCache } = await api();
  invalidateSkillCache();
  rmSync(dataDir, { recursive: true, force: true });
});

test("本地技能进入索引和可勾选列表，关闭后三处都没有，文件字节不变", async () => {
  const { createLocalSkill, listSelectableSkillMetas, listSkillMetas, readSkill, renderEnabledSkills, renderSkillIndex, setSkillEnabled } =
    await api();
  const created = createLocalSkill({
    dir: "weekly-report",
    name: "周报",
    description: "用户要写周报时按固定栏目整理，不要改成自由散文。",
    body: "先列本周完成，再列下周计划。",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const file = join(dataDir, "skills", "weekly-report", "SKILL.md");
  const before = statSync(file).size;
  expect(listSelectableSkillMetas("generic").some((skill) => skill.dir === "weekly-report" && skill.source === "local")).toBe(true);
  expect(renderSkillIndex("generic")).toContain("weekly-report");
  expect(readSkill("weekly-report")).toContain("先列本周完成");
  expect(renderEnabledSkills(["weekly-report"])).toContain("先列本周完成");

  const disabled = setSkillEnabled("weekly-report", false);
  expect(disabled.ok).toBe(true);
  expect(statSync(file).size).toBe(before);
  expect(readFileSync(file, "utf-8").length).toBeGreaterThan(0);
  expect(listSkillMetas("generic").some((skill) => skill.dir === "weekly-report")).toBe(false);
  expect(listSelectableSkillMetas("generic").some((skill) => skill.dir === "weekly-report")).toBe(false);
  expect(renderSkillIndex("generic")).not.toContain("weekly-report");
  expect(readSkill("weekly-report")).toBeNull();
  expect(renderEnabledSkills(["weekly-report"])).toBe("");

  const enabled = setSkillEnabled("weekly-report", true);
  expect(enabled.ok).toBe(true);
  expect(statSync(file).size).toBe(before);
  expect(readSkill("weekly-report")).toContain("先列本周完成");
});

test("正文里残留的 frontmatter 不会重复（客户端把整份 SKILL.md 当正文传也安全）", async () => {
  const { createLocalSkill, readSkillDocument } = await api();
  const created = createLocalSkill({
    dir: "full-md",
    name: "整份文件",
    description: "用户直接贴了完整 SKILL.md 当正文。",
    body: "---\nname: 旧名字\ndescription: 旧描述\n---\n\n先列本周完成，再列下周计划。\n",
  });
  expect(created.ok).toBe(true);
  const doc = readSkillDocument("full-md");
  expect(doc).toBeTruthy();
  // 正文里的旧 frontmatter 被剥离，不泄漏到正文。
  expect(doc!.body).toContain("先列本周完成");
  expect(doc!.body).not.toContain("旧名字");
  expect(doc!.body).not.toContain("旧描述");
  // 整份文件里只应有一组 frontmatter 键（服务端重新生成的那份）。
  expect((doc!.content.match(/^description:/m) || []).length).toBe(1);
});

test("不能覆盖或删除内置技能，也不能写入路径穿越", async () => {
  const { createLocalSkill, deleteLocalSkill, listSkillCatalog } = await api();
  expect(listSkillCatalog().filter((skill) => skill.source === "builtin").length).toBeGreaterThanOrEqual(8);
  const overwrite = createLocalSkill({
    dir: "pdf",
    name: "假 PDF",
    description: "不该写进去。",
    body: "no",
  });
  expect(overwrite.ok).toBe(false);
  if (!overwrite.ok) expect(overwrite.code).toBe("SKILL_BUILTIN_READONLY");
  const removed = deleteLocalSkill("pdf");
  expect(removed.ok).toBe(false);
  if (!removed.ok) expect(removed.code).toBe("SKILL_BUILTIN_READONLY");
  const escaped = createLocalSkill({
    dir: "../pdf",
    name: "越界",
    description: "不该写进去。",
    body: "no",
  });
  expect(escaped.ok).toBe(false);
});

test("观影角色只看到未限定角色的技能和写了 movie 的技能", async () => {
  const { createLocalSkill, listSelectableSkillMetas } = await api();
  createLocalSkill({
    dir: "movie-notes",
    name: "观影笔记",
    description: "整理观影笔记时使用。",
    roles: ["movie"],
    body: "只记录看过的片子。",
  });
  createLocalSkill({
    dir: "all-roles",
    name: "全部助手",
    description: "任何助手整理清单时使用。",
    body: "用短列表。",
  });
  const movie = listSelectableSkillMetas("movie").map((skill) => skill.dir);
  const generic = listSelectableSkillMetas("generic").map((skill) => skill.dir);
  expect(movie).toContain("movie-notes");
  expect(movie).toContain("all-roles");
  expect(generic).not.toContain("movie-notes");
  expect(generic).toContain("all-roles");
  expect(generic).toContain("pdf");
  expect(generic).not.toContain("web-research");
});

test("上传文本会丢掉 default，zip 只接受根目录的 SKILL.md", async () => {
  const { extractSkillMdFromZip, importLocalSkillText, listSelectableSkillMetas } = await api();
  const imported = importLocalSkillText(
    "from-file",
    "---\nname: 来自文件\ndescription: 用户上传了一份流程时按它执行。\ndefault: true\n---\n\n按文件里的步骤。\n",
  );
  expect(imported.ok).toBe(true);
  if (imported.ok) expect(imported.skill.default).toBeUndefined();
  expect(listSelectableSkillMetas("generic").some((skill) => skill.dir === "from-file")).toBe(true);

  const okZip = extractSkillMdFromZip(
    zipStored("SKILL.md", Buffer.from("---\nname: 压缩包\ndescription: 从 zip 安装时使用。\n---\n\n步骤\n")),
  );
  expect(okZip.ok).toBe(true);
  const nested = extractSkillMdFromZip(zipStored("docs/SKILL.md", Buffer.from("x")));
  expect(nested.ok).toBe(false);
  const scripts = extractSkillMdFromZip(
    Buffer.concat([
      zipStored("SKILL.md", Buffer.from("---\nname: a\ndescription: b\n---\n\nbody\n")),
      zipStored("scripts/run.sh", Buffer.from("echo hi")),
    ]),
  );
  expect(scripts.ok).toBe(false);
  const escape = extractSkillMdFromZip(zipStored("../SKILL.md", Buffer.from("no")));
  expect(escape.ok).toBe(false);
  const deflated = extractSkillMdFromZip(
    zipStored("SKILL.md", Buffer.from("---\nname: 压缩\ndescription: deflate 包。\n---\n\n正文\n"), 8),
  );
  expect(deflated.ok).toBe(true);
});
