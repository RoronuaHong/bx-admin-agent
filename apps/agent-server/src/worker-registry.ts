// M1（Supervisor 路由层）Worker 注册表。
// 设计要点（见 docs/agent/MULTI_AGENT_ARCHITECTURE.md §3）：
//   - Worker = 工具子集（whitelist）+ 领域系统提示 + 环境/项目配置的声明式组合，不是独立进程/模型实例。
//   - 所有 Worker 共享同一个模型池与执行引擎；preferredModel 仅作为「装配属性」在命中后覆盖默认模型。
//   - 本文件零依赖 tools.ts（仅 type-only import ToolDomain），避免与 tools.ts 形成循环依赖；
//     工具裁剪由 chat.ts 组合 listAgentTools + workerToolNames 完成。
//   - 红线：domain 为通用分类词（backend-api/knowledge/common 等），非业务词；registry 是配置层，无词形路由。
import type { ToolDomain } from "./tools.js";

export type ApiEnvironment = "test" | "prod";

export interface WorkerDef {
  id: string;
  domain: ToolDomain;
  label: string;
  project?: string;
  environment?: ApiEnvironment;
  /** 该 worker 暴露的工具白名单（按名字）；缺省按 domain 推导（见 workerToolNames） */
  toolWhitelist?: string[];
  /** 领域系统提示（可选，作为 system step 注入） */
  systemPrompt?: string;
  /** M1+ 增强：命中后 understand/final 使用该模型，实现「按 Agent 维度切模型」（见 §3.8） */
  preferredModel?: string;
  /** prod 强制 always；test 可 normal（与全局写确认护栏叠加，见 chat 确认分支） */
  writeConfirmPolicy?: "always" | "normal";
}

/** 后台 API Worker 共用工具子集（test/prod 一致；环境差异走 environment / writeConfirmPolicy） */
const BACKEND_API_TOOLS = [
  "submit_understood_intent",
  "search_api_module",
  "read_api_module",
  "call_api",
  "grep_codebase",
  "search_symbol",
  "get_list_columns",
  "get_page_schema",
  "render_table",
  "export_dataset",
  "normalize_output",
  "read_field_mapping",
  "summarize_chart_data",
  "write_code_file",
  "git_commit_push",
];

const BACKEND_TEST_PROMPT =
  "[workflow/worker] 当前 Worker：后台管理 API（测试环境）。" +
  "优先 search_api_module / read_api_module → call_api 取真实数据；写操作须经用户确认。" +
  "勿调用知识库类工具；需要检索文档时先 route_to_agent(domain=knowledge)。" +
  "需要生产环境时 route_to_agent(domain=backend-api, environment=prod)。";

const BACKEND_PROD_PROMPT =
  "[workflow/worker] 当前 Worker：后台管理 API（生产环境）。" +
  "API 域名与测试隔离；写操作一律强制用户确认（writeConfirmPolicy=always）。" +
  "优先 search_api_module / read_api_module → call_api；勿调用知识库类工具。" +
  "切回测试环境：route_to_agent(domain=backend-api, environment=test)。";

const KNOWLEDGE_PROMPT =
  "[workflow/worker] 当前 Worker：知识库查询。" +
  "优先 search_knowledge_base / search_dingtalk_doc / read_file；基于检索结果回答并给出出处。" +
  "禁止 call_api / 后台写操作；需要后台数据时先 route_to_agent(domain=backend-api)。";

const COMMON_PROMPT =
  "[workflow/worker] 当前 Worker：通用调度。" +
  "可做反问、意图校验、项目切换、偏好与时间查询；业务取数或知识检索请先 route_to_agent 切到对应域。";

// 默认 worker 注册表（配置化；finance/customer-service/database/consumer-viewing 为后续预留）。
// 新增领域 = 加一条 WorkerDef，不改引擎。
export const DEFAULT_WORKERS: WorkerDef[] = [
  {
    id: "backend-api-bx-film-admin-test",
    domain: "backend-api",
    label: "后台管理 API（测试）",
    project: "bx-film-admin",
    environment: "test",
    toolWhitelist: BACKEND_API_TOOLS,
    systemPrompt: BACKEND_TEST_PROMPT,
    writeConfirmPolicy: "normal",
  },
  {
    id: "backend-api-bx-film-admin-prod",
    domain: "backend-api",
    label: "后台管理 API（生产）",
    project: "bx-film-admin",
    environment: "prod",
    toolWhitelist: BACKEND_API_TOOLS,
    systemPrompt: BACKEND_PROD_PROMPT,
    writeConfirmPolicy: "always",
  },
  {
    id: "knowledge",
    domain: "knowledge",
    label: "知识库查询",
    toolWhitelist: ["search_knowledge_base", "search_dingtalk_doc", "read_file", "list_dir", "fetch_url"],
    systemPrompt: KNOWLEDGE_PROMPT,
  },
  {
    id: "common",
    domain: "common",
    label: "通用",
    toolWhitelist: [
      "request_clarification",
      "parse_intent",
      "set_project",
      "get_current_time",
      "update_user_preference",
      "get_user_preferences",
    ],
    systemPrompt: COMMON_PROMPT,
  },
];

const BY_ID = new Map(DEFAULT_WORKERS.map((w) => [w.id, w]));

export function resolveWorkerById(id: string): WorkerDef | null {
  return BY_ID.get(id) ?? null;
}

export function resolveWorker(domain: string, project?: string, environment?: string): WorkerDef | null {
  // 模型常传占位值（"-"/空串/"none"）表达「未指定」，此时按「不限」匹配，
  // 避免 knowledge/common 这类不绑定项目/环境的 Worker 因占位值非空而匹配失败（M1 路由空转）。
  const p = project && project !== "-" && project.toLowerCase() !== "none" ? project : undefined;
  const e = environment && environment !== "-" && environment.toLowerCase() !== "none" ? environment : undefined;
  return (
    DEFAULT_WORKERS.find(
      (w) =>
        w.domain === domain &&
        (!p || w.project === p) &&
        // worker 未声明 environment 视为「不限环境」放行；声明了才要求精确匹配
        (!w.environment || !e || w.environment === e),
    ) ?? null
  );
}

/** 返回该 worker 应暴露的工具名集合；worker 无白名单时返回 null（调用方回退全量工具） */
export function workerToolNames(worker: WorkerDef | null): Set<string> | null {
  if (!worker) return null;
  if (worker.toolWhitelist?.length) return new Set(worker.toolWhitelist);
  return null;
}

/** 格式化 Worker 领域提示（供 understand 每轮注入；含 ACTIVE_WORKER_CTX 标记便于去重） */
export function formatWorkerGuide(worker: WorkerDef): string {
  const env = worker.environment ? ` environment=${worker.environment}` : "";
  const policy = worker.writeConfirmPolicy ? ` writeConfirm=${worker.writeConfirmPolicy}` : "";
  const head = `[workflow/worker-context] id=${worker.id} domain=${worker.domain}${env}${policy}`;
  const body = worker.systemPrompt?.trim() || `当前 Worker「${worker.label}」。`;
  return `${head}\n${body}\n[ACTIVE_WORKER_CTX:${worker.id}]`;
}

/** 写操作是否强制 UI 确认：缺省/always → 强制；normal → 仍对写操作强制（安全默认，与全局护栏一致） */
export function mustConfirmWrite(worker: WorkerDef | null): boolean {
  // M1 收尾：prod 显式 always；test 的 normal 目前与 always 同效（不放开「模型 confirm=true 静默写」）。
  // 保留字段区分，便于日后对 test 做更细策略而不改调用方。
  void worker?.writeConfirmPolicy;
  return true;
}
