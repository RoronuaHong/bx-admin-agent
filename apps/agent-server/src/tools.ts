import type { AgentToolDef } from "./models.js";
import { fetchLink, resolveLocalDoc } from "./sources.js";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { getActiveProject, getSession, setActiveProject, ensureDefaultProject } from "./session.js";
import { config } from "./config.js";
import { formatModuleSummary, loadApiModuleIndex, resolveApiModules } from "./api-index.js";
import { callUpstream, resolveBaseUrl } from "./upstream.js";
import type { BaseUrlKey, CountryConfig } from "@bx/shared";
import {
  findApiOperationCandidates,
  guessOperationIdFromPath,
  hasOperationPath,
  loadApiOperationIndex,
  resolveApiOperation,
  resolveApiOperationByPath,
  resolveApiOperationByPathSuffix,
  type ApiOperation,
} from "./api-operation-index.js";
import { getRouterPolicy } from "./router-policy.js";
import { appendClarificationMetric } from "./clarification-policy.js";
import { resolveCodebaseRoot } from "./project-context.js";
import { getProjectConfig, projectAccessibleBy } from "./project-registry.js";
import { lookupTermModules, formatTranslationHits } from "./translation-lookup.js";
import { runContractSearch } from "./query-contraction.js";
import { DEFAULT_WORKERS, resolveWorker } from "./worker-registry.js";
import {
  parseUnderstoodIntent,
  SUBMIT_UNDERSTOOD_INTENT,
} from "./understood-intent.js";
import { isMockToken, mockCallApiResult } from "./mock-upstream.js";
import {
  execGetListColumns,
  execGetPageSchema,
  execReadFieldMapping,
  execRenderTable,
  execSummarizeChartData,
  extractPagingContract,
} from "./output-tools.js";
import { execExportDataset } from "./export-tools.js";
import { defaultClarificationPolicyPath, defaultFieldMappingPath } from "./agent-docs.js";
import { searchDingtalkDoc, type SearchDingtalkDocInput } from "./tools/dingtalk-doc.js";
import { formatSearchResults, searchKnowledgeBase } from "./tools/knowledge-base.js";
import { searchSymbol } from "./symbol-index.js";
// 工具参数里常有局部变量 path；勿与 node:path 同名，否则 TDZ（Cannot access 'path2' before initialization）


// 工具注册表（G1 前置版）：本地文件浏览 + 链接抓取，后续在此追加企业 API 工具。
// 模型通过原生 tool_use / function calling 调用，服务端执行后把结果回传模型继续推理。
//
// 规范（与 docs/WORKFLOW.md「功能规范」保持一致）：
// - 命名：snake_case + 动词开头（list_*/read_*/fetch_*），≤32 字符。
// - 描述：动词开头说明"做什么"，"Use when/用户何时问"说明触发场景，"不要用本工具"说明边界。
// - 错误：统一返回 `错误：<类型>；<原因>；<建议>` 文本（放结果里而非抛异常），给模型自纠正线索。
// - 单一职责：一个工具只做一件事；描述常量在此定义，MCP 出口（mcp.ts）复用，禁止双份漂移。

export const TOOL_PATH_DESC =
  "本地文件系统绝对路径（Windows 如 D:\\Code\\project\\src\\api\\a.ts），" +
  "或相对路径（基于服务端 AGENT_DOCS_DIR 白名单目录，若已配置）";

// 单一来源的工具描述（聊天工具循环与 MCP 出口共用）。
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_dir:
    "列出本地目录下的一层内容（子目录、文件名及大小），用于浏览本地代码项目结构。" +
    "用户询问项目结构、接口位置、目录内容、某路径下有什么时使用。" +
    "需要看单个文件内容时请用 read_file，不要用本工具翻文件。每个目录最多列出 300 项；传文件路径时返回文件内容。",
  read_file:
    "读取本地文本文件内容（限 2MB，二进制不支持）。" +
    "用户询问代码实现、配置文件、文档内容时使用；需要浏览目录结构时请用 list_dir，不要用本工具。" +
    "支持 .ts/.tsx/.vue/.js/.jsx/.json/.md/.yaml/.env 等文本与源码文件。",
  fetch_url:
    "抓取 http/https 链接内容并转为纯文本（限 2MB），可访问本机服务（如 http://localhost:3100）或内网地址。" +
    "用户要求访问某网址、看接口返回、抓网页内容时使用。" +
    "仅支持 http/https 协议，其他协议（ftp/file 等）会失败；需要带 Cookie/Header 的请求当前不支持。",
  search_api_module:
    "按业务模块名搜索接口定义（用户口语描述的业务模块名），返回匹配的接口文件、函数名和 URL 路径。" +
    "用户用自然语言描述业务模块、未提供文件路径时使用；找到模块后直接用 read_api_module 读取完整源码并据此 call_api，" +
    "不要反复 grep / list_dir 绕路探索（read_api_module 已返回完整源码）。" +
    "提示：源码/菜单名常为「XX率数据统计」「XX统计」等规范名，口语词整词搜不到时，" +
    "可直接用 search_api_module 搜核心词（服务端会对查询词做词尾逐字收缩降级重搜，无需手动拆词）。",
  read_api_module:
    "读取接口定义文件的完整源码。" +
    "可传模块名/别名（用户口语业务词或英文模块 id）或文件路径（如 src/api 下相对路径）；多个用逗号分隔。" +
    "不确定模块对应哪个文件时，先用 search_api_module 搜索；拿到「建议用 read_api_module 读取」提示时直接读该文件后 call_api。",
  call_api:
    "以当前登录用户身份调用企业内部接口（自动携带鉴权 token，按登录国家线拼接域名）。" +
    "优先传 operation（module.func，如 <模块>.getById），由服务端映射到正确接口，避免调错。" +
    "优先使用 path + base（如 path=<接口路径>, base=backend），不要自己拼完整域名。" +
    "base 对应前端 base.ts：backend/getUrl、user/getUserUrl、film/getFilmUrl。" +
    "内网域名仅支持 http，不要用 https。写操作 confirm=true 需用户确认。接口调用成功后会自动写操作日志。" +
    "【分页】列表查询如需多页/多条数据，由你按接口契约多次调用 call_api 拉取拼接（每次传对应分页参数，如 page=1/2/3 或 limit），" +
    "服务端不做分页循环、不提供分页默认值；只取一页就直接传该页参数调用一次。",
  request_clarification:
    "当请求目标/关键用词语义模糊、无法确定唯一业务含义，或缺少必要槽位（模块名、操作类型、操作对象）时，" +
    "返回结构化反问问题与可选项（提供 1 个或多个带选项的问题，必要时允许多选），让用户收敛范围后再执行。" +
    "禁止在目标/词义不明时硬猜取数后输出与请求不符的结果。已明确、可直接执行的请求无需反问。",
  write_code_file:
    "修改/新增业务项目代码文件（限当前项目 codebaseRoot 内，禁止写 .git/node_modules/dist 等目录）。" +
    "用户要求改代码、修 bug、加功能、写配置文件时使用。path 传 codebaseRoot 内相对路径（如 src/api/xxx.ts）或绝对路径；" +
    "content 传文件完整新内容（会整体覆盖）。执行前会请求用户确认；仅当用户明确要求改动代码时才调用，不要擅自修改源码。",
  git_commit_push:
    "把当前项目代码改动提交并推送到 gitlab 远程（git add -A → commit → push origin <分支>）。" +
    "配合 write_code_file 使用：完成代码修改后，若用户要求提交，调用本工具（message 必填，如「feat: 新增xxx」）。" +
    "⚠️ git add -A 会提交 codebaseRoot 内【全部】改动（含非本次修改的文件），提交前请先用 git status 确认改动范围。" +
    "分支默认取当前 checkout 分支（业务项目测试=dev）；禁止直接推 master/main 生产分支（需显式 allowMaster=true 并经二次确认）。" +
    "执行前会请求用户确认；仅当用户明确要求提交代码时才调用。",
  grep_codebase:
    "在本地代码仓库中用关键词全局搜索（ripgrep），返回匹配行、所在文件、行号。" +
    "用户提到某个业务名词、模块名、变量名、函数名、中文叫法，需要定位其在代码中的位置时使用。" +
    "返回结果包含文件路径和上下文行，可直接用 read_file 读取完整内容。" +
    "不要用于需要执行接口的操作，仅用于代码搜索定位。",
  search_symbol:
    "符号级检索（AST 解析 PC 端 src/api 接口定义）：按函数名、中文动作、URL 片段、模块名精确命中导出接口函数，" +
    "返回其签名（参数）、HTTP 方法、完整 URL、中文动作、依赖 import。" +
    "与 grep_codebase 互补：grep 找「文本在哪一行」，本工具找「这个函数签名与调用关系是什么」。" +
    "适合需要看清某个接口函数长什么样、参数怎么传、调的是哪个 URL 的场景；定位后再用 read_api_module/grep_codebase 看实现细节。" +
    "参数：query（函数名片段/中文动作/URL 片段，必填）、limit（返回条数，默认 8）。",
  normalize_output:
    "将 API 返回的原始数据做格式规范化（字段过滤/排序/条数修正）。" +
    "注意：call_api 成功后服务端会自动受控渲染表格（含中文字段名），通常无需调用本工具。" +
    "仅当服务端提示 [workflow/output-align]（自动渲染失败，或表头含英文字段）时才手动处理：" +
    "先按 pc-column-mapping 技能到当前项目源码取中文字段/枚举映射，再用 render_table 的 columns.title 输出中文表头。" +
    "本工具不再提供字段中文化（映射已不在配置表维护，改由源码 + pc-column-mapping 技能承担）。",
  submit_understood_intent:
    "把你对用户这句话的理解提交给规则引擎。只做语义理解，不要查代码、不要调接口。" +
    "字段：isBusinessRequest（是否要查/改后台业务数据）、project、module（业务模块英文 id，来自源码路径）、" +
    "value（id/名称等）、operationType（read/write/unknown）、operationHint（列表/详情/新增等）、summary、" +
    "operation（可选，推荐：你选定的完整接口 id module.func——按 api-interface-routing 技能读 read_api_module 源码精确选出，留空则服务端按命名惯例兜底）。" +
    "注意：分页/多条数据需求（如\"前3页\"\"前20条\"）不在本工具表达——由你后续在 tool-loop 里多次调 call_api 拉取拼接（每次传对应分页参数），服务端不做分页循环。" +
    "module 给英文 id（来自源码路径）。能根据菜单名/源码路径直接确定可调用的英文模块 id 就直接填，不要为了确认多做一轮检索；" +
    "只有确实拿不准时才调 search_api_module / grep_codebase 检索 PC 端源码确认。填错会收到 MODULE_RETRY 提示，届时按提示重新检索即可。" +
    "不确定的槽位留空，operationType 用 unknown，不要猜测。",
  search_dingtalk_doc:
    "查询公司内部钉钉文档（alidocs.dingtalk.com）的内容。" +
    "当用户用自然语言询问公司内部的文档、规范、资料、知识库内容时使用（如「登录方式通道的文档在哪」「查一下 XX 规范」）。" +
    "参数：query（搜索关键词，必填）、maxResults（最多返回条数，默认 10）。" +
    "未配置企业应用凭证时返回配置指引，不会中断对话。",
  search_knowledge_base:
    "检索企业本地知识库（docs/knowledge/ 目录下的 md/txt/html 文档），返回相关文档段落与引用出处。" +
    "当用户用自然语言询问公司内部规范、流程、资料、知识库内容时使用（如「报销流程是什么」「部署规范在哪」）。" +
    "优先于 search_dingtalk_doc（本地知识库离线可用、响应快）；钉钉在线文档查不到时再用 search_dingtalk_doc。" +
    "参数：query（搜索关键词或自然语言问题，必填）、maxResults（最多返回条数，默认 5）。" +
    "返回结果带「来源：docs/knowledge/xxx」引用，可直接告知用户出处。",
  parse_intent:
    "规则层：校验四元组槽位是否齐全。应在大模型 submit_understood_intent 之后调用。" +
    "传入 understood* 字段（模型理解结果），本工具只做策略校验与反问，不再从原文猜模块。" +
    "project 优先从 session.activeProject 读取。缺少 project/module/operation 时返回 CLARIFICATION_REQUIRED。",
  set_project:
    "切换当前会话的全局项目上下文（activeProject）。" +
    "用户说「切换到xxx项目」「我要操作xxx系统」时调用，设置后后续所有请求都默认在该项目范围内执行。" +
    "支持的项目列表见 clarification-policy.json 中的 intentSchema.slots.project.options。",
  get_list_columns:
    "读取 PC 列表页 configs.data.tsx 中的列定义（title/dataIndex），用于与后台表头对齐。" +
    "用户要看列表、对齐字段、渲染表格表头时使用。",
  get_page_schema:
    "识别模块对应页面类型（list/edit/analysis_chart/bi_iframe/modal_form），并给出输出建议。" +
    "不确定该用表格、图表摘要还是详情分块时先调用。",
  render_table:
    "把数组或 {list:[]} 渲染成 Markdown 表格，并推送到聊天界面结构化预览。" +
    "支持 tree（children 层级缩进）与 footer（sum/avg 表尾）。" +
    "columns 的 title 传中文（用 get_list_columns 的 PC title，或按 pc-column-mapping 技能从当前项目源码取；key 必须与数据字段一致）。" +
    "注意：call_api 成功后服务端会自动受控渲染表格，通常无需调用本工具；" +
    "仅当服务端提示 [workflow/output-align] 时才手动调用。需要下载文件时再用 export_dataset。",
  summarize_chart_data:
    "把图表/时间序列收成文字摘要（趋势、极值、均值）+ 关键点表。" +
    "支持 PC 报表字段（cycle/统计数值字段），以及 metricField、seriesFields。" +
    "报表/Analysis/ECharts 页面使用；不要假装画图。摘要成功后必须立刻用自然语言回复用户。",
  read_field_mapping:
    "读取 field-mapping.json 中某模块的渲染规则（renderRules：位掩码位值/图片/数组分隔/布尔等）。" +
    "字段/枚举中文映射已不在配置表维护：表头或枚举值英文时，请按 pc-column-mapping 技能到当前项目源码找中文映射，不要编造。",
  export_dataset:
    "把表格数据导出为 Excel(.xlsx) 或 PDF，并在聊天中预览+提供下载。" +
    "支持 tree（children 树表）与 footer（sum/avg 表尾汇总）。" +
    "用户说导出、下载、Excel、PDF、汇总表时使用。" +
    "data 必须传真实数据行（来自 call_api 返回的 rows/list，或本次会话已渲染的表格数据），禁止用描述性文字占位。" +
    "必须通过函数调用通道发起本工具（禁止以 XML/JSON/自然语言文本形式模拟工具调用）。",
  get_current_time:
    "获取服务器当前日期与时间（ISO 格式）。当用户口语含相对时间（今天/昨天/本周/本月/最近 N 天等）" +
    "或调用接口需要 date/timeRange/timestamp 等时间参数时，先调用本工具取得当前日期，再自行换算为接口要求的参数；" +
    "禁止丢弃相对时间词、禁止反问用户要具体日期。返回 date(YYYY-MM-DD)、datetime(ISO 8601)、timestamp(毫秒)。",
  // M1（Supervisor 路由）：模型主动选择 Worker 上下文（领域×项目×环境）。服务端校验命中后装配工具子集与领域提示；
  // 路由判定完全交模型，工具仅描述可选值，无业务逻辑写死。
  route_to_agent:
    "切换当前 Agent 执行的 Worker（上下文域）。传入 domain（必填，可选值 backend-api/knowledge/common/finance/customer-service/database）" +
    "与可选 project（项目标识，如 bx-film-admin）、environment（test/prod，缺省 test）。服务端校验是否存在匹配 Worker，" +
    "命中后后续工具调用被限定在该 Worker 上下文（工具子集 + 领域提示），实现「按类型分 Agent」的路由。若不确定用哪个域，先用 request_clarification 收敛。",
};

