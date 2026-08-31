/**
 * 钉钉文档检索（方案 A 骨架）
 * ----------------------------------------------------------------
 * 目标：让聊天大模型能调用 search_dingtalk_doc 工具，用自然语言查询
 * 公司内部钉钉文档（alidocs.dingtalk.com）的内容。
 *
 * 鉴权：使用「企业内部应用」身份（Client ID / Client Secret），
 * 通过 gettoken 换取 access_token，再调用文档搜索/读取接口。
 * 注意：这是「应用身份」凭证，不是个人 Cookie；需公司钉钉管理员
 * 建应用并授权文档读权限。
 *
 * 凭证来自 .env（见 load-env.ts 已 loadDotenv）：
 *   DINGTALK_CLIENT_ID    应用 Client ID（AppKey）
 *   DINGTALK_CLIENT_SECRET 应用 Client Secret
 *   DINGTALK_DOC_BASE_URL 文档 API 基址（默认 https://api.dingtalk.com/v1.0）
 *
 * 未配置凭证时，工具返回友好提示，不报错中断聊天。
 *
 * TODO（凭证到位后联调）：
 *   1. 确认文档搜索实际端点与参数（钉钉文档 API 可能随版本调整）；
 *   2. 处理分页、权限过滤（仅返回应用可见文档）；
 *   3. 如需读取正文，补充 getDocContent 调用。
 */
import { config as dotenvConfig } from "dotenv";

const CLIENT_ID = process.env.DINGTALK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET || "";
const DOC_BASE_URL =
  process.env.DINGTALK_DOC_BASE_URL || "https://api.dingtalk.com/v1.0";

let cachedToken: { token: string; expireAt: number } | null = null;

export function isDingtalkConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/** 获取/复用 access_token（应用身份）。过期前复用，避免频繁请求。 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expireAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  if (!isDingtalkConfigured()) {
    throw new Error("DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 未配置");
  }
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(
    CLIENT_ID,
  )}&appsecret=${encodeURIComponent(CLIENT_SECRET)}`;
  const resp = await fetch(url, { method: "GET" });
  const data = (await resp.json()) as { errcode?: number; access_token?: string; expires_in?: number; errmsg?: string };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`获取钉钉 token 失败：${data.errmsg || data.errcode}`);
  }
  if (!data.access_token) {
    throw new Error("获取钉钉 token 失败：响应中无 access_token");
  }
  cachedToken = {
    token: data.access_token,
    expireAt: Date.now() + (data.expires_in || 7200) * 1000,
  };
  return cachedToken.token;
}

export interface SearchDingtalkDocInput {
  query: string;
  maxResults?: number;
}

/**
 * 搜索钉钉文档。
 * 返回文本摘要；未配置凭证时返回指引文案。
 */
export async function searchDingtalkDoc(
  input: SearchDingtalkDocInput,
): Promise<string> {
  const query = String(input.query || "").trim();
  if (!query) return "错误：query 为必填参数，请传入要搜索的文档关键词。";

  if (!isDingtalkConfigured()) {
    return [
      "提示：钉钉文档检索尚未配置企业应用凭证。",
      "请在 agent-server/.env 配置：",
      "  DINGTALK_CLIENT_ID=你的应用ClientID",
      "  DINGTALK_CLIENT_SECRET=你的应用ClientSecret",
      "并向公司钉钉管理员申请文档读权限后，本工具即可查询公司内部文档。",
    ].join("\n");
  }

  try {
    const token = await getAccessToken();
    const maxResults = Number(input.maxResults || 10);
    const searchUrl = `${DOC_BASE_URL}/doc/search?keyword=${encodeURIComponent(query)}&count=${maxResults}`;
    const resp = await fetch(searchUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await resp.json()) as {
      result?: Array<{ name?: string; docId?: string; url?: string; snippet?: string }>;
      code?: number;
      message?: string;
    };
    if (data.code && data.code !== 0) {
      return `钉钉文档搜索失败：${data.message || data.code}`;
    }
    const items = data.result || [];
    if (!items.length) {
      return `未找到与「${query}」相关的钉钉文档。`;
    }
    return items
      .map((it, i) => {
        const lines = [`[${i + 1}] ${it.name || "(无标题)"}`];
        if (it.url) lines.push(`链接：${it.url}`);
        if (it.snippet) lines.push(`摘要：${it.snippet}`);
        return lines.join("\n");
      })
      .join("\n\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `钉钉文档搜索出错：${msg}`;
  }
}
