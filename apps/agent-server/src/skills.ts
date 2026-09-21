// Skills（渐进式加载，对齐 Deep Agents 的 Skills 能力）：
// 目录约定 `apps/agent-server/skills/<name>/SKILL.md`，frontmatter 提供 name/description。
// 启动只把「索引」（名称 + 描述）注入系统提示；命中任务需要时由模型调 read_skill 取全文，
// 避免把所有 skill 全文塞进上下文（官方口径：reads SKILL.md frontmatter at startup, then
// reads full skill content only when a task needs it）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = resolve(__dirname, "..", "skills");
const SKILL_FILE = "SKILL.md";

/**
 * 勾选注入的技能全文总字符上限（动态段必须有硬上限）。
 * 用户可勾选多个技能，全文累加（单个 SKILL.md 动辄数千字）会挤占历史与工具结果预算；
 * 超出后不再注入后续技能，并在末尾注明（不静默丢内容）。
 */
const ENABLED_SKILLS_INJECT_CHARS = Number(process.env.SKILLS_INJECT_CHARS || 12_000);

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
   */
  default?: boolean;
}

interface Cache {
  at: number;
  skills: SkillMeta[];
}

let cache: Cache | null = null;
const CACHE_TTL_MS = 30_000;

/** 解析 SKILL.md 头部 frontmatter（--- 包裹的 `key: value` 行）。 */
function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith("---")) return out;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of raw.slice(3, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 列出可用 skills（带短缓存，避免每次请求都扫盘）。传 `role` 时按角色过滤（缺省 roles = 全角色可见）。 */
export function listSkillMetas(role?: string | null): SkillMeta[] {
  const all = listAllSkillMetas();
  const r = String(role || "").trim();
  if (!r || r === "generic") {
    return all.filter((s) => !s.roles?.length || s.roles.includes("generic"));
  }
  return all.filter((s) => !s.roles?.length || s.roles.includes(r));
}

function listAllSkillMetas(): SkillMeta[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  const skills: SkillMeta[] = [];
  try {
    if (existsSync(SKILLS_DIR)) {
      for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(SKILLS_DIR, entry.name, SKILL_FILE);
        if (!existsSync(file)) continue;
        const meta = parseFrontmatter(readFileSync(file, "utf-8"));
        skills.push({
          name: meta.name || entry.name,
          description: meta.description || "",
          dir: entry.name,
          ...(meta.roles ? { roles: meta.roles.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } : {}),
          ...(meta.default === "true" ? { default: true } : {}),
        });
      }
    }
  } catch {
    /* 读不到就当没有 skills */
  }
  cache = { at: Date.now(), skills };
  return skills;
}

/**
 * 「技能」面板**可勾选**的技能：系统自带技能（`default: true`）不在其列。
 *
 * 这一层只影响**展示**：面板的语义是「用户为本对话额外指定、全文注入」，
 * 而系统自带技能本来就随索引生效、不需要用户勾选，列出来只会让人以为必须勾一次。
 * 注意**不要**顺手把它们从索引或加载路径里摘掉——那等于删功能。
 */
export function listSelectableSkillMetas(role?: string | null): SkillMeta[] {
  return listSkillMetas(role).filter((s) => !s.default);
}

/** 读取某个 skill 的全文（路径安全：只允许一级目录名）。 */
export function readSkill(dir: string): string | null {
  const name = String(dir || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const file = join(SKILLS_DIR, name, SKILL_FILE);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** 渲染进系统提示的索引段（按角色过滤）；没有 skills 时返回空串。 */
export function renderSkillIndex(role?: string | null): string {
  // 用**全量**清单（含 `default: true` 的系统自带技能）：隐藏只在面板那一层，
  // 索引照旧常驻，模型命中任务时仍能 read_skill 取全文——少一个技能在这里，就等于少一项能力。
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
    if (content == null) continue; // 目录已删除等：跳过，不编造
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
