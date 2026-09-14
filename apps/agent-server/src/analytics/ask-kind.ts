/**
 * Decide whether this turn is a data ask (needs time_range) or a capability / chit turn.
 * Uses existing metric/channel/time extractors — not a greeting wordlist as the router.
 */

import { loadCatalogCards } from "./catalog-card.js";
import { extractChannelsFromNl } from "./intent.js";
import {
  inferMetricIdFromNl,
  inferOutputDimsFromNl,
  metricFamilyNeedsClarify,
} from "./metric-infer.js";
import type { AnalyticsPack } from "./semantic-layer.js";
import { hasTimeSignal, turnMentionsTime } from "./time-resolve.js";
import { extractAppVersionFromNl } from "./verified-query.js";

/** Quantitative / BI cues that are not overlay metric aliases (e.g. 有多少台设备).
 * Do not include 对比/对照 — those appear in product questions like 「对比会拆表吗」. */
const QUANT_CUE =
  /多少|几台|几人|排行|同比|环比|留存|付费|订单|日活|\bDAU\b|\bhow many\b|\bviewers\b/i;

/** Follow-ups about the product / help card — not a data ask. */
const META_ASK_CUE =
  /拆表|会拆|怎么对比|如何对比|对比会|对比吗|怎么问|如何问|操作说明|怎么用|如何使用|怎么下载|如何下载|下载\s*csv|查看\s*sql|展开\s*sql|sql怎么/i;

const CAPABILITY_CUE =
  /能干嘛|能做什么|能干什么|有哪些能力|你会什么|怎么用|怎么问|如何使用|操作说明|what can you|who are you|you do\b|你是谁/i;

const CHIT_PREFIX =
  /^(你好|您好|哈喽|嗨|hi\b|hello\b|hey\b|thanks?\b|thank you\b|谢谢|多谢|好的|嗯+)/i;

/** Not a warehouse ask — do not resolve a date or run SQL. */
const OFFTOPIC_CUE = /天气|气温|下雨|天气预报|几点了/;

/** Physical names + explicit catalog-card synonyms (埋点 / 订单 / 影片日统计). */
function catalogEntityNamedInNl(nl: string): boolean {
  const text = String(nl || "").trim();
  if (text.length < 2) return false;
  const lower = text.toLowerCase();
  for (const [name, card] of Object.entries(loadCatalogCards())) {
    if (name && name.length >= 3 && lower.includes(name.toLowerCase())) return true;
    for (const syn of card.synonyms || []) {
      const s = String(syn || "").trim();
      if (s.length >= 2 && text.includes(s)) return true;
    }
  }
  return false;
}

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
  if (catalogEntityNamedInNl(text)) return true;
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

function isOffTopicTurn(nl: string, pack: AnalyticsPack): boolean {
  const text = String(nl || "").trim();
  if (!OFFTOPIC_CUE.test(text)) return false;
  if (inferMetricIdFromNl(text, pack)) return false;
  if (catalogEntityNamedInNl(text)) return false;
  if (extractChannelsFromNl(text, pack).length) return false;
  if (QUANT_CUE.test(text)) return false;
  return true;
}

export function isCapabilityOrChitTurn(nl: string): boolean {
  const text = String(nl || "").trim();
  if (!text) return false;
  if (CAPABILITY_CUE.test(text)) return true;
  if (isThanksTurn(text)) return true;
  if (text.length <= 24 && CHIT_PREFIX.test(text)) return true;
  return false;
}

/** Short ack after a result — not a new ask and not “what can you do”. */
export function isThanksTurn(nl: string): boolean {
  return /^(谢谢|多谢|thanks?\b|thank you\b|好的|收到|知道了|嗯+|ok(ay)?|got it)[。.!！]*$/i.test(
    String(nl || "").trim(),
  );
}

/** User accepts the assistant’s pending clarify / listed口径 — not a new ask and not thanks. */
export function isAcceptSuggestionTurn(nl: string): boolean {
  return /^(按你说的(?:来|做|办)?|就按你说的(?:来)?|就按这个|就这样(?:吧|查)?|你定|你看着办|随便(?:一个|选一个)?|第一种|选第一个|用第一个)[。.!！]*$/i.test(
    String(nl || "").trim(),
  );
}

