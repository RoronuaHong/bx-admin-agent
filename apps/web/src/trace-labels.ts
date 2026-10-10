import type { UiLocale } from "./ui-locale";

/**
 * 步骤标题给用户看，执行仍用原来的工具名。
 * 做法与 LibreChat / OpenHuman 的时间线一致：内置工具用固定动词短语，
 * MCP 按动作词（search / list / get…）翻成当前界面语言，原始标识留在 title 里。
 */
type Phrase = readonly [zh: string, en: string, pt: string, hi: string];

const phrase = (p: Phrase, locale: UiLocale) =>
  locale === "zh" ? p[0] : locale === "pt-BR" ? p[2] : locale === "hi" ? p[3] : p[1];

const BUILTIN: Record<string, Phrase> = {
  fs_ls: ["列出文件", "List files", "Listar arquivos", "फ़ाइलें सूचीबद्ध करें"],
  fs_glob: ["查找文件", "Find files", "Localizar arquivos", "फ़ाइलें ढूँढें"],
  fs_grep: ["搜索文件内容", "Search file contents", "Pesquisar no conteúdo", "फ़ाइल सामग्री खोजें"],
  fs_read: ["读取文件", "Read file", "Ler arquivo", "फ़ाइल पढ़ें"],
  fs_write: ["写入文件", "Write file", "Gravar arquivo", "फ़ाइल लिखें"],
  fs_edit: ["编辑文件", "Edit file", "Editar arquivo", "फ़ाइल संपादित करें"],
  fs_delete: ["删除文件", "Delete file", "Excluir arquivo", "फ़ाइल हटाएँ"],
  write_todos: ["更新计划", "Update plan", "Atualizar plano", "योजना अपडेट करें"],
  task: ["委派子任务", "Delegate task", "Delegar tarefa", "कार्य सौंपें"],
  export_data: ["导出文件", "Export file", "Exportar arquivo", "फ़ाइल निर्यात करें"],
  web_search: ["公开检索", "Web search", "Pesquisa na web", "वेब खोज"],
  fetch_url: ["打开网页", "Open page", "Abrir página", "पृष्ठ खोलें"],
  render_chart: ["绘制图表", "Draw chart", "Desenhar gráfico", "चार्ट बनाएँ"],
  read_skill: ["读取技能", "Read skill", "Ler habilidade", "स्किल पढ़ें"],
  search_tools: ["查找工具", "Find tools", "Localizar ferramentas", "टूल ढूँढें"],
  search_knowledge: ["检索知识库", "Search knowledge", "Pesquisar conhecimento", "ज्ञान खोजें"],
  knowledge_sources: ["查看知识来源", "List knowledge sources", "Listar fontes", "ज्ञान स्रोत देखें"],
  search_dingtalk_doc: ["检索钉钉文档", "Search DingTalk docs", "Pesquisar docs DingTalk", "DingTalk दस्तावेज़ खोजें"],
  run_command: ["运行命令", "Run command", "Executar comando", "कमांड चलाएँ"],
  run_script: ["运行脚本", "Run script", "Executar script", "स्क्रिप्ट चलाएँ"],
  run_tool_code: ["运行代码", "Run code", "Executar código", "कोड चलाएँ"],
  image_gen: ["生成图片", "Generate image", "Gerar imagem", "छवि बनाएँ"],
  save_memory: ["保存记忆", "Save memory", "Salvar memória", "मेमोरी सहेजें"],
  recall_memory: ["读取记忆", "Recall memory", "Ler memória", "मेमोरी पढ़ें"],
  request_clarification: ["向你确认", "Ask you", "Pedir confirmação", "आपसे पूछें"],
  list_schedules: ["查看定时任务", "List schedules", "Listar agendamentos", "शेड्यूल देखें"],
  manage_schedule: ["管理定时任务", "Manage schedule", "Gerenciar agendamento", "शेड्यूल प्रबंधित करें"],
  count_list_by_time: ["按时间计数", "Count by time", "Contar por tempo", "समय के अनुसार गिनें"],
  record_watched_movies: ["记录观影", "Record watched movies", "Registrar filmes", "देखी फ़िल्में दर्ज करें"],
};

const VERBS: Array<{ re: RegExp; phrase: Phrase }> = [
  { re: /^(search|find|query|lookup)/, phrase: ["检索", "Search", "Pesquisar", "खोजें"] },
  { re: /^(list|ls)/, phrase: ["列出", "List", "Listar", "सूची"] },
  { re: /^(get|fetch|read|show)/, phrase: ["获取", "Get", "Obter", "प्राप्त करें"] },
  { re: /^(count)/, phrase: ["计数", "Count", "Contar", "गिनती"] },
  { re: /^(create|add|insert)/, phrase: ["创建", "Create", "Criar", "बनाएँ"] },
  { re: /^(update|edit|patch)/, phrase: ["更新", "Update", "Atualizar", "अपडेट"] },
  { re: /^(delete|remove)/, phrase: ["删除", "Delete", "Excluir", "हटाएँ"] },
  { re: /^(export|download)/, phrase: ["导出", "Export", "Exportar", "निर्यात"] },
];

function prettyId(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").trim();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function externalQuery(who: string, locale: UiLocale): string {
  if (locale === "zh") return `查询 ${who}`;
  if (locale === "pt-BR") return `Consultar ${who}`;
  if (locale === "hi") return `${who} क्वेरी`;
  return `Query ${who}`;
}

/** 步骤上显示的名称。原始工具名不要直接给用户看。 */
export function toolDisplayName(name: string, locale: UiLocale): string {
  const known = BUILTIN[name];
  if (known) return phrase(known, locale);
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const split = rest.indexOf("__");
    const serverId = split >= 0 ? rest.slice(0, split) : rest;
    const action = split >= 0 ? rest.slice(split + 2) : "";
    const who = prettyId(serverId);
    const head = action.split(/[_-]/)[0] || "";
    const verb = VERBS.find((item) => item.re.test(head));
    return verb ? `${phrase(verb.phrase, locale)} ${who}` : externalQuery(who, locale);
  }
  return prettyId(name);
}

/** 内置来源和已经写进标题里的 MCP 服务名不再单独挂一枚标签。 */
export function showToolServer(name: string, server: string | undefined): boolean {
  if (!server || server === "builtin") return false;
  return !name.startsWith("mcp__");
}

/**
 * 思考通道经常是模型的英文草稿纸，提示词压不住。
 * ChatGPT 的做法是不把这段原文铺给用户；这里只在「界面语言对不上、而且已经是一整段英文」时收起。
 * 短句和界面语言里的思考照常显示。
 */
export function visibleThinking(text: string, locale: UiLocale): string {
  const body = text.trim();
  if (!body || locale === "en") return body;
  const han = (body.match(/\p{Script=Han}/gu) || []).length;
  const dev = (body.match(/\p{Script=Devanagari}/gu) || []).length;
  const lat = (body.match(/\p{Script=Latin}/gu) || []).length;
  if (lat < 80) return body;
  if (locale === "zh" && han / (han + lat) < 0.15) return "";
  if (locale === "hi" && dev / (dev + lat) < 0.15) return "";
  if (locale === "pt-BR") {
    const en = (body.match(/\b(the|and|that|this|with|would|should|let me)\b/gi) || []).length;
    const pt = (body.match(/\b(não|que|para|uma|com|está|isso|arquivo)\b/gi) || []).length;
    if (en > 12 && en > pt * 3) return "";
  }
  return body;
}
