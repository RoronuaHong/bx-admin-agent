// 聊天气泡相关的共享类型。原先定义在 ChatPage.vue 内部，抽取 ChatBubble 子组件后需要共享。
// 结构与 ChatPage 原定义保持一致（用同一组外部类型），保证 provide/inject 两侧的签名结构兼容。
import type { ChartSpec } from "./api";
import type { ArtifactSpec, TodoItem, SupportLabels } from "@bx/shared";

export type StepStatus = "running" | "ok" | "error" | "cancelled" | "interrupted";

export type SubagentStatus = "running" | "done" | "cancelled" | "error" | "interrupted";

export interface ToolStep {
  id: string;
  name: string;
  server?: string;
  args?: string;
  status: StepStatus;
  result?: string;
}

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
   * 结构化澄清（工具 request_clarification）：把模型的「散文追问」变成可点选的选项卡，
   * 复用确认通道回传用户选中的选项值。
   */
  clarification?: {
    id: string;
    ticket: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    /** 模型声明的「缺的是哪个决策点」与「为什么它会影响答案」（可选；未声明时不显示）。 */
    missingField?: string;
    whyItMatters?: string;
    expiresInMs?: number;
  } | null;
  /** 客服助手封闭分类（事项、是否要求代发、路由建议、越权、承诺门控）。 */
  supportLabels?: SupportLabels;
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