/** 「对比会拆表吗」一类：问产品怎么工作，不是取数。 */
function isMetaProductQuestion(nl: string, pack: AnalyticsPack): boolean {
  const text = String(nl || "").trim();
  if (!META_ASK_CUE.test(text)) return false;
  if (hasTimeSignal(text) || turnMentionsTime(text)) return false;
  if (extractChannelsFromNl(text, pack).length) return false;
  if (inferMetricIdFromNl(text, pack)) return false;
  if (inferOutputDimsFromNl(text).length) return false;
  if (extractAppVersionFromNl(text)) return false;
  if (catalogEntityNamedInNl(text)) return false;
  return true;
}

/** True → reply with usage, do not require a date or run SQL. */
export function shouldAnswerCapabilities(nl: string, pack: AnalyticsPack): boolean {
  const text = String(nl || "").trim();
  if (!text) return false;
  if (isCapabilityOrChitTurn(text) && !hasTimeSignal(text)) return true;
  if (isOffTopicTurn(text, pack)) return true;
  if (isMetaProductQuestion(text, pack)) return true;
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
    intro: "用自然语言问观看人数等指标，结果来自 Metabase。请写明日期或时间范围；缺日期会反问，不会自己猜指标怎么算。",
    how: [
      "一次说清：渠道 + 指标 + 日期（「昨天」「最近 7 天」也可以）",
      "说「各自」「同时」才会拆成多张表；只说「各渠道」通常是一张表",
    ],
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
    how: [
      "Spell out channel + metric + dates (“yesterday” or “last 7 days” also works)",
      "Say “separately” or “at the same time” to split tables; “each channel” is usually one table",
    ],
    examples: [
      "viewers by day for IndiaA from Aug 20–21",
      "viewers by channel for the last 7 days",
      "viewers by day separately for IndiaA and FoxA from Aug 20–21",
    ],
    note: "I cannot change backend data. Click an example to fill the input, or open Help in the header.",
  },
  pt: {
    title: "Posso buscar metricas para voce",
    intro: "Pergunte metricas como visualizadores em linguagem natural. Resultados do Metabase. Inclua data ou intervalo; se faltar, eu pergunto.",
    how: [
      "Diga canal + metrica + datas (“ontem” ou “ultimos 7 dias” tambem vale)",
      "Diga “separadamente” ou “ao mesmo tempo” para varias tabelas; “cada canal” costuma ser uma so",
    ],
    examples: [
      "visualizadores por dia IndiaA de 20–21 ago",
      "visualizadores por canal nos ultimos 7 dias",
      "visualizadores por dia separadamente IndiaA e FoxA de 20–21 ago",
    ],
    note: "Nao altero dados de backoffice. Clique num exemplo para preencher, ou abra Ajuda no topo.",
  },
  hi: {
    title: "मैं एनालिटिक्स ला सकता हूँ",
    intro: "प्राकृतिक भाषा में व्यूअर्स जैसे मेट्रिक पूछें। परिणाम Metabase से। तिथि या अवधि लिखें; न हो तो मैं पूछूंगा।",
    how: [
      "चैनल + मेट्रिक + तिथि बताएं (“कल” या “पिछले 7 दिन” भी चलता है)",
      "“अलग-अलग” या “एक साथ” कहने पर कई टेबल; “हर चैनल” आमतौर पर एक टेबल",
    ],
    examples: [
      "IndiaA 20–21 अगस्त दैनिक व्यूअर्स",
      "पिछले 7 दिनों में चैनल अनुसार व्यूअर्स",
      "IndiaA और FoxA 20–21 अगस्त अलग-अलग दैनिक व्यूअर्स",
    ],
    note: "बैकएंड डेटा नहीं बदलता। उदाहरण पर क्लिक करके इनपुट भरें, या हेडर में सहायता खोलें।",
  },
};