// ---- M0（工具领域分组）：工具→领域标注（通用分类词，非业务词，符合「禁止写死」红线）----
export type ToolDomain =
  | "backend-api"        // 后台业务：模块定位 + 取数 + 渲染 + 代码改动
  | "knowledge"          // 知识检索：文档/网页/文件
  | "finance"            // 财务（M1+ 预留）
  | "customer-service"   // 客服咨询（M1+ 预留）
  | "database"           // 数据库直查（M1+ 预留）
  | "common";            // 通用：意图/反问/项目切换/时间

// 唯一事实来源；listAgentTools 自动附带 domain，新增工具漏标会在启动时告警（见 checkToolDomainCoverage）。
export const TOOL_DOMAIN: Record<string, ToolDomain> = {
  // 后台业务 API 域
  submit_understood_intent: "backend-api",
  search_api_module: "backend-api",
  read_api_module: "backend-api",
  call_api: "backend-api",
  grep_codebase: "backend-api",
  search_symbol: "backend-api",
  get_list_columns: "backend-api",
  get_page_schema: "backend-api",
  render_table: "backend-api",
  export_dataset: "backend-api",
  normalize_output: "backend-api",
  read_field_mapping: "backend-api",
  summarize_chart_data: "backend-api",
  write_code_file: "backend-api",
  git_commit_push: "backend-api",
  // 知识检索域
  search_knowledge_base: "knowledge",
  search_dingtalk_doc: "knowledge",
  read_file: "knowledge",
  list_dir: "knowledge",
  fetch_url: "knowledge",
  // 通用域
  request_clarification: "common",
  parse_intent: "common",
  set_project: "common",
  get_current_time: "common",
  // 路由工具（M1 Supervisor 选 Worker 上下文）本就属于通用调度层
  route_to_agent: "common",
};

export function getSubmitUnderstoodIntentTool(): AgentToolDef {
  // 完全抛弃 aliases（2026-08-22）：module 不再用候选 enum 约束，改为自由文本英文模块 id。
  // 模块定位 100% 交模型实时 grep 源码（search_api_module 底层 rg 扫 PC 端 src/api+src/views；
  // grep_codebase / read_api_module 配合），服务端 parse_intent 只做「英文 id 可调用性」安全校验。
  return {
    name: SUBMIT_UNDERSTOOD_INTENT,
    description: TOOL_DESCRIPTIONS.submit_understood_intent,
    inputSchema: {
      type: "object",
      properties: {
        isBusinessRequest: {
          type: "boolean",
          description: "用户是否要查询或修改后台业务数据（闲聊/问概念则为 false）",
        },
        project: { type: "string", description: "项目名或 key，不确定则留空" },
        module: {
          type: "string",
          description:
            "业务模块英文 id（来自源码路径，如 src/api 下的模块 key）。能确定就直接填，不要为了确认多做一轮检索；只有确实拿不准时才先调 search_api_module / grep_codebase 检索 PC 端源码确认后再填。" +
            "源码/菜单名常为「XX率数据统计」「XX统计」等规范名，口语词（如「留存报表」「xx报告」）整词搜不到时拆核心业务词（如「留存」）再搜；" +
            "查不到就留空，不要猜测、不要填中文",
        },
        value: { type: "string", description: "操作对象，如 id 或名称，没有则留空" },
        operation: {
          type: "string",
          description:
            "（可选，推荐）你选定的完整接口 id，格式 module.func（如 <模块>.getList、<模块>.getById、<模块>.update）。" +
            "能确定就直接填——先用 read_api_module 读模块接口源码，按 api-interface-routing 技能从函数名语义选出唯一接口；" +
            "拿不准多个列表接口选哪个时再 grep_codebase 查 PC 端页面实际调用。留空时服务端才按英文命名惯例兜底选接口（列表 getList/详情 byId 等）。",
        },
        operationType: {
          type: "string",
          enum: ["read", "write", "unknown"],
          description: "读/写；吃不准用 unknown，不要猜",
        },
        operationHint: { type: "string", description: "更细的动作，如 列表、详情、新增" },
        summary: { type: "string", description: "一句话复述你理解的用户意图" },
      },
      required: ["isBusinessRequest", "operationType"],
    },
  };
}

export function getRouteToAgentTool(): AgentToolDef {
  return {
    name: "route_to_agent",
    description: TOOL_DESCRIPTIONS.route_to_agent,
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          enum: ["backend-api", "knowledge", "common", "finance", "customer-service", "database"],
          description: "目标领域/上下文域（必填）",
        },
        project: { type: "string", description: "项目标识（如 bx-film-admin），backend-api 类通常需要" },
        environment: { type: "string", enum: ["test", "prod"], description: "环境，缺省 test" },
      },
      required: ["domain"],
    },
  };
}

