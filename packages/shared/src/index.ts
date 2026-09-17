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

// 流式事件契约（server → web，HTTP Streamable / NDJSON 每行一条）：直连大模型时只有
// 模型标识、流式文本与终态；勾选 MCP 后额外产出工具步骤事件（tool_call / tool_result）
// 与写操作确认事件；任务规划（write_todos）产出 todos 事件。
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "model"; id: string; label: string }
  | { type: "tool_call"; id: string; name: string; server?: string; args?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; text: string }
  | { type: "confirmation_required"; id: string; name: string; args?: string; reason?: string }
  | { type: "confirmation_response"; id: string; confirmed: boolean }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
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
    }
  | { type: "done" };
