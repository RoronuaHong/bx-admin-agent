import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// 技能层：skills/<name>/SKILL.md（YAML frontmatter + Markdown 指南）。
// 按 description 关键词匹配用户消息，把命中技能的正文作为「技能指南」注入首轮 user 消息，
// 引导模型高效使用工具。遵循 SKILL.md 规范（name/description 必填，version 可选，渐进披露）。
//
// 多目录支持（Cursor skill 对齐）：
// - 运行时自有技能：apps/agent-server/skills/<name>/SKILL.md
// - Cursor 生态技能：<repo>/.cursor/skills/<name>/SKILL.md（单一来源，运行时直接读取，
//   避免复制副本导致漂移）。
//
// Cursor 架构对齐（2026-08-22）：
// - Rules（.cursor/rules/*.mdc，alwaysApply: true）= 常驻底线，每次会话注入，优先级最高。
// - Skills（.cursor/skills/*/SKILL.md）= 按需能力，模型读 description 判断相关性后加载；
//   disable-model-invocation: true 的技能禁止模型自动调用（仅显式触发），不再作常驻注入。

export interface Skill {
  name: string;
  description: string;
  version: string;
  /** 是否禁止模型自动调用（Cursor 规范 disable-model-invocation）。true = 禁止模型自主调用 */
  disabledInvocation: boolean;
  /** 是否启用（false = 停用，运行时忽略；用于把旧技能替换为 Cursor skill 后保留文件可追溯） */
  enabled: boolean;
  body: string;
}

/** 常驻规则（Cursor Rules，alwaysApply: true）：每次会话注入，优先级最高 */
export interface ResidentRule {
  name: string;
  description: string;
  body: string;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SKILLS_DIRS = [
  // 运行时自有技能目录
  fileURLToPath(new URL("../skills/", import.meta.url)),
  // Cursor 生态技能目录（仓库根 .cursor/skills/）：apps/agent-server/src -> 仓库根
  resolve(__dirname, "..", "..", "..", ".cursor", "skills") + "/",
];
// Cursor Rules 目录（仓库根 .cursor/rules/）
const RULES_DIR = resolve(__dirname, "..", "..", "..", ".cursor", "rules") + "/";

let cache: Skill[] | null = null;
let rulesCache: ResidentRule[] | null = null;

// Claude 官方 Layer1 技能目录预算：上下文约 2%，回退 16000 字符。
// 超出时 chat.ts 注入端会截断技能清单；此处仅加载时告警便于定位膨胀。
const SKILL_CATALOG_BUDGET = 16000;

export function loadSkills(): Skill[] {
  if (cache) return cache;
  const skills: Skill[] = [];
  const seen = new Set<string>();
  try {
    for (const dir of SKILLS_DIRS) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 目录缺失时静默跳过（如未配置 .cursor/skills）
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (seen.has(entry.name)) continue;
        const file = join(dir, entry.name, "SKILL.md");
        let md: string;
        try {
          md = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
        } catch {
          continue;
        }
        const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) continue;
        const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
        if (!name || !description) continue;
        const version = match[1].match(/^version:\s*(.+)$/m)?.[1]?.trim() || "0.0.0";
        const disabledInvocation =
          /^disable-model-invocation:\s*(true|1|yes)$/im.test(match[1]);
        const enabled = !/^enabled:\s*(false|0|no)$/im.test(match[1]);
        if (!enabled) continue; // 停用技能不加载（保留文件可追溯，运行时忽略）
        skills.push({ name, description, version, disabledInvocation, enabled: true, body: match[2].trim() });
        seen.add(entry.name);
      }
    }
  } catch {
    /* 技能目录缺失时静默跳过 */
  }
  cache = skills;
  const catalogTotal = skills.reduce((n, s) => n + `- ${s.name}：${s.description}`.length, 0);
  if (catalogTotal > SKILL_CATALOG_BUDGET) {
    console.warn(
      `[skills] 技能清单超预算：${catalogTotal} 字符 > ${SKILL_CATALOG_BUDGET}（chat.ts 注入端会截断，请精简 description）`,
    );
  }
  return skills;
}

/** 测试/热更新：清空技能缓存 */
export function clearSkillsCache() {
  cache = null;
  rulesCache = null;
}

/**
 * 加载 Cursor Rules 常驻底线（.cursor/rules/*.mdc，alwaysApply: true）。
 * 对齐 Cursor 语义：Rules = 每次会话自动注入的底线约束，优先级最高。
 */
export function loadResidentRules(): ResidentRule[] {
  if (rulesCache) return rulesCache;
  const rules: ResidentRule[] = [];
  try {
    const entries = readdirSync(RULES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mdc")) continue;
      const file = join(RULES_DIR, entry.name);
      let md: string;
      try {
        md = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
      } catch {
        continue;
      }
      const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) continue;
      const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
      const alwaysApply = /^alwaysApply:\s*(true|1|yes)$/im.test(match[1]);
      if (!alwaysApply) continue; // 仅 alwaysApply 规则常驻注入（对齐 Cursor Rules）
      const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.name.replace(/\.mdc$/, "");
      rules.push({ name, description: description || name, body: match[2].trim() });
    }
  } catch {
    /* .cursor/rules 目录缺失时静默跳过 */
  }
  rulesCache = rules;
  return rules;
}

