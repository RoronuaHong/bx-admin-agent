import type { UiLocale } from "./ui-locale";

// 多 Agent 门户与路由的**前端镜像清单**（领域适配指南 §8.3）。
// 角色的真实定义在服务端 `apps/agent-server/src/roles.ts`；这里只描述「门户怎么展示、跳到哪」。
// 新增 Agent：服务端 roles.ts 加角色 → 这里加一条镜像（id 必须一致）。路由映射见 router.ts：
// /chat 走 ChatPage（通用助手），各专属 Agent（如 /movie 观影助手）走各自的独立页。
// 文案按界面语言给四语（与 tx() 同顺序），由 PortalPage 按当前 locale 取值。

/** 一条界面文案的四语版本。 */
export interface AgentText {
  zh: string;
  en: string;
  "pt-BR": string;
  hi: string;
}

export interface AgentEntry {
  /** 与服务端 roles.ts 的角色 id 一致；对话的 agentId 字段用它。 */
  id: string;
  path: string;
  label: AgentText;
  description: AgentText;
  icon: string;
}

export const AGENTS: AgentEntry[] = [
  {
    id: "generic",
    path: "/chat",
    icon: "◎",
    label: {
      zh: "通用助手",
      en: "General assistant",
      "pt-BR": "Assistente geral",
      hi: "सामान्य सहायक",
    },
    description: {
      zh: "检索信息、分析数据、写代码、读写文件、规划任务——引擎的默认形态。",
      en: "Search information, analyze data, write code, read and write files, plan tasks — the engine's default form.",
      "pt-BR": "Buscar informações, analisar dados, escrever código, ler e gravar arquivos, planejar tarefas — a forma padrão do motor.",
      hi: "जानकारी खोजें, डेटा का विश्लेषण करें, कोड लिखें, फ़ाइलें पढ़ें और लिखें, कार्यों की योजना बनाएँ — इंजन का डिफ़ॉल्ट रूप।",
    },
  },
  {
    id: "movie",
    path: "/movie",
    icon: "▶",
    label: {
      zh: "观影助手",
      en: "Movie assistant",
      "pt-BR": "Assistente de filmes",
      hi: "फ़िल्म सहायक",
    },
    description: {
      zh: "影片发现与了解：找片、按口味推荐、对比。只聊观影相关。",
      en: "Discover and learn about films: find titles, get taste-based picks, compare. Movie talk only.",
      "pt-BR": "Descubra e conheça filmes: encontre títulos, receba recomendações pelo seu gosto, compare. Somente sobre cinema.",
      hi: "फ़िल्में खोजें और जानें: टाइटल ढूँढें, पसंद के अनुसार सुझाव पाएँ, तुलना करें। केवल फ़िल्मों से जुड़ी बातचीत।",
    },
  },
  {
    id: "support",
    path: "/support",
    icon: "☎",
    label: {
      zh: "客服助手",
      en: "Support assistant",
      "pt-BR": "Assistente de suporte",
      hi: "सहायता सहायक",
    },
    description: {
      zh: "处理咨询、售后与常见问题：查订单、跟进工单、给出标准解答话术。",
      en: "Handle inquiries, after-sales and FAQs: look up orders, follow up tickets, give standard answers.",
      "pt-BR": "Trata dúvidas, pós-venda e perguntas frequentes: consulta pedidos, acompanha tickets, dá respostas padrão.",
      hi: "पूछताछ, बिक्री-बाद और सामान्य प्रश्न संभालें: ऑर्डर देखें, टिकट ट्रैक करें, मानक उत्तर दें।",
    },
  },
];

/** 取某条 Agent 文案在当前界面语言下的字符串（缺省回退英文）。 */
export function agentText(text: AgentText, locale: UiLocale): string {
  return text[locale] || text.en;
}

/** 按 id 找 Agent（页面用它取本地化角色名）。 */
export function findAgent(id: string): AgentEntry | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

export function listAgents(): AgentEntry[] {
  return AGENTS;
}
