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

export interface SkillMeta {
  name: string;
  description: string;
  /** 相对 skills 根目录的目录名（read_skill 的入参）。 */
  dir: string;
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

/** 列出可用 skills（带短缓存，避免每次请求都扫盘）。 */
function listSkills(): SkillMeta[] {
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
        });
      }
    }
  } catch {
    /* 读不到就当没有 skills */
  }
  cache = { at: Date.now(), skills };
  return skills;
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

/** 渲染进系统提示的索引段；没有 skills 时返回空串。 */
export function renderSkillIndex(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  const lines = skills.map((skill) => `- ${skill.dir}${skill.description ? `：${skill.description}` : ""}`);
  return [
    "以下是可以按需加载的技能（skills）。任务命中时调用 read_skill 工具取全文，再按其中步骤执行：",
    ...lines,
  ].join("\n");
}
