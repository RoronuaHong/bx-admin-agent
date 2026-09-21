export interface LocalizedToken {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  defaultMessage?: string;
}

export interface ApiErrorPayload {
  error: LocalizedToken;
}

/** 任务规划条目（Deep Agents 的 write_todos 形态：全量替换，非增量）。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

/** 工具风险级别（副作用强弱；数据外发是另一正交轴，后续再扩展）。 */
export type RiskLevel = "read" | "write" | "destructive";

/** 结构化澄清的一个选项（工具 request_clarification 的产物）。 */
export interface ClarifyOption {
  label: string;
  description?: string;
}

/**
 * 图表族白名单：内置工具 `render_chart` 的校验依据，也是前端 G2 / G6 的分流依据。
 * 清单放共享包是**刻意**的——服务端工具白名单与前端渲染分流必须同源，
 * 各自维护一份的后果是「后端放行了一种新图型、前端按统计图去画」，静默降级成表格。
 */
export const CHART_TYPES = [
  "pie",
  "bar",
  "column",
  "line",
  "area",
  "scatter",
  "radar",
  "treemap",
  "funnel",
  "boxplot",
  "histogram",
  "waterfall",
  "dual_axes",
  "sankey",
  "mind_map",
  "org_chart",
  "network",
] as const;

/** 图形类图表族（关系 / 层级 / 流程）：前端走 G6，其余走 G2 的统计图语法。 */
export const GRAPH_CHART_TYPES = ["sankey", "mind_map", "org_chart", "network"] as const;

/**
 * 图表 spec（内置工具 render_chart 的产出）：服务端只透传，浏览器用 AntV 本地绘制
 * （零外链、数据不出本机）。
 *
 * 这个形状**三处共用同一定义**——chat 事件（`ChatEvent` 的 chart 变体）、
 * 落库快照（`StoredMessage.charts`）、前端组件（ChartCard / web 的 ChartSpec 类型）：
 * 各自声明一份的结果是「落库类型与渲染类型漂移」（旧代码就出现过落库只认 13 种图型、
 * 而工具白名单已有 17 种，且图形类的 data 被声明成数组）。
 */
export interface ChartSpec {
  /** 图表族，取值见 `CHART_TYPES`（`GRAPH_CHART_TYPES` 里的走 G6，其余走 G2）。 */
  chartType: string;
  /** 真实数据：统计图为行对象数组，图形类为 {nodes,edges} 或 {name,children} 层级结构（来自工具取数，禁止编造）。 */
  data: unknown;
  title?: string;
  /** 字段映射（x/y/color/size/series 等）。 */
  encode?: Record<string, string>;
  /** 额外选项（轴标题、图布局等）。 */
  options?: Record<string, unknown>;
}

