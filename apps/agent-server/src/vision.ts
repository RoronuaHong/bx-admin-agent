import { config } from "./config.js";

// 图片转录：把图片内容转成文字描述，供非视觉模型（如 hy3）对话时使用。
// 两条转录路径：本地 ollama 视觉模型 / 远程 OpenAI 兼容视觉端点。

const TRANSCRIBE_PROMPT = "请用中文简要描述这张图片的内容，如果包含文字请完整转写出来。";

async function transcribeWithOllama(base64: string, mediaType: string): Promise<string> {
  const url = `${config.visionOllamaUrl.replace(/\/+$/, "")}/api/chat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.visionOllamaModel,
      stream: false,
      messages: [
        {
          role: "user",
          content: TRANSCRIBE_PROMPT,
          images: [`data:${mediaType};base64,${base64}`],
        },
      ],
    }),
    signal: AbortSignal.timeout(config.modelTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ollama 转录失败：http ${response.status}`);
  }
  const body = (await response.json()) as { message?: { content?: string } };
  const text = body.message?.content?.trim() || "";
  if (!text) throw new Error("ollama 转录失败：响应为空");
  return text;
}

async function transcribeWithRemote(base64: string, mediaType: string): Promise<string> {
  const base = config.visionBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.visionApiKey}`,
    },
    body: JSON.stringify({
      model: config.visionModel,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(config.modelTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`视觉端点转录失败：http ${response.status}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("视觉端点转录失败：响应为空");
  return text;
}

// 转录一张图片为文字；失败时抛错，由调用方决定降级策略。
export async function transcribeImage(base64: string, mediaType: string): Promise<string> {
  // 远程端点已配置 key 时优先远程，否则走本地 ollama。
  if (config.visionApiKey) {
    try {
      return await transcribeWithRemote(base64, mediaType);
    } catch (error) {
      // 远程失败时尝试本地 ollama 兜底，保留远程错误信息。
      try {
        return await transcribeWithOllama(base64, mediaType);
      } catch {
        throw error;
      }
    }
  }
  return transcribeWithOllama(base64, mediaType);
}