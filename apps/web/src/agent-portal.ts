import type { LocalizedText } from "./localize";
import type { PortalEntryKey } from "./portal-permissions";

export type PortalCard = {
  key: string;
  entry?: PortalEntryKey;
  title: LocalizedText;
  desc: LocalizedText;
  chip: LocalizedText;
  cta: LocalizedText;
  tone: "primary" | "default" | "muted";
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
  zh: "当前门户承载多个 Agent 入口。后台管理 Agent 已可用；知识库 / RAG Agent、观影助手 Agent 与更多能力按规划逐步接入。",
  en: "This portal hosts multiple agent entries. The admin agent is available now, while the knowledge / RAG agent, viewing agent, and more capabilities are being introduced incrementally.",
  pt: "Este portal concentra varias entradas de agentes. O agente de backoffice ja esta disponivel; o agente de conhecimento / RAG, o agente de visualizacao e outras capacidades serao introduzidos gradualmente.",
  hi: "यह पोर्टल कई एजेंट प्रवेश बिंदु समेटे हुए है। एडमिन एजेंट अभी उपलब्ध है; नॉलेज / RAG एजेंट, व्यूइंग एजेंट और अन्य क्षमताएं चरणबद्ध रूप से जोड़ी जाएंगी।",
};

export const PORTAL_CARDS: PortalCard[] = [
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
    tone: "primary",
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
    cta: { zh: "查看方案页", en: "View overview", pt: "Ver visao geral", hi: "ओवरव्यू देखें" },
    href: "/agents/knowledge",
    tone: "default",
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
    cta: { zh: "查看方案页", en: "View overview", pt: "Ver visao geral", hi: "ओवरव्यू देखें" },
    href: "/agents/viewing",
    tone: "default",
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
  },
];