// 流式事件契约（server → web，HTTP Streamable / NDJSON 每行一条）：直连大模型时只有
// 模型标识、流式文本与终态；勾选 MCP 后额外产出工具步骤事件（tool_call / tool_result）
// 与写操作确认事件；任务规划（write_todos）产出 todos 事件。
// 支持扩展思考的模型（Claude 3.7+/4、o 系列）会在回答前产出 thinking 事件：前端渲染成
// 可折叠的「思考过程」块，取代静默规划期的「正在规划…」占位（最佳实践：实时展示推理）。
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "model"; id: string; label: string }
  | { type: "tool_call"; id: string; name: string; server?: string; args?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; text: string }
  | {
      type: "confirmation_required";
      /** 工具调用 id（UI 关联步骤用，不再用于批准）。 */
      id: string;
      /** 服务端签发的一次性确认票据（批准必须用它，与请求会话绑定）。 */
      ticket: string;
      name: string;
      server?: string;
      args?: string;
      /** 生效风险级别（read 不弹卡；write/destructive 弹卡）。 */
      level?: RiskLevel;
      reason?: string;
      /** 关键参数摘要（截断 + 敏感键脱敏），让用户知情批准。 */
      argSummary?: Array<{ key: string; value: string }>;
      /** 是否可提供「本对话只读授权」勾选（仅未声明级别的外部服务器工具）。 */
      canGrantRead?: boolean;
      /** 票据有效期（毫秒）：超时未应答按拒绝处理（fail-closed），前端据此提示时限。 */
      expiresInMs?: number;
    }
  | { type: "confirmation_response"; id: string; confirmed: boolean }
  | {
      /** 结构化澄清（工具 request_clarification）：把「散文追问」升级为带选项的选项卡。 */
      type: "clarification_required";
      id: string;
      /** 与确认卡同源的一次性票据（会话绑定、超时按「跳过」处理）。 */
      ticket: string;
      question: string;
      options: ClarifyOption[];
      /** 缺的是哪个决策点（由模型声明，界面与日志展示用；未声明时不显示）。 */
      missingField?: string;
      /** 为什么它会影响答案或下一步动作（由模型声明，一句话）。 */
      whyItMatters?: string;
      expiresInMs?: number;
    }
  | { type: "clarification_response"; id: string; answer?: string }
  | { type: "todos"; todos: TodoItem[] }
  | {
      /** 子代理（task）启动：独立事件维度，旧前端忽略未知 type 即可向后兼容。 */
      type: "subagent_start";
      /** 子代理运行 id（跨事件唯一，前端独立取消用）。 */
      id: string;
      /** 父代理发起的 task 工具调用 id（UI 关联步骤用）。 */
      parentId: string;
      description: string;
    }
  | { type: "subagent_delta"; id: string; text: string }
  | {
      type: "subagent_end";
      id: string;
      ok: boolean;
      /** 终态：正常完成 / 被独立取消 / 执行出错。 */
      status: "done" | "cancelled" | "error";
      text: string;
    }
  | { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
  | ({ type: "chart" } & ChartSpec)
  | {
      /** 本轮上下文用量（透明度）：跨轮 token 占用、预算、丢弃条数与被清理的工具结果数。 */
      type: "usage";
      /** 历史 + 本轮输入占用的 token（不含工具 schema 与输出预留）。 */
      tokens: number;
      /** 本次可用的历史 token 预算。 */
      budget: number;
      /** 模型上下文窗口（token）。 */
      window: number;
      /** 参与本次请求的历史消息条数。 */
      turns: number;
      /** 因预算被丢弃的较早消息条数。 */
      dropped: number;
      /** 本次请求是否携带了历史摘要（上下文压缩产物）。 */
      summarized?: boolean;
      /** 本轮被清理（占位化）的工具结果条数。 */
      toolResultsCleared: number;
      /** 本轮被卸载到虚拟文件系统（可 fs_read 取回）的工具结果条数。 */
      toolResultsOffloaded?: number;
      /** 工具循环实际使用的轮次（模型调用次数）。 */
      rounds?: number;
      /** 本轮实际执行的工具调用次数。 */
      toolCalls?: number;
      /** 模型调用瞬时失败的重试次数（对用户透明的重试）。 */
      modelRetries?: number;
      /** 因主模型失败而切换到备用模型的次数（韧性降级）。 */
      modelFallbacks?: number;
      /** 因连续失败被熔断跳过的工具调用次数。 */
      toolFusions?: number;
      /** 伪工具调用（把调用写成文本）被拦截并纠正的次数。 */
      pseudoCallRetries?: number;
      /** 接地护栏纠正次数（零数据作答被作废并回灌提示补取数据的次数）。 */
      groundingRetries?: number;
      /** 事后核验次数（收束前对「回答 vs 本轮证据」做断言级核对的次数）。 */
      groundingVerifications?: number;
      /** 纠正后仍未取得任何工具数据、最终以确定性拒答收束。 */
      ungrounded?: boolean;
      /** 循环累计发送的 prompt token 估算（成本护栏开启时统计）。 */
      costTokens?: number;
    }
  | { type: "done" };
