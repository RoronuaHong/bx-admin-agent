// 内置工具层（路线 B：在自研 harness 上补齐 Deep Agents 能力）。
// 与 MCP 工具同台竞争：同一套 tool_calls 循环、同一套事件契约（server 标记为 "builtin"）。
// 仅在「启用 MCP」的工具模式下注入 —— 直连模式保持零工具语义；schema token 计入预算公式。
import type { TodoItem } from "@bx/shared";
import { fsEdit, fsList, fsRead, fsWrite } from "./fs-store.js";
import { setConversationTodos } from "./conversations.js";
import { type ToolSpec, safeJsonParse } from "./models.js";
import { readSkill } from "./skills.js";
import { search as ragSearch, listSources as ragSources } from "./rag/store.js";
import { addHistory, setFeedback } from "./movie/profile.js";

export const BUILTIN_SERVER = "builtin";

/**
 * 内置工具风险登记表（写操作安全闸门 P0-1）：内置工具不在 MCP 注册表里，
 * 必须显式登记级别，否则 risk.ts 会按「未知」兜底处理（fail-closed）。
 * scope = workspace 的工具只写「本对话工作区」，无外部副作用（免确认依据）；
 * 例外：fs_write / fs_edit 直接变更用户可见的工作区文件，scope 标 external 以走确认流程。
 */
export const BUILTIN_RISK: Record<
  string,
  { level: "read" | "write" | "destructive"; scope: "workspace" | "external"; reason: string }
> = {
  fs_read: { level: "read", scope: "workspace", reason: "读取本对话工作区文件" },
  fs_ls: { level: "read", scope: "workspace", reason: "列出本对话工作区文件" },
  read_skill: { level: "read", scope: "workspace", reason: "读取技能说明" },
  search_tools: { level: "read", scope: "workspace", reason: "检索工具清单" },
  search_knowledge: { level: "read", scope: "workspace", reason: "检索本地知识库（只读）" },
  knowledge_sources: { level: "read", scope: "workspace", reason: "列出知识库已入库来源" },
  fs_write: { level: "write", scope: "external", reason: "写入本对话工作区文件（需用户确认）" },
  fs_edit: { level: "write", scope: "external", reason: "编辑本对话工作区文件（需用户确认）" },
  write_todos: { level: "write", scope: "workspace", reason: "更新任务计划（对话内部状态）" },
  task: { level: "read", scope: "workspace", reason: "委派子任务（子代理自身只读）" },
  record_watched_movies: {
    level: "write",
    scope: "workspace",
    reason: "把用户表达过的观影偏好写入本地画像（无外部副作用）",
  },
};

/** 启动断言：内置工具漏登记级别时直接抛错（在启动即暴露，而不是运行时静默放行）。 */
export function assertBuiltinRiskCoverage(): void {
  const missing = builtinToolSpecs({ toolSearch: true })
    .map((item) => item.name)
    .filter((name) => !BUILTIN_RISK[name]);
  if (missing.length) {
    throw new Error(`内置工具缺少风险登记（BUILTIN_RISK）：${missing.join("、")}`);
  }
}

