// Skills（渐进式加载）：
// 内置目录 `apps/agent-server/skills/<name>/SKILL.md` 只读；
// 本地目录 `.data/skills/<name>/SKILL.md` 由管理页写入。
// 启动只把「索引」（名称 + 描述）注入系统提示；命中时 read_skill 取全文。
// 全局开关在 `.data/skills-state.json`，不改 SKILL.md。关掉的技能不进索引。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { DATA_DIR } from "./store-util.js";
import { hasRole } from "./roles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = resolve(__dirname, "..", "skills");
const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 256 * 1024;
const BODY_LINE_HINT = 500;

/**
 * 勾选注入的技能全文总字符上限（动态段必须有硬上限）。
 * 用户可勾选多个技能，全文累加（单个 SKILL.md 动辄数千字）会挤占历史与工具结果预算；
 * 超出后不再注入后续技能，并在末尾注明（不静默丢内容）。
 */
const ENABLED_SKILLS_INJECT_CHARS = Number(process.env.SKILLS_INJECT_CHARS || 12_000);

const DIR_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface SkillMeta {
  name: string;
  description: string;
  /** 相对 skills 根目录的目录名（read_skill 的入参）。 */
  dir: string;
  /** 可见角色（frontmatter `roles: movie, generic` 逗号分隔）；缺省 = 所有角色可见。 */
  roles?: string[];
  /**
   * 系统自带技能（frontmatter `default: true`）：**不在「技能」面板的勾选列表里显示**。
   *
   * 面板的语义是「用户为本对话额外指定、全文注入」；系统自带技能本来就随索引生效、
   * 不需要用户勾选，列进面板只会让人误以为必须先勾一次才好用。
   *
   * ⚠️ 这个标记**只影响展示**：它的加载路径与其它技能完全一致（索引常驻 + 命中时 read_skill 取全文）。
   * 想「不显示」时不要顺手把它从索引、read_skill 或 skills 目录里去掉——那是在删功能。
   * 本地技能一律不当成 default，避免一份上传文件把自己从面板藏掉。
   */
  default?: boolean;
  /** 系统自带或本地添加。面板只允许移除本地技能。 */
  source?: "builtin" | "local";
}

export interface SkillCatalogItem extends SkillMeta {
  source: "builtin" | "local";
  /** 全局开关。关掉后不进索引、read_skill 当不存在、对话勾选也不接受。文件还在。 */
  enabled: boolean;
  bytes: number;
}

export type SkillWriteResult =
  | { ok: true; skill: SkillCatalogItem; warning?: string }
  | { ok: false; status: number; code: string; error: string };

interface DiskSkill {
  name: string;
  description: string;
  dir: string;
  roles?: string[];
  default?: boolean;
  source: "builtin" | "local";
  bytes: number;
}

interface Cache {
  at: number;
  skills: DiskSkill[];
}

let cache: Cache | null = null;
const CACHE_TTL_MS = 30_000;

/** 技能数据目录。生产与 AGENT_DATA_DIR / .data 对齐。
 *  单测用 SKILL_DATA_DIR，避免改 AGENT_DATA_DIR 把同进程里其它模块的数据目录一起换掉。 */
function runtimeDataDir(): string {
  const skillOverride = process.env.SKILL_DATA_DIR;
  if (skillOverride && skillOverride.trim()) return resolve(skillOverride);
  const override = process.env.AGENT_DATA_DIR;
  if (override && override.trim()) return resolve(override);
  return DATA_DIR;
}

export function localSkillsRoot(): string {
  return join(runtimeDataDir(), "skills");
}

function statePath(): string {
  return join(runtimeDataDir(), "skills-state.json");
}

export function invalidateSkillCache(): void {
  cache = null;
}

/** 解析 SKILL.md 头部 frontmatter（--- 包裹的 `key: value` 行）。 */
function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function bodyAfterFrontmatter(raw: string): string | null {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = text.slice(end + 4);
  return after.replace(/^\r?\n/, "");
}

function splitRoles(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const roles = raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return roles.length ? roles : undefined;
}

function safeDir(dir: string): string | null {
  const name = String(dir || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return name;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function loadDisabled(): Set<string> {
  try {
    if (!existsSync(statePath())) return new Set();
    const parsed = JSON.parse(readFileSync(statePath(), "utf-8")) as { disabled?: unknown };
    if (!Array.isArray(parsed.disabled)) return new Set();
    return new Set(parsed.disabled.filter((x): x is string => typeof x === "string" && Boolean(x)));
  } catch {
    return new Set();
  }
}

function saveDisabled(disabled: Set<string>): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ disabled: [...disabled].sort() }, undefined, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function scanRoot(root: string, source: "builtin" | "local"): DiskSkill[] {
  if (!existsSync(root)) return [];
  let rootReal: string;
  try {
    if (lstatSync(root).isSymbolicLink()) return [];
    rootReal = realpathSync(root);
  } catch {
    return [];
  }
  const skills: DiskSkill[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  for (const dir of names) {
    if (!safeDir(dir)) continue;
    const folder = join(root, dir);
    const file = join(folder, SKILL_FILE);
    try {
      const folderStat = lstatSync(folder);
      if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) continue;
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) continue;
      const real = realpathSync(file);
      if (!isInside(rootReal, real)) continue;
      const raw = readFileSync(real, "utf-8");
      const meta = parseFrontmatter(raw);
      const bytes = statSync(real).size;
      skills.push({
        name: meta.name || dir,
        description: meta.description || "",
        dir,
        ...(splitRoles(meta.roles) ? { roles: splitRoles(meta.roles) } : {}),
        ...(source === "builtin" && meta.default === "true" ? { default: true } : {}),
        source,
        bytes,
      });
    } catch {
      /* 单份坏文件不影响其余技能 */
    }
  }
  skills.sort((a, b) => a.dir.localeCompare(b.dir));
  return skills;
}

function listDiskSkills(): DiskSkill[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  const builtin = scanRoot(SKILLS_DIR, "builtin");
  const taken = new Set(builtin.map((s) => s.dir));
  const local = scanRoot(localSkillsRoot(), "local").filter((s) => !taken.has(s.dir));
  const skills = [...builtin, ...local];
  cache = { at: Date.now(), skills };
  return skills;
}

/** 管理页用：含已全局关闭的技能。本地与内置同名时只保留内置。 */
export function listSkillCatalog(): SkillCatalogItem[] {
  const disabled = loadDisabled();
  return listDiskSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    dir: skill.dir,
    ...(skill.roles ? { roles: skill.roles } : {}),
    ...(skill.default ? { default: true } : {}),
    source: skill.source,
    enabled: !disabled.has(skill.dir),
    bytes: skill.bytes,
  }));
}

function matchesRole(skill: { roles?: string[] }, role?: string | null): boolean {
  const r = String(role || "").trim();
  if (!r || r === "generic") return !skill.roles?.length || skill.roles.includes("generic");
  return !skill.roles?.length || skill.roles.includes(r);
}

/** 列出当前生效的 skills（全局开着）。传 `role` 时按角色过滤（缺省 roles = 全角色可见）。 */
export function listSkillMetas(role?: string | null): SkillMeta[] {
  return listSkillCatalog()
    .filter((skill) => skill.enabled && matchesRole(skill, role))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      dir: skill.dir,
      ...(skill.roles ? { roles: skill.roles } : {}),
      ...(skill.default ? { default: true } : {}),
      source: skill.source,
    }));
}

/** 全局开着的目录名，不按角色收窄。对话勾选校验用这份，避免电影技能被通用过滤丢掉。 */
export function listEnabledSkillDirs(): string[] {
  return listSkillCatalog().filter((skill) => skill.enabled).map((skill) => skill.dir);
}

/**
 * 「技能」面板**可勾选**的技能：系统自带技能（`default: true`）不在其列，全局关闭的也不在。
 */
export function listSelectableSkillMetas(role?: string | null): SkillMeta[] {
  return listSkillMetas(role).filter((s) => !s.default);
}

function locateSkillFile(dir: string): { item: SkillCatalogItem; file: string } | null {
  const name = safeDir(dir);
  if (!name) return null;
  const item = listSkillCatalog().find((skill) => skill.dir === name);
  if (!item) return null;
  const root = item.source === "builtin" ? SKILLS_DIR : localSkillsRoot();
  const file = join(root, name, SKILL_FILE);
  try {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return null;
    const rootReal = realpathSync(root);
    const real = realpathSync(file);
    if (!isInside(rootReal, real)) return null;
    return { item, file: real };
  } catch {
    return null;
  }
}

/** 读取某个 skill 的全文。全局关闭、路径不合法、文件不在时返回 null。 */
export function readSkill(dir: string): string | null {
  const found = locateSkillFile(dir);
  if (!found || !found.item.enabled) return null;
  try {
    return readFileSync(found.file, "utf-8");
  } catch {
    return null;
  }
}

