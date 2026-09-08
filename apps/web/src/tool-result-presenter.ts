import type { UiLocale } from "./ui-locale";
import { localizeToken, pickLocalized } from "./localize";

type UnderstoodIntentResult = {
  isBusinessRequest?: boolean;
  operationType?: string;
  responseMode?: string;
  confidence?: number;
  summary?: string;
};

type LocalizedResultPayload = {
  _i18n?: { code?: string; params?: Record<string, string | number | boolean | null> };
  hintCode?: string;
  hintParams?: Record<string, string | number | boolean | null>;
  guideCode?: string;
  message?: string;
};

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isStructuredPayload(raw: string): boolean {
  const text = raw.trimStart();
  return text.startsWith("{") || text.startsWith("[") || text.startsWith("UI_TABLE") || text.startsWith("UI_FILE");
}

function parseUiTransport(raw: string): { table?: unknown; file?: unknown } | null {
  const lines = String(raw || "").split("\n");
  const out: { table?: unknown; file?: unknown } = {};
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "UI_TABLE" && lines[i + 1]) {
      try {
        out.table = JSON.parse(lines[i + 1]);
      } catch {
        return null;
      }
    }
    if (lines[i] === "UI_FILE" && lines[i + 1]) {
      try {
        out.file = JSON.parse(lines[i + 1]);
      } catch {
        return null;
      }
    }
  }
  return out.table || out.file ? out : null;
}

function sanitizeDiagnosticStrings(locale: UiLocale, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticStrings(locale, item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      shouldHideDiagnosticString(locale, item) &&
      /^(hint|_hint|outputHint|guide|question|detail)$/i.test(key)
    ) {
      out[key] = pickLocalized(locale, {
        zh: item,
        en: "Hidden raw localized diagnostic text.",
        pt: "Texto bruto de diagnostico em outro idioma foi ocultado.",
        hi: "दूसरी भाषा का कच्चा डायग्नोस्टिक पाठ छिपा दिया गया है।",
      });
      continue;
    }
    out[key] = sanitizeDiagnosticStrings(locale, item);
  }
  return out;
}

function localizeCodeFields(locale: UiLocale, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => localizeCodeFields(locale, item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (/Code$/.test(key) && typeof item === "string") {
      const baseKey = key.slice(0, -4);
      const paramsKey = `${baseKey}Params`;
      out[baseKey] = localizeToken(locale, {
        code: item,
        params: source[paramsKey] as Record<string, string | number | boolean | null> | undefined,
      });
      continue;
    }
    if (/Params$/.test(key) && typeof source[`${key.slice(0, -6)}Code`] === "string") continue;
    out[key] = localizeCodeFields(locale, item);
  }
  return out;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text);
}

function containsLatinSentence(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters >= 8 && /\s/.test(text);
}

function shouldHideDiagnosticString(locale: UiLocale, text: string): boolean {
  if (locale === "zh") return false;
  if (containsCjk(text)) return true;
  if ((locale === "pt-BR" || locale === "hi") && containsLatinSentence(text)) return true;
  return false;
}

function translateResponseMode(locale: UiLocale, value: string): string {
  const mode = String(value || "").trim();
  if (mode === "execute") {
    return pickLocalized(locale, {
      zh: "执行查询/操作",
      en: "execute query/action",
      pt: "executar consulta/acao",
      hi: "क्वेरी/ऑपरेशन चलाएं",
    });
  }
  if (mode === "clarify") {
    return pickLocalized(locale, {
      zh: "先澄清",
      en: "clarify first",
      pt: "esclarecer primeiro",
      hi: "पहले स्पष्टीकरण लें",
    });
  }
  if (mode === "explain-capability") {
    return pickLocalized(locale, {
      zh: "说明能力/路径",
      en: "explain capability/path",
      pt: "explicar capacidade/caminho",
      hi: "क्षमता/पथ समझाएं",
    });
  }
  return mode;
}

