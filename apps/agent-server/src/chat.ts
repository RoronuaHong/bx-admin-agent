// 聊天引擎：直连大模型（一次调用，流式输出，无工具、无编排、无循环）。
import type { ChatEvent } from "@bx/shared";
import { defaultModel, getModel } from "./config.js";
import { callAgent, type ModelTurn, type OptionImage } from "./models.js";
import type { Session } from "./session.js";
import { touchSession } from "./session.js";
import { getUploadImage } from "./uploads.js";

const HISTORY_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS || 8);
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET || 24_000);

function buildTurns(session: Session, userText: string): ModelTurn[] {
  const history = session.messages.slice(-HISTORY_MAX_TURNS * 2);
  const turns: ModelTurn[] = history.map((m) => ({ role: m.role, content: m.text }));
  turns.push({ role: "user", content: userText });
  let total = turns.reduce((acc, t) => acc + t.content.length, 0);
  while (total > HISTORY_CHAR_BUDGET && turns.length > 1) {
    total -= (turns.shift() as ModelTurn).content.length;
  }
  return turns;
}

function imagesOf(ids: string[] | undefined): OptionImage[] {
  const out: OptionImage[] = [];
  for (const id of ids || []) {
    const img = getUploadImage(id);
    if (img) out.push({ base64: img.data.toString("base64"), mediaType: img.mediaType });
  }
  return out;
}

/**
 * 执行一轮对话，产出 ChatEvent 流（SSE 契约）。
 * 服务端只做：模型选择 + 历史窗口 + 流式转发 + 落会话历史。
 */
export async function* chatStream(
  session: Session,
  userText: string,
  opts: { model?: string; images?: string[]; systemExtra?: string } = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const model = getModel(opts.model) || defaultModel();
  if (!model) {
    yield {
      type: "error",
      error: { code: "MODEL_UNAVAILABLE", defaultMessage: "没有可用模型" },
      message: "没有可用模型",
    };
    yield { type: "done" };
    return;
  }
  yield { type: "model", id: model.id, label: model.label };

  const turns = buildTurns(session, userText);
  const images = imagesOf(opts.images);

  // 流式桥接：模型回调把增量推入队列，生成器侧边等边 yield（保持实时上屏）。
  const chunks: string[] = [];
  let settled = false;
  let failure: string | null = null;
  let wake: (() => void) | null = null;
  const running = callAgent(model, turns, images, signal, { systemExtra: opts.systemExtra }, (chunk) => {
    chunks.push(chunk);
    wake?.();
  })
    .catch((err) => {
      failure = String((err as Error)?.message || err);
    })
    .finally(() => {
      settled = true;
      wake?.();
    });

  let text = "";
  while (!settled || chunks.length) {
    if (!chunks.length) {
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
      continue;
    }
    const chunk = chunks.shift() as string;
    text += chunk;
    yield { type: "text_delta", text: chunk };
  }
  await running;

  if (failure) {
    yield {
      type: "error",
      error: { code: "MODEL_ERROR", defaultMessage: failure },
      message: failure,
    };
    yield { type: "done" };
    return;
  }

  const finalText = text.trim();
  session.messages.push({ role: "user", text: userText }, { role: "assistant", text: finalText });
  touchSession(session);
  yield { type: "text", text: finalText };
  yield { type: "done" };
}
