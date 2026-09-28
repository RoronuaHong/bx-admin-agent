// 钉钉文档检索（方案 A）：用企业内部应用凭证换 token 后检索文档。
// 设计要点（对齐红线 / 最佳实践）：
// - 凭证缺失或无效时返回配置指引，绝不抛错中断对话（fail-soft）。
// - 仅只读检索，不下写任何数据。
// - 不写死任何业务词；文档搜索端点在联调时按钉钉开放平台实际 API 微调（TODO 标注）。
const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
const DOC_BASE_URL = (process.env.DINGTALK_DOC_BASE_URL || "https://www.dingtalk.com").replace(/\/+$/, "");

export interface DingtalkDocResult {
  ok: boolean;
  text: string;
}

async function getToken(): Promise<string | null> {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  try {
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(CLIENT_ID)}&appsecret=${encodeURIComponent(CLIENT_SECRET)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
    if (!data.access_token) {
      console.warn(`[dingtalk-doc] 获取 token 失败：${data.errcode ?? "?"} ${data.errmsg ?? ""}`);
      return null;
    }
    return data.access_token;
  } catch (err) {
    console.warn(`[dingtalk-doc] 获取 token 异常：${String((err as Error)?.message || err)}`);
    return null;
  }
}

export async function searchDingtalkDoc(query: string, limit = 10): Promise<DingtalkDocResult> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return {
      ok: false,
      text:
        "钉钉文档检索未配置：服务端需设置 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_DOC_BASE_URL（企业内部应用凭证）。" +
        "配置前无法检索钉钉文档；也可先把文档导出到本地知识库走 search_knowledge_base。",
    };
  }
  const token = await getToken();
  if (!token) {
    return { ok: false, text: "钉钉文档检索鉴权失败：无法获取 access_token（检查 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 是否有效）。" };
  }
  // TODO（联调）：文档搜索端点需按钉钉开放平台实际 API 微调（路径 / 参数 / 返回字段）。
  try {
    const url = `${DOC_BASE_URL}/docs/search?keyword=${encodeURIComponent(query)}&count=${Math.min(Math.max(limit, 1), 50)}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, text: `钉钉文档检索失败：HTTP ${res.status}` };
    const data = (await res.json()) as {
      list?: Array<{ title?: string; url?: string; snippet?: string }>;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, text: `钉钉文档检索失败：${data.errcode} ${data.errmsg ?? ""}` };
    }
    const items = data.list || [];
    if (!items.length) return { ok: true, text: `未找到与「${query}」相关的钉钉文档。` };
    const text = items
      .map((it, i) => `${i + 1}. ${it.title || "(无标题)"}${it.url ? ` — ${it.url}` : ""}${it.snippet ? `\n   ${it.snippet}` : ""}`)
      .join("\n");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: `钉钉文档检索异常：${String((err as Error)?.message || err)}` };
  }
}
