import type { ArtifactSpec, TodoItem } from "@bx/shared";
import type { ChartSpec, PendingMessage, UploadResult } from "../../api";
import type { ToolStep, SubagentStatus } from "../../chat-types";
import type { UiLocale } from "../../ui-locale";

export interface Bubble {
  id: number;
  role: "user" | "assistant" | "notice";
  text: string;
  /** 这条气泡出现的时刻（毫秒）。旧快照没有这个字段时不显示。 */
  at?: number;
  images?: Array<{ id: string; name: string }>;
  streaming?: boolean;
  error?: string;
  steps?: ToolStep[];
  /** 等待用户确认的工具调用（write/destructive 级别或服务器级 requireConfirm；批准必须用一次性票据）。 */
  pending?: {
    id: string;
    ticket: string;
    name: string;
    server?: string;
    args?: string;
    level?: "read" | "write" | "destructive";
    reason?: string;
    argSummary?: Array<{ key: string; value: string }>;
    canGrantRead?: boolean;
    grantRead?: boolean;
    /** 票据有效期（服务端下发）：超时按拒绝处理，前端据此提示并自动作废卡片。 */
    expiresInMs?: number;
  } | null;
  /**
   * 结构化澄清（工具 request_clarification）：把模型的「散文追问」变成可点选的选项，
   * 复用确认通道回传用户选中的选项值。
   */
  clarification?: {
    id: string;
    ticket: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    /** 模型声明的「缺的是哪个决策点」与「为什么它会影响答案」（可选；未声明时不覆盖）。 */
    missingField?: string;
    whyItMatters?: string;
    expiresInMs?: number;
  } | null;
  /** 客服助手封闭分类（事项、是否要求代发、路由建议、越权、承诺门控）。 */
  supportLabels?: import("@bx/shared").SupportLabels;
  /** 本轮上下文用量（服务端回传，用于透明度展示）。 */
  usage?: {
    tokens: number;
    budget: number;
    window: number;
    turns: number;
    dropped: number;
    summarized?: boolean;
    toolResultsCleared: number;
    toolResultsOffloaded?: number;
  };
  /** 任务规划（write_todos 产出，随执行推进状态）。 */
  todos?: TodoItem[];
  /** 前端本地渲染图表（render_chart 产出；零外链，浏览器用 AntV 绘制）。一轮可出多张，按顺序展示。 */
  charts?: ChartSpec[];
  /** 可下载产物（export_data 产出；随对话快照恢复，前端渲染下载卡片，点一下即可拿走文件）。 */
  artifacts?: ArtifactSpec[];
  /** 子代理（task）实时状态：独立事件维度，随流式进度更新，仅作展示（不落库）。 */
  subagents?: Array<{
    id: string;
    parentId: string;
    description: string;
    status: SubagentStatus;
    text: string;
  }>;
  /** 扩展思考（thinking 增量拼接，支持思考的模型才有；仅作展示，不回灌模型上下文）。 */
  thinking?: string;
  /** 累计思考耗时（毫秒）：各思考段相加，工具执行/回灌的间隙不计；展示用（对齐 ChatGPT「Thought for Ns」）。 */
  thinkMs?: number;
}

/** 对话级设置（真相在 conversation 文档；前端只做镜像 + 乐观更新）。 */
export interface ConvSettings {
  /** 空 = 用服务端默认模型。 */
  modelId: string;
  /** 空 = 用设备默认语言（`session.preferences.locale`）。 */
  locale: "" | UiLocale;
  mcpEnabled: string[];
  /** 用户为本对话勾选的技能（skills 目录名）；空 = 全部走索引 + read_skill 按需加载。 */
  skillsEnabled: string[];
}

/**
 * 每个对话独立的运行时状态。
 * 对齐 AI SDK 的「每个会话一个显式实例」：状态与中断句柄都归实例所有，
 * 因此切换对话只改指针、不打断任何流，N 个对话可同时流式。
 */
export interface ConvState {
  bubbles: Bubble[];
  input: string;
  sending: boolean;
  /** 并发运行中的轮次计数：放开「流式期间发送」（抢占）后同一对话可同时有多轮，sending 由它推导。 */
  runCount: number;
  /**
   * 本轮发送周期内发生过并发（runCount 曾 >1）。增量落库水位假设「同一时刻只有一条 reply 在流式更新」，
   * 并发时被打破：先收束者把水位推到「含对方半截」，后收束者若只回写末条，中间项 reply 的终态就永远落不库。
   * 并发过的对话在并发收束期间一律全量落库（见 runTurn finally），runCount 归零后复位。
   */
  hadConcurrent: boolean;
  /** 该对话所有活跃轮次的中断句柄；「停止」中止全部（抢占语义下旧轮次也在列表里）。 */
  controllers: AbortController[];
  /** 同步派发标志：防止并发双击导致同一条消息开两个 run（R08）。 */
  dispatching: boolean;
  pendingImages: UploadResult[];
  /** 待发的文档附件（PDF / Word / Excel / md / txt / csv）：随消息发 attachments，由服务端解析后注入上下文。 */
  pendingDocs: UploadResult[];
  /** 该对话最近一次错误（侧栏状态点用）。 */
  error: string;
  /** 对话级设置（模型 / 语言 / MCP 启用集 / 技能启用集）。 */
  settings: ConvSettings;
  /** 待发队列（后端持久化：忙时入队，turn 收束后按序自动发）。 */
  queue: PendingMessage[];
}
