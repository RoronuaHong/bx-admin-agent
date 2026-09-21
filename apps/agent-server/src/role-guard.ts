/**
 * 角色身份护栏：兜底拦截模型把「自己」错认为某个底层大模型 / 品牌的自报
 * （典型：用户问「你是谁」时回「我是 Kimi，由 Moonshot AI 开发…」）。
 *
 * 行为（**按句**判断，保留原「开场自报」情形，并覆盖「先报正确身份、再补一句模型自报」）：
 * - 某一句的开头是自我指认 + 模型/品牌名，且**该句本身就是自报句**（短句、模型名后紧跟分隔或「由…」）：
 *   - 是首句 → 换成本角色身份，保留其后内容（原行为）；
 *   - 不是首句 → 直接丢弃这一句（冗余且泄漏）。
 * - 非自报句里的品牌提及（如「我是 Kimi 的忠实用户」「Kimi 是月之暗面的模型」）不受影响。
 * - 长回答（>400 字）整段不动，交提示词层处理——确定性改写只处理「自报身份」这一种确定情形。
 *
 * 匹配的是跨系统通用的模型 / 厂商名（Kimi / GPT / Claude …），不含任何业务词，符合「禁止写死业务词」红线。
 */
const MODEL_BRANDS =
  "kimi|moonshot\\s*ai|月之暗面|chatgpt|gpt[-\\s]?\\d*|claude|gemini|文心一言|通义千问|讯飞星火|deepseek|豆包|智谱清言|智谱|glm|openai|anthropic|qwen|ernie|spark|doubao|minimax";

/**
 * 自我指认句：句首（可带一句问候）就是「我是/我是_i_am + 模型名」，且模型名后面必须是
 * 分隔符 / 「（由…）」/ 句末——否则像「我是 Kimi 的忠实用户」这种正常表述会被误伤。
 */
const SELF_ID_AS_MODEL = new RegExp(
  `^(?:\\s*(?:你好|您好|hi|hello|hey)[，,!！?？\\s]*)?(?:我是|i\\s*am|i'?m)\\s*(?:${MODEL_BRANDS})(?=[，,。.！!?？、：:；;（(]|\\s*由|\\s*$)`,
  "i",
);

/** 自报句该有的长度上限：超过它就不是「自报身份」，而是正文里提到了某个模型名。 */
const SELF_ID_MAX_CHARS = 40;

/** 按句末标点切段（保留分隔符，便于原样拼回）。 */
function splitSentences(text: string): string[] {
  return (text.match(/[^。.！!?？\n]*[。.！!?？\n]?/g) || []).filter((seg) => seg.trim().length > 0);
}

/** 若回复中含「模型/品牌身份自报」，改本角色身份（首句）或丢该句（非首句）；否则原样返回。 */
export function enforceRoleIdentity(text: string, roleLabel: string): string {
  const t = text.trim();
  if (t.length === 0 || t.length > 400) return text; // 超长回复交提示词层处理
  const segments = splitSentences(t);
  if (!segments.length) return text;

  let changed = false;
  const kept: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const isSelfId = seg.trim().length <= SELF_ID_MAX_CHARS && SELF_ID_AS_MODEL.test(seg.trim());
    if (!isSelfId) {
      kept.push(seg);
      continue;
    }
    changed = true;
    // 首句自报 → 换成本角色身份；非首句自报 → 丢弃（前面已经说对了身份，这句纯属泄漏）。
    if (i === 0) kept.push(`我是${roleLabel}。`);
  }
  return changed ? kept.join("") : text;
}
