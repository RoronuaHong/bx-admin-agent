import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { UiLocale } from "./ui-locale";
import { repairTables } from "./md-tables";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style") {
    data.forceKeepAttr = true;
  }
});

/** 超过该行的表格默认折叠（与 history.ts 上下文表格折叠阈值一致），避免长表占满首屏。 */
const LONG_TABLE_ROWS = 12;

/**
 * 折叠块标题：渲染层生成、会直接显示给用户，必须跟随界面语言。
 * （模型正文里的中文属于内容本身，不做翻译；这里只处理我们注入的 UI 文案。）
 */
const FOLD_LABELS: Record<UiLocale, { tools: string; longTable: (rows: number) => string }> = {
  zh: {
    tools: "工具执行明细（已在工具步骤中展示）",
    longTable: (rows) => `完整数据表（${rows} 行，点击展开）`,
  },
  en: {
    tools: "Tool trace (already shown in the tool steps)",
    longTable: (rows) => `Full table (${rows} rows, click to expand)`,
  },
  "pt-BR": {
    tools: "Detalhes da execução (já exibidos nas etapas de ferramentas)",
    longTable: (rows) => `Tabela completa (${rows} linhas, clique para expandir)`,
  },
  hi: {
    tools: "टूल निष्पादन विवरण (टूल चरणों में दिखाया गया)",
    longTable: (rows) => `पूरी तालिका (${rows} पंक्तियाँ, विस्तार के लिए क्लिक करें)`,
  },
};

/**
 * 前端渲染后处理：把不应占据首屏的内部内容折叠起来（纯展示层，不动模型输出）。
 *  1) [本轮已执行的工具] 段——模型把内部工具轨迹回显进回答，而工具步骤气泡已单独展示过，这里默认收起；
 *  2) 超长数据表——明细表行数过多时默认收起，汇总/短表保持展开。
 */
function foldAgentBlocks(html: string, locale: UiLocale): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const labels = FOLD_LABELS[locale];

  // 1) [本轮已执行的工具] 段落 + 其后连续的列表（工具调用清单）整体收起。
  const heads = Array.from(body.querySelectorAll("p, h1, h2, h3, h4, h5, h6"));
  for (const h of heads) {
    const txt = (h.textContent || "").trim();
    if (txt !== "[本轮已执行的工具]" && txt !== "本轮已执行的工具") continue;
    const details = doc.createElement("details");
    details.className = "agent-tool-trace";
    const summary = doc.createElement("summary");
    summary.textContent = labels.tools;
    details.appendChild(summary);
    const nodes: Node[] = [h];
    let sib = h.nextElementSibling;
    while (sib && (sib.tagName === "UL" || sib.tagName === "OL")) {
      nodes.push(sib);
      sib = sib.nextElementSibling;
    }
    h.parentNode!.insertBefore(details, h);
    for (const n of nodes) details.appendChild(n);
  }

  // 2) 超长表格收起（保留汇总/短表展开）。
  const wrappers = Array.from(body.querySelectorAll(".table-wrapper"));
  for (const w of wrappers) {
    const table = w.querySelector("table");
    if (!table) continue;
    const rowCount = table.querySelectorAll("tbody tr").length || table.querySelectorAll("tr").length;
    if (rowCount <= LONG_TABLE_ROWS) continue;
    const details = doc.createElement("details");
    details.className = "agent-long-table";
    const summary = doc.createElement("summary");
    summary.textContent = labels.longTable(rowCount);
    w.parentNode!.insertBefore(details, w);
    details.appendChild(summary);
    details.appendChild(w);
  }

  return body.innerHTML;
}

const mdCache = new Map<string, string>();

export function renderChatMarkdown(text: string, locale: UiLocale = "zh"): string {
  const base = text.length > 240 ? `${text.length}:${text.slice(0, 120)}:${text.slice(-80)}` : text;
  // 缓存键带上语言：同一段正文在不同语言下折叠块标题不同。
  const key = `${locale}\u0000${base}`;
  const hit = mdCache.get(key);
  if (hit) return hit;
  const raw = md.render(repairTables(text))
    .replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, "</table></div>");
  const folded = foldAgentBlocks(raw, locale);
  const html = DOMPurify.sanitize(folded, {
    ALLOWED_TAGS: [
      "p","br","hr","strong","em","b","i","s","del","ins","u","sup","sub","mark",
      "h1","h2","h3","h4","h5","h6",
      "ul","ol","li","dl","dt","dd",
      "blockquote","pre","code","kbd","samp",
      "table","thead","tbody","tfoot","tr","th","td","colgroup","col",
      "div","span","details","summary",
      "a","img",
    ],
    ALLOWED_ATTR: ["href","src","alt","title","class","style","target","rel","width","height","align","id","name","type","start","colspan","rowspan"],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  if (mdCache.size > 80) mdCache.clear();
  mdCache.set(key, html);
  return html;
}
