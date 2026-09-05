import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { TOOL_DESCRIPTIONS, TOOL_PATH_DESC, runAgentTool } from "./tools.js";

// MCP Server 出口（MCP SDK v2，Streamable HTTP transport）：
// 把 agent 工具（list_dir / read_file / fetch_url）暴露为 MCP 工具，
// 任何支持 MCP 的客户端（Claude 桌面 / Claude Code / opencode 等）连上 /mcp 即可使用。
// 鉴权：本机服务 + DNS rebinding 防护（localhostHostValidation），按需再加 token。
// 规范：工具命名/描述与聊天工具循环同源（复用 tools.ts 常量），禁止各自维护一份。

const mcpServer = new McpServer({ name: "bx-agent", version: "0.1.0" });

mcpServer.registerTool(
  "submit_understood_intent",
  {
    title: "提交大模型对用户意图的理解",
    description: TOOL_DESCRIPTIONS.submit_understood_intent,
    inputSchema: z.object({
      isBusinessRequest: z.boolean(),
      project: z.string().optional(),
      module: z.string().optional(),
      value: z.string().optional(),
      operationType: z.enum(["read", "write", "unknown"]),
      operationHint: z.string().optional(),
      summary: z.string().optional(),
    }),
  },
  async (input) => toolResult("submit_understood_intent", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "parse_intent",
  {
    title: "校验意图四元组槽位",
    description: TOOL_DESCRIPTIONS.parse_intent,
    inputSchema: z.object({
      userInput: z.string().describe("用户原始输入文本"),
      sessionProject: z.string().optional().describe("当前会话的 activeProject.key"),
      understoodFromLlm: z.boolean().optional(),
      understoodProject: z.string().optional(),
      understoodModule: z.string().optional(),
      understoodValue: z.string().optional(),
      understoodOperation: z.string().optional(),
    }),
  },
  async (input) => toolResult("parse_intent", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "set_project",
  {
    title: "切换全局项目上下文",
    description: TOOL_DESCRIPTIONS.set_project,
    inputSchema: z.object({
      projectKey: z.string().describe("项目标识 key"),
      projectLabel: z.string().describe("项目展示名"),
    }),
  },
  async ({ projectKey, projectLabel }) =>
    toolResult("set_project", { projectKey, projectLabel }),
);

mcpServer.registerTool(
  "write_code_file",
  {
    title: "修改/新增业务项目代码文件",
    description: TOOL_DESCRIPTIONS.write_code_file,
    inputSchema: z.object({
      path: z.string().describe("codebaseRoot 内相对路径或绝对路径"),
      content: z.string().describe("文件完整新内容"),
      description: z.string().optional().describe("用户确认展示的改动说明"),
    }),
  },
  async (input) => toolResult("write_code_file", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "git_commit_push",
  {
    title: "提交并推送代码到 gitlab",
    description: TOOL_DESCRIPTIONS.git_commit_push,
    inputSchema: z.object({
      message: z.string().describe("提交信息"),
      branch: z.string().optional().describe("目标分支，默认当前分支（业务=dev）"),
      push: z.boolean().optional().describe("是否推送远程，默认 true"),
      allowMaster: z.boolean().optional().describe("是否允许推生产分支 master/main"),
      description: z.string().optional().describe("用户确认展示的提交说明"),
    }),
  },
  async (input) => toolResult("git_commit_push", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "normalize_output",
  {
    title: "PC 端字段对齐输出",
    description: TOOL_DESCRIPTIONS.normalize_output,
    inputSchema: z.object({
      module: z.string().describe("业务模块名（如 <模块>），用于查找字段映射规则"),
      data: z.unknown().describe("API 原始返回数据"),
      fields: z.array(z.string()).optional().describe("只输出指定字段（中文名），不传则全部输出"),
    }),
  },
  async ({ module: mod, data, fields }) =>
    toolResult("normalize_output", { module: mod, data, fields }),
);

mcpServer.registerTool(
  "grep_codebase",
  {
    title: "全局代码搜索",
    description: TOOL_DESCRIPTIONS.grep_codebase,
    inputSchema: z.object({
      pattern: z.string().describe("搜索关键词或正则"),
      dir: z.string().optional().describe("限定搜索目录，默认项目根目录"),
      fileGlob: z.string().optional().describe("文件类型过滤，如 *.ts"),
      maxResults: z.number().optional().describe("最多返回条数，默认 40"),
    }),
  },
  async ({ pattern, dir, fileGlob, maxResults }) =>
    toolResult("grep_codebase", { pattern, dir, fileGlob, maxResults }),
);

mcpServer.registerTool(
  "search_api_module",
  {
    title: "搜索接口模块",
    description: TOOL_DESCRIPTIONS.search_api_module,
    inputSchema: z.object({
      query: z.string().describe("业务模块名或关键词"),
    }),
  },
  async ({ query }) => toolResult("search_api_module", { query }),
);

mcpServer.registerTool(
  "read_api_module",
  {
    title: "读取接口模块源码",
    description: TOOL_DESCRIPTIONS.read_api_module,
    inputSchema: z.object({
      module: z.string().describe("模块名/别名或接口文件路径"),
    }),
  },
  async ({ module }) => toolResult("read_api_module", { module }),
);

mcpServer.registerTool(
  "call_api",
  {
    title: "调用业务接口",
    description: TOOL_DESCRIPTIONS.call_api,
    inputSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP 方法"),
      operation: z.string().optional(),
      path: z.string().optional(),
      base: z.enum(["backend", "user", "film"]).optional(),
      url: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      confirm: z.boolean().optional(),
      description: z.string().optional(),
    }),
  },
  async (input) => toolResult("call_api", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "request_clarification",
  {
    title: "发起范围澄清",
    description: TOOL_DESCRIPTIONS.request_clarification,
    inputSchema: z.object({
      intent: z.string(),
      missingSlots: z.array(z.string()),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
      riskLevel: z.enum(["read", "write"]),
    }),
  },
  async (input) => toolResult("request_clarification", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "list_dir",
  {
    title: "列出本地目录",
    description: TOOL_DESCRIPTIONS.list_dir,
    inputSchema: z.object({
      path: z.string().describe(TOOL_PATH_DESC),
    }),
  },
  async ({ path }) => toolResult("list_dir", { path }),
);

mcpServer.registerTool(
  "read_file",
  {
    title: "读取本地文件",
    description: TOOL_DESCRIPTIONS.read_file,
    inputSchema: z.object({
      path: z.string().describe(TOOL_PATH_DESC),
    }),
  },
  async ({ path }) => toolResult("read_file", { path }),
);

mcpServer.registerTool(
  "fetch_url",
  {
    title: "抓取链接内容",
    description: TOOL_DESCRIPTIONS.fetch_url,
    inputSchema: z.object({
      url: z.string().describe("http/https 完整 URL"),
    }),
  },
  async ({ url }) => toolResult("fetch_url", { url }),
);

mcpServer.registerTool(
  "search_dingtalk_doc",
  {
    title: "查询公司内部钉钉文档",
    description: TOOL_DESCRIPTIONS.search_dingtalk_doc,
    inputSchema: z.object({
      query: z.string().describe("搜索关键词（自然语言或短语）"),
      maxResults: z.number().optional().describe("最多返回条数，默认 10"),
    }),
  },
  async ({ query, maxResults }) =>
    toolResult("search_dingtalk_doc", { query, maxResults }),
);

mcpServer.registerTool(
  "search_knowledge_base",
  {
    title: "检索企业本地知识库",
    description: TOOL_DESCRIPTIONS.search_knowledge_base,
    inputSchema: z.object({
      query: z.string().describe("搜索关键词或自然语言问题"),
      maxResults: z.number().optional().describe("最多返回条数，默认 5"),
    }),
  },
  async ({ query, maxResults }) =>
    toolResult("search_knowledge_base", { query, maxResults }),
);

mcpServer.registerTool(
  "search_symbol",
  {
    title: "符号级检索 PC 接口定义（AST）",
    description: TOOL_DESCRIPTIONS.search_symbol,
    inputSchema: z.object({
      query: z
        .string()
        .describe("函数名片段 / 中文动作 / URL 片段（如 /v0.1/<接口路径>）"),
      limit: z.number().optional().describe("最多返回条数，默认 8"),
    }),
  },
  async ({ query, limit }) => toolResult("search_symbol", { query, limit }),
);

mcpServer.registerTool(
  "get_list_columns",
  {
    title: "读取 PC 列表列定义",
    description: TOOL_DESCRIPTIONS.get_list_columns,
    inputSchema: z.object({
      module: z.string().optional(),
      path: z.string().optional(),
    }),
  },
  async (input) => toolResult("get_list_columns", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "get_page_schema",
  {
    title: "识别页面输出类型",
    description: TOOL_DESCRIPTIONS.get_page_schema,
    inputSchema: z.object({
      module: z.string(),
    }),
  },
  async ({ module }) => toolResult("get_page_schema", { module }),
);

mcpServer.registerTool(
  "render_table",
  {
    title: "渲染 Markdown 表格",
    description: TOOL_DESCRIPTIONS.render_table,
    inputSchema: z.object({
      data: z.unknown(),
      columns: z
        .array(
          z.object({
            title: z.string().optional(),
            key: z.string().optional(),
            dataIndex: z.string().optional(),
          }),
        )
        .optional(),
      maxRows: z.number().optional(),
    }),
  },
  async (input) => toolResult("render_table", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "summarize_chart_data",
  {
    title: "图表数据摘要",
    description: TOOL_DESCRIPTIONS.summarize_chart_data,
    inputSchema: z.object({
      data: z.unknown(),
      metricLabel: z.string().optional(),
    }),
  },
  async (input) => toolResult("summarize_chart_data", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "read_field_mapping",
  {
    title: "读取字段映射",
    description: TOOL_DESCRIPTIONS.read_field_mapping,
    inputSchema: z.object({
      module: z.string(),
    }),
  },
  async ({ module }) => toolResult("read_field_mapping", { module }),
);

mcpServer.registerTool(
  "export_dataset",
  {
    title: "导出 Excel/PDF",
    description: TOOL_DESCRIPTIONS.export_dataset,
    inputSchema: z.object({
      data: z.unknown(),
      columns: z.array(z.record(z.string(), z.unknown())).optional(),
      format: z.enum(["xlsx", "pdf"]).optional(),
      title: z.string().optional(),
      filename: z.string().optional(),
      tree: z.boolean().optional(),
      footer: z.unknown().optional(),
    }),
  },
  async (input) => toolResult("export_dataset", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "get_current_time",
  {
    title: "获取当前日期与时间",
    description: TOOL_DESCRIPTIONS.get_current_time,
    inputSchema: z.object({
      timezone: z.string().optional().describe("可选时区（IANA 名，如 Asia/Shanghai）；不传则用服务器本地时区"),
    }),
  },
  async (input) => toolResult("get_current_time", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "update_user_preference",
  {
    title: "更新用户偏好",
    description: TOOL_DESCRIPTIONS.update_user_preference,
    inputSchema: z.object({
      key: z.enum(["replyLanguage"]),
      value: z.string(),
    }),
  },
  async (input) => toolResult("update_user_preference", input as Record<string, unknown>),
);

mcpServer.registerTool(
  "get_user_preferences",
  {
    title: "读取用户偏好",
    description: TOOL_DESCRIPTIONS.get_user_preferences,
    inputSchema: z.object({}),
  },
  async (input) => toolResult("get_user_preferences", input as Record<string, unknown>),
);

async function toolResult(name: string, input: Record<string, unknown>) {
  const text = await runAgentTool(name, input);
  return { content: [{ type: "text" as const, text }] };
}

const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
void mcpServer.connect(transport);

export function attachMcp(app: Hono): void {
  // DNS rebinding 防护（本机服务）：只允许 localhost/127.0.0.1/[::1] 的 Host 头访问。
  const localhostHostValidation: MiddlewareHandler = async (c, next) => {
    const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return c.text("Forbidden", 403);
    await next();
  };
  app.use("/mcp", localhostHostValidation);
  app.all("/mcp", (c) => transport.handleRequest(c.req.raw));
}