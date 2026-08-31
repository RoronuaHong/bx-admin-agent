/**
 * gitlab 代码库拉取适配器（方案 A：git 协议 + 本机凭据，非交互，2026-08-22）。
 *
 * 背景：gitlab REST API（http 301 → https，https 443 本机不通）不可作为检索路径；
 * 但 git 协议非交互可访问（本机 Windows credential manager 已缓存 gitlab 凭据，
 * git config url.https://hong@git.work.xxbbc.com/.insteadof 内嵌用户名）。
 * 因此「gitlab 在线代码库」落地为：git 协议 clone/fetch 到服务端缓存目录，
 * 现有 grep_codebase / search_api_module / read_api_module 直接 rg 该目录。
 *
 * 配置（apps/agent-server/.env）：
 *   GITLAB_GIT_BASE=https://hong@git.work.xxbbc.com/
 *   GITLAB_REPO_CACHE_DIR=D:\Code\bx-agent-repos
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "./project-registry.js";

const DEFAULT_GIT_BASE = "https://hong@git.work.xxbbc.com/";

function gitBase(): string {
  return (process.env.GITLAB_GIT_BASE || DEFAULT_GIT_BASE).replace(/\/+$/, "") + "/";
}

/** gitlab 仓库克隆 URL（如 https://hong@git.work.xxbbc.com/web/bx-film-admin-in2.git） */
export function gitRepoUrl(project: ProjectConfig): string {
  if (!project.gitRepo) return "";
  return `${gitBase()}${project.gitRepo}.git`;
}

/** 同步项目代码到 codebaseRoot：首次浅克隆到目标分支；已存在则 fetch + reset --hard 对齐 gitlab。 */
export function syncProjectCode(
  project: ProjectConfig,
  opts: { depth?: number } = {},
): { ok: boolean; message: string } {
  const url = gitRepoUrl(project);
  if (!url) return { ok: false, message: `项目 ${project.key} 未配置 gitRepo，跳过` };
  const dir = project.codebaseRoot;
  const branch = project.branch || "dev";
  const depth = String(opts.depth || 1);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  try {
    if (!existsSync(path.join(dir, ".git"))) {
      execFileSync(
        "git",
        ["clone", "-b", branch, "--single-branch", "--depth", depth, url, dir],
        { env, stdio: "pipe", encoding: "utf8", timeout: 300000 },
      );
      return { ok: true, message: `已从 gitlab 克隆 ${project.gitRepo}@${branch} → ${dir}` };
    }
    // 保护用户工作区：有未提交改动时不强制覆盖（返回提示，避免 reset 丢代码）
    const dirty = execFileSync(
      "git", ["-C", dir, "status", "--porcelain"],
      { env, stdio: "pipe", encoding: "utf8", timeout: 15000 },
    ).trim();
    if (dirty) {
      return {
        ok: false,
        message: `${project.gitRepo} 本地有 ${dirty.split("\n").length} 个未提交文件，已跳过同步（保护工作区）；请先提交/还原后再 sync`,
      };
    }
    // 保护「已 commit 未 push」的本地提交：checkout -B 会丢弃本地领先 origin 的 commit
    // （如 agent write_code_file + git_commit_push 后 push 失败/未推送）。领先 >0 时跳过同步。
    try {
      const ahead = execFileSync(
        "git", ["-C", dir, "rev-list", "--count", `origin/${branch}..HEAD`],
        { env, stdio: "pipe", encoding: "utf8", timeout: 15000 },
      ).trim();
      if (Number(ahead) > 0) {
        return {
          ok: false,
          message: `${project.gitRepo} 本地有 ${ahead} 个未推送 commit（origin/${branch} 之后），已跳过同步（避免丢失）；请先 push 到 gitlab 后再 sync`,
        };
      }
    } catch { /* 无 origin 引用时跳过该保护 */ }
    execFileSync(
      "git",
      ["-C", dir, "fetch", "origin", branch, "--depth", depth],
      { env, stdio: "pipe", encoding: "utf8", timeout: 300000 },
    );
    // checkout -B：强制创建/重置本地分支到 origin/<branch> 并切换（含工作树同步，丢弃本地分支差异）
    execFileSync(
      "git",
      ["-C", dir, "checkout", "-B", branch, `origin/${branch}`],
      { env, stdio: "pipe", encoding: "utf8", timeout: 120000 },
    );
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      env,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    return { ok: true, message: `已同步 ${project.gitRepo}@${branch} → ${head}（${dir}）` };
  } catch (e: unknown) {
    return { ok: false, message: `同步 ${project.gitRepo}@${branch} 失败：${(e as Error).message}` };
  }
}

/** 读取已拉取代码目录的当前 HEAD commit（供对齐报告/日志） */
export function currentHead(project: ProjectConfig): string {
  try {
    return execFileSync(
      "git",
      ["-C", project.codebaseRoot, "rev-parse", "--short", "HEAD"],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "pipe", encoding: "utf8", timeout: 15000 },
    ).trim();
  } catch {
    return "";
  }
}
