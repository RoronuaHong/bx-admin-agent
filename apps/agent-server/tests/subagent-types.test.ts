// 具名子代理类型契约（docs/agent/SUBAGENTS_DESIGN.md §4 / §6）。
//
// 锚定四件事：① 文件式定义的 frontmatter 解析与启动期校验（不合法就跳过，不静默生效）；
// ② 同名定义「内置 < 随代码发布 < 本地覆盖」的优先级；③ 未知 id fail-closed；
// ④ 类型级能力边界（工具 allow/deny、readonly 第二道闸）与父代理索引预算（只含 name+description）。
//
// 实现代码尚未合并时本文件会失败——这是有意的：测试是契约，源码要向契约靠拢，而不是反过来。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveToolRisk, subagentMayExecute } from "../src/risk.js";

// 每个用例用独立临时目录：vitest 多文件并行跑时，共用 AGENT_DATA_DIR 会与别的用例互删文件。
const prevSubagentDataDir = process.env.SUBAGENT_DATA_DIR;
let localDir = "";

/** 跨实现形态读取 SubagentSpec：身份字段可能是 id 或 name，正文可能是 prompt / body。 */
type SpecLike = {
  id?: string;
  name?: string;
  description?: string;
  prompt?: string;
  body?: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  readonly?: boolean;
  maxTurns?: number;
};
const specId = (s: SpecLike) => s.id ?? s.name ?? "";
const specBody = (s: SpecLike) => s.prompt ?? s.body ?? s.systemPrompt ?? "";
const specTools = (s: SpecLike) => s.tools ?? [];

async function api() {
  return import("../src/subagents.js");
}

function writeLocal(fileId: string, content: string) {
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, `${fileId}.md`), content, "utf-8");
}

function specText(fields: {
  name: string;
  description: string;
  tools?: string;
  readonly?: boolean;
  maxTurns?: number;
  body: string;
}): string {
  return [
    "---",
    `name: ${fields.name}`,
    `description: ${fields.description}`,
    ...(fields.tools ? [`tools: ${fields.tools}`] : []),
    ...(fields.readonly !== undefined ? [`readonly: ${fields.readonly}`] : []),
    ...(fields.maxTurns !== undefined ? [`maxTurns: ${fields.maxTurns}`] : []),
    "---",
    "",
    fields.body,
    "",
  ].join("\n");
}

beforeEach(async () => {
  localDir = join(mkdtempSync(join(tmpdir(), "bx-subagent-types-")), "subagents");
  process.env.SUBAGENT_DATA_DIR = dirname(localDir);
  (await api()).invalidateSubagentCache();
});

afterEach(async () => {
  (await api()).invalidateSubagentCache();
  if (prevSubagentDataDir === undefined) delete process.env.SUBAGENT_DATA_DIR;
  else process.env.SUBAGENT_DATA_DIR = prevSubagentDataDir;
  rmSync(dirname(localDir), { recursive: true, force: true });
});

test("[A] frontmatter 解析：name/description/tools/readonly/maxTurns 与正文分离", async () => {
  writeLocal(
    "probe-a",
    specText({
      name: "probe-a",
      description: "本地探针：只用于验证 frontmatter 解析。",
      tools: "fs_read, web_search",
      readonly: true,
      maxTurns: 3,
      body: "PROBE_A_BODY_MARKER：这是正文，不该出现在路由索引里。",
    }),
  );
  const { getSubagentType, listSubagentTypes } = await api();
  const spec = getSubagentType("probe-a") as SpecLike | undefined;
  expect(spec, "本地定义应被加载").toBeDefined();
  expect(specId(spec!)).toBe("probe-a");
  expect(spec!.description).toContain("本地探针");
  expect(specTools(spec!)).toContain("fs_read");
  expect(specTools(spec!)).toContain("web_search");
  expect(spec!.readonly).toBe(true);
  expect(Number(spec!.maxTurns)).toBe(3);
  expect(specBody(spec!)).toContain("PROBE_A_BODY_MARKER");
  expect(listSubagentTypes().some((s) => specId(s as SpecLike) === "probe-a")).toBe(true);
});

