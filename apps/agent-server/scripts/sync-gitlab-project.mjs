/**
 * 方案 A：从 gitlab 同步项目代码到 codebaseRoot + 生成 api 索引。
 * ----------------------------------------------------------------
 * 用法：node scripts/sync-gitlab-project.mjs [projectKey]   （缺省同步全部项目）
 * 配置：apps/agent-server/.env 的 GITLAB_GIT_BASE / GITLAB_REPO_CACHE_DIR
 * 分支：测试环境 dev / 生产 master（clarification-policy.json project.options 的 branch）
 *
 * 说明：gitlab REST API（http 301→https，https 443 本机不通）不可用，改用 git 协议
 *       （https://<user>@git.work.xxbbc.com/...，本机 credential manager 凭据）拉取。
 *       首次浅克隆到目标分支；已存在则 fetch + reset --hard 对齐 gitlab。
 *       2026-08-24：不再自动生成 data/api-module-index-<key>.json（该索引已删除，
 *       模块定位完全交模型实时 grep 源码）；如需索引可手动跑 generate-api-index.mjs。
 */
import "../src/load-env.js";
import { getProjectConfig, listProjects } from "../src/project-registry.ts";
import { syncProjectCode } from "../src/gitlab-repo.ts";

const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const target = (process.argv[2] || "").trim();
const projects = target ? [getProjectConfig(target)].filter(Boolean) : listProjects();
if (!projects.length) {
  console.error(`未找到项目配置${target ? `「${target}」` : ""}（clarification-policy.json project.options）`);
  process.exit(1);
}

for (const p of projects) {
  console.log(`\n===== 同步 ${p.key}（${p.label}）branch=${p.branch} =====`);
  const r = syncProjectCode(p);
  console.log(r.message);
}
console.log("\n完成（仅同步代码，索引文件不再生成）。");
