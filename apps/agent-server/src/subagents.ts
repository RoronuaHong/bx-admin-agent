// 具名子代理类型加载器。
// 优先级：代码兜底 < apps/agent-server/subagents/*.md < .data/subagents/*.md（同名后者覆盖）。
// 启动期加载一次并缓存；定义变更随进程重启生效（invalidateSubagentCache 只清缓存，不接管理页）。
// 依赖约束：复用 skills.ts 的 frontmatter 解析器与 builtins.ts 的风险登记表；不 import chat / system-prompt，避免成环。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyAfterFrontmatter, listEnabledSkillDirs, parseFrontmatter } from "./skills.js";
import { BUILTIN_RISK } from "./builtins.js";
import { DATA_DIR } from "./store-util.js";
import { loadServers } from "./mcp/config.js";

export interface SubagentSpec {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  readonly?: boolean;
  skills?: string[];
  mcpServers?: string[];
}

export const GENERAL_PURPOSE_ID = "general-purpose";

const BUILTIN_SUBAGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "subagents");
const NAME_RE = /^[a-z0-9-]{1,64}$/;
const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "maxTurns",
  "readonly",
  "skills",
  "mcpServers",
]);

/**
 * 内置工具 id 直接取 builtins.ts 的 BUILTIN_RISK 键，避免维护两份名单。
 * builtins.ts 不 import system-prompt / subagents，故这里引用不会成环；
 * 仅用于「逐项告警并忽略未知 id」，运行时可用性仍由 chat.ts 求交决定。
 */
const BUILTIN_TOOL_IDS = new Set<string>(Object.keys(BUILTIN_RISK));

/** 代码兜底：连 subagents 目录都不可读时仍有一个可用的通用型。随代码发布的 .md 会覆盖它。 */
const FALLBACK: SubagentSpec = {
  name: GENERAL_PURPOSE_ID,
  description: "通用子代理：没有专属类型时用本类型，继承当前全部可用工具。",
  systemPrompt: "你是通用子代理。独立完成父代理委派的任务，只回传结论与关键依据，不要复述整段对话。",
};

let cache: SubagentSpec[] | null = null;