test("[B] 启动期校验：文件名/name 不一致、非法 name、缺 description、空正文一律跳过（fail-closed）", async () => {
  writeLocal(
    "mismatch",
    specText({ name: "another-name", description: "文件名与 name 不一致。", body: "不该生效。" }),
  );
  writeLocal(
    "Bad_Name",
    specText({ name: "Bad_Name", description: "name 含大写和下划线。", body: "不该生效。" }),
  );
  writeLocal("no-desc", "---\nname: no-desc\n---\n\n缺 description。\n");
  writeLocal("empty-body", "---\nname: empty-body\ndescription: 正文是空的。\n---\n\n");
  const { getSubagentType, listSubagentTypes, subagentIndexText } = await api();
  for (const id of ["mismatch", "Bad_Name", "no-desc", "empty-body"]) {
    expect(getSubagentType(id), `${id} 应被跳过`).toBeUndefined();
    expect(listSubagentTypes().some((s) => specId(s as SpecLike) === id), `${id} 不该进列表`).toBe(false);
    expect(subagentIndexText(), `${id} 不该进索引`).not.toContain(id);
  }
});

test("[C] 优先级覆盖：本地同名定义覆盖内置，列表里同名只保留一份", async () => {
  writeLocal(
    "general-purpose",
    specText({
      name: "general-purpose",
      description: "LOCAL_OVERRIDE_DESCRIPTION：本地覆盖内置同名定义。",
      body: "LOCAL_OVERRIDE_BODY_MARKER",
    }),
  );
  const { GENERAL_PURPOSE_ID, getSubagentType, listSubagentTypes } = await api();
  const spec = getSubagentType(GENERAL_PURPOSE_ID) as SpecLike | undefined;
  expect(spec, "同名本地定义应覆盖内置定义").toBeDefined();
  expect(spec!.description).toContain("LOCAL_OVERRIDE_DESCRIPTION");
  expect(specBody(spec!)).toContain("LOCAL_OVERRIDE_BODY_MARKER");
  const matches = listSubagentTypes().filter((s) => specId(s as SpecLike) === GENERAL_PURPOSE_ID);
  expect(matches).toHaveLength(1);
});

test("[D] 未知类型 fail-closed：不查到、不进列表、不退化成 general-purpose", async () => {
  const { GENERAL_PURPOSE_ID, getSubagentType, listSubagentTypes, subagentIndexText } = await api();
  const unknown = "no-such-agent-type-xyz";
  expect(getSubagentType(unknown)).toBeUndefined();
  expect(listSubagentTypes().some((s) => specId(s as SpecLike) === unknown)).toBe(false);
  expect(subagentIndexText()).not.toContain(unknown);
  // 缺省类型必须存在，未知类型不得「回退」成它（由调用方显式选择，而不是加载器兜底）。
  expect(getSubagentType(GENERAL_PURPOSE_ID)).toBeDefined();
  expect(getSubagentType(unknown)).not.toBe(getSubagentType(GENERAL_PURPOSE_ID));
});

