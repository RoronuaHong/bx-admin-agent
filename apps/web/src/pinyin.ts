/**
 * 中文搜索辅助：拼音匹配（基于已装的 `pinyin-pro`，不自建汉字→拼音表）。
 *
 * 场景：技能/连接器/专家等中文名称，用户习惯输入拼音检索，例如
 *   jn      → 技能          （首字母）
 *   jineng  → 技能          （全拼）
 *   yhlb    → 用户列表
 *   lb      → 用户列表      （从中间字起匹配）
 *
 * 实现说明：
 * - 用 `pinyin-pro` 的 `match()`，它自带多音字/词组词典，支持首字母、全拼、混合缩写；
 * - 用默认的 `precision: "start"`（拼音串需从头匹配，位置可偏移）。实测 `precision: "any"`
 *   会把「添加文件」误判为命中 `jn`（取「文jian」里的 j…n），故不放宽；
 * - 非中文（id、英文标签等）走原文子串匹配，两者取或。
 *
 * 体积优化：字典较大，`pinyin-pro` 不在首屏加载，而是首次打开搜索面板时按需
 * `import()`（自动拆成独立 chunk）。未就绪前 `fieldMatches` 降级为纯原文子串匹配，
 * 不会误命中；就绪后 `pinyinReady` 翻转，各 computed 重新计算即可用上拼音。
 */

import { ref, type Ref } from "vue";

type PinyinLib = { match: (text: string, pinyin: string, options?: object) => unknown };

let lib: PinyinLib | null = null;
/** 字典是否就绪：computed 读它即可在加载完成后重算。 */
export const pinyinReady: Ref<boolean> = ref(false);

/** 首次打开带搜索的面板时调用；重复调用无副作用。 */
export function loadPinyin(): void {
  if (lib || typeof window === "undefined") return;
  void import("pinyin-pro")
    .then((m) => {
      lib = m as unknown as PinyinLib;
      pinyinReady.value = true;
    })
    .catch(() => {
      /* 加载失败则维持降级（纯原文匹配），搜索只是少了拼音能力，不会崩。 */
    });
}

/** 单字段是否命中：原文子串 或 拼音（首字母/全拼/缩写）。字典未就绪时仅原文匹配。 */
function fieldMatches(field: string, query: string): boolean {
  if (field.toLowerCase().includes(query)) return true;
  if (!lib) return false;
  try {
    return lib.match(field, query) !== null;
  } catch {
    return false;
  }
}

/**
 * 模糊匹配：任一段文本命中即算命中。
 * @param parts 参与匹配的字段（名称、描述、标识等），空值自动忽略。
 * @param query 用户输入，空串视为「不过滤」。
 */
export function matchesFuzzy(parts: Array<string | undefined | null>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some((p) => (p ? fieldMatches(p, q) : false));
}

/**
 * 分档模糊匹配：单字符关键词只在「短字段」（名称 / 标识）上判定，长描述不参与。
 *
 * 原因：一个字母几乎必然出现在长描述或其拼音串里（如「标准解答话术」→ biaozhun jieda…
 * 含 a），若长文本也参与，输入任意字母都会命中全部条目，搜索等于失效。
 *
 * @param short 名称、标识等短字段。
 * @param long 描述等长文本，仅在关键词 ≥2 个字符时参与。
 */
export function matchesFuzzyScoped(
  short: Array<string | undefined | null>,
  long: Array<string | undefined | null>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return matchesFuzzy(q.length < 2 ? short : [...short, ...long], q);
}
