/**
 * 项目注册表（方案 A 落地：多项目代码库来自 gitlab，2026-08-22）。
 *
 * 项目配置单一来源：docs/agent/clarification-policy.json 的 intentSchema.slots.project.options。
 * 每个项目条目支持字段：
 *   - key / label：现有
 *   - gitRepo：gitlab 仓库路径（namespace/repo，如 web/bx-film-admin-in2）
 *   - branch：分支（测试环境 dev / 生产 master）
 *   - codebaseRoot：代码目录（gitlab 拉取落地目录；缺省按 GITLAB_REPO_CACHE_DIR/<key>，
 *     已有本地 clone 的项目可直接指向本地目录，如 D:\Code\bx-film-admin-in2）
 *
 * 代码获取不再依赖开发机手动 clone：scripts/sync-gitlab-project.mjs 用 git 协议（本机凭据）
 * 拉取到 codebaseRoot；grep/read/渲染/索引统一经 project-context.resolveCodebaseRoot() 读取。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectConfig {
  key: string;
  label: string;
  codebaseRoot: string;
  gitRepo?: string; // gitlab namespace/repo，如 web/bx-film-admin-in2
  branch?: string;  // 测试 dev / 生产 master
}

interface PolicyProjectOption {
  key?: string;
  label?: string;
  codebaseRoot?: string;
  gitRepo?: string;
  branch?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/ → apps/agent-server → apps → 仓库根 → docs/agent/clarification-policy.json
const POLICY_PATH = path.resolve(__dirname, "..", "..", "..", "docs", "agent", "clarification-policy.json");
const CACHE_ROOT = process.env.GITLAB_REPO_CACHE_DIR || path.resolve("D:\\Code", "bx-agent-repos");

function loadProjectOptions(): PolicyProjectOption[] {
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")) as {
      intentSchema?: {
        slots?: {
          project?: { options?: PolicyProjectOption[] };
        };
      };
    };
    return (raw.intentSchema?.slots?.project?.options || []).filter((p) => p.key);
  } catch {
    return [];
  }
}

export function getProjectConfig(key: string): ProjectConfig | null {
  const found = loadProjectOptions().find((p) => p.key === key);
  if (!found) return null;
  return {
    key: found.key!,
    label: found.label || found.key!,
    codebaseRoot: found.codebaseRoot || path.join(CACHE_ROOT, found.key!),
    gitRepo: found.gitRepo,
    branch: found.branch || "dev",
  };
}

export function listProjects(): ProjectConfig[] {
  return loadProjectOptions()
    .map((p) => getProjectConfig(p.key!))
    .filter((x): x is ProjectConfig => Boolean(x));
}

/** codebaseRoot 是否已就绪（gitlab 拉取已落地或本地目录存在） */
export function projectCodebaseReady(project: ProjectConfig): boolean {
  return fs.existsSync(project.codebaseRoot);
}