/** 单个内置工具的执行结果；`todos` 存在时由 chat 循环负责持久化并发 todos 事件。 */
export interface BuiltinOutcome {
  ok: boolean;
  text: string;
  todos?: TodoItem[];
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const MAX_TODOS = 20;
const MAX_TODO_CHARS = 200;

function spec(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { name, description, parameters };
}

const jsonType = (type: string, description: string) => ({ type, description });

/**
 * 工具检索（按需加载模式的入口：对齐 Claude Code 的 ToolSearch 与 Anthropic「Code execution with MCP」
 * 一文的 `search_tools`）。工具定义总量超过阈值时，只把工具**名称**写进系统提示，
 * 参数 schema 由本工具按需检索加载。执行逻辑在 chat.ts 的循环里（需要访问本轮工具清单与已加载集合）。
 */
export const TOOL_SEARCH_NAME = "search_tools";

const TOOL_SEARCH_SPEC: ToolSpec = {
  name: TOOL_SEARCH_NAME,
  description:
    "按关键词检索可用的 MCP 工具并加载它们的参数说明。当前会话工具较多，参数说明未全部载入上下文；" +
    "要调用某个工具前先在这里检索（关键词可以是工具名、能力描述或服务器名），检索命中后即可直接调用。" +
    "未加载的工具无法调用。",
  parameters: {
    type: "object",
    properties: {
      query: jsonType("string", "检索关键词（工具名 / 能力描述 / 服务器名）"),
      limit: jsonType("number", "最多返回并加载多少个工具（默认 8，上限 20）"),
    },
    required: ["query"],
  },
};

export function builtinToolSpecs(opts: { toolSearch?: boolean } = {}): ToolSpec[] {
  return [
    spec(
      "fs_write",
      "把内容写入当前对话的工作区文件（覆盖同名文件）。用于保存中间结果、大段数据或待办材料，之后可用 fs_read 取回。",
      {
        type: "object",
        properties: {
          path: jsonType("string", "工作区内相对路径，如 results/summary.md"),
          content: jsonType("string", "要写入的完整内容"),
        },
        required: ["path", "content"],
      },
    ),
    spec("fs_read", "读取工作区文件内容（fs_write 写入或被卸载的工具结果）。", {
      type: "object",
      properties: { path: jsonType("string", "工作区内相对路径") },
      required: ["path"],
    }),
    spec("fs_edit", "精确替换工作区文件中的一段内容（old_string 必须在文件中唯一）。", {
      type: "object",
      properties: {
        path: jsonType("string", "工作区内相对路径"),
        old_string: jsonType("string", "要被替换的原文（必须唯一命中）"),
        new_string: jsonType("string", "替换后的内容"),
      },
      required: ["path", "old_string", "new_string"],
    }),
    spec("fs_ls", "列出当前对话工作区里的全部文件与大小。", {
      type: "object",
      properties: {},
    }),
    spec(
      "write_todos",
      "写入/更新任务计划（全量替换）。多步任务开始前先列出步骤并随执行推进状态：pending → in_progress → completed/cancelled。",
      {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "完整计划列表（每次调用全量替换）",
            items: {
              type: "object",
              properties: {
                content: jsonType("string", `步骤描述（≤${MAX_TODO_CHARS} 字）`),
                status: jsonType("string", "pending | in_progress | completed | cancelled"),
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    ),
    spec(
      "task",
      "把一个独立子任务委派给子代理执行：子代理有自己独立的上下文和工具，执行完后只回传结论摘要。" +
        "适合：会产生大量中间数据的查询（主对话只拿结论）、可以并行处理的多个独立子任务、" +
        "多步骤的独立小任务。不要用于一步就能完成的简单查询（自己直接调用工具更快）。" +
        "注意：子代理看不到当前对话内容，description 必须自带全部背景（目标、数据范围、返回格式）。",
      {
        type: "object",
        properties: {
          description: jsonType(
            "string",
            "子任务的完整描述（要具体：目标、范围、期望返回格式），子代理看不到当前对话",
          ),
          servers: {
            type: "array",
            description:
              "可选：只给该子代理这些服务器上的工具（服务器标识 = 工具名前缀 mcp__<服务器>__ 里的 <服务器>）。" +
              "留空 = 继承主代理的全部工具。用于把子代理的能力限定在它真正需要的范围内。",
            items: { type: "string" },
          },
        },
        required: ["description"],
      },
    ),
    spec(
      "read_skill",
      "读取某个技能（skill）的完整说明。系统提示里列出了可用技能索引；任务命中时调用本工具取全文并按步骤执行。",
      {
        type: "object",
        properties: { name: jsonType("string", "技能目录名（见系统提示中的技能索引）") },
        required: ["name"],
      },
    ),
    spec(
      "search_knowledge",
      "检索本地知识库（已入库的企业文档：制度/流程/规范等）。" +
        "当用户问的是文档里才有的内容（制度、流程、规范、标准）时用它取原文片段，" +
        "并在回答里注明来源（返回结果的 source/title），不要凭记忆编造。" +
        "检索为空说明知识库没这份资料，如实说没有，不要用通用知识代替。",
      {
        type: "object",
        properties: {
          query: jsonType("string", "检索问题或关键词（写完整问题比单词效果好）"),
          topK: jsonType("number", "返回条数（默认 5）"),
        },
        required: ["query"],
      },
    ),
    spec("knowledge_sources", "列出知识库已入库的来源与切片数（判断某类资料有没有入库时用）。", {
      type: "object",
      properties: {},
    }),
    spec(
      "record_watched_movies",
      "记录用户**看过 / 喜欢 / 不喜欢**的影片，写入本地观影画像（持久保存，供后续口味相关回答参考）。" +
        "当用户在对话里明确提到自己看过、喜欢或不喜欢某部片时调用；" +
        "每部片至少给 title，若已通过搜索工具拿到影片 id 就一并给出（id 更准确）。" +
        "只记录用户明确表达过的观影经历或偏好，不要凭猜测调用。",
      {
        type: "object",
        properties: {
          movies: {
            type: "array",
            description: "影片列表，每条至少含 title",
            items: {
              type: "object",
              properties: {
                id: jsonType("string", "影片 id（可先用搜索工具查到，优先提供）"),
                title: jsonType("string", "片名（必填）"),
                year: jsonType("number", "年份（可选）"),
                rating: jsonType("number", "用户给出的评分（可选）"),
                verdict: jsonType("string", "用户态度：like / dislike（可选；用户没表态就不要填）"),
              },
              required: ["title"],
            },
          },
        },
        required: ["movies"],
      },
    ),
    // 仅按需加载模式注入：工具 schema 已全量载入时，检索没有意义，白占一个工具位。
    ...(opts.toolSearch ? [TOOL_SEARCH_SPEC] : []),
  ];
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** 归一化 write_todos 入参；非法返回错误文本。 */
function normalizeTodos(raw: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "todos 必须为数组" };
  if (raw.length > MAX_TODOS) return { error: `计划条数过多（${raw.length}，上限 ${MAX_TODOS}）` };
  const todos: TodoItem[] = [];
  for (const item of raw) {
    const entry = (item || {}) as { content?: unknown; status?: unknown };
    const content = String(entry.content || "").trim().slice(0, MAX_TODO_CHARS);
    const status = String(entry.status || "pending");
    if (!content) return { error: "每条计划都需要 content" };
    if (!TODO_STATUSES.has(status)) return { error: `非法状态：${status}` };
    todos.push({ content, status: status as TodoItem["status"] });
  }
  return { todos };
}

/**
 * 执行内置工具；不是内置工具返回 null（交回 MCP 通道）。
 * `conversationId` 用于工作区隔离与 todos 落库；
 * `namespace` 用于知识库按角色隔离（默认 "generic"，由调用方按当前角色传入，不暴露给模型）。
 */
export async function execBuiltin(
  name: string,
  argsJson: string,
  conversationId: string,
  namespace = "generic",
  ownerKey?: string,
): Promise<BuiltinOutcome | null> {
  const args = safeJsonParse(argsJson);
  switch (name) {
    case "fs_write": {
      const result = fsWrite(conversationId, str(args, "path"), str(args, "content"));
      if ("error" in result) return { ok: false, text: `写入失败：${result.error}` };
      return { ok: true, text: `已写入 ${result.path}（${result.bytes} 字节）` };
    }
    case "fs_read": {
      const result = fsRead(conversationId, str(args, "path"));
      if ("error" in result) return { ok: false, text: `读取失败：${result.error}` };
      return { ok: true, text: result.content };
    }
    case "fs_edit": {
      const result = fsEdit(conversationId, str(args, "path"), str(args, "old_string"), str(args, "new_string"));
      if ("error" in result) return { ok: false, text: `编辑失败：${result.error}` };
      return { ok: true, text: `已更新 ${result.path}` };
    }
    case "fs_ls": {
      const files = fsList(conversationId);
      if (!files.length) return { ok: true, text: "（工作区为空）" };
      return {
        ok: true,
        text: files.map((file) => `${file.path}（${file.bytes} 字节）`).join("\n"),
      };
    }
    case "read_skill": {
      const content = readSkill(str(args, "name"));
      if (!content) return { ok: false, text: `技能不存在：${str(args, "name")}` };
      return { ok: true, text: content };
    }
    case "search_knowledge": {
      const query = str(args, "query").trim();
      if (!query) return { ok: false, text: "search_knowledge 需要 query" };
      const topK = Math.min(Math.max(Number(args.topK) || 5, 1), 20);
      const hits = await ragSearch(query, topK, namespace);
      if (!hits.length) return { ok: true, text: "（知识库中没有匹配内容）" };
      return {
        ok: true,
        text: hits
          .map((h, i) => `[${i + 1}] ${h.title}（来源：${h.source}，相关度 ${h.score}）\n${h.text}`)
          .join("\n\n"),
      };
    }
    case "knowledge_sources": {
      const sources = ragSources(namespace);
      if (!sources.length) return { ok: true, text: "（知识库为空：先用 build-rag-index 入库）" };
      return {
        ok: true,
        text: sources.map((s) => `${s.source}（${s.title}，${s.chunks} 切片）`).join("\n"),
      };
    }
    case "write_todos": {
      const result = normalizeTodos(args.todos);
      if ("error" in result) return { ok: false, text: `计划写入失败：${result.error}` };
      await setConversationTodos(conversationId, result.todos).catch(() => undefined);
      const done = result.todos.filter((item) => item.status === "completed").length;
      return {
        ok: true,
        text: `计划已更新：共 ${result.todos.length} 步，已完成 ${done}。`,
        todos: result.todos,
      };
    }
    case "record_watched_movies": {
      if (!ownerKey) return { ok: false, text: "无法记录观影偏好：缺少用户标识" };
      const raw = Array.isArray(args.movies) ? args.movies : [];
      // 显式标注元素类型：否则 spread 条件对象会把 verdict 拓宽成 string，调用 setFeedback 时类型不匹配。
      const items: Array<{ id: string; title: string; year?: number; rating?: number; verdict?: "like" | "dislike" }> = raw
        .map((entry) => {
          const rec = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
          const title = String(rec.title || "").trim();
          // 先归一为 string 再收窄：rec 是 Record<string, unknown>，字面量比较无法收窄索引签名。
          const rawVerdict = String(rec.verdict || "");
          const verdict: "like" | "dislike" | undefined =
            rawVerdict === "like" || rawVerdict === "dislike" ? rawVerdict : undefined;
          return {
            // id 缺失时用片名兜底：保证历史仍能记录（代价是可能与 id 形态的同一部片重复，去重口径由画像层负责）。
            id: String(rec.id || "").trim() || title,
            title,
            ...(Number(rec.year) ? { year: Number(rec.year) } : {}),
            ...(Number(rec.rating) ? { rating: Number(rec.rating) } : {}),
            ...(verdict ? { verdict } : {}),
          };
        })
        .filter((item) => item.title);
      if (!items.length) return { ok: false, text: "record_watched_movies 至少需要一条含 title 的记录" };
      await addHistory(
        ownerKey,
        items.map((item) => ({
          id: item.id,
          title: item.title,
          ...(item.year ? { year: item.year } : {}),
          ...(item.rating ? { rating: item.rating } : {}),
          source: "chat" as const,
        })),
      );
      const withVerdict = items.filter((item) => item.verdict);
      for (const item of withVerdict) {
        await setFeedback(ownerKey, { id: item.id, title: item.title, verdict: item.verdict! });
      }
      return {
        ok: true,
        text: `已记录 ${items.length} 部影片${withVerdict.length ? `（其中 ${withVerdict.length} 部带偏好态度）` : ""}，后续推荐会参考。`,
      };
    }
    default:
      return null;
  }
}
