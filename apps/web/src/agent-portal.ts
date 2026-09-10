import type { LocalizedText } from "./localize";
import type { PortalEntryKey } from "./portal-permissions";

export type PortalCardTone = "primary" | "default" | "muted";
export type PortalCardAccent = "analytics" | "admin" | "knowledge" | "viewing" | "more";

export type PortalCard = {
  key: string;
  entry?: PortalEntryKey;
  title: LocalizedText;
  desc: LocalizedText;
  chip: LocalizedText;
  cta: LocalizedText;
  tone: PortalCardTone;
  accent: PortalCardAccent;
  featured?: boolean;
  href?: string;
  authHref?: string;
};

export const PORTAL_TITLE: LocalizedText = {
  zh: "选择一个 Agent 开始",
  en: "Choose an agent to begin",
  pt: "Escolha um agente para comecar",
  hi: "शुरू करने के लिए एक एजेंट चुनें",
};

export const PORTAL_KICKER: LocalizedText = {
  zh: "多 Agent 门户",
  en: "Multi-Agent Portal",
  pt: "Portal Multiagente",
  hi: "मल्टी-एजेंट पोर्टल",
};

export const PORTAL_LEAD: LocalizedText = {
  zh: "先从数据分析问数开始；各 Agent 独立鉴权（后台管理用运营账号，其它入口不混用）。统一从本门户进入。",
  en: "Start with analytics Q&A. Each agent has its own auth — admin uses ops accounts; others are not shared. All entries live on this portal.",
  pt: "Comece pela analise. Cada agente tem auth propria — admin usa contas operacionais; as demais nao se misturam. Tudo neste portal.",
  hi: "एनालिटिक्स से शुरू करें। हर एजेंट का अपना auth — एडमिन ऑप्स खाता; बाकी मिलाए नहीं। सब इसी पोर्टल से।",
};

export const PORTAL_CARDS: PortalCard[] = [
  {
    key: "analytics",
    entry: "analytics",
    title: { zh: "数据分析 Agent", en: "Analytics Agent", pt: "Agent de Analise", hi: "एनालिटिक्स एजेंट" },
    desc: {
      zh: "基于 Metabase 的自然语言问数：时间解析、SQL 生成与表格结果，独立于后台管理会话。",
      en: "Natural-language analytics via Metabase: time resolve, SQL generation, and table results — separate from the admin chat session.",
      pt: "Analise em linguagem natural via Metabase: resolucao de tempo, geracao de SQL e tabelas — separado do chat de admin.",
      hi: "Metabase के माध्यम से प्राकृतिक भाषा एनालिटिक्स: समय रिज़ॉल्व, SQL जनरेशन और टेबल परिणाम — एडमिन चैट से अलग।",
    },
    chip: { zh: "推荐", en: "Featured", pt: "Destaque", hi: "विशेष" },
    cta: { zh: "进入问数", en: "Open analytics", pt: "Abrir analise", hi: "एनालिटिक्स खोलें" },
    href: "/analytics",
    tone: "primary",
    accent: "analytics",
    featured: true,
  },
  {
    key: "admin",
    entry: "admin",
    title: { zh: "后台管理 Agent", en: "Admin Agent", pt: "Agent de Backoffice", hi: "एडमिन एजेंट" },
    desc: {
      zh: "面向运营后台的自然语言查询、工具调用与会话工作台。",
      en: "Natural-language querying, tool use, and workspace for backend operations.",
      pt: "Consultas em linguagem natural, uso de ferramentas e area de trabalho para operacoes de backoffice.",
      hi: "बैकएंड ऑपरेशंस के लिए प्राकृतिक भाषा क्वेरी, टूल उपयोग और वर्कस्पेस।",
    },
    chip: { zh: "Agent", en: "Agent", pt: "Agente", hi: "एजेंट" },
    cta: {
      zh: "登录后进入",
      en: "Sign in to continue",
      pt: "Entrar para continuar",
      hi: "जारी रखने के लिए लॉगिन करें",
    },
    authHref: "/agents/admin/chat",
    href: "/agents/admin/login",
    tone: "default",
    accent: "admin",
  },
  {
    key: "knowledge",
    entry: "knowledge",
    title: { zh: "知识库 / RAG Agent", en: "Knowledge / RAG Agent", pt: "Agent de Conhecimento / RAG", hi: "नॉलेज / RAG एजेंट" },
    desc: {
      zh: "面向知识库、制度、流程与文档检索的独立 Agent 入口，当前先展示方案与能力范围。",
      en: "Independent entry for knowledge-base, policy, process, and document retrieval. This version explains scope and planned capabilities.",
      pt: "Entrada independente para base de conhecimento, politicas, processos e busca documental. Esta versao apresenta o escopo e as capacidades planejadas.",
      hi: "नॉलेज बेस, नीति, प्रक्रिया और दस्तावेज़ खोज के लिए स्वतंत्र प्रवेश। यह संस्करण फिलहाल दायरा और नियोजित क्षमताएं दिखाता है।",
    },
    chip: { zh: "Agent", en: "Agent", pt: "Agente", hi: "एजेंट" },
    cta: { zh: "进入方案聊天框", en: "Open chat shell", pt: "Abrir shell de chat", hi: "चैट शेल खोलें" },
    href: "/agents/knowledge",
    tone: "default",
    accent: "knowledge",
  },
  {
    key: "viewing",
    entry: "viewing",
    title: { zh: "观影助手 Agent", en: "Viewing Agent", pt: "Agent de Visualizacao", hi: "व्यूइंग एजेंट" },
    desc: {
      zh: "面向观影场景的独立 Agent 入口，当前先展示方案与能力范围。",
      en: "Independent entry for the viewing assistant. This version explains scope and planned capabilities.",
      pt: "Entrada independente para o agente de visualizacao. Esta versao apresenta o escopo e as capacidades planejadas.",
      hi: "व्यूइंग असिस्टेंट के लिए स्वतंत्र प्रवेश। यह संस्करण फिलहाल दायरा और नियोजित क्षमताएं दिखाता है।",
    },
    chip: { zh: "Agent", en: "Agent", pt: "Agente", hi: "एजेंट" },
    cta: { zh: "进入方案聊天框", en: "Open chat shell", pt: "Abrir shell de chat", hi: "चैट शेल खोलें" },
    href: "/agents/viewing",
    tone: "default",
    accent: "viewing",
  },
  {
    key: "more",
    title: { zh: "更多 Agent 即将上线", en: "More Agents Soon", pt: "Mais agentes em breve", hi: "और एजेंट जल्द आ रहे हैं" },
    desc: {
      zh: "为后续子 Agent 扩展预留统一入口与产品位置。",
      en: "Reserved product space for future sub-agents and new workflows.",
      pt: "Espaco reservado para futuros subagentes e novos fluxos.",
      hi: "भविष्य के सब-एजेंट और नए वर्कफ़्लो के लिए आरक्षित स्थान।",
    },
    chip: { zh: "规划中", en: "Planned", pt: "Planejado", hi: "योजना" },
    cta: { zh: "先看规划", en: "See roadmap", pt: "Ver roadmap", hi: "रोडमैप देखें" },
    tone: "muted",
    accent: "more",
  },
];
