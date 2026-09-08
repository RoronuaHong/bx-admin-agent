import type { ChatEvent } from "./api";
import { localizeToken } from "./localize";
import type { Bubble } from "./chat-storage";
import type { ChartView, TableView } from "./types";
import type { UiLocale } from "./ui-locale";

const TOOL_STATUS_MAP: Record<string, { zh: string; en: string; pt?: string; hi?: string }> = {
  submit_understood_intent: { zh: "正在理解你的意图…", en: "Understanding your intent…", pt: "Entendendo sua intencao…", hi: "आपका अभिप्राय समझा जा रहा है…" },
  search_api_module: { zh: "正在搜索业务模块…", en: "Searching business modules…", pt: "Buscando modulos de negocio…", hi: "बिजनेस मॉड्यूल खोजे जा रहे हैं…" },
  read_api_module: { zh: "正在读取接口定义…", en: "Reading API definitions…", pt: "Lendo definicoes de API…", hi: "API परिभाषाएँ पढ़ी जा रही हैं…" },
  grep_codebase: { zh: "正在检索代码…", en: "Searching the codebase…", pt: "Buscando no codigo…", hi: "कोडबेस खोजा जा रहा है…" },
  read_file: { zh: "正在读取文件…", en: "Reading files…", pt: "Lendo arquivos…", hi: "फ़ाइलें पढ़ी जा रही हैं…" },
  list_dir: { zh: "正在列出目录…", en: "Listing directories…", pt: "Listando diretorios…", hi: "डायरेक्टरी सूचीबद्ध की जा रही हैं…" },
  call_api: { zh: "正在调用接口查询数据…", en: "Querying data via API…", pt: "Consultando dados via API…", hi: "API से डेटा क्वेरी किया जा रहा है…" },
  request_clarification: { zh: "正在向你确认…", en: "Requesting clarification…", pt: "Solicitando esclarecimento…", hi: "स्पष्टीकरण मांगा जा रहा है…" },
  search_knowledge: { zh: "正在检索知识库…", en: "Searching the knowledge base…", pt: "Buscando na base de conhecimento…", hi: "ज्ञान आधार खोजा जा रहा है…" },
  normalize_output: { zh: "正在整理输出…", en: "Formatting output…", pt: "Formatando saida…", hi: "आउटपुट व्यवस्थित किया जा रहा है…" },
  render_table: { zh: "正在渲染表格…", en: "Rendering table…", pt: "Renderizando tabela…", hi: "तालिका रेंडर की जा रही है…" },
  export_dataset: { zh: "正在导出数据…", en: "Exporting data…", pt: "Exportando dados…", hi: "डेटा निर्यात किया जा रहा है…" },
  get_page_schema: { zh: "正在读取页面结构…", en: "Reading page schema…", pt: "Lendo schema da pagina…", hi: "पेज स्कीमा पढ़ा जा रहा है…" },
};

export function toolStatusTextForLocale(locale: UiLocale, name: string): string {
  const item = TOOL_STATUS_MAP[name];
  if (item) {
    return locale === "zh" ? item.zh : locale === "pt-BR" ? (item.pt || item.en) : locale === "hi" ? (item.hi || item.en) : item.en;
  }
  return locale === "zh"
    ? `正在调用工具：${name}…`
    : locale === "pt-BR"
      ? `Chamando ferramenta: ${name}…`
      : locale === "hi"
        ? `टूल कॉल किया जा रहा है: ${name}…`
        : `Calling tool: ${name}…`;
}