/** 管理页预览：关闭的技能也能看全文。 */
export function readSkillDocument(dir: string): { skill: SkillCatalogItem; content: string; body: string } | null {
  const found = locateSkillFile(dir);
  if (!found) return null;
  try {
    const content = readFileSync(found.file, "utf-8");
    const body = bodyAfterFrontmatter(content) ?? content;
    return { skill: found.item, content, body };
  } catch {
    return null;
  }
}

function validateDir(dir: string): SkillWriteResult | null {
  const name = String(dir || "").trim();
  if (!DIR_RE.test(name)) {
    return { ok: false, status: 400, code: "SKILL_DIR_INVALID", error: "目录名只能用小写字母、数字和连字符，1–64 位，且不能以连字符开头或结尾" };
  }
  return null;
}

function validateFields(input: { name?: string; description?: string; roles?: string[]; body?: string }): SkillWriteResult | null {
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const body = String(input.body ?? "");
  if (!name || name.length > 80 || /[\r\n]/.test(name)) {
    return { ok: false, status: 400, code: "SKILL_NAME_INVALID", error: "显示名必填，1–80 字，不能换行" };
  }
  if (!description || description.length > 1024 || /[\r\n]/.test(description)) {
    return { ok: false, status: 400, code: "SKILL_DESCRIPTION_INVALID", error: "描述必填，1–1024 字，不能换行。描述要同时写清做什么、什么时候用" };
  }
  if (!body.trim()) {
    return { ok: false, status: 400, code: "SKILL_BODY_INVALID", error: "正文不能为空" };
  }
  const roles = (input.roles || []).map((role) => String(role || "").trim()).filter(Boolean);
  for (const role of roles) {
    if (!hasRole(role)) {
      return { ok: false, status: 400, code: "SKILL_ROLE_INVALID", error: `未知角色：${role}` };
    }
  }
  return null;
}

/** 去除正文中可能残留的头部 frontmatter（客户端把整份 SKILL.md 当正文传、或粘贴了带 --- 的开头时）。
 *  没有 frontmatter 时原样返回，幂等——与上传路径 importLocalSkillText 行为保持一致。 */
function stripLeadingFrontmatter(raw: string): string {
  return bodyAfterFrontmatter(raw) ?? raw;
}

