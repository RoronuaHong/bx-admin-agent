export interface LocalizedToken {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  defaultMessage?: string;
}

export interface ApiErrorPayload {
  error: LocalizedToken;
}

// SSE 事件契约（server → web）：直连大模型，只有模型标识、流式文本与终态。
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "model"; id: string; label: string }
  | { type: "error"; error: LocalizedToken; message?: string; code?: string | number }
  | { type: "done" };
