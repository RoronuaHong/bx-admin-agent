/**
 * 请求级当前项目上下文（多项目代码库解析，2026-08-22）。
 *
 * chatStream 请求入口根据 session.activeProject 调用 setCurrentProject()；
 * grep / 渲染 / 索引等所有「代码根目录 / 项目索引」解析统一走本模块。
 * 单项目（默认项目 = env.CODEBASE_ROOT）行为与改造前完全一致。
 *
 * ⚠️ 模块级状态：适用于单用户/低并发 agent 服务（内部工具）；多请求并发时以「最近设置」为准。
 */
import { getProjectConfig, type ProjectConfig } from "./project-registry.js";

const DEFAULT_CODEBASE_ROOT = "D:\\Code\\bx-film-admin-in2";

let currentKey = "";
let currentProject: ProjectConfig | null = null;

export function setCurrentProject(key: string | null | undefined): void {
  currentKey = key || "";
  currentProject = key ? getProjectConfig(key) : null;
}

export function clearCurrentProject(): void {
  setCurrentProject("");
}

export function getCurrentProjectKey(): string {
  return currentKey;
}

/** 当前请求的代码根目录：activeProject 配置的 codebaseRoot 优先；否则 env.CODEBASE_ROOT（兼容单项目）。 */
export function resolveCodebaseRoot(): string {
  if (currentProject?.codebaseRoot) return currentProject.codebaseRoot;
  return process.env.CODEBASE_ROOT || DEFAULT_CODEBASE_ROOT;
}

/** 当前项目是否为「gitlab 远程库」模式（配了 gitRepo） */
export function isRemoteProject(): boolean {
  return Boolean(currentProject?.gitRepo);
}
