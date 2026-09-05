// M1（Supervisor 路由层）Worker 注册表。
// 设计要点（见 docs/agent/MULTI_AGENT_ARCHITECTURE.md §3）：
//   - Worker = 工具子集（whitelist）+ 领域系统提示 + 环境/项目配置的声明式组合，不是独立进程/模型实例。
//   - 所有 Worker 共享同一个模型池与执行引擎；preferredModel 仅作为「装配属性」在命中后覆盖默认模型。
//   - 本文件零依赖 tools.ts（仅 type-only import ToolDomain），避免与 tools.ts 形成循环依赖；
//     工具裁剪由 chat.ts 组合 listAgentTools + workerToolNames 完成。
//   - 红线：domain 为通用分类词（backend-api/knowledge/common 等），非业务词；registry 是配置层，无词形路由。
import type { ToolDomain } from "./tools.js";

export interface WorkerDef {
  id: string;
  domain: ToolDomain;
  label: string;
  project?: string;
  environment?: "test" | "prod";
  /** 该 worker 暴露的工具白名单（按名字）；缺省按 domain 推导（见 workerToolNames） */
  toolWhitelist?: string[];
  /** 领域系统提示（可选，作为 system step 注入） */
  systemPrompt?: string;
  /** M1+ 增强：命中后 understand/final 使用该模型，实现「按 Agent 维度切模型」（见 §3.8） */
  preferredModel?: string;
  writeConfirmPolicy?: "always" | "normal";
}

// 默认 worker 注册表（配置化；finance/customer-service/database 为 M1+ 预留，暂不启用）。
// 新增领域 = 加一条 WorkerDef，不改引擎。
export const DEFAULT_WORKERS: WorkerDef[] = [
  {
    id: "backend-api-bx-film-admin-test",
    domain: "backend-api",
    label: "后台管理 API（测试）",
    project: "bx-film-admin",
    environment: "test",
    toolWhitelist: [
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
    ],
  },
  {
    id: "knowledge",
    domain: "knowledge",
    label: "知识库查询",
    toolWhitelist: ["search_knowledge_base", "search_dingtalk_doc", "read_file", "list_dir", "fetch_url"],
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