export function listAgentTools(): AgentToolDef[] {
  const all: AgentToolDef[] = [
    getSubmitUnderstoodIntentTool(),
    {
      name: "search_api_module",
      description: TOOL_DESCRIPTIONS.search_api_module,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "业务模块名或关键词（用户口语业务词即可）",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "read_api_module",
      description: TOOL_DESCRIPTIONS.read_api_module,
      inputSchema: {
        type: "object",
        properties: {
          module: {
            type: "string",
            description: "模块名/别名（用户口语业务词或英文模块 id）或接口文件相对路径（src/api 下相对路径），支持逗号分隔多个",
          },
        },
        required: ["module"],
      },
    },
    {
      name: "call_api",
      description: TOOL_DESCRIPTIONS.call_api,
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
            description: "HTTP 方法",
          },
          operation: {
            type: "string",
            description: "接口操作名（推荐），格式 module.func，如 <模块>.getById、<模块>.getList；会自动映射到 base/path",
          },
          path: {
            type: "string",
            description: "接口相对路径（推荐），如 /v0.1/<模块路径>/<接口名>；与 base 配合使用，由服务端按登录国家自动拼域名",
          },
          base: {
            type: "string",
            enum: ["backend", "user", "film", "gather"],
            description: "API 基址类型：backend=管理后台(getUrl)、user=用户/通行证(getUserUrl)、film=影片服务(getFilmUrl)、gather=爬虫/影片匹配(getGatherUrl/getMovieMatchUrl)",
          },
          url: {
            type: "string",
            description: "完整 http URL（不推荐，易拼错）；优先用 path+base",
          },
          params: {
            type: "object",
            description: "请求参数：GET 时作为 query string，POST/PUT/PATCH/DELETE 时作为 JSON body",
            additionalProperties: true,
          },
          intent: {
            type: "object",
            description: "本次调用的意图契约：先把用户需求结构化声明，服务端据此做确定性自检（不判语义）。建议必填——声明后才能校验筛选条件是否落地、页数是否足够。",
            properties: {
              target: {
                type: "string",
                description: "要查的业务对象类别（来自用户原话的核心名词，如 <用户>/<订单>/<权限>/<影片> 等通用类别词），用于自检对照，不参与语义判定",
              },
              filters: {
                type: "array",
                description: "筛选条件列表；每一项都会校验其 value 是否实际进入 params（防止条件被吞）",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string", description: "筛选字段名（即接口契约的参数名，如 <status>/<type> 之类英文参数）" },
                    op: { type: "string", description: "比较方式：= / in / like / range，默认 =" },
                    value: { type: "string", description: "筛选值；若接口该字段是编码枚举（如 <0>/<1>/<2> 这类数字编码），请先用 get_field_mapping 查源码映射后传编码值，不要传中文业务词" },
                  },
                  required: ["field", "value"],
                },
              },
              paging: {
                type: "object",
                properties: {
                  wantPages: { type: "number", description: "期望页数（如「前3页」=3）" },
                  wantRows: { type: "number", description: "期望总条数" },
                },
              },
            },
          },
          log: {
            type: "object",
            description: "可选日志覆盖项：menuId/module/operator。不传则服务端自动推断并写入操作日志。",
            properties: {
              menuId: { type: "string" },
              module: { type: "string" },
              operator: { type: "string" },
            },
          },
          confirm: {
            type: "boolean",
            description: "是否需要用户确认后再执行（写操作请设为 true，查询操作设为 false）",
          },
          description: {
            type: "string",
            description: "一句话说明本次操作的业务含义，用于展示给用户（如「查询XX列表」）",
          },
        },
        required: ["method"],
      },
    },
    {
      name: "request_clarification",
      description: TOOL_DESCRIPTIONS.request_clarification,
      inputSchema: {
        type: "object",
        properties: {
          intent: { type: "string", description: "当前意图，如 查看详情 / 更新状态" },
          missingSlots: { type: "array", items: { type: "string" }, description: "缺失的关键槽位，如 module/operation/id" },
          question: { type: "string", description: "明确的反问句，必须可让用户收敛范围" },
          options: {
            type: "array",
            description: "候选项，建议 2-4 个",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "string" },
              },
              required: ["label", "value"],
            },
          },
          riskLevel: { type: "string", enum: ["read", "write"] },
        },
        required: ["intent", "missingSlots", "question", "options", "riskLevel"],
      },
    },
    {
      name: "parse_intent",
      description: TOOL_DESCRIPTIONS.parse_intent,
      inputSchema: {
        type: "object",
        properties: {
          userInput: {
            type: "string",
            description: "用户原始输入文本",
          },
          sessionProject: {
            type: "string",
            description: "当前会话的 activeProject.key（从 session 上下文读取，若已知则传入，避免重复问用户）",
          },
          understoodFromLlm: {
            type: "boolean",
            description: "是否已有大模型理解结果；为 true 时只校验槽位，不再从原文猜模块",
          },
          understoodProject: { type: "string", description: "模型理解的 project" },
          understoodModule: { type: "string", description: "模型理解的 module（可中文）" },
          understoodValue: { type: "string", description: "模型理解的 value" },
          understoodOperation: {
            type: "string",
            description: "模型理解的操作类型：read / write / unknown",
          },
        },
        required: ["userInput"],
      },
    },
    {
      name: "set_project",
      description: TOOL_DESCRIPTIONS.set_project,
      inputSchema: {
        type: "object",
        properties: {
          projectKey: {
            type: "string",
            description: "项目标识 key，如 bx-film-admin；参见 clarification-policy.json intentSchema.slots.project.options",
          },
          projectLabel: {
            type: "string",
            description: "项目展示名，如 影视后台管理系统",
          },
        },
        required: ["projectKey", "projectLabel"],
      },
    },
    {
      name: "grep_codebase",
      description: TOOL_DESCRIPTIONS.grep_codebase,
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "搜索关键词或正则（如 <函数名>/<中文业务词>），建议用业务名词/函数名/中文",
          },
          dir: {
            type: "string",
            description: "限定搜索目录，默认搜整个项目根目录。可传绝对路径（如 D:\\Code\\bx-film-admin-in2\\src\\api）",
          },
          fileGlob: {
            type: "string",
            description: "限定文件类型，如 *.ts、*.vue，默认不限制",
          },
          maxResults: {
            type: "number",
            description: "最多返回条数，默认 40",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "search_symbol",
      description: TOOL_DESCRIPTIONS.search_symbol,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "函数名片段 / 中文动作 / URL 片段（如 /v0.1/<接口路径>）",
          },
          limit: {
            type: "number",
            description: "最多返回条数，默认 8",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "write_code_file",
      description: TOOL_DESCRIPTIONS.write_code_file,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "codebaseRoot 内相对路径（如 src/api/xxx.ts）或绝对路径；禁止写 .git/node_modules/dist 等",
          },
          content: {
            type: "string",
            description: "文件完整新内容（整体覆盖），不超过 1MB",
          },
          description: {
            type: "string",
            description: "给用户确认时展示的改动说明（如「修复XX列表分页参数」）",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "git_commit_push",
      description: TOOL_DESCRIPTIONS.git_commit_push,
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "提交信息（如 feat: / fix: 开头）",
          },
          branch: {
            type: "string",
            description: "目标分支，默认当前 checkout 分支（业务项目测试=dev）；禁止 master/main 除非 allowMaster=true",
          },
          push: {
            type: "boolean",
            description: "是否 push 到 gitlab 远程，默认 true",
          },
          allowMaster: {
            type: "boolean",
            description: "仅当你确认要推生产分支（master/main）时才置 true（需二次确认）",
          },
          description: {
            type: "string",
            description: "给用户确认时展示的提交说明",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "normalize_output",
      description: TOOL_DESCRIPTIONS.normalize_output,
      inputSchema: {
        type: "object",
        properties: {
          module: {
            type: "string",
            description: "业务模块名（如 <模块>），用于查找字段映射规则",
          },
          data: {
            description: "API 原始返回数据（对象或数组），将对字段名和枚举值进行转换",
          },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "可选：只输出这些字段（对齐后的中文字段名），不传则输出全部字段",
          },
        },
        required: ["module", "data"],
      },
    },
    {
      name: "list_dir",
      description: TOOL_DESCRIPTIONS.list_dir,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: TOOL_PATH_DESC } },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: TOOL_DESCRIPTIONS.read_file,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: TOOL_PATH_DESC } },
        required: ["path"],
      },
    },
    {
      name: "fetch_url",
      description: TOOL_DESCRIPTIONS.fetch_url,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "http/https 完整 URL" } },
        required: ["url"],
      },
    },
    {
      name: "get_list_columns",
      description: TOOL_DESCRIPTIONS.get_list_columns,
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string", description: "模块/菜单名（英文模块 id 或中文菜单名）" },
          path: { type: "string", description: "可选：configs.data.tsx 相对或绝对路径" },
        },
      },
    },
    {
      name: "get_page_schema",
      description: TOOL_DESCRIPTIONS.get_page_schema,
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string", description: "模块/目录/菜单关键词" },
        },
        required: ["module"],
      },
    },
    {
      name: "render_table",
      description: TOOL_DESCRIPTIONS.render_table,
      inputSchema: {
        type: "object",
        properties: {
          data: { description: "行数组或 {list:[]} / API data 包装" },
          columns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                key: { type: "string" },
                dataIndex: { type: "string" },
              },
            },
            description: "表头；key/dataIndex 对应行字段",
          },
          maxRows: { type: "number", description: "最多行数，默认 50，上限 200" },
          title: { type: "string" },
          tree: { type: "boolean", description: "按 children 展平为树表" },
          footer: { description: "{sum:['amount'], label:'合计'} 或 footer 行对象" },
        },
        required: ["data"],
      },
    },
    {
      name: "summarize_chart_data",
      description: TOOL_DESCRIPTIONS.summarize_chart_data,
      inputSchema: {
        type: "object",
        properties: {
          data: { description: "number[] 或报表行[]（含 cycle/successCount）或 {date,value}[] 或 {categories,series}" },
          metricLabel: { type: "string", description: "指标名，如 Google登录 成功数" },
          metricField: { type: "string", description: "Y 字段，如 successCount" },
          xField: { type: "string", description: "X 字段，如 cycle" },
          seriesFields: {
            description: "多折线：[{field:'successCount',label:'成功数'}, ...]，对齐 PC Analysis",
          },
        },
        required: ["data"],
      },
    },
    {
      name: "read_field_mapping",
      description: TOOL_DESCRIPTIONS.read_field_mapping,
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string", description: "映射模块 key，如 <模块> 等英文模块 id" },
        },
        required: ["module"],
      },
    },
    {
      name: "export_dataset",
      description: TOOL_DESCRIPTIONS.export_dataset,
      inputSchema: {
        type: "object",
        properties: {
          data: { description: "行数组、树（含 children）或 {list:[]}" },
          columns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                key: { type: "string" },
                dataIndex: { type: "string" },
              },
            },
          },
          format: { type: "string", enum: ["xlsx", "pdf"], description: "默认 xlsx" },
          title: { type: "string" },
          filename: { type: "string" },
          tree: { type: "boolean", description: "按 children 展平为树表" },
          footer: {
            description: "表尾：{sum:['amount'], avg:['rate'], label:'合计'} 或直接 footer 行对象",
          },
        },
        required: ["data"],
      },
    },
    {
      name: "search_knowledge_base",
      description: TOOL_DESCRIPTIONS.search_knowledge_base,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词或自然语言问题（必填）" },
          maxResults: { type: "number", description: "最多返回条数，默认 5" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_current_time",
      description: TOOL_DESCRIPTIONS.get_current_time,
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "可选时区（IANA 名，如 Asia/Shanghai）；不传则用服务器本地时区",
          },
        },
      },
    },
    getRouteToAgentTool(),
  ];
  // M0（工具领域分组）：附 domain 元数据；漏标回退 common，未覆盖工具在启动时告警一次（见 checkToolDomainCoverage）。
  return all.map((t) => ({ ...t, domain: TOOL_DOMAIN[t.name] ?? "common" }));
}

// ---- M0：工具领域分组辅助（领域为通用分类词，非业务词，符合红线）----
// listAgentToolsForDomains 供 M1 Supervisor 路由命中 worker 后调用；M0 阶段仍全量注入，仅提供能力。
export function listAgentToolsForDomains(domains: ToolDomain[]): AgentToolDef[] {
  const set = new Set(domains);
  return listAgentTools().filter((t) => set.has((t.domain as ToolDomain) ?? "common"));
}

// 生成「按领域分组的工具目录」文本，注入 system 前缀，让模型看清工具归属（不裁掉任何工具，仅组织呈现）。
// 内容完全静态，模块级缓存避免多轮循环重复重建（buildStaticGuide 每 understand 轮调用一次）。
let catalogCache: string | null = null;
export function toolCatalogByDomain(): string {
  if (catalogCache) return catalogCache;
  const groups: Partial<Record<ToolDomain, string[]>> = {};
  for (const t of listAgentTools()) {
    const d = (t.domain as ToolDomain) ?? "common";
    (groups[d] ??= []).push(t.name);
  }
  const order: ToolDomain[] = ["backend-api", "knowledge", "finance", "customer-service", "database", "common"];
  const lines = order
    .filter((d) => groups[d]?.length)
    .map((d) => `- ${d}：${groups[d]!.join("、")}`);
  catalogCache = "[workflow/tool-catalog] 可用工具按领域分组（按需选用，无需全部使用）：\n" + lines.join("\n");
  return catalogCache;
}

// 开发期一次性校验：所有工具都应被 TOOL_DOMAIN 覆盖，漏标回退 common 并在控制台告警（不阻断运行）。
let domainCoverageChecked = false;
function checkToolDomainCoverage() {
  if (domainCoverageChecked) return;
  domainCoverageChecked = true;
  for (const t of listAgentTools()) {
    if (!TOOL_DOMAIN[t.name]) {
      console.warn(`[tools] 工具 ${t.name} 未配置 domain，已回退 common（请在 TOOL_DOMAIN 补充）`);
    }
  }
}
checkToolDomainCoverage();

// SSRF 防护：检查 URL 主机是否在白名单内（白名单为空时允许所有 http/https）。
function normalizeInternalUrl(url: string): string {
  try {
    const u = new URL(url);
    // 内网 xxbbc 域名只支持 http；https 会导致 SSL 错误或证书过期
    if (u.protocol === "https:" && /\.xxbbc\.com$/i.test(u.hostname)) {
      u.protocol = "http:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url;
}

function checkApiHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "错误：URL 格式无效；请提供完整的 http/https URL（如 http://localhost:3100/api/...）";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "错误：协议不支持；call_api 仅支持 http/https 协议";
  }
  const allowed = config.allowedApiHosts;
  if (allowed.length > 0) {
    const host = parsed.host; // 含端口，如 localhost:3100
    const hostname = parsed.hostname; // 不含端口
    if (!allowed.some((h) => h === host || h === hostname)) {
      return `错误：目标主机 ${host} 不在白名单内；请在 ALLOWED_API_HOSTS 中添加（当前白名单：${allowed.join(", ")}）`;
    }
  }
  return null;
}

export interface ApiCallOptions {
  token?: string;
  country?: CountryConfig;
  menus?: unknown[];
  sessionId?: string;  // 用于 parse_intent / set_project 读写会话级全局项目上下文
  /** 当前用户原句，用于报表参数默认（如 Google / 近7天） */
  userText?: string;
  /** 操作者归属（countryId:loginName，P2 溯源 + 多项目 ACL 判定） */
  ownerKey?: string;
}

interface ClarificationPayload {
  intent: string;
  missingSlots: string[];
  question: string;
  options: Array<{ label: string; value: string }>;
  riskLevel: "read" | "write";
  resumeTool: "call_api";
  resumeInput: Record<string, unknown>;
}

function toClarificationText(payload: ClarificationPayload): string {
  return `CLARIFICATION_REQUIRED\n${JSON.stringify(payload, null, 2)}`;
}

function flattenMenus(menus: unknown[]): Array<{ id?: string | number; name?: string; englishName?: string }> {
  const out: Array<{ id?: string | number; name?: string; englishName?: string }> = [];
  const stack = [...menus];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const item = cur as Record<string, unknown>;
    out.push({
      id: item.id as string | number | undefined,
      name: item.name as string | undefined,
      englishName: item.englishName as string | undefined,
    });
    const children = item.children;
    if (Array.isArray(children)) stack.push(...children);
  }
  return out;
}

// 2026-08-24 去写死：删除 MODULE_TO_MENU_ENGLISH 静态映射表（模块英文 id → 菜单英文名，39 条手工维护，
// 违反「禁止写死映射」红线）。操作日志的 menuId 仅在菜单英文名 == 模块 id 时直接命中（极少），
// 命中不了则留空（日志仍正常记录，仅不关联菜单高亮）。菜单关联由模型/前端动态处理，服务端不维护映射。
function resolveMenuId(moduleName: string, menus: unknown[]): string {
  const flat = flattenMenus(menus);
  const direct = flat.find((m) => m.englishName === moduleName);
  if (direct?.id != null) return String(direct.id);
  return "";
}

function inferOperator(method: string, path: string): string {
  const p = path.toLowerCase();
  if (p.includes("getdetail")) return "查询详情";
  if (p.includes("list") || p.includes("/get")) return "查询列表";
  if (p.includes("setvisible")) return "设置状态";
  if (p.includes("delete") || p.includes("del")) return "删除";
  if (p.includes("create")) return "新增";
  if (p.includes("update")) return "更新";
  if (method === "GET") return "查询";
  return "操作";
}

async function appendOperationLog(args: {
  opts: ApiCallOptions;
  path: string;
  fullUrl: string;
  params: Record<string, unknown>;
  method: string;
  resolvedOp?: ApiOperation | null;
  resolvedModule?: string;
  inputLog?: Record<string, unknown>;
}): Promise<void> {
  const { opts, path, fullUrl, params, method, resolvedOp, resolvedModule, inputLog } = args;
  if (!opts.country || !opts.token) return;
  const policy = getRouterPolicy();

  // 强制对齐 PC：默认仅记录前端明确配置了 getLogOptions(...) 的 operation。
  // 可通过 log.enabled 显式覆盖（true/false）用于灰度排查。
  const manualEnabled = typeof inputLog?.enabled === "boolean" ? Boolean(inputLog.enabled) : null;
  const shouldLog = policy.guards.pcLogAlignmentOnly
    ? Boolean(resolvedOp?.logEnabled)
    : (manualEnabled ?? Boolean(resolvedOp?.logEnabled));
  if (!shouldLog) return;

  const moduleName = String(inputLog?.module || resolvedOp?.logModule || resolvedModule || "unknown");
  const menuId = String(inputLog?.menuId || (Array.isArray(opts.menus) ? resolveMenuId(moduleName, opts.menus) : ""));
  const operator = String(inputLog?.operator || resolvedOp?.logOperator || inferOperator(method, path));
  const body = {
    operator,
    module: moduleName,
    body: params,
    url: fullUrl,
  };

  try {
    await callUpstream({
      country: opts.country,
      token: opts.token,
      method: "POST",
      path: "/v0.1/operationlog/add",
      baseUrlKey: "backend",
      params: {
        lang: "en-US",
        menuId,
        content: JSON.stringify(body),
      },
    });
  } catch {
    // 日志失败不影响主流程结果
  }
}

