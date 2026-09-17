import type { UiLocale } from "./ui-locale";
import type { LocalizedToken } from "./api";

export type LocalizedTextStrict = {
  zh: string;
  en: string;
  pt: string;
  hi: string;
};

export function pickStrictLocalized(locale: UiLocale, item: LocalizedTextStrict): string {
  if (locale === "zh") return item.zh;
  if (locale === "pt-BR") return item.pt;
  if (locale === "hi") return item.hi;
  return item.en;
}

const GENERIC_FALLBACKS: Record<string, LocalizedTextStrict> = {
  GENERIC_UNKNOWN_ERROR: {
    zh: "操作失败，请稍后再试。",
    en: "Operation failed. Please try again later.",
    pt: "A operacao falhou. Tente novamente mais tarde.",
    hi: "कार्रवाई विफल हुई। कृपया बाद में फिर से प्रयास करें।",
  },
  GENERIC_NOT_FOUND: {
    zh: "目标不存在或已失效。",
    en: "The requested item was not found or is no longer available.",
    pt: "O item solicitado nao foi encontrado ou nao esta mais disponivel.",
    hi: "मांगा गया आइटम नहीं मिला या अब उपलब्ध नहीं है।",
  },
};

// 仅收录当前服务端会产生的错误码；未收录时回退到服务端 defaultMessage。
const TOKEN_TEXT: Record<string, LocalizedTextStrict> = {
  MODEL_UNAVAILABLE: {
    zh: "没有可用模型，请先在服务端配置 MODEL_PROVIDERS。",
    en: "No model available. Configure MODEL_PROVIDERS on the server first.",
    pt: "Nenhum modelo disponivel. Configure MODEL_PROVIDERS no servidor.",
    hi: "कोई मॉडल उपलब्ध नहीं है। सर्वर पर MODEL_PROVIDERS कॉन्फ़िगर करें।",
  },
  MODEL_ERROR: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  CHAT_EMPTY_INPUT: {
    zh: "请输入内容。",
    en: "Please enter a message.",
    pt: "Digite uma mensagem.",
    hi: "कृपया संदेश दर्ज करें।",
  },
  CHAT_STREAM_FAILED: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  STREAM_ERROR: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  UPLOAD_NO_FILES: {
    zh: "未收到文件。",
    en: "No file received.",
    pt: "Nenhum arquivo recebido.",
    hi: "कोई फ़ाइल प्राप्त नहीं हुई।",
  },
  UPLOAD_TOO_MANY_FILES: {
    zh: "一次最多上传 4 个文件。",
    en: "You can upload up to 4 files at a time.",
    pt: "Voce pode enviar ate 4 arquivos por vez.",
    hi: "एक बार में अधिकतम 4 फ़ाइलें अपलोड करें।",
  },
  UPLOAD_SAVE_FAILED: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  UPLOAD_FAILED: GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR,
  UPLOAD_IMAGE_NOT_FOUND: GENERIC_FALLBACKS.GENERIC_NOT_FOUND,
};

function interpolate(template: string, params?: Record<string, string | number | boolean | null>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(params?.[key] ?? ""));
}

export function localizeToken(
  locale: UiLocale,
  token?: LocalizedToken | null,
  fallbackCode = "GENERIC_UNKNOWN_ERROR",
): string {
  const item = token?.code ? TOKEN_TEXT[token.code] : undefined;
  if (item) return interpolate(pickStrictLocalized(locale, item), token?.params);
  // 未录入词典时优先用服务端 defaultMessage，避免把具体错误吞成「操作失败」。
  if (token?.defaultMessage?.trim()) return interpolate(token.defaultMessage, token?.params);
  const fallback = TOKEN_TEXT[fallbackCode] || GENERIC_FALLBACKS.GENERIC_UNKNOWN_ERROR;
  return interpolate(pickStrictLocalized(locale, fallback), token?.params);
}
