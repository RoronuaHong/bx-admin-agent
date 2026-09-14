/**
 * Decide whether this turn is a data ask (needs time_range) or a capability / chit turn.
 * Uses existing metric/channel/time extractors — not a greeting wordlist as the router.
 */

import { extractChannelsFromNl } from "./intent.js";
import {
  inferMetricIdFromNl,
  inferOutputDimsFromNl,
  metricFamilyNeedsClarify,
} from "./metric-infer.js";
import type { AnalyticsPack } from "./semantic-layer.js";
import { hasTimeSignal, turnMentionsTime } from "./time-resolve.js";
import { extractAppVersionFromNl } from "./verified-query.js";

/** Quantitative / BI cues that are not overlay metric aliases (e.g. 有多少台设备). */
const QUANT_CUE =
  /多少|几台|几人|排行|对比|对照|同比|环比|留存|付费|订单|日活|\bDAU\b|\bhow many\b|\bviewers\b/i;

const CAPABILITY_CUE =
  /能干嘛|能做什么|能干什么|有哪些能力|你会什么|怎么用|怎么问|如何使用|操作说明|what can you|who are you|you do\b|你是谁/i;

const CHIT_PREFIX =
  /^(你好|您好|哈喽|嗨|hi\b|hello\b|hey\b|thanks?\b|thank you\b|谢谢|多谢|好的|嗯+)/i;

export function hasDataAskSignal(nl: string, pack: AnalyticsPack): boolean {
  const text = String(nl || "").trim();
  if (!text) return false;
  if (hasTimeSignal(text) || turnMentionsTime(text)) return true;
  if (inferMetricIdFromNl(text, pack)) return true;
  if (metricFamilyNeedsClarify(text, pack)) return true;
  if (extractChannelsFromNl(text, pack).length) return true;
  if (inferOutputDimsFromNl(text).length) return true;
  if (extractAppVersionFromNl(text)) return true;
  if (QUANT_CUE.test(text)) return true;
  for (const def of pack.metricDefs || []) {
    if ((def.aliases || []).some((a) => a && text.includes(a))) return true;
  }
  const tables = [...(pack.warehouse?.tables || []), ...(pack.tables || [])];
  for (const t of tables) {
    const name = String(t.name || "").trim();
    if (name && text.includes(name)) return true;
  }
  return false;
}

export function isCapabilityOrChitTurn(nl: string): boolean {
  const text = String(nl || "").trim();
  if (!text) return false;
  if (CAPABILITY_CUE.test(text)) return true;
  if (text.length <= 24 && CHIT_PREFIX.test(text)) return true;
  return false;
}

export function isThanksTurn(nl: string): boolean {
  return /^(谢谢|多谢|thanks?\b|thank you\b)/i.test(String(nl || "").trim());
}

/** True → reply with usage, do not require a date or run SQL. */
export function shouldAnswerCapabilities(nl: string, pack: AnalyticsPack): boolean {
  const text = String(nl || "").trim();
  if (!text) return false;
  if (isCapabilityOrChitTurn(text) && !hasTimeSignal(text)) return true;
  if (!hasDataAskSignal(text, pack) && !turnMentionsTime(text)) return true;
  return false;
}

export type AnalyticsHelpCard = {
  title: string;
  intro: string;
  how: string[];
  examples: string[];
  note: string;
};

export function analyticsHelpMarkdown(card: AnalyticsHelpCard): string {
  const how = card.how.map((line) => `- ${line}`).join("\n");
  const examples = card.examples.map((line) => `- ${line}`).join("\n");
  return [`**${card.title}**`, "", card.intro, "", how, "", examples, "", card.note].join("\n");
}

export function buildAnalyticsHelpCard(input: {
  locale?: string;
}): { message: string; helpCard: AnalyticsHelpCard } {
  const loc = localeKey(input.locale);
  const helpCard = HELP_COPY[loc];
  return { message: analyticsHelpMarkdown(helpCard), helpCard };
}