/** 列表数据行数保护：超大 rows/list/records/items 先裁剪到 maxRows 并加占位行提示。
 *  相比 stringifyResult 的纯字符截断（JSON 会被拦腰截断、normalize_output 解析失败），
 *  这里保持 JSON 合法，同时防止一次 call_api 顶满 20K 上下文、压慢模型收尾轮。 */
function limitListRows(data: unknown, maxRows = 50): unknown {
  if (Array.isArray(data)) {
    return data.length > maxRows
      ? [...data.slice(0, maxRows), { _truncated: `仅显示前 ${maxRows} 条，共 ${data.length} 条` }]
      : data;
  }
  if (data && typeof data === "object") {
    const v = data as Record<string, unknown>;
    const out: Record<string, unknown> = { ...v };
    for (const key of ["rows", "list", "records", "items"]) {
      const arr = out[key];
      if (Array.isArray(arr) && arr.length > maxRows) {
        out[key] = [...arr.slice(0, maxRows), { _truncated: `仅显示前 ${maxRows} 条，共 ${arr.length} 条` }];
      }
    }
    return out;
  }
  return data;
}

function stringifyResult(data: unknown): string {
  const limited = limitListRows(data, 50);
  const text = typeof limited === "string" ? limited : JSON.stringify(limited, null, 2);
  const MAX = config.contextMaxChars;
  return text.length > MAX ? `${text.slice(0, MAX)}\n...(响应过长已截断，共 ${text.length} 字符)` : text;
}

/** call_api 兜底（2026-08-24）：operation 模块片段（如 <接口模块片段> / <页面目录片段>）在索引中
 *  多候选/无候选时，实时 grep codebase src/api 找包含该片段的接口文件；唯一命中则映射为其模块 operation。
 *  弱模型不按 search_api_module 候选执行时的确定性收尾（纯源码驱动，零静态映射表；多命中不猜）。 */
export function resolveOperationByApiGrep(operation: string): ApiOperation | null {
  const seg = operation.split(".").map((s) => s.trim()).filter(Boolean);
  const token = (seg[0] || "").trim();
  const opSuffix = seg.length > 1 ? seg[seg.length - 1] : "";
  if (!token) return null;
  const apiDir = nodePath.join(resolveCodebaseRoot(), "src", "api");

  // 2026-08-24 修复：点号模块段 → 斜杠路径直查。弱模型常把模块路径 movie/autoUpload
  // 写成 movie.autoUpload（operation 整体 movie.autoUpload.getList），原逻辑只取首段 movie
  // grep 多命中不猜 → MODULE_RETRY → 模型被迫 grep/read_file 绕路（影片上传自动化实测）。
  // 兼容三种写法：movie/autoUpload.getList（斜杠）、movie.autoUpload.getList（点号）、混合。
  if (seg.length >= 2) {
    const modPath = seg.slice(0, -1).join("/"); // movie/autoUpload
    const directFile = nodePath.join(apiDir, `${modPath}.ts`);
    if (existsSync(directFile)) {
      // 有 func 后缀：走 resolve（含结构回落）；无后缀：模块下唯一接口才采纳（不默认 getList）
      if (opSuffix) {
        return (
          resolveApiOperation(`${modPath}.${opSuffix}`) ||
          resolveApiOperation(`${seg.slice(0, -1).join(".")}.${opSuffix}`)
        );
      }
      return resolveUniqueOpUnderModule(modPath);
    }
  }

  let raw = "";
  try {
    raw = execSync(
      `rg --no-heading --line-number --color never -i -m 12 -- "${token.replace(/"/g, '\\"')}" "${apiDir}"`,
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
    ).toString();
  } catch {
    raw = grepCodebaseNative(token, apiDir, "", 20);
  }
  const files = new Set<string>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const m = line.match(/^([A-Za-z]:\\(?:[^:]+)):\d+:/) || line.match(/^([A-Za-z]:\/(?:[^:]+)):\d+:/);
    if (m) files.add(m[1]);
  }
  if (files.size !== 1) return null; // 0 或多命中不猜，保持原有候选追问
  const file = [...files][0].replace(/\\/g, "/");
  const fm = file.match(/src\/api\/(.+)\.ts$/);
  if (!fm) return null;
  const moduleId = fm[1]; // 如 <模块>/<接口模块>
  if (opSuffix) {
    return (
      resolveApiOperation(`${moduleId}.${opSuffix}`) ||
      resolveApiOperation(`${moduleId.replace(/\//g, ".")}.${opSuffix}`)
    );
  }
  return resolveUniqueOpUnderModule(moduleId);
}

/** 模块路径下若索引仅有 1 个 operation 则采纳，多接口不猜（替代写死 getList） */
function resolveUniqueOpUnderModule(modulePath: string): ApiOperation | null {
  const needle = modulePath.replace(/\\/g, "/").replace(/\.ts$/i, "").toLowerCase();
  if (!needle) return null;
  const ops = loadApiOperationIndex().operations.filter((o) => {
    const mod = (o.module || "").replace(/\\/g, "/").toLowerCase();
    const idHead = (o.id.split(".")[0] || "").replace(/\./g, "/").toLowerCase();
    const file = (o.file || "").replace(/\\/g, "/").replace(/\.ts$/i, "").toLowerCase();
    return mod === needle || mod.endsWith("/" + needle) || idHead === needle || file.endsWith("/" + needle) || file === needle;
  });
  return ops.length === 1 ? ops[0] : null;
}

/** ⚠️【临时只读模式】统一返回文案：写操作被拦截时的提示（2026-08-25，恢复读写时连同两处守卫一起删除）。 */
export const READONLY_REPLY =
  "只读模式：当前系统仅开放查询功能，新增/修改/删除等写操作暂不可用（临时限制，恢复时间另行通知）。";

/**
 * ⚠️【临时只读模式】写操作判定（2026-08-25）：
 * 只拦「真实增删改」，放行 POST 的统计/查询接口（如 <读语义统计函数> 这类 POST 统计——函数名是
 * get 前缀读语义，非写操作）。判定 = 方法非 GET 且 函数名含写动词（英文 CRUD 契约词，非业务词）：
 *   create/add/insert/update/modify/edit/delete/remove/save/enable/disable/audit/reject/approve/
 *   push/send/clear/reset/start/stop/publish/offline/online/bind/unbind/set/status/change
 * 函数名从 operation（module.func）或 path 最后一段提取；纯读动词（get/query/list/detail/stat/
 * report/option/page/search/export）不算写。恢复读写时删除本函数与两处守卫即可。
 */
function isReadonlyBlocked(method: string, operation?: string, apiPath?: string, url?: string): boolean {
  if (method === "GET") return false;
  const ident = [operation, apiPath, url]
    .filter(Boolean)
    .map((s) => String(s))
    .join(" ")
    .split(/[/.]/g)
    .pop() || "";
  return /(?:create|add|insert|update|modify|edit|delete|remove|save|enable|disable|audit|reject|approve|push|send|clear|reset|start|stop|publish|offline|online|bind|unbind|change)\b/i.test(ident);
}