/** 本地定义目录：SUBAGENT_DATA_DIR > AGENT_DATA_DIR > .data，对齐 skills.ts 的数据目录口径。 */
function localSubagentsRoot(): string {
  const override = process.env.SUBAGENT_DATA_DIR || process.env.AGENT_DATA_DIR;
  return join(override && override.trim() ? resolve(override) : DATA_DIR, "subagents");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const items = raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * 逐项校验 id 列表：未知项告警并忽略，保留其余项；全部未知时返回空数组（fail-closed，
 * 交给 chat.ts 的「工具交集为空 → failed」处理），绝不放宽成「继承全部」。
 * known 为空表示校验源当前不可用（如尚未配置 MCP server），此时不误删任何项。
 */
function validateIds(field: string, raw: string | undefined, known: Set<string>, source: string): string[] | undefined {
  const list = splitList(raw);
  if (!list) return undefined;
  const kept: string[] = [];
  for (const id of list) {
    if (known.size === 0 || known.has(id)) kept.push(id);
    else console.warn(`[subagents] ${source} 的未知 ${field} id：${id}（已忽略）`);
  }
  return kept;
}

function knownSkillIds(): Set<string> {
  try {
    return new Set(listEnabledSkillDirs());
  } catch {
    return new Set();
  }
}

function knownMcpServerIds(): Set<string> {
  try {
    return new Set(loadServers().map((s) => s.id));
  } catch {
    return new Set();
  }
}

/** 解析单份定义；任何结构性问题都跳过整份文件并告警，不让坏定义静默生效。 */
function parseDefinition(raw: string, fileBase: string, source: string): SubagentSpec | null {
  const reject = (why: string): null => {
    console.warn(`[subagents] 跳过 ${source} 定义 ${fileBase}.md：${why}`);
    return null;
  };
  const meta = parseFrontmatter(raw);

  for (const key of Object.keys(meta)) {
    if (!ALLOWED_FIELDS.has(key)) return reject(`非法字段名：${key}`);
  }
  const name = (meta.name || "").trim();
  const description = (meta.description || "").trim();
  if (!name) return reject("缺 name");
  if (!description) return reject("缺 description");
  if (!NAME_RE.test(name)) return reject(`name 不合法：${name}`);
  if (name !== fileBase) return reject(`文件名与 name 不一致（文件名 ${fileBase}，name ${name}）`);
  const systemPrompt = bodyAfterFrontmatter(raw);
  if (!systemPrompt || !systemPrompt.trim()) return reject("正文为空");

  const spec: SubagentSpec = { name, description, systemPrompt };

  const tools = validateIds("tools", meta.tools, BUILTIN_TOOL_IDS, name);
  if (tools) spec.tools = tools;
  const disallowedTools = validateIds("disallowedTools", meta.disallowedTools, BUILTIN_TOOL_IDS, name);
  if (disallowedTools) spec.disallowedTools = disallowedTools;

  // skills / mcpServers 的可用 id 是运行时集合，校验源为空时不误删。
  const skills = validateIds("skills", meta.skills, knownSkillIds(), name);
  if (skills) spec.skills = skills;
  const mcpServers = validateIds("mcpServers", meta.mcpServers, knownMcpServerIds(), name);
  if (mcpServers) spec.mcpServers = mcpServers;

  const model = (meta.model || "").trim();
  if (model && model !== "inherit") spec.model = model;

  if (meta.maxTurns && meta.maxTurns.trim()) {
    const turns = Number(meta.maxTurns.trim());
    if (Number.isInteger(turns) && turns > 0) spec.maxTurns = turns;
    else console.warn(`[subagents] ${name} 的 maxTurns 不是正整数：${meta.maxTurns}（已忽略）`);
  }

  if (meta.readonly && meta.readonly.trim()) {
    const flag = meta.readonly.trim().toLowerCase();
    if (flag === "true" || flag === "false") spec.readonly = flag === "true";
    else console.warn(`[subagents] ${name} 的 readonly 不是 true/false：${meta.readonly}（按 false 处理）`);
  }

  return spec;
}

/**
 * 扫描单个目录的 *.md（不递归），按 skills.ts 同款校验拒绝符号链接与路径穿越。
 * byCreated 用于本地目录：按文件创建时间（再按名字）排，让先落地的定义优先进入预算有限的索引。
 */
function scanDir(root: string, source: string, byCreated = false): SubagentSpec[] {
  if (!existsSync(root)) return [];
  let rootReal: string;
  try {
    if (lstatSync(root).isSymbolicLink()) return [];
    rootReal = realpathSync(root);
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const files: { name: string; file: string; created: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = join(root, name);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const real = realpathSync(file);
      if (!isInside(rootReal, real)) continue;
      files.push({ name, file: real, created: stat.birthtimeMs || stat.mtimeMs });
    } catch (err) {
      console.warn(`[subagents] 读取 ${source} 定义 ${name} 失败：${String((err as Error)?.message || err)}`);
    }
  }
  if (byCreated) files.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
  else files.sort((a, b) => a.name.localeCompare(b.name));

  const out: SubagentSpec[] = [];
  for (const { name, file } of files) {
    const spec = parseDefinition(readFileSync(file, "utf-8"), name.slice(0, -3), source);
    if (spec) out.push(spec);
  }
  return out;
}

function loadAll(): SubagentSpec[] {
  const byName = new Map<string, SubagentSpec>();
  const put = (spec: SubagentSpec) => byName.set(spec.name, spec);
  put(FALLBACK);
  for (const spec of scanDir(BUILTIN_SUBAGENTS_DIR, "内置")) put(spec);
  for (const spec of scanDir(localSubagentsRoot(), "本地", true)) put(spec);
  return [...byName.values()];
}

function all(): SubagentSpec[] {
  if (!cache) cache = loadAll();
  return cache;
}

export function listSubagentTypes(): SubagentSpec[] {
  return all().slice();
}

export function getSubagentType(id: string): SubagentSpec | undefined {
  return all().find((spec) => spec.name === id);
}

export function invalidateSubagentCache(): void {
  cache = null;
}

function indexCharLimit(): number {
  const n = Number(process.env.SUBAGENT_INDEX_CHARS || 4000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
}

/** 父代理路由索引：每条只有 name: description（无正文），单条描述截断 500 字符，总量受预算约束。 */
export function subagentIndexText(): string {
  const specs = all();
  const max = indexCharLimit();
  const header = "可用子代理类型（通过 task 的 subagent_type 选择；不指定用 general-purpose）：\n";
  const caution = "注意：task 的 description 必须自包含，子代理看不到当前对话。\n";
  const base = header + caution;
  if (base.length >= max) return base.slice(0, max);

  const omission = (n: number) => `\n还有 ${n} 个类型未列出（超出字数上限）。\n`;
  const lineOf = (spec: SubagentSpec) =>
    `${spec.name}: ${spec.description.length > 500 ? spec.description.slice(0, 500) : spec.description}\n`;

  // 先按 name 排序再决定收录谁（与设计一致）：预算不足时按名字靠前的类型优先，输出顺序即收录顺序。
  const sorted = specs.slice().sort((a, b) => a.name.localeCompare(b.name));
  const picked: SubagentSpec[] = [];
  for (const spec of sorted) {
    const remaining = sorted.length - picked.length - 1;
    const note = remaining > 0 ? omission(remaining) : "";
    const lines = [...picked, spec].map(lineOf).join("");
    if (base.length + lines.length + note.length > max) break;
    picked.push(spec);
  }
  const omitted = sorted.length - picked.length;
  const body = picked.map(lineOf).join("");
  return (base + body + (omitted > 0 ? omission(omitted) : "")).slice(0, max);
}