function fallbackIntentSummary(locale: UiLocale, item: UnderstoodIntentResult): string {
  if (item.isBusinessRequest === false && item.responseMode === "explain-capability") {
    return pickLocalized(locale, {
      zh: "用户在打招呼或闲聊",
      en: "User is greeting or chatting",
      pt: "O usuario esta cumprimentando ou conversando",
      hi: "उपयोगकर्ता अभिवादन कर रहा है या सामान्य बातचीत कर रहा है",
    });
  }
  if (item.isBusinessRequest === true && item.responseMode === "clarify") {
    return pickLocalized(locale, {
      zh: "业务请求信息不足，需要先澄清",
      en: "Business request needs clarification before execution",
      pt: "A solicitacao de negocio precisa de esclarecimento antes da execucao",
      hi: "व्यावसायिक अनुरोध को चलाने से पहले स्पष्टीकरण चाहिए",
    });
  }
  if (item.isBusinessRequest === true && item.responseMode === "execute") {
    return pickLocalized(locale, {
      zh: "已识别为可继续执行的业务请求",
      en: "Business request identified and ready to continue",
      pt: "Solicitacao de negocio identificada e pronta para continuar",
      hi: "व्यावसायिक अनुरोध पहचाना गया है और आगे बढ़ सकता है",
    });
  }
  return pickLocalized(locale, {
    zh: "已完成意图理解",
    en: "Intent parsed",
    pt: "Intencao interpretada",
    hi: "आशय समझ लिया गया",
  });
}

function normalizeUnderstoodIntentResult(raw: string, locale: UiLocale): string {
  const parsed = parseJsonObject(raw);
  if (!parsed) return raw;
  const item = parsed as UnderstoodIntentResult;
  const summary = String(item.summary || "").trim();
  const next = {
    ...parsed,
    responseMode:
      locale === "zh" || !item.responseMode
        ? item.responseMode
        : translateResponseMode(locale, item.responseMode),
    summary:
      locale === "zh"
        ? summary || fallbackIntentSummary(locale, item)
        : !summary || containsCjk(summary)
          ? fallbackIntentSummary(locale, item)
          : summary,
  };
  return JSON.stringify(next, null, 2);
}

export function presentToolLabel(name: string, locale: UiLocale): string {
  const names: Record<string, { zh: string; en: string; pt?: string; hi?: string }> = {
    call_api: { zh: "接口调用", en: "API Call", pt: "Chamada de API", hi: "API कॉल" },
    export_dataset: { zh: "导出文件", en: "Export File", pt: "Exportar arquivo", hi: "फ़ाइल निर्यात करें" },
    search_dingtalk_doc: { zh: "检索钉钉文档", en: "Search DingTalk Docs", pt: "Buscar docs do DingTalk", hi: "DingTalk दस्तावेज़ खोजें" },
    search_knowledge_base: { zh: "检索知识库", en: "Search Knowledge Base", pt: "Buscar base de conhecimento", hi: "ज्ञानकोष खोजें" },
    search_api_module: { zh: "检索接口", en: "Search API", pt: "Buscar API", hi: "API खोज" },
    read_api_module: { zh: "读取接口源码", en: "Read API Source", pt: "Ler codigo da API", hi: "API सोर्स पढ़ें" },
    read_file: { zh: "读取文件", en: "Read File", pt: "Ler arquivo", hi: "फ़ाइल पढ़ें" },
    grep_codebase: { zh: "检索代码", en: "Search Code", pt: "Buscar codigo", hi: "कोड खोज" },
    normalize_output: { zh: "字段对齐", en: "Normalize Output", pt: "Normalizar saida", hi: "आउटपुट सामान्य करें" },
    render_table: { zh: "渲染表格", en: "Render Table", pt: "Renderizar tabela", hi: "तालिका रेंडर करें" },
    get_list_columns: { zh: "读取列定义", en: "Read Columns", pt: "Ler colunas", hi: "कॉलम पढ़ें" },
    get_page_schema: { zh: "读取页面结构", en: "Read Page Schema", pt: "Ler esquema da pagina", hi: "पेज स्कीमा पढ़ें" },
    read_field_mapping: { zh: "读取字段映射", en: "Read Field Mapping", pt: "Ler mapeamento de campos", hi: "फ़ील्ड मैपिंग पढ़ें" },
    route_to_agent: { zh: "切换智能体", en: "Route to Agent", pt: "Encaminhar para agente", hi: "एजेंट रूट करें" },
    set_project: { zh: "切换项目", en: "Set Project", pt: "Definir projeto", hi: "प्रोजेक्ट सेट करें" },
    update_user_preference: { zh: "更新偏好", en: "Update Preferences", pt: "Atualizar preferencias", hi: "प्राथमिकताएं अपडेट करें" },
    get_user_preferences: { zh: "读取偏好", en: "Read Preferences", pt: "Ler preferencias", hi: "प्राथमिकताएं पढ़ें" },
    submit_understood_intent: { zh: "意图理解", en: "Intent Understanding", pt: "Entendimento da intencao", hi: "आशय समझ" },
    parse_intent: { zh: "规则校验", en: "Rule Validation", pt: "Validacao de regras", hi: "नियम सत्यापन" },
  };
  const item = names[name];
  return item ? pickLocalized(locale, item) : name;
}