function isToolCallJson(text: string) {
  if (/"tool_calls"\s*:/.test(text) && /"name"\s*:/.test(text)) return true;
  if (/"tool"\s*:\s*["']/.test(text) && /"parameters"\s*:/.test(text)) return true;
  return false;
}

export interface StreamEventState {
  suppressDelta: boolean;
  gotDone: boolean;
  toolCount: number;
  modelNotice: string;
}

export function applyChatStreamEvent(args: {
  event: ChatEvent;
  assistant: Bubble;
  state: StreamEventState;
  locale: UiLocale;
  tx: (zh: string, en: string, pt?: string, hi?: string) => string;
}) {
  const { event, assistant, state, locale, tx } = args;

  if (event.type === "text") {
    if (!isToolCallJson(event.text)) {
      assistant.text = event.text;
      if (!assistant.toolActive && !state.gotDone) assistant.status = undefined;
      state.suppressDelta = false;
    }
    return state;
  }

  if (event.type === "text_delta") {
    const combined = assistant.text + event.text;
    if (state.suppressDelta || isToolCallJson(combined) || isToolCallJson(event.text)) {
      state.suppressDelta = true;
      return state;
    }
    assistant.text += event.text;
    if (state.toolCount > 0 || state.gotDone) {
      assistant.status = tx("正在生成回答…", "Generating reply…", "Gerando resposta…", "उत्तर तैयार किया जा रहा है…");
    }
    return state;
  }

  if (event.type === "model") {
    state.modelNotice =
      event.reason === "fallback"
        ? tx(`模型调用异常，已自动降级为 ${event.label} 处理`, `Model fallback applied automatically: ${event.label}`, `Fallback de modelo aplicado automaticamente: ${event.label}`, `${event.label} के लिए मॉडल फॉलबैक अपने आप लागू किया गया।`)
        : tx(`当前模型不支持图片，本次已自动切换为 ${event.label} 处理`, `The current model does not support images. Switched to ${event.label}.`, `O modelo atual nao suporta imagens. A conversa foi trocada para ${event.label}.`, `वर्तमान मॉडल चित्रों का समर्थन नहीं करता। इसे ${event.label} पर स्विच किया गया है।`);
    return state;
  }

  if (event.type === "tool_call") {
    state.toolCount += 1;
    assistant.toolStep = state.toolCount;
    const base = toolStatusTextForLocale(locale, event.name);
    assistant.status = state.toolCount > 1
      ? locale === "zh"
        ? `${base}（第 ${state.toolCount} 步）`
        : locale === "pt-BR"
          ? `${base} (etapa ${state.toolCount})`
          : locale === "hi"
            ? `${base} (${state.toolCount}वां चरण)`
            : `${base} (step ${state.toolCount})`
      : base;
    assistant.currentTool = event.name;
    assistant.toolActive = true;
    return state;
  }

  if (event.type === "tool_result") {
    if (!assistant.toolResults) assistant.toolResults = [];
    if (assistant.toolResults.length < 20) {
      assistant.toolResults.push({ name: event.name, result: event.result });
    }
    return state;
  }

  if (event.type === "reasoning") {
    assistant.reasoning = (assistant.reasoning || "") + event.text + "\n";
    if (assistant.reasoningExpanded === undefined) assistant.reasoningExpanded = true;
    return state;
  }

  if (event.type === "done") {
    assistant.toolActive = false;
    assistant.currentTool = undefined;
    assistant.finished = true;
    if (state.toolCount > 0) {
      assistant.status = tx(`已调用 ${state.toolCount} 个工具，正在生成回答…`, `${state.toolCount} tools called, generating reply…`, `${state.toolCount} ferramentas chamadas, gerando resposta…`, `${state.toolCount} टूल कॉल हुए, उत्तर तैयार किया जा रहा है…`);
    }
    state.gotDone = true;
    return state;
  }

  if (event.type === "error") {
    assistant.error = localizeToken(locale, event.error, "GENERIC_UNKNOWN_ERROR");
    return state;
  }

  if (event.type === "table") {
    if (!assistant.tables) assistant.tables = [];
    assistant.tables.push(JSON.parse(JSON.stringify(event.table)) as TableView);
    return state;
  }

  if (event.type === "chart") {
    if (!assistant.charts) assistant.charts = [];
    assistant.charts.push(JSON.parse(JSON.stringify(event.chart)) as ChartView);
    return state;
  }

  if (event.type === "file") {
    if (!assistant.files) assistant.files = [];
    assistant.files.push(event.file);
  }

  return state;
}
