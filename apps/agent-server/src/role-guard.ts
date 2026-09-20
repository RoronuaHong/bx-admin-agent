/**
 * 角色身份护栏：兜底拦截模型把「自己」错认为某个底层大模型 / 品牌的自报
 * （典型：用户问「你是谁」时回「我是 Kimi，由 Moonshot AI 开发…」）。
 *
 * 行为：仅当回复**以**某个模型/品牌身份开场（^ 锚定）时，截掉开头的自我指认小句
 * （到第一个句末标点为止），保留其后的真实内容，并补上正确角色身份。
 * - 非开头位置的品牌提及、正常长回答都不受影响（只处理「开门见山自报模型」这一种确定情形）。
 * - 匹配的是跨系统通用的模型 / 厂商名（Kimi / GPT / Claude …），不含任何业务词，符合「禁止写死业务词」红线。
 */
const SELF_ID_AS_MODEL =
  /^(?:\s*(?:你好|您好|hi|hello|hey)[，,!！?？\s]*)?(?:我是|i\s*am|i'?m)\s*(?:kimi|moonshot\s*ai|月之暗面|chatgpt|gpt[-\s]?\d*|claude|gemini|文心一言|通义千问|讯飞星火|deepseek|豆包|智谱清言|智谱|glm|openai|anthropic|qwen|ernie|spark|doubao|minimax)/i;

const SENT_END = /[。.！!?？\n]/;

/** 若回复以模型/品牌身份开场，纠正为本角色身份并保留后续内容；否则原样返回。 */
export function enforceRoleIdentity(text: string, roleLabel: string): string {
  const t = text.trim();
  if (t.length === 0 || t.length > 400) return text; // 超长回复交提示词层处理
  if (!SELF_ID_AS_MODEL.test(t)) return text;
  // 截掉开头的自我指认小句（到第一个句末标点为止），保留其后真实内容。
  const end = t.search(SENT_END);
  const body = end >= 0 ? t.slice(end + 1).replace(/^[\s，,。.！!?？]+/, "") : "";
  return `我是${roleLabel}。${body}`;
}