export function presentToolResult(name: string, raw: string, locale: UiLocale): string {
  if (name === "submit_understood_intent") return normalizeUnderstoodIntentResult(raw, locale);
  const text = String(raw || "");
  const uiTransport = parseUiTransport(text);
  if (uiTransport) {
    return JSON.stringify(
      {
        message: pickLocalized(locale, {
          zh: "结构化表格/文件结果已生成，原始包装文本已省略。",
          en: "Structured table/file output is available. Raw wrapper text has been omitted.",
          pt: "A saida estruturada de tabela/arquivo esta disponivel. O texto bruto de embalagem foi omitido.",
          hi: "संरचित तालिका/फ़ाइल आउटपुट उपलब्ध है। कच्चा wrapper पाठ हटा दिया गया है।",
        }),
        ...uiTransport,
      },
      null,
      2,
    );
  }
  const parsed = parseJsonObject(text) as LocalizedResultPayload | null;
  if (parsed?._i18n?.code) {
    const messageToken = { code: parsed._i18n.code, params: parsed._i18n.params };
    const next = localizeCodeFields(locale, sanitizeDiagnosticStrings(locale, {
      ...parsed,
      message: localizeToken(locale, messageToken),
    })) as Record<string, unknown>;
    delete next._i18n;
    return JSON.stringify(next, null, 2);
  }
  if (/^错误[:：]/.test(text.trimStart())) {
    return pickLocalized(locale, {
      zh: "工具执行失败，请展开查看详细结果。",
      en: "The tool failed. Expand to inspect the full result.",
      pt: "A ferramenta falhou. Expanda para ver o resultado completo.",
      hi: "टूल विफल हुआ। पूरा परिणाम देखने के लिए विस्तार करें।",
    });
  }
  if (
    locale !== "zh" &&
    !isStructuredPayload(text) &&
    (containsCjk(text) || ((locale === "pt-BR" || locale === "hi") && containsLatinSentence(text)))
  ) {
    return pickLocalized(locale, {
      zh: text,
      en: "The tool returned raw localized text that is hidden in this UI locale. Expand to inspect the original result.",
      pt: "A ferramenta retornou texto bruto em outro idioma, ocultado neste locale da interface. Expanda para ver o resultado original.",
      hi: "टूल ने किसी अन्य भाषा में कच्चा पाठ लौटाया है, जो इस UI locale में छिपाया गया है। मूल परिणाम देखने के लिए विस्तार करें।",
    });
  }
  return raw;
}