export function analyticsNonAskReply(input: {
  locale?: string;
  hasPrevAsk?: boolean;
  thanks?: boolean;
}): string {
  if (input.thanks && input.hasPrevAsk) {
    return localeKey(input.locale) === "zh"
      ? "收到。下一问请带上日期或时间范围，例如「最近7天各渠道观看人数」。"
      : "Got it. For the next ask, include a date or range — e.g. “viewers by channel for the last 7 days”.";
  }
  return buildAnalyticsHelpCard(input).message;
}

function localeKey(locale?: string): "zh" | "en" | "pt" | "hi" {
  const l = String(locale || "zh").toLowerCase();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("pt")) return "pt";
  if (l.startsWith("hi")) return "hi";
  return "zh";
}

const HELP_COPY: Record<"zh" | "en" | "pt" | "hi", AnalyticsHelpCard> = {
  zh: {
    title: "我能帮你问数",
    intro: "用自然语言问观看人数等指标，结果来自 Metabase。请写明日期或时间范围；缺日期会反问，不编造口径。",
    how: ["一次说清：渠道 / 维度 + 指标 + 日期（「昨天」「最近 7 天」也可以）", "对比或按天 / 按渠道混问时，会拆成多张表"],
    examples: [
      "八月二十到二十一印度A按天观看人数",
      "最近7天各渠道观看人数",
      "八月二十到二十一印度A和FoxA各自按天观看人数",
    ],
    note: "不能改后台数据。点示例可填入输入框，或打开顶栏「操作说明」。",
  },
  en: {
    title: "I can pull analytics for you",
    intro: "Ask metrics like viewers in natural language. Results come from Metabase. Include a date or range; if it is missing I will ask — I will not invent definitions.",
    how: ["Spell out channel/dimension + metric + dates (“yesterday” or “last 7 days” also works)", "Comparisons, or mixing daily and by-channel, return multiple tables"],
    examples: [
      "viewers by day for IndiaA from Aug 20–21",
      "viewers by channel for the last 7 days",
      "viewers by day for IndiaA and FoxA from Aug 20–21",
    ],
    note: "I cannot change backend data. Click an example to fill the input, or open Help in the header.",
  },
  pt: {
    title: "Posso buscar metricas para voce",
    intro: "Pergunte metricas como visualizadores em linguagem natural. Resultados do Metabase. Inclua data ou intervalo; se faltar, eu pergunto.",
    how: ["Diga canal/dimensao + metrica + datas (“ontem” ou “ultimos 7 dias” tambem vale)", "Comparacoes ou misturar por dia e por canal retornam varias tabelas"],
    examples: [
      "visualizadores por dia IndiaA de 20–21 ago",
      "visualizadores por canal nos ultimos 7 dias",
      "visualizadores por dia IndiaA e FoxA de 20–21 ago",
    ],
    note: "Nao altero dados de backoffice. Clique num exemplo para preencher, ou abra Ajuda no topo.",
  },
  hi: {
    title: "मैं एनालिटिक्स ला सकता हूँ",
    intro: "प्राकृतिक भाषा में व्यूअर्स जैसे मेट्रिक पूछें। परिणाम Metabase से। तिथि या अवधि लिखें; न हो तो मैं पूछूंगा।",
    how: ["चैनल/आयाम + मेट्रिक + तिथि बताएं (“कल” या “पिछले 7 दिन” भी चलता है)", "तुलना या दैनिक/चैनल मिश्रण पर कई तालिकाएं मिलेंगी"],
    examples: [
      "IndiaA 20–21 अगस्त दैनिक व्यूअर्स",
      "पिछले 7 दिनों में चैनल अनुसार व्यूअर्स",
      "IndiaA और FoxA 20–21 अगस्त दैनिक व्यूअर्स",
    ],
    note: "बैकएंड डेटा नहीं बदलता। उदाहरण पर क्लिक करके इनपुट भरें, या हेडर में सहायता खोलें।",
  },
};