function composeSkillFile(input: { name: string; description: string; roles?: string[]; body: string }): string {
  const roles = (input.roles || []).map((role) => role.trim()).filter(Boolean);
  const body = stripLeadingFrontmatter(input.body).replace(/^\uFEFF/, "").replace(/^\r?\n/, "");
  const lines = [
    "---",
    `name: ${input.name.trim()}`,
    `description: ${input.description.trim()}`,
    ...(roles.length ? [`roles: ${roles.join(", ")}`] : []),
    "---",
    "",
    body,
  ];
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function bodyWarning(body: string): string | undefined {
  const lines = body.split(/\r?\n/).length;
  if (lines > BODY_LINE_HINT) return "建议把细节拆出去";
  return undefined;
}

function writeLocalFile(dir: string, content: string): SkillWriteResult | null {
  if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_BYTES) {
    return { ok: false, status: 400, code: "SKILL_TOO_LARGE", error: "技能文件不能超过 256 KiB" };
  }
  const root = localSkillsRoot();
  const folder = join(root, dir);
  mkdirSync(root, { recursive: true });
  if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) {
    return { ok: false, status: 400, code: "SKILL_LINK_REJECTED", error: "拒绝把技能写到符号链接上" };
  }
  mkdirSync(folder, { recursive: true });
  const target = join(folder, SKILL_FILE);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    return { ok: false, status: 400, code: "SKILL_LINK_REJECTED", error: "拒绝覆盖符号链接" };
  }
  const tmp = join(folder, `${SKILL_FILE}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
  invalidateSkillCache();
  return null;
}

function builtinDir(dir: string): boolean {
  return listDiskSkills().some((skill) => skill.source === "builtin" && skill.dir === dir);
}

function localDir(dir: string): boolean {
  return listDiskSkills().some((skill) => skill.source === "local" && skill.dir === dir);
}

export function createLocalSkill(input: {
  dir?: string;
  name?: string;
  description?: string;
  roles?: string[];
  body?: string;
}): SkillWriteResult {
  const dirError = validateDir(String(input.dir || ""));
  if (dirError) return dirError;
  const fieldError = validateFields(input);
  if (fieldError) return fieldError;
  const dir = String(input.dir).trim();
  if (builtinDir(dir)) {
    return { ok: false, status: 403, code: "SKILL_BUILTIN_READONLY", error: "不能覆盖系统自带技能" };
  }
  if (localDir(dir)) {
    return { ok: false, status: 409, code: "SKILL_EXISTS", error: "同名本地技能已存在" };
  }
  const content = composeSkillFile({
    name: String(input.name),
    description: String(input.description),
    roles: input.roles,
    body: String(input.body),
  });
  const writeError = writeLocalFile(dir, content);
  if (writeError) return writeError;
  const skill = listSkillCatalog().find((item) => item.dir === dir);
  if (!skill) return { ok: false, status: 500, code: "SKILL_WRITE_FAILED", error: "写入后没有读到技能" };
  const warning = bodyWarning(String(input.body));
  return warning ? { ok: true, skill, warning } : { ok: true, skill };
}

export function updateLocalSkill(
  dir: string,
  input: { name?: string; description?: string; roles?: string[]; body?: string },
): SkillWriteResult {
  const dirError = validateDir(dir);
  if (dirError) return dirError;
  const name = dir.trim();
  if (builtinDir(name)) {
    return { ok: false, status: 403, code: "SKILL_BUILTIN_READONLY", error: "系统自带技能不能编辑" };
  }
  if (!localDir(name)) {
    return { ok: false, status: 404, code: "SKILL_NOT_FOUND", error: "本地技能不存在" };
  }
  const fieldError = validateFields(input);
  if (fieldError) return fieldError;
  const content = composeSkillFile({
    name: String(input.name),
    description: String(input.description),
    roles: input.roles,
    body: String(input.body),
  });
  const writeError = writeLocalFile(name, content);
  if (writeError) return writeError;
  const skill = listSkillCatalog().find((item) => item.dir === name);
  if (!skill) return { ok: false, status: 500, code: "SKILL_WRITE_FAILED", error: "写入后没有读到技能" };
  const warning = bodyWarning(String(input.body));
  return warning ? { ok: true, skill, warning } : { ok: true, skill };
}

export function deleteLocalSkill(dir: string): SkillWriteResult | { ok: true } {
  const dirError = validateDir(dir);
  if (dirError) return dirError;
  const name = dir.trim();
  if (builtinDir(name)) {
    return { ok: false, status: 403, code: "SKILL_BUILTIN_READONLY", error: "系统自带技能不能删除" };
  }
  if (!localDir(name)) {
    return { ok: false, status: 404, code: "SKILL_NOT_FOUND", error: "本地技能不存在" };
  }
  const folder = join(localSkillsRoot(), name);
  if (lstatSync(folder).isSymbolicLink()) {
    return { ok: false, status: 400, code: "SKILL_LINK_REJECTED", error: "拒绝删除符号链接" };
  }
  rmSync(folder, { recursive: true, force: true });
  const disabled = loadDisabled();
  if (disabled.delete(name)) saveDisabled(disabled);
  invalidateSkillCache();
  return { ok: true };
}

export function setSkillEnabled(dir: string, enabled: boolean): SkillWriteResult {
  const name = safeDir(dir);
  if (!name || !listDiskSkills().some((skill) => skill.dir === name)) {
    return { ok: false, status: 404, code: "SKILL_NOT_FOUND", error: "技能不存在" };
  }
  const file = locateSkillFile(name);
  const before = file ? statSync(file.file).size : -1;
  const disabled = loadDisabled();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  saveDisabled(disabled);
  invalidateSkillCache();
  const skill = listSkillCatalog().find((item) => item.dir === name);
  if (!skill) return { ok: false, status: 500, code: "SKILL_WRITE_FAILED", error: "更新开关后没有读到技能" };
  if (before >= 0 && skill.bytes !== before) {
    return { ok: false, status: 500, code: "SKILL_MUTATED", error: "开关不应改动技能文件" };
  }
  return { ok: true, skill };
}

/** 从已有 SKILL.md 文本安装。服务端重写 frontmatter，丢掉 default。 */
export function importLocalSkillText(dir: string, raw: string): SkillWriteResult {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { ok: false, status: 400, code: "SKILL_FRONTMATTER_INVALID", error: "frontmatter 必须是文件开头 --- 包裹" };
  }
  const meta = parseFrontmatter(text);
  const body = bodyAfterFrontmatter(text);
  if (body == null || !meta.name || !meta.description) {
    return { ok: false, status: 400, code: "SKILL_FRONTMATTER_INVALID", error: "frontmatter 必须包含 name 和 description" };
  }
  return createLocalSkill({
    dir,
    name: meta.name,
    description: meta.description,
    roles: splitRoles(meta.roles),
    body,
  });
}

/**
 * 只接受根目录上唯一的 SKILL.md。多文件、子目录、路径穿越、加密包一律拒绝。
 * 调用方应先把整个 zip 限制在 256 KiB。
 */
export function extractSkillMdFromZip(buf: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    return { ok: false, error: "不是 zip 文件" };
  }
  const names: string[] = [];
  let text: string | null = null;
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (nameStart + nameLen > buf.length || dataStart + compSize > buf.length) {
      return { ok: false, error: "zip 结构不完整" };
    }
    const name = buf.slice(nameStart, nameStart + nameLen).toString("utf-8").replace(/\\/g, "/");
    if (flags & 0x1) return { ok: false, error: "不接受加密的 zip" };
    if (flags & 0x8) return { ok: false, error: "不接受带数据描述符的 zip" };
    if (!name || name.endsWith("/")) {
      return { ok: false, error: "zip 里只能有根目录的 SKILL.md" };
    }
    names.push(name);
    if (name !== SKILL_FILE || name.includes("/") || name.includes("..")) {
      return { ok: false, error: "zip 里只能有根目录的 SKILL.md，不能附带脚本或其他路径" };
    }
    if (uncompSize > MAX_SKILL_BYTES || compSize > MAX_SKILL_BYTES) {
      return { ok: false, error: "技能文件不能超过 256 KiB" };
    }
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    let raw: Buffer;
    if (method === 0) {
      raw = compressed;
    } else if (method === 8) {
      try {
        raw = inflateRawSync(compressed, { maxOutputLength: MAX_SKILL_BYTES });
      } catch {
        return { ok: false, error: "zip 解压失败" };
      }
    } else {
      return { ok: false, error: "只接受存储或 deflate 压缩" };
    }
    if (raw.length > MAX_SKILL_BYTES) return { ok: false, error: "技能文件不能超过 256 KiB" };
    text = raw.toString("utf-8");
    offset = dataStart + compSize;
  }
  if (names.length !== 1 || text == null) {
    return { ok: false, error: "zip 里只能有根目录的 SKILL.md" };
  }
  return { ok: true, text };
}

/** 渲染进系统提示的索引段（按角色过滤，不含全局关闭的技能）。 */
export function renderSkillIndex(role?: string | null): string {
  const skills = listSkillMetas(role);
  if (!skills.length) return "";
  const lines = skills.map((skill) => `- ${skill.dir}${skill.description ? `：${skill.description}` : ""}`);
  return [
    "以下是可以按需加载的技能（skills）。任务命中时调用 read_skill 工具取全文，再按其中步骤执行：",
    ...lines,
  ].join("\n");
}

/**
 * 渲染用户为本对话主动勾选的技能全文（输入框「技能」面板勾选语义）。
 * 注入系统提示的**动态后缀**（而非稳定前缀）：勾选是低频但非零变化的对话级设置，
 * 放动态段避免破坏 prompt cache 命中。已勾选的技能不再依赖 read_skill 按需加载。
 * 全局关闭的技能这里读不到，不会注入。
 */
export function renderEnabledSkills(dirs: string[] | null | undefined): string {
  if (!dirs?.length) return "";
  const blocks: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  let skipped = 0;
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir || seen.has(dir)) continue;
    seen.add(dir);
    const content = readSkill(dir);
    if (content == null) continue;
    const block = `<skill name="${dir}">\n${content}\n</skill>`;
    if (used + block.length > ENABLED_SKILLS_INJECT_CHARS) {
      skipped += 1;
      continue;
    }
    used += block.length;
    blocks.push(block);
  }
  if (!blocks.length) return "";
  const tail = skipped > 0 ? `\n…（另有 ${skipped} 个技能因超出注入上限未注入，必要时用 read_skill 按需读取）` : "";
  return [
    "以下是用户为本对话指定的技能全文，与本轮任务相关时**优先按其中步骤执行**：",
    ...blocks,
    tail,
  ]
    .filter((part) => part)
    .join("\n\n");
}
