export type AnalyticsAskExample = {
  zh: string;
  en: string;
  pt: string;
  hi: string;
};

/**
 * Click-to-fill / welcome NL.
 * Only use channels that exist in elt_watch_detail (IndiaA, FoxA, GoGo).
 * IndiaB / 巴西A are ungrounded and must not appear here.
 * English/PT/HI must use compact codes (IndiaA), not “India A”.
 */
export const ANALYTICS_ASK_EXAMPLES: AnalyticsAskExample[] = [
  {
    zh: "八月二十到二十一印度A按天观看人数",
    en: "viewers by day for IndiaA from Aug 20–21",
    pt: "visualizadores por dia IndiaA de 20–21 ago",
    hi: "IndiaA 20–21 अगस्त दैनिक व्यूअर्स",
  },
  {
    zh: "最近7天各渠道观看人数",
    en: "viewers by channel for the last 7 days",
    pt: "visualizadores por canal nos ultimos 7 dias",
    hi: "पिछले 7 दिनों में चैनल अनुसार व्यूअर्स",
  },
  {
    zh: "八月二十到二十一印度A和FoxA各自按天观看人数",
    en: "viewers by day for IndiaA and FoxA from Aug 20–21",
    pt: "visualizadores por dia IndiaA e FoxA de 20–21 ago",
    hi: "IndiaA और FoxA 20–21 अगस्त दैनिक व्यूअर्स",
  },
  {
    zh: "本周FoxA按语言观看人数",
    en: "viewers by language for FoxA this week",
    pt: "visualizadores por idioma FoxA nesta semana",
    hi: "इस सप्ताह FoxA भाषा अनुसार व्यूअर्स",
  },
];

export const ANALYTICS_HELP_EXAMPLES = ANALYTICS_ASK_EXAMPLES.slice(0, 3);
