import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

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

const mdCache = new Map<string, string>();

export function renderChatMarkdown(text: string): string {
  const key = text.length > 240 ? `${text.length}:${text.slice(0, 120)}:${text.slice(-80)}` : text;
  const hit = mdCache.get(key);
  if (hit) return hit;
  const raw = md.render(text)
    .replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, "</table></div>");
  const html = DOMPurify.sanitize(raw, {
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