test("[E] 工具 allow/deny：联网型拿到 web 工具；readonly 类型即使声明 fs_write 也禁写", async () => {
  // 显式构造「types 里声明了 fs_write 且 readonly=true」的场景。
  // 旧用例拿 bi-explorer 断言，而它的 tools 本就不含 fs_write，const effectiveWrite 恒为 false → 断言恒真、从不真正校验。
  // 必须在首次 getSubagentType 触发缓存加载之前写好本地定义。
  writeLocal(
    "readonly-write-probe",
    specText({
      name: "readonly-write-probe",
      description: "只读探针：显式声明 fs_write 但 readonly=true，用于验证强制过滤。",
      tools: "fs_read, fs_write",
      readonly: true,
      body: "READONLY_WRITE_PROBE_BODY",
    }),
  );
  const { getSubagentType } = await api();
  const web = getSubagentType("web-researcher") as SpecLike | undefined;
  expect(web, "web-researcher 应随代码发布").toBeDefined();
  expect(specTools(web!)).toContain("web_search");
  expect(specTools(web!)).toContain("fetch_url");

  const spec = getSubagentType("readonly-write-probe") as SpecLike | undefined;
  expect(spec, "本地定义应被加载").toBeDefined();
  // 先把场景坐实：types 确实声明了 fs_write，且 readonly 确实为 true（否则下面的断言又成恒真）。
  expect(specTools(spec!), "探针必须在 tools 里声明 fs_write").toContain("fs_write");
  expect(spec!.readonly, "探针必须是 readonly").toBe(true);
  // 第二道闸（纯函数，非恒真）：readonly 下 fs_write 必被拒，fs_read 放行。
  // 若闸门被移除，resolveToolRisk("fs_write") 为 write/workspace → subagentMayExecute 会返回 true，此断言即红。
  expect(subagentMayExecute(resolveToolRisk("fs_write"), false, spec!.readonly)).toBe(false);
  expect(subagentMayExecute(resolveToolRisk("fs_read"), false, spec!.readonly)).toBe(true);
  // 第一道闸（chat.ts 按 readonly 从内置工具清单剥离 fs_write）由
  // subagent-status-contract.test.ts 的端到端用例断言子代理实际拿到的工具清单覆盖。
  const bi = getSubagentType("bi-explorer") as SpecLike | undefined;
  expect(bi, "bi-explorer 应随代码发布").toBeDefined();
  expect(bi!.readonly).toBe(true);
});

test("[F] readonly 第二道闸：连免确认的工作区写也拒绝，非只读子代理仍可写", () => {
  // 非只读子代理：工作区写照旧放行（P0-5 口径不变）。
  expect(subagentMayExecute(resolveToolRisk("fs_write"), false)).toBe(true);
  // readonly 子代理：工作区写也拒绝；只读仍放行。审计接线由 write-gate.test.ts 锚定。
  expect(subagentMayExecute(resolveToolRisk("fs_write"), false, true)).toBe(false);
  expect(subagentMayExecute(resolveToolRisk("fs_read"), false, true)).toBe(true);
  expect(subagentMayExecute(resolveToolRisk("fs_edit"), false, true)).toBe(false);
});

test("[G] 父代理索引预算：只含 name+description、不含正文、单条与总量都截断", async () => {
  writeLocal(
    "aa-probe-long",
    specText({
      name: "aa-probe-long",
      description: "L".repeat(600),
      body: "INDEX_BODY_MARKER：正文绝不能进路由索引。",
    }),
  );
  // 再造 10 个长描述类型，把总量顶过默认 4000 字符预算。
  for (let i = 0; i < 10; i += 1) {
    writeLocal(
      `zz-filler-${i}`,
      specText({ name: `zz-filler-${i}`, description: `F${i}`.repeat(200), body: "FILLER_BODY_MARKER" }),
    );
  }
  const { subagentIndexText } = await api();
  const index = subagentIndexText();
  expect(index).toContain("aa-probe-long");
  expect(index).not.toContain("INDEX_BODY_MARKER");
  expect(index).not.toContain("FILLER_BODY_MARKER");
  // 单条 description 上限 500：不得出现 501 个连续 L。
  expect(index).not.toContain("L".repeat(501));
  // 总量上限 SUBAGENT_INDEX_CHARS（默认 4000）：溢出按名排序截断，不是无限增长。
  expect(index.length).toBeLessThanOrEqual(4000);
  expect(index).toMatch(/还有\s*\d+\s*个类型未列出/);
});