export async function execCallApi(
  input: Record<string, unknown>,
  opts: ApiCallOptions = {},
): Promise<string> {
  const policy = getRouterPolicy();
  // 类型放宽：后续若 resolvedOp.method 存在会被真实索引方法覆盖（L920 后）。
  let method = String(input.method || "GET").toUpperCase();
  let params = (input.params && typeof input.params === "object" && !Array.isArray(input.params))
    ? { ...(input.params as Record<string, unknown>) }
    : {};

  const operation = String(input.operation || "").trim();
  const inputPath = String(input.path || "").trim();
  let resolvedOp = operation ? resolveApiOperation(operation) : resolveApiOperationByPath(inputPath);
  // 仅 path、精确未命中：后缀唯一匹配 → 再按 path 末两段猜 module.func（/v0.1/user/getList→user.getList）
  if (!operation && !resolvedOp && inputPath) {
    resolvedOp =
      resolveApiOperationByPathSuffix(inputPath) ||
      (() => {
        const guess = guessOperationIdFromPath(inputPath);
        return guess ? resolveApiOperation(guess) || resolveOperationByApiGrep(guess) : null;
      })();
  }
  // 模型输出的 camelCase 模块名经 resolveApiOperation 归一化后仍可能需候选择一
  if (operation && !resolvedOp) {
    const candidates = findApiOperationCandidates(operation, 4);
    if (candidates.length === 1) {
      resolvedOp = candidates[0];
    } else {
      // 服务端源码兜底（2026-08-24）：operation 的模块片段（如 <接口模块片段> / <页面目录片段>）
      // 在索引中多候选/无候选时，实时 grep codebase src/api 找包含该片段的接口文件；
      // 唯一命中则直接映射为其模块 operation——弱模型不按 search_api_module 候选执行时的确定性收尾。
      resolvedOp = resolveOperationByApiGrep(operation);
    }
  }
  const resolvedModule = resolvedOp?.module?.split("/").slice(-1)[0];
  // 索引登记了真实 HTTP 方法（如 POST）：模型常漏传/传错 method，必须以索引为准，
  // 否则 GET 打到 POST 接口会触发网关「invalid method of HTTP」。
  if (resolvedOp?.method) method = resolvedOp.method.toUpperCase();
  let apiPath = (resolvedOp?.path || inputPath);
  const base = (resolvedOp?.base || String(input.base || "backend").trim()) as BaseUrlKey;
  const url = normalizeInternalUrl(String(input.url || "").trim());

  // 2026-08-24 去写死：删除「列表/分页接口缺参补默认 page=1, size=100」的服务端写死默认值——
  // 分页参数（page/size/pageSize）完全由模型按接口契约（read_api_module 读源码）在 params 里提供，
  // 服务端不补任何默认值（参考 Cursor 模型自主决定数据量）。

  if (operation && !resolvedOp) {
    // operation 传了但索引里找不到：提示 parse_intent 层重新推断，不在这里反问用户
    // 避免两套反问逻辑并存造成文案混乱
    const candidates = findApiOperationCandidates(operation, 4);
    appendClarificationMetric({
      type: "clarification_required",
      reason: "operation_not_resolved",
      operation,
      candidateCount: candidates.length,
    });
    if (candidates.length) {
      // 有候选项时，通过 CLARIFICATION_REQUIRED 让 workflow 层按四元组规则反问
      const options = candidates.map((c) => ({ label: `${c.id}`, value: c.id }));
      return toClarificationText({
        intent: "调用业务接口",
        missingSlots: ["module"],
        question: `你要操作哪个模块？「${operation}」匹配到以下候选：`,
        options,
        riskLevel: method === "GET" ? "read" : "write",
        resumeTool: "call_api",
        resumeInput: { ...input, method, params },
      });
    }
    // 没有任何候选：引导用户用中文模块名描述
    return toClarificationText({
      intent: "调用业务接口",
      missingSlots: ["module"],
      question: `未能识别「${operation}」对应的模块，请确认你要操作的业务模块：`,
      options: [
        { label: "按模块检索", value: "__search__" },
      ],
      riskLevel: method === "GET" ? "read" : "write",
      resumeTool: "call_api",
      resumeInput: { ...input, method, params },
    });
  }
  if (!operation && policy.guards.requireOperation && !apiPath && !url) {
    // 缺 operation：不是「模块没说」，而是接口操作未落到索引；勿用无关模块候选项误导用户
    appendClarificationMetric({
      type: "clarification_required",
      reason: "operation_required_by_policy",
      method,
    });
    return toClarificationText({
      intent: "调用业务接口",
      missingSlots: ["operation"],
      question:
        "已理解你的业务意图，但还缺可调用的接口操作名。请补充：要查的是哪个菜单下的列表/详情，" +
        "或直接给出「模块名+操作」（格式 module.func，如 <模块>.getList），由你确认后重试。",
      options: [
        { label: "按模块名重新检索后重试", value: "search_api_module" },
        { label: "直接调用列表接口（module.getList）", value: "list" },
        { label: "直接调用详情接口（module.getById）", value: "detail" },
      ],
      riskLevel: method === "GET" ? "read" : "write",
      resumeTool: "call_api",
      resumeInput: { ...input, method, params },
    });
  }
  if (policy.guards.denyUnknownOperation && !resolvedOp && operation) {
    return `错误：operation 不在索引中：${operation}`;
  }
  // 2026-08-25 彻底去参数别名：paramAliases 已随 project-aliases.json 删除（全交给大模型），
  // 参数名由模型按 api-interface-routing skill 读接口源码后直接填 call_api.params，不做任何映射。

  // 2026-08-24 去写死：删除「/movie/getDetail 参数兼容」硬编码（特定接口路径 + movieId 转换规则，
  // 属写死特定业务适配）。模型应按 api-interface-routing skill 读接口源码拿到正确参数名（movieId）；
  // 若仍传错，后端如实报错回显，服务端不维护特定接口的兼容规则。

  // 推荐：path + base + 登录国家线
  if (apiPath) {
    const strictIndex = policy.guards.strictIndexPath || process.env.CALL_API_STRICT_INDEX === "1";
    if (strictIndex && !hasOperationPath(apiPath)) {
      // 2026-08-24：模型常抄残缺 path（如 /v1.9.0/beac/list 丢前缀）。精确未命中时尝试唯一后缀匹配，
      // 唯一命中则修正为索引登记 path 继续；多命中/无命中才报未登记。
      const suffixOp = resolveApiOperationByPathSuffix(apiPath);
      if (suffixOp) {
        resolvedOp = suffixOp;
        apiPath = suffixOp.path;
      } else {
        const guess = guessOperationIdFromPath(apiPath);
        const guessedOp = guess
          ? resolveApiOperation(guess) || resolveOperationByApiGrep(guess)
          : null;
        if (guessedOp) {
          resolvedOp = guessedOp;
          apiPath = guessedOp.path;
          if (guessedOp.method) method = guessedOp.method.toUpperCase();
        } else {
          return `错误：path ${apiPath} 未在接口索引中登记；请改用 operation 调用，或先更新 api-operation-index.json`;
        }
      }
    }
    if (!opts.country) {
      return "错误：未获取登录国家线；请重新登录后再调用接口";
    }

    // ⚠️【临时只读模式】apiPath 分支写操作拦截（置于 mock 分支前，真实与 mock 语义一致）：
    // 只拦「增删改」（method 非 GET 且函数名含写动词），POST 统计查询（如 <读语义统计函数>）放行。
    // 此分支覆盖模型 tool 节点 + 服务端兜底编排的 path 方式；url 直发分支另有同语义守卫。
    if (isReadonlyBlocked(method, operation, apiPath, url)) {
      return READONLY_REPLY;
    }

    // mock-token / MOCK_UPSTREAM：不打真实网关，避免评测与未登录环境「登录过期」
    if (config.mockUpstream || isMockToken(opts.token)) {
      const mocked = mockCallApiResult({
        operation,
        path: apiPath,
        method,
        params,
      });
      return stringifyResult(mocked);
    }

    const baseUrl = resolveBaseUrl(opts.country, base);
    if (!baseUrl) {
      return `错误：当前国家线未配置 ${base} 地址；请在服务端 COUNTRY_* 环境变量中配置`;
    }
    const fullUrl = `${baseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
    const hostErr = checkApiHost(fullUrl);
    if (hostErr) return hostErr;
    try {
      const data = await callUpstream({
        country: opts.country,
        token: opts.token || "",
        method: method === "POST" ? "POST" : "GET",
        path: apiPath,
        baseUrlKey: base,
        params,
      });
      await appendOperationLog({
        opts,
        path: apiPath,
        fullUrl,
        params,
        method,
        resolvedOp,
        resolvedModule,
        inputLog: (input.log && typeof input.log === "object" ? input.log as Record<string, unknown> : undefined),
      });
      let resultText = stringifyResult(data);

      // 写操作回读：仅在策略开启且存在同模块 getById 时执行。
      if (policy.guards.postWriteReadback && method !== "GET" && resolvedOp && params.id != null) {
        const readOp = resolveApiOperation(`${resolvedOp.module}.getById`);
        if (readOp) {
          try {
            const rb = await callUpstream({
              country: opts.country,
              token: opts.token || "",
              method: "GET",
              path: readOp.path,
              baseUrlKey: readOp.base,
              params: { id: params.id },
            });
            resultText += `\n\n[readback]\n${stringifyResult(rb)}`;
          } catch (e) {
            resultText += `\n\n[readback_error] ${(e as Error).message}`;
          }
        }
      }
      return resultText;
    } catch (e) {
      return `错误：请求失败；${(e as Error).message}`;
    }
  }

  if (!url) {
    appendClarificationMetric({
      type: "clarification_required",
      reason: "missing_path_and_url",
      method,
    });
    return toClarificationText({
      intent: "调用业务接口",
      missingSlots: ["path_or_url"],
      question: "你希望我按哪种方式调用接口？",
      options: [
        { label: "提供 operation（推荐）", value: "operation" },
        { label: "提供 path + base", value: "path_base" },
        { label: "提供完整 url", value: "url" },
      ],
      riskLevel: method === "GET" ? "read" : "write",
      resumeTool: "call_api",
      resumeInput: { ...input, method, params },
    });
  }

  // ⚠️【临时只读模式】call_api 的 url 直发分支同样拦截写操作——该分支走原生 fetch，
  // 不经上面的 apiPath 分支，需独立守卫（与 apiPath 分支守卫同一只读语义）。
  if (isReadonlyBlocked(method, operation, apiPath, url)) {
    return READONLY_REPLY;
  }

  if (config.mockUpstream || isMockToken(opts.token)) {
    return stringifyResult(
      mockCallApiResult({ operation, path: url, method, params }),
    );
  }

  const hostErr = checkApiHost(url);
  if (hostErr) return hostErr;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    clientType: "5",
    lang: "en-US",
  };
  if (opts.token) headers.Authorization = opts.token;

  let fetchUrl = url;
  let init: RequestInit = { method, headers };

  if (method === "GET") {
    const u = new URL(url);
    u.searchParams.set("_t", String(Date.now()));
    u.searchParams.set("clientType", "5");
    u.searchParams.set("lang", "en-US");
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    fetchUrl = u.toString();
  } else {
    init.body = JSON.stringify({ lang: "en-US", clientType: 5, ...params });
  }

  let response: Response;
  try {
    response = await fetch(fetchUrl, { ...init, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    const msg = (e as Error).message;
    const hint = url.startsWith("https://") && /\.xxbbc\.com/i.test(url)
      ? "；内网域名请改用 path+base 或 http:// 协议"
      : "";
    return `错误：请求失败；${msg}${hint}；请检查目标服务是否可达`;
  }

  const text = await response.text();
  if (!response.ok) {
    return `错误：HTTP ${response.status}；${text.slice(0, 500)}`;
  }

  await appendOperationLog({
    opts,
    path: new URL(fetchUrl).pathname,
    fullUrl: fetchUrl,
    params,
    method,
    resolvedOp,
    resolvedModule,
    inputLog: (input.log && typeof input.log === "object" ? input.log as Record<string, unknown> : undefined),
  });

  return stringifyResult(text);
}

/**
 * rg（ripgrep）缺失时的 Node 原生递归搜索兜底。
 * 服务器未安装 ripgrep 时，grep_codebase 仍可工作，避免工具反复失败拖慢工具链。
 */
/** statSync 容错：路径不存在返回 null */
function tryStat(p: string): import("node:fs").Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** 单文件 grep：模型把 dir 传成文件路径时，直接对该文件内容做行级匹配（rg 同样作用于单文件） */
function grepSingleFile(pattern: string, file: string, maxResults: number): string {
  try {
    const content = readFileSync(file, "utf-8");
    const re = new RegExp(pattern, "i");
    const lines = content.split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re.test(lines[i])) hits.push(`${file}:${i + 1}:${lines[i].slice(0, 200)}`);
    }
    if (!hits.length) return `未找到匹配 "${pattern}" 的结果（文件: ${file}）`;
    return `搜索关键词: ${pattern}\n文件: ${file}\n结果 ${hits.length} 条:\n\n` + hits.join("\n");
  } catch (err: unknown) {
    return `错误：读取文件失败；${(err as Error).message}`;
  }
}

function grepCodebaseNative(pattern: string, root: string, fileGlob: string, maxResults: number): string {
  const re = new RegExp(pattern, "i");
  const globRe = fileGlob ? new RegExp(fileGlob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"), "i") : null;
  const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nuxt", ".output", "logs", "tmp"]);
  const results: string[] = [];

  const walk = (dir: string, depth = 0) => {
    if (depth > 12 || results.length >= maxResults) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxResults) return;
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) continue;
        walk(nodePath.join(dir, ent.name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (globRe && !globRe.test(ent.name)) continue;
      const full = nodePath.join(dir, ent.name);
      try {
        const text = readFileSync(full, "utf8");
        for (const [lineIdx, line] of text.split("\n").entries()) {
          if (re.test(line)) {
            results.push(`${full.replace(/\\/g, "/")}:${lineIdx + 1}:${line.slice(0, 300)}`);
            break; // 每文件最多 1 条，与 rg -m 1 一致
          }
        }
      } catch {
        /* 二进制/不可读文件跳过 */
      }
    }
  };
  walk(root);

  if (!results.length) return "";
  return results.slice(0, maxResults).join("\n");
}

/** 校验并解析当前项目代码根目录内的路径（防越界/防写入危险目录）。
 *  返回 { ok: true, full, root } 或 { ok: false, error }。 */
function resolveCodebasePath(raw: string): { ok: true; full: string; root: string } | { ok: false; error: string } {
  const root = resolveCodebaseRoot();
  const full = nodePath.resolve(root, String(raw || ""));
  const rel = nodePath.relative(root, full);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel) || rel === "") {
    return { ok: false, error: `路径越界：${raw} 不在当前项目代码目录内（${root}）` };
  }
  if (/^(\.git|node_modules|dist|build|coverage|\.nuxt|\.output|logs|tmp)(\\|\/|$)/.test(rel)) {
    return { ok: false, error: `禁止写入目录：${raw}（${rel} 是依赖/构建产物目录）` };
  }
  return { ok: true, full, root };
}

export async function runAgentTool(
  name: string,
  input: Record<string, unknown>,
  opts: ApiCallOptions = {},
): Promise<string> {
  if (name === SUBMIT_UNDERSTOOD_INTENT) {
    const understood = parseUnderstoodIntent(input);
    return JSON.stringify({ _understood: true, ...understood }, null, 2);
  }

  if (name === "set_project") {
    const projectKey = String(input.projectKey || "").trim();
    const projectLabel = String(input.projectLabel || "").trim();
    if (!projectKey || !projectLabel) return "错误：参数缺失；projectKey 和 projectLabel 均为必填；请传入项目标识和展示名";
    // P2 多项目 ACL：项目必须在注册表内；allowOwners 配置时仅名单内操作者可切换
    //（未配置 = 开放）。判定先于会话写入，拒绝时不产生任何副作用。
    const cfg = getProjectConfig(projectKey);
    if (!cfg) return `错误：未知项目标识 ${projectKey}；可用项目清单见澄清策略配置`;
    if (!projectAccessibleBy(cfg, opts.ownerKey)) {
      return `错误：当前账号无权访问该项目（${projectKey}）；如需开通请联系管理员在项目配置的 allowOwners 中加入该账号`;
    }
    const sid = opts.sessionId;
    if (!sid) return "错误：无法读取会话 ID；请重新登录";
    const ok = setActiveProject(sid, { key: projectKey, label: cfg.label || projectLabel, setAt: Date.now() });
    if (!ok) return "错误：会话不存在；请重新登录";
    return `已切换全局项目上下文：${cfg.label || projectLabel}（${projectKey}）。后续所有请求均默认在此项目范围内执行，无需重复声明。`;
  }

  if (name === "write_code_file") {
    const rawPath = String(input.path || "").trim();
    const content = String(input.content ?? "");
    if (!rawPath) return "错误：参数缺失；path 为必填参数";
    if (content.length > 1024 * 1024) return "错误：文件内容超过 1MB，禁止写入";
    const res = resolveCodebasePath(rawPath);
    if (!res.ok) return res.error;
    try {
      mkdirSync(nodePath.dirname(res.full), { recursive: true });
      writeFileSync(res.full, content, "utf8");
      return `已写入 ${res.full.replace(/\\/g, "/")}（${content.length} 字符）`;
    } catch (e: unknown) {
      return `错误：写入失败；${(e as Error).message}`;
    }
  }

  if (name === "git_commit_push") {
    const message = String(input.message || "").trim();
    if (!message) return "错误：参数缺失；message（提交信息）为必填参数";
    const root = resolveCodebaseRoot();
    const branch = String(input.branch || "").trim();
    const push = input.push !== false;
    const allowMaster = input.allowMaster === true;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const sh = (args: string[]): string =>
      execFileSync("git", ["-C", root, ...args], { env, stdio: "pipe", encoding: "utf8", timeout: 180000 }).toString().trim();
    try {
      const curBranch = sh(["rev-parse", "--abbrev-ref", "HEAD"]);
      // 分支保护前置：目标分支（显式 branch 或当前分支）为 master/main 且未显式放行 → 直接拦截，
      // 避免先 checkout 出本地 master 分支造成副作用。
      const targetBranch = branch || curBranch;
      if ((targetBranch === "master" || targetBranch === "main") && !allowMaster) {
        return "错误：禁止直接提交/推送生产分支 master/main；请先切换到 dev 或功能分支（确需推生产请显式 allowMaster=true 并二次确认）";
      }
      let cur = curBranch;
      if (branch && branch !== cur) {
        try {
          sh(["checkout", branch]);
        } catch {
          try {
            sh(["checkout", "-B", branch, `origin/${branch}`]);
          } catch {
            return `错误：分支 ${branch} 本地与远程均不存在，无法切换`;
          }
        }
        cur = branch;
      }
      const status = sh(["status", "--porcelain"]);
      if (!status) return `提交跳过：${root} 无任何改动`;
      sh(["add", "-A"]);
      let identity: string[] = [];
      try {
        const name = sh(["config", "user.name"]);
        const email = sh(["config", "user.email"]);
        if (!name || !email) identity = ["-c", "user.name=Agent", "-c", "user.email=agent@local"];
      } catch {
        identity = ["-c", "user.name=Agent", "-c", "user.email=agent@local"];
      }
      sh([...identity, "commit", "-m", message]);
      const head = sh(["rev-parse", "--short", "HEAD"]);
      const files = status.split("\n").slice(0, 30).map((l) => `  ${l}`).join("\n");
      if (push) {
        sh(["push", "origin", cur]);
        return `已提交并推送 ${cur} @ ${head}：${message}\n改动文件：\n${files}`;
      }
      return `已提交 ${cur} @ ${head}：${message}（push=false 未推送）\n改动文件：\n${files}`;
    } catch (e: unknown) {
      return `错误：git 操作失败；${(e as Error).message}`;
    }
  }

  if (name === "route_to_agent") {
    const domain = String(input.domain || "").trim();
    const project = input.project ? String(input.project).trim() : undefined;
    const environment = input.environment ? String(input.environment).trim() : "test";
    if (!domain) return "错误：参数缺失；domain 为必填（可选值见工具描述）";
    const worker = resolveWorker(domain, project, environment);
    if (!worker) {
      const available = DEFAULT_WORKERS.map(
        (w) => `${w.id}(${w.domain}${w.project ? "/" + w.project : ""}${w.environment ? "/" + w.environment : ""})`,
      ).join(", ");
      return `未找到匹配 Worker（domain=${domain} project=${project ?? "-"} env=${environment}）。已注册：${available}`;
    }
    return `已切换到 Worker「${worker.label}」（id=${worker.id}）。后续工具调用将限定在该 Worker 上下文（工具子集 + 领域提示）。\n[ACTIVE_WORKER:${worker.id}]`;
  }

  if (name === "parse_intent") {
    const userInput = String(input.userInput || "").trim();
    if (!userInput) return "错误：参数缺失；userInput 为必填参数";

    // 从 session 读取已有的全局项目上下文（superpower 层：跨轮记忆）
    const sid = opts.sessionId;
    const activeProject = sid ? (ensureDefaultProject(sid) || getActiveProject(sid)) : null;
    const sessionProjectKey = String(input.sessionProject || activeProject?.key || "").trim();
    const sessionProjectLabel = activeProject?.label || "";

    // ---- 读取策略配置里的项目列表和槽位规则 ----
    // 2026-08-25 去写死：项目列表只从 clarification-policy.json 的 project.options（单一来源，
    // 项目注册表）读取；读失败不再降级到写死的「影视后台」——交模型按注册表缺失情况处理，
    // 避免代码里硬编码具体业务项目名。
    const policyPath = defaultClarificationPolicyPath();
    let projectOptions: Array<{ key: string; label: string }> = [{ key: "global", label: "通用（不限项目）" }];
    try {
      const policyRaw = resolveLocalDoc(policyPath);
      if ("note" in policyRaw) {
        const policy = JSON.parse(policyRaw.note.text);
        const opts2 = policy?.intentSchema?.slots?.project?.options;
        if (Array.isArray(opts2)) projectOptions = opts2;
      }
    } catch { /* 降级使用通用兜底 */ }

    const understoodFromLlm =
      input.understoodFromLlm === true || input.understoodFromLlm === "true";
    const understoodProject = String(input.understoodProject || "").trim();
    const understoodModule = String(input.understoodModule || "").trim();
    const understoodValue = String(input.understoodValue || "").trim();
    const understoodOpRaw = String(input.understoodOperation || "").trim().toLowerCase();
    // A 方案：模块歧义/不可调用时的处理模式。
    //   true  = 主流程（模型 tool-loop）：返回 MODULE_RETRY 反馈文本，错误回传模型自愈；
    //   false = 服务端兜底编排（orchestrate，无模型可回传）：返回 CLARIFICATION_REQUIRED 渲染给用户选。
    const retryOnModuleAmbiguity =
      input.retryOnModuleAmbiguity === true || input.retryOnModuleAmbiguity === "true";

    // 完全抛弃 aliases（2026-08-22）：不再构建任何「中文词 → 模块」关键词表。
    // 模块定位 100% 交模型实时 grep 源码（search_api_module / grep_codebase / read_api_module）。
    // 操作索引中存在接口的模块（可调用）；模型提交的英文模块 id 必须在此集合内，否则回传自愈。
    const usableModules = new Set(loadApiOperationIndex().operations.map((o) => o.module));

    // 1. project：session > 模型理解 > 原文匹配 > 部署默认项目（本 Agent 面向影视后台）
    let resolvedProject = sessionProjectKey;
    let resolvedProjectLabel = sessionProjectLabel;
    if (!resolvedProject && understoodProject) {
      for (const p of projectOptions) {
        if (
          understoodProject === p.key ||
          understoodProject.includes(p.label) ||
          p.label.includes(understoodProject)
        ) {
          resolvedProject = p.key;
          resolvedProjectLabel = p.label;
          break;
        }
      }
    }
    if (!resolvedProject) {
      for (const p of projectOptions) {
        if (userInput.includes(p.label) || userInput.toLowerCase().includes(p.key.toLowerCase())) {
          resolvedProject = p.key;
          resolvedProjectLabel = p.label;
          break;
        }
      }
    }
    if (!resolvedProject) {
      const def = config.defaultProject;
      if (def.key) {
        resolvedProject = def.key;
        resolvedProjectLabel = def.label;
        if (sid) {
          setActiveProject(sid, { key: def.key, label: def.label, setAt: Date.now() });
        }
      }
    }
    if (!resolvedProject) {
      const optionsList = projectOptions.map((p) => ({ label: `${p.label}（${p.key}）`, value: p.key }));
      return `CLARIFICATION_REQUIRED\n${JSON.stringify({
        intent: "解析用户意图",
        missingSlots: ["project"],
        question: "你要操作哪个项目？",
        options: optionsList,
        riskLevel: "read",
        resumeTool: "call_api",
        resumeInput: { _pendingInput: userInput },
      })}`;
    }

    // ---- module 解析（完全抛弃 aliases：模块定位 100% 交模型实时 grep 源码）----
    // 职责边界（2026-08-22 起）：
    // 1) 模型在 submit_understood_intent 里直接给英文模块 id（<模块> / <模块> / <模块>），
    //    该 id 由模型用 search_api_module（rg 扫 PC 端 src/api+src/views）/ grep_codebase /
    //    read_api_module 实时确认；服务端不再有任何「中文词 → 模块」映射表参与路由。
    // 2) 服务端只做「无损预处理 + 可调用性安全校验」：
    //    - 括号剥离：模型常输出「report（用户观影数据统计）」复合描述 → 剥为 report；
    //    - 英文 id 必须存在于操作索引（可调用），否则 MODULE_RETRY 回传模型自愈（主流程）
    //      或 CLARIFICATION_REQUIRED 渲染给用户（服务端兜底）。
    // 3) 模型未给 module：
    //    - 主流程（retryOnModuleAmbiguity=false）：反问「你要操作哪个模块？」，模型在 tool-loop
    //      里自愈（search_api_module 定位后再 submit）；
    //    - 服务端兜底（orchestrate，retryOnModuleAmbiguity=true）：不反问（无模型可回传），
    //      放行返回 module 空，由 orchestrate 后续 grep/search 步骤代模型定位（依赖 grep 命中）。
    let resolvedModule = "";
    if (understoodModule) {
      const candidate = String(understoodModule).trim().replace(/[（(].*?[）)]/g, "").trim();
      if (usableModules.has(candidate)) {
        // 英文 id 精确命中可调用模块 → 权威唯一（如 <模块> / <模块>/<子模块> / <模块>_<接口模块>）
        resolvedModule = candidate;
      } else {
        // 中文术语兜底：模型可能直接给「<中文业务术语>」等中文（来自 search_api_module 索引定位结果），
        // 经 resolveApiModules 反查别名索引映射到英文模块 id（如 <中文术语>→<模块>/<接口模块>）。
        const byAlias = resolveApiModules(candidate).filter((m) => usableModules.has(m.id));
        if (byAlias.length) {
          resolvedModule = byAlias[0].id;
        }
      }
      if (!resolvedModule) {
        const feedback =
          `未找到模块「${understoodModule}」对应的可调用接口。` +
          `请用 search_api_module / grep_codebase 检索 PC 端源码，确认正确的英文模块 id 后重新提交` +
          `（可参考接口文件 src/api 下的模块 key，如 <模块> / <模块> / <模块>）。`;
        if (retryOnModuleAmbiguity) return `MODULE_RETRY\n${feedback}`;
        return `CLARIFICATION_REQUIRED\n${JSON.stringify({
          intent: "解析用户意图",
          missingSlots: ["module"],
          question: `未找到模块「${understoodModule}」对应的接口，请确认你要操作哪个模块？`,
          options: [{ label: "查询类", value: "read" }],
          riskLevel: "read",
          resumeTool: "call_api",
          resumeInput: { _pendingInput: userInput, project: resolvedProject },
        })}`;
      }
    } else if (retryOnModuleAmbiguity) {
      // 服务端兜底编排（orchestrate，无模型 loop）：模型未给 module → 放行，
      // resolvedModule 保持空，由 orchestrate 后续 grep_codebase / search_api_module 代模型定位
      // （依赖 grep 命中，不再有候选索引补全）。
    } else {
      // 主流程：模型未给出 module → 反问（模型在 tool-loop 里可自愈）
      return `CLARIFICATION_REQUIRED\n${JSON.stringify({
        intent: "解析用户意图",
        missingSlots: ["module"],
        question: "你要操作哪个模块？",
        options: [{ label: "查询类", value: "read" }],
        riskLevel: "read",
        resumeTool: "call_api",
        resumeInput: { _pendingInput: userInput, project: resolvedProject },
      })}`;
    }

    // 对齐 Cursor「信任模型 + 有歧义反问」：不在此用规则猜模块/反推上下文。
    // 模型理解缺失或不可调用时已在上面返回 CLARIFICATION_REQUIRED 反问，
    // 走到这里说明 module 已由模型理解确定且通过安全校验。

    // 3. operation：优先用模型结果
    // operation 判定（对齐 Cursor「信任模型 + 有歧义反问」）：
    // - capabilities：识别「可以做哪些操作/支持哪些操作/能做什么」这类能力询问（元问题），
    //   即使模型误判 op（如 read），只要用户输入是能力问法就返回操作清单（安全/准确相关，保留）。
    // - read/write：完全信任模型给出的 operationType；
    //   模型未给出（understoodOpRaw 为空）时不再用关键词猜（旧规则解析层职责），交由下方反问。
    // 意图判定（operationType）一律以模型提交的 understoodOpRaw 为准，禁止服务端写死中文意图词：
    // - 「可以做哪些操作」等能力询问原靠写死词表 capabilityKeywords 判定，已删除——能力枚举本就该由模型
    //   基于始终可用的业务上下文自主输出，服务端不预判；无模型理解时 capability 不命中。
    // - 写/读判定原靠写死词表 writeKeywords（增删改/上下线...）兜底，已删除——无模型理解时一律判 read：
    //   写操作必须经模型明确意图 + 用户确认才执行，无模型理解下不自动判 write（避免误删/误改安全红线）。
    let operationType: "read" | "write" | "capabilities" | null = null;
    if (understoodOpRaw === "read" || understoodOpRaw === "write") {
      operationType = understoodOpRaw;
    } else if (understoodOpRaw === "capabilities") {
      operationType = "capabilities";
    } else if (!understoodFromLlm) {
      // 服务端兜底（无模型理解）只给安全默认 read；不靠中文词猜写意图、也不猜 capabilities。
      operationType = "read";
    }

    if (!resolvedModule) {
      // 服务端兜底编排（orchestrate，retryOnModuleAmbiguity=true）走到这里说明模型未给 module：
      // 不反问（无模型可回传），放行返回 module 空，由 orchestrate 后续 grep_codebase /
      // search_api_module 代模型定位（依赖 grep 命中）。
      if (retryOnModuleAmbiguity) {
        /* 放行，module 空由 orchestrate 的 grep/search 步骤定位 */
      } else {
        return `CLARIFICATION_REQUIRED\n${JSON.stringify({
          intent: "解析用户意图",
          missingSlots: ["module"],
          question: "你要操作哪个模块？",
          options: [{ label: "查询类", value: "read" }],
          riskLevel: "read",
          resumeTool: "call_api",
          resumeInput: { _pendingInput: userInput, project: resolvedProject },
        })}`;
      }
    }

    if (!operationType) {
      return `CLARIFICATION_REQUIRED\n${JSON.stringify({
        intent: "解析用户意图",
        missingSlots: ["operation"],
        question: `你想对「${resolvedProjectLabel}」做什么操作？`,
        options: [{ label: "查询 / 查看详情 / 列表", value: "read" }],
        riskLevel: "read",
        resumeTool: "call_api",
        resumeInput: { _pendingInput: userInput, project: resolvedProject },
      })}`;
    }

    return JSON.stringify({
      _parsed: true,
      project: resolvedProject,
      projectLabel: resolvedProjectLabel,
      projectFromSession: Boolean(sessionProjectKey),
      module: resolvedModule,
      value: understoodValue || undefined,
      operationType,
      understoodFromLlm,
      rawInput: userInput,
      _next: "根据 module+operationType 选择 call_api operation",
    }, null, 2);
  }

  if (name === "get_list_columns") {
    return execGetListColumns(input);
  }
  if (name === "get_page_schema") {
    return execGetPageSchema(input);
  }
  if (name === "render_table") {
    return execRenderTable(input);
  }
  if (name === "summarize_chart_data") {
    return execSummarizeChartData(input);
  }
  if (name === "read_field_mapping") {
    return execReadFieldMapping(input);
  }
  if (name === "export_dataset") {
    return execExportDataset(input);
  }

  if (name === "normalize_output") {
    const moduleName = String(input.module || "").trim().toLowerCase();
    // 容错：模型常把 API 返回的 JSON 文本（可能经 JSON.stringify 转义过）原样传入。
    // 剥引号/嵌套转义直到拿到对象/数组，否则后续 normalize 会返回「带引号的字符串字面量」，
    // 导致 render_table 解析失败报「无数据」。
    let rawData = input.data;
    while (typeof rawData === "string") {
      const t = rawData.trim();
      if (!t.startsWith("[") && !t.startsWith("{")) break;
      try {
        const p = JSON.parse(t);
        if (typeof p === "string") {
          rawData = p;
          continue;
        }
        rawData = p;
        break;
      } catch {
        break;
      }
    }
    const fieldsFilter = Array.isArray(input.fields) ? input.fields.map((f) => String(f)) : null;

    if (!moduleName) return "错误：参数缺失；module 为必填参数；请传入业务模块名（如 <模块>）";
    if (rawData === undefined || rawData === null) return "错误：参数缺失；data 为必填参数；请传入 API 原始返回数据";

    try {
      // 读取字段映射配置（superpower 层）
      const mappingPath = defaultFieldMappingPath();
      const mappingRaw = resolveLocalDoc(mappingPath);
      let mapping: Record<string, unknown> = {};
      if ("note" in mappingRaw) {
        try { mapping = JSON.parse(mappingRaw.note.text); } catch { /* ignore */ }
      }

      const modules = (mapping.modules || {}) as Record<string, {
        fieldMap?: Record<string, string>;
        enumMap?: Record<string, Record<string, string>>;
      }>;
      const moduleConfig = modules[moduleName] || {};
      const fieldMap = moduleConfig.fieldMap || {};
      const enumMap = moduleConfig.enumMap || {};

      // 将单条记录做字段对齐
      const normalizeRecord = (record: Record<string, unknown>): Record<string, unknown> => {
        const result: Record<string, unknown> = {};
        for (const [rawKey, rawVal] of Object.entries(record)) {
          const label = fieldMap[rawKey] || rawKey; // 优先用中文标签，没有映射就保留原字段名
          let val = rawVal;
          // 枚举值翻译
          if (enumMap[rawKey] && val !== null && val !== undefined) {
            val = enumMap[rawKey][String(val)] ?? val;
          }
          result[label] = val;
        }
        // 字段过滤
        if (fieldsFilter) {
          const filtered: Record<string, unknown> = {};
          for (const f of fieldsFilter) {
            if (f in result) filtered[f] = result[f];
          }
          return filtered;
        }
        return result;
      };

      let normalized: unknown;
      if (Array.isArray(rawData)) {
        normalized = (rawData as Record<string, unknown>[]).map(normalizeRecord);
      } else if (typeof rawData === "object" && rawData !== null) {
        normalized = normalizeRecord(rawData as Record<string, unknown>);
      } else {
        normalized = rawData;
      }

      return `[已对齐 PC 端字段 - 模块: ${moduleName}]\n${JSON.stringify(normalized, null, 2)}`;
    } catch (err: unknown) {
      return `错误：normalize_output 执行失败；${(err as Error).message}`;
    }
  }
  if (name === "grep_codebase") {
    const pattern = String(input.pattern || "").trim();
    if (!pattern) return "错误：参数缺失；pattern 为必填参数；请传入要搜索的关键词或正则";
    const maxResults = Number(input.maxResults || 40);
    const root = resolveCodebaseRoot();
    const rawDir = String(input.dir || root).trim();
    // 模型常传相对路径 src/api；相对 CODEBASE_ROOT 解析，避免在 agent-server cwd 下找不到
    const searchDir = nodePath.isAbsolute(rawDir) ? rawDir : nodePath.resolve(root, rawDir);
    const fileGlob = String(input.fileGlob || "").trim();

    try {
      // 容错：模型常把「文件路径」当 dir 传（如 src/api/account.ts）。文件不存在是目录，
      // 直接对该文件内容做单文件 grep（rg 直接作用于文件；原生兜底用 readFileSync 单文件）。
      const searchStat = tryStat(searchDir);
      if (searchStat && !searchStat.isDirectory()) {
        return grepSingleFile(pattern, searchDir, maxResults);
      }
      const globArg = fileGlob ? `--glob "${fileGlob}"` : "";
      const cmd = `rg --no-heading --line-number --color never -i -m 1 ${globArg} -- "${pattern.replace(/"/g, '\\"')}" "${searchDir}"`;
      let output: string;
      try {
        output = execSync(cmd, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15000 }).toString();
      } catch (e: unknown) {
        // rg 不存在（ENOENT）或未命中时：回退 Node 原生递归搜索，避免工具因缺少 ripgrep 而失败/拖慢
        output = grepCodebaseNative(pattern, searchDir, fileGlob, maxResults);
      }
      const lines = output.split("\n").filter(Boolean);
      if (!lines.length) return `未找到匹配 "${pattern}" 的结果（搜索目录: ${searchDir}）`;
      const truncated = lines.slice(0, maxResults);
      const note = lines.length > maxResults ? `\n（共 ${lines.length} 条，已截断至 ${maxResults} 条，可缩小 fileGlob 或 dir 精确搜索）` : "";
      return `搜索关键词: ${pattern}\n目录: ${searchDir}\n结果 ${truncated.length} 条:\n\n` + truncated.join("\n") + note;
    } catch (err: unknown) {
      return `错误：grep_codebase 执行失败；${(err as Error).message}；请确认 rg（ripgrep）已安装`;
    }
  }
  if (name === "search_symbol") {
    const query = String(input.query || "").trim();
    if (!query) return "错误：参数缺失；query 为必填参数（函数名片段/中文动作/URL 片段/模块名）";
    const limit = Number(input.limit || 8);
    try {
      return searchSymbol(query, limit);
    } catch (err: unknown) {
      return `错误：search_symbol 执行失败；${(err as Error).message}；可改用 grep_codebase 做文本检索`;
    }
  }
  if (name === "search_api_module") {
    const query = String(input.query || "").trim();
    if (!query) return "错误：参数缺失；query 为必填参数；请传入业务模块名";
    // 方案 A（2026-08-22）：模块定位以「实时 grep 源码」为主，不再强依赖索引。
    // 模型从 PC 端源码（bx-film-admin-in2）直接理解模块与接口的对应关系（近义词/别名由模型语义判断），
    // 避免索引快照过期/缺别名导致定位失败（如「影片采集员」在索引里只有「影片采集源」）。
    // 索引（api-module-index）仅作兜底补充，不参与主路径。
    const root = resolveCodebaseRoot();
    const srcDir = nodePath.join(root, "src");
    const grepResults: string[] = [];
    try {
      let grepRaw: string;
      try {
        const cmd = `rg --no-heading --line-number --color never -i -m 12 -- "${query.replace(/"/g, '\\"')}" "${srcDir}\\api" "${srcDir}\\views"`;
        grepRaw = execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10000 }).toString();
      } catch (e: unknown) {
        // rg 缺失/未命中时回退 Node 原生递归搜索（与 grep_codebase 的 grepCodebaseNative 一致）
        grepRaw = grepCodebaseNative(query, srcDir, "", 20);
      }
      const lines = grepRaw.split("\n").filter(Boolean);
      // 提取命中文件路径（去重），优先 api/ 目录下的接口定义文件
      // 兼容 rg（反斜杠路径 D:\...）与 grepCodebaseNative（正斜杠路径 D:/...）
      const files = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^([A-Za-z]:\\(?:[^:]+)):\d+:/) || line.match(/^([A-Za-z]:\/(?:[^:]+)):\d+:/);
        if (m) files.add(m[1]);
      }
      if (files.size) {
        // 过滤噪声目录：local/（本地测试数据）、locales/（翻译表）、tran.json 等非业务源码
        // 兼容 rg（反斜杠路径）与 grepCodebaseNative（正斜杠路径）
        const isNoise = (f: string) =>
          /[\\/]local[\\/]/i.test(f) || /[\\/]locales[\\/]/i.test(f) || /tran\.json/i.test(f) || /\.txt:/i.test(f) || /\.txt$/.test(f);
        const useful = [...files].filter((f) => !isNoise(f));
        const apiFiles = useful.filter((f) => /\\api\\/i.test(f));
        const viewFiles = useful.filter((f) => /\\views\\/i.test(f));
        const routerFiles = useful.filter((f) => /\\router\\/i.test(f));
        if (apiFiles.length) {
          grepResults.push(`[接口定义文件]（源码命中）\n${apiFiles.slice(0, 6).map((f) => `- ${f}`).join("\n")}`);
        }
        if (viewFiles.length) {
          const views = viewFiles.slice(0, 6);
          grepResults.push(`[页面文件]（源码命中）\n${views.map((f) => `- ${f}`).join("\n")}`);
          // 源码事实：页面 import 的接口函数与模块（如 <页面目录>/List.vue → <接口函数> @
          // <模块>/<接口模块>）。页面路径（views/<业务目录>/<页面目录>）≠ 接口模块 id
          // （<模块>/<接口模块>），且页面拉数据用的函数名常与「预期 getList」不同；仅给页面路径
          // 模型无法推断接口模块/函数（「<某业务分页查询>」曾因缺此映射而绕路收束）。
          // 提取源码 import 属「实时读源码拿事实」，非写死映射表，交模型自主判断。
          const pageApiFns = new Set<string>();
          for (const vf of views) {
            try {
              const vc = readFileSync(vf, "utf8").slice(0, 256 * 1024);
              for (const m of vc.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\/@\/|@\/)api\/([A-Za-z0-9_./-]+)['"]/g)) {
                const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
                const mod = m[2].replace(/\/+$/, "");
                for (const n of names) pageApiFns.add(`${n}（模块 ${mod}）`);
              }
            } catch { /* 读页面失败跳过该文件 */ }
          }
          if (pageApiFns.size) {
            grepResults.push(
              `[页面 import 的接口函数]（页面源码 import，权威，优先使用）\n${[...pageApiFns].join("\n")}`,
            );
          }
        }
        if (routerFiles.length) {
          grepResults.push(`[路由文件]（源码命中）\n${routerFiles.slice(0, 4).map((f) => `- ${f}`).join("\n")}`);
        }
        if (!useful.length) {
          // 只有噪声命中 → 关键词在业务源码中不直接存在。
          // A+（2026-08-24）：若命中翻译表（纯 i18n 页面，如「账号合并」），实时四跳反查定位模块，
          // 把可用的中间产物（候选模块+路由+页面）交给模型裁决，避免死路提示。
          const localeHit = [...files].some((f) => /[\\/]locales[\\/]/i.test(f));
          if (localeHit) {
            try {
              const hits = lookupTermModules(query, root);
              if (hits.length) {
                return (
                  formatTranslationHits(query, hits) +
                  `\n\n建议：用 read_api_module 读取候选模块的接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`
                );
              }
            } catch { /* 反查异常走原提示 */ }
          }
          return `「${query}」在业务源码（src/api、src/views、src/router）中未直接命中，仅在翻译表/本地数据中发现。` +
            `请说明业务场景或换更准确的关键词；也可以用 grep_codebase 在 src 下精确搜索。`;
        }
        // 附上命中行上下文（过滤噪声目录）
        const sample = lines
          .filter((l) => {
            const m = l.match(/^([A-Za-z]:\\(?:[^:]+)):/) || l.match(/^([A-Za-z]:\/(?:[^:]+)):/);
            return m ? !isNoise(m[1]) : true;
          })
          .slice(0, 20)
          .join("\n");
        grepResults.push(`[命中上下文]\n${sample}`);
      }
    } catch { /* rg 失败时走索引兜底 */ }

    // 源码 grep 未命中时，先尝试翻译表反查（2026-08-24 A+ 补缺）：grep 范围是 src/api+src/views（rg 主路径），
    // 即使回退 grepCodebaseNative 全 src，query 含数字残渣（如「账号合并558523069977」）也可能零命中；
    // lookupTermModules 内部会剥离数字/英文/标点变体命中翻译表，拿到候选模块交模型裁决。
    if (!grepResults.length) {
      try {
        const hits = lookupTermModules(query, root);
        if (hits.length) {
          return (
            formatTranslationHits(query, hits) +
            `\n\n建议：用 read_api_module 读取候选模块的接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`
          );
        }
      } catch { /* 反查失败继续索引兜底 */ }
    }
    // 收缩重搜（2026-08-24 引入，2026-08-26 去写死词表）：口语词（如「留存报表」）与源码/菜单命名
    // （「留存率数据统计」）不一致导致整词零命中。词尾逐字收缩（纯算法，无显示词缀词表）后轻量 grep，
    // 首个命中候选即返回，交模型裁决（唯一直接用/多候选提示），不硬调、不引入映射表。
    if (!grepResults.length) {
      try {
        const hit = runContractSearch(query, [nodePath.join(root, "src", "api"), nodePath.join(root, "src", "views")], 6);
        if (hit) {
          return (
            `[收缩重搜]「${query}」在源码中未直接命中（口语词/别名与源码命名不一致），收缩为「${hit.pattern}」后命中：\n` +
            hit.files.map((f) => `- ${f}`).join("\n") +
            `\n\n建议：用 read_api_module 读取候选模块的接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`
          );
        }
      } catch { /* 收缩重搜失败继续索引兜底 */ }
    }
    // 索引兜底（2026-08-24 起索引已删除，resolveApiModules 降级返回空，
    // 模块定位完全交模型 grep 源码；保留调用仅为向前兼容未来重建索引）。
    if (!grepResults.length) {
      const fromIndex = resolveApiModules(query);
      if (fromIndex.length) {
        const top = fromIndex[0];
        return `[索引定位]「${query}」匹配到模块：${top.id}（文件 src/api/${top.file}）。\n` +
          `可用函数：${top.exports.join(", ")}。\n` +
          `建议：用 read_api_module 读取接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`;
      }
    }
    if (grepResults.length) {
      return `[源码定位]「${query}」在 PC 端源码命中：\n\n${grepResults.join("\n\n")}\n\n建议：用 read_api_module 读取接口源码（返回完整函数名与参数），确认后直接 call_api；不要 grep / list_dir 反复绕路。`;
    }
    return `未找到与「${query}」匹配的模块：业务源码（src/api、src/views、src/router）中未直接命中该关键词，索引中亦无对应术语。请换更准确的关键词，或说明业务场景；也可以用 grep_codebase 在 src 下精确搜索。`;
  }
  if (name === "read_api_module") {
    const moduleParam = String(input.module || "").trim();
    if (!moduleParam) return "错误：参数缺失；module 为必填参数；可传模块名或接口文件相对路径";

    const apiDir = process.env.API_MODULE_DIR || nodePath.join(resolveCodebaseRoot(), "src", "api");
    const tokens = moduleParam.split(",").map((m) => m.trim()).filter(Boolean);
    const results: string[] = [];
    // 接口速览（2026-08-25）：从源码提取每个导出函数的 函数名 + HTTP method + @description 中文，
    // 置于源码之前。模块函数命名常不含 List（如 <模块>/<接口模块> 的 <读语义统计接口> 描述即「<业务对象>
    // 列表」），仅给源码模型易被统计类函数名（getSummary/getWatchSummary）迷惑而 grep 找 getList 绕路；
    // 速览是「源码事实提取」非写死映射，帮助模型一眼识别各接口语义后自主选列表接口。
    const buildApiOverview = (content: string): string => {
      const lines = content.split("\n");
      const out: string[] = [];
      let pendingDesc = "";
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const d = l.match(/@description:\s*(.+)/);
        if (d) pendingDesc = d[1].trim();
        const ex = l.match(/export\s+const\s+(\w+)\s*=\s*\([^)]*\)\s*=>/);
        if (!ex) continue;
        const fnName = ex[1];
        // 函数体内 method（向后最多扫 6 行找 defHttp.get/post/put/delete）
        let method = "";
        for (let j = i; j <= Math.min(i + 8, lines.length - 1); j++) {
          const m = lines[j].match(/defHttp\.(get|post|put|delete|patch)/);
          if (m) { method = m[1].toUpperCase(); break; }
        }
        // 列表类接口标注：仅用英文 CRUD 契约词（getList/List/Page/Query/Search/Stat/Report/getAll）
        // 判定函数名——标注仅供模型参考，最终接口选路由模型裁决（2026-08-25 红线：不做中文
        // 功能词判定，「全部由大模型判断」；函数名不含 List 的统计/粘性接口由模型按
        // api-interface-routing skill 读源码判断，服务端不再以描述中文词预判）。
        const isListLike = /getList|List|Page|Query|Search|Stat|Report|getAll/i.test(fnName);
        out.push(`- ${fnName} [${method || "?"}] ${pendingDesc}${isListLike ? "  ← 列表/分页候选" : ""}`);
        pendingDesc = "";
      }
      return out.join("\n");
    };

    // 分页参数契约注入（2026-08-26，对齐 Cursor 工具 schema 层）：从模块对应页面表格配置提取
    // 真实分页参数名（useStandardTable fetchSetting 显式值 / 框架默认 page+size），随接口速览一并返回，
    // 模型调用 call_api 前像读 schema 一样直接拿到该接口的分页参数契约，不再凭习惯猜 pageNum/pageSize。
    // 找不到契约返回 null（不注入，不臆造）；字段名来自源码/框架，属通用契约语义。
    const pagingContractText = (moduleHint: string): string => {
      try {
        const c = extractPagingContract(moduleHint);
        if (!c) return "";
        const srcLabel = c.source === "explicit" ? "页面表格显式配置" : "标准表格 hook 默认";
        return (
          `\n\n[分页参数契约]（该接口对应页面表格，${srcLabel}，源码事实）\n` +
          `分页参数名：页码=${c.pageField}，每页条数=${c.sizeField}\n` +
          `调用 call_api 时请使用这两个参数名（如 ${JSON.stringify({
            [c.pageField]: 1,
            [c.sizeField]: 20,
          })}），不要臆造 pageNum/pageSize 等其他名称。`
        );
      } catch {
        return "";
      }
    };
    // 操作索引中存在接口的模块（可调用）；无接口模块（如 <无接口模块>）不读，
    // 避免「<中文业务泛词>」把模型带到 <无接口模块>（PC <业务>列表实际调 <模块> 模块）。
    const usableModules = new Set(loadApiOperationIndex().operations.map((o) => o.module));
    // 直接按路径解析源码（2026-08-24 修复：api-module-index.json 已删除，resolveApiModules 恒空，
    // 导致 read_api_module 对任何参数都返回「未找到匹配模块」。现兼容 4 种格式：
    // <模块>/<接口模块>.ts、<模块>/<接口模块>、<接口模块>.ts、绝对路径）。
    const resolveApiFilePath = (token: string): string | null => {
      const t = token.replace(/\\/g, "/").replace(/^\/+/, "");
      if (/^[a-zA-Z]:\//.test(t) || nodePath.isAbsolute(token)) {
        const abs = nodePath.resolve(t);
        return existsSync(abs) ? abs : null;
      }
      const candidates = [t, t.endsWith(".ts") ? t : t + ".ts", t + ".js"];
      for (const c of candidates) {
        const p = nodePath.join(apiDir, c);
        if (existsSync(p)) return p;
      }
      return null;
    };
    for (const token of tokens) {
      // 1) 索引模块名解析（中文别名/模块 id；索引文件已删时返回空，落到路径解析）
      const resolved = resolveApiModules(token);
      if (resolved.length) {
        for (const mod of resolved) {
          if (!usableModules.has(mod.id)) {
            results.push(`[${mod.id}] 无接口（sys 类目录模块），已跳过`);
            continue;
          }
          const filePath = `${apiDir}\\${mod.file.replace(/\//g, "\\")}`;
          const result = resolveLocalDoc(filePath);
          const summary = formatModuleSummary(mod);
          if ("note" in result) {
            const overview = buildApiOverview(result.note.text);
            const paging = pagingContractText(mod.id);
            results.push(`${summary}\n\n[接口速览]\n${overview}${paging}\n\n--- 源码 ---\n${result.note.text}`);
          } else {
            results.push(`${summary}\n\n错误：${result.error}`);
          }
        }
        continue;
      }
      // 2) 直接路径解析源码
      const filePath = resolveApiFilePath(token);
      if (!filePath) {
        results.push(`[${token}] 未找到匹配模块；建议先用 search_api_module 搜索（也可直接传 src/api 下相对路径或绝对路径）`);
        continue;
      }
      const rel = nodePath.relative(apiDir, filePath).replace(/\\/g, "/");
      const result = resolveLocalDoc(filePath);
      if ("note" in result) {
        const overview = buildApiOverview(result.note.text);
        // 路径解析时用文件相对路径的最后两段推导 moduleHint（如 user/account_group → user/account_group）
        const moduleHint = rel.replace(/\.ts$/, "").replace(/\\/g, "/");
        const paging = pagingContractText(moduleHint);
        results.push(`[src/api/${rel}]\n\n[接口速览]\n${overview}${paging}\n\n--- 源码 ---\n${result.note.text}`);
      } else {
        results.push(`[src/api/${rel}]\n\n错误：${result.error}`);
      }
    }
    return results.join("\n\n==========\n\n");
  }
  if (name === "call_api") {
    return execCallApi(input, opts);
  }
  if (name === "request_clarification") {
    const intent = String(input.intent || "未命名意图");
    const missingSlots = Array.isArray(input.missingSlots) ? input.missingSlots.map((x) => String(x)) : [];
    const question = String(input.question || "");
    const options = Array.isArray(input.options) ? input.options : [];
    const riskLevel = String(input.riskLevel || "read");

    // 已有默认/会话项目时，拦截「只问 project」的澄清，避免 UI 反复弹选项目
    const onlyProject =
      missingSlots.length === 1 &&
      missingSlots[0] === "project" &&
      /项目/.test(question);
    if (onlyProject) {
      const active = opts.sessionId
        ? (ensureDefaultProject(opts.sessionId) || getActiveProject(opts.sessionId))
        : null;
      const def = active || config.defaultProject;
      if (def?.key) {
        if (opts.sessionId && !active) {
          setActiveProject(opts.sessionId, {
            key: def.key,
            label: "label" in def ? def.label : config.defaultProject.label,
            setAt: Date.now(),
          });
        }
        return JSON.stringify({
          _clarificationSkipped: true,
          reason: "project_already_bound",
          project: def.key,
          projectLabel: "label" in def ? def.label : config.defaultProject.label,
          hint: "项目已绑定，请继续检索模块并 call_api，不要再问用户选项目。",
        });
      }
    }

    appendClarificationMetric({
      type: "clarification_asked",
      intent,
      missingSlots,
      optionCount: options.length,
      riskLevel,
    });
    return `CLARIFICATION_REQUIRED\n${JSON.stringify({ intent, missingSlots, question, options, riskLevel }, null, 2)}`;
  }
  if (name === "fetch_url") {
    const url = String(input.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return "错误：参数无效；url 必须以 http:// 或 https:// 开头；请确认链接格式后重试";
    }
    const result = await fetchLink(url);
    if (typeof result === "string") {
      if (result.startsWith("抓取失败")) {
        const reason = result.replace(/^抓取失败[:：]?\s*/, "");
        return `错误：抓取失败；${reason}；请检查 URL 是否正确、目标是否可达，或改用 fetch_url 抓取其他链接`;
      }
      return `抓取结果：${result}`;
    }
    return `[${result.label}]\n${result.text}`;
  }
  if (name === "search_dingtalk_doc") {
    const payload = input as unknown as SearchDingtalkDocInput;
    return await searchDingtalkDoc(payload);
  }
  if (name === "search_knowledge_base") {
    // 本地知识库检索（方案 B）：docs/knowledge/ 下的文档，混合检索（词法 TF-IDF + embedding 语义 RRF 融合）+ 引用出处。
    const query = String(input.query || "").trim();
    if (!query) return "错误：参数缺失；query（搜索关键词或问题）为必填";
    const maxResults = Math.min(Math.max(Number(input.maxResults) || 5, 1), 10);
    const results = await searchKnowledgeBase(query, maxResults);
    return formatSearchResults(results, query);
  }
  if (name === "get_current_time") {
    // 通用时间能力工具（2026-08-26，对齐 Claude Code「模型自查环境时间」机制）：返回服务器当前日期/时间，
    // 供模型把用户口语中的相对时间（今天/昨天/本周/本月/最近 N 天）换算为接口要求的 date/timeRange 参数。
    // 纯 new Date() 实现，零业务词、零写死、零 IO；timezone 可选（IANA 名），默认服务器本地时区。
    const tz = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : undefined;
    const now = new Date();
    // 用 Intl 在指定时区取 YYYY-MM-DD（toISOString 是 UTC，需按目标时区校正日期）
    const dateStr = (() => {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now);
        return parts; // en-CA 格式即 YYYY-MM-DD
      } catch {
        return now.toISOString().slice(0, 10);
      }
    })();
    const datetimeStr = (() => {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(now).replace(", ", "T") + (tz ? ` (${tz})` : "");
      } catch {
        return now.toISOString();
      }
    })();
    return JSON.stringify({
      date: dateStr,
      datetime: datetimeStr,
      timestamp: now.getTime(),
    });
  }
  const filePath = String(input.path || "").trim();
  if (!filePath) {
    return "错误：参数缺失；path 为必填参数；请提供文件或目录的本地绝对路径（如 D:\\Code\\project）";
  }
  const result = resolveLocalDoc(filePath);
  if ("note" in result) {
    return `[${result.note.label}]\n${result.note.text}`;
  }
  return `错误：读取失败；${result.error}；请检查路径是否正确，或先用 list_dir 浏览目录结构确认路径`;
}
