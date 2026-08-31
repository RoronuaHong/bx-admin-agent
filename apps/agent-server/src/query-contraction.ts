/**
 * 查询词「收缩降级」算法（2026-08-24 引入，2026-08-26 去写死词表）。
 *
 * 背景：用户口语词（如「留存报表」）往往不是源码/菜单里的精确字符串（官方菜单名「留存率数据统计」，
 * 路由 retentionTotal）。search_api_module / grep_codebase 对整词零命中后定位链路就死了——
 * 缺的是「口语词 → 收缩到能命中的核心词」这一通用能力，而不是映射表。
 *
 * 解法：把查询词「词尾逐字收缩」生成降级候选序列，从长到短依次轻量 grep（rg -l，零命中即降级），
 * 首个命中候选返回。不引入任何「词→模块」映射表、不写死任何业务词/功能词/显示词缀表——
 * 完全符合 2026-08-22「完全抛弃 aliases」+ 2026-08-26「除 tools/skills 外不写死」红线；
 * 命中结果交模型裁决（唯一直接用/多候选诚实提示），不硬调。
 *
 * 纯算法（无业务语义）：
 * - 词尾逐字收缩本身已能自然覆盖「留存报表」→「留存」（逐字删自动剥掉显示词缀，无需显式词表）；
 * - 收缩最小 2 个汉字，防止泛命中（如「留存」→「留」）。
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

/** 生成降级候选序列（保序去重）：原词优先 → 剥尾部非中文残渣 → 词尾逐字收缩。 */
export function contractCandidates(term: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(term);
  // 1) 剥尾部非中文残渣（数字/字母/标点/单位，如模型 query 粘连的「留存报表看30天」→「留存报表看」）
  const core0 = term.replace(/[^\u4e00-\u9fa5]+$/g, "");
  if (core0 && core0 !== term) push(core0);
  // 2) 逐码点收缩（最小 2 字符）：「留存报表看30天」→「留存报表看30」→…→「留存报表」→「留存报」→「留存」。
  //    不要求纯中文：口语词中间可能粘连数字/单位（模型 query 粘连「30天」/「账号合并558523069977」），
  //    逐码点删自然覆盖；仅要求含至少一个汉字（纯英文模块 id 无需收缩，且防止泛命中）。
  const core = core0 || term;
  if (core.length >= 2 && /[\u4e00-\u9fa5]/.test(core)) {
    for (let i = core.length - 1; i >= 2; i--) {
      const p = core.slice(0, i);
      if (/[\s，。、！？；：""''（）]$/.test(p)) continue; // 尾部残留标点/空格跳过
      push(p);
    }
  }
  return out;
}

export interface ContractHit {
  /** 命中的收缩候选（如「留存」） */
  pattern: string;
  /** 命中的文件绝对路径（最多 maxFiles 个） */
  files: string[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nuxt", ".output", "logs", "tmp", "local"]);
const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".json", ".md", ".txt", ".html", ".htm"]);

/** rg 缺失时的原生回退（-l 语义：只收集命中的文件路径，大小写不敏感，跳过二进制/超限文件）。 */
function walkMatch(dir: string, lower: string, maxFiles: number, acc: string[]): void {
  if (acc.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= maxFiles) return;
    if (e.name.startsWith(".")) continue;
    const full = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) walkMatch(full, lower, maxFiles, acc);
    } else if (e.isFile()) {
      if (!TEXT_EXTS.has(nodePath.extname(e.name).toLowerCase())) continue;
      try {
        const st = statSync(full);
        if (st.size > 2 * 1024 * 1024) continue;
        if (readFileSync(full, "utf8").toLowerCase().includes(lower)) acc.push(full);
      } catch {
        /* 忽略不可读文件 */
      }
    }
  }
}

function isRgMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * 从长到短依次轻量 grep（rg -l），首个命中候选即返回；全部零命中返回 null。
 * - rg 零命中（exit 1）→ 继续下一个候选；rg 缺失 → 原生递归回退。
 * - 命中结果只返回文件路径，语义归属交调用方（search_api_module / workflow-orchestrate 的
 *   resolveModuleFromGrep 复用现有「api 路径命中 / views 读页面找 import」逻辑），不硬调。
 */
export function runContractSearch(term: string, searchDirs: string[], maxFiles = 6): ContractHit | null {
  const candidates = contractCandidates(term);
  const dirs = [...new Set(searchDirs.filter(Boolean))];
  if (!dirs.length) return null;
  for (const cand of candidates) {
    try {
      const cmd = `rg --no-heading -l -i -- "${cand.replace(/"/g, '\\"')}" ${dirs.map((d) => `"${d}"`).join(" ")}`;
      const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 8000 }).toString();
      const files = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (files.length) return { pattern: cand, files: files.slice(0, maxFiles) };
    } catch (e: unknown) {
      if (isRgMissing(e)) {
        // rg 缺失：原生递归回退（-l 语义），首个候选命中即返回
        const files: string[] = [];
        const lower = cand.toLowerCase();
        for (const d of dirs) walkMatch(d, lower, maxFiles, files);
        if (files.length) return { pattern: cand, files };
      }
      // 零命中（rg exit 1）→ 继续下一个收缩候选
    }
  }
  return null;
}
