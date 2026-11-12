// 评测防泄题（留一法）：跑分器每跑一例，把「本例卡片 + 与它等价的卡片」写进留出文件；
// BI MCP 进程在评测模式下（设置了 BI_EVAL_HOLDOUT_FILE）每次检索/取卡前读取它，把这些卡片从所有检索源里隐藏，
// 并整体禁用 get_golden_set。否则题目 = 卡片标题，模型按标题搜到原卡片照抄 SQL，测的就是检索而不是能力。
// runner 与 MCP 是两个进程（MCP 由 agent-server 以 stdio 拉起），只能经文件传递；两边必须指向同一个绝对路径。
import fs from "node:fs";
import path from "node:path";

export const HOLDOUT_ENV = "BI_EVAL_HOLDOUT_FILE";

const normSql = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().toLowerCase() : "");
const normName = (s) => (typeof s === "string" ? s.replace(/\s+/g, "").toLowerCase() : "");

/** 本例要留出的卡片：自身 + 编译后 SQL 相同或标题相同的「孪生卡片」（复制改名/同口径多份的卡片同样会泄题）。 */
export function holdoutCardIds(cases, caseId) {
  const self = cases.find((c) => c.id === caseId);
  if (!self) return [caseId];
  const sql = normSql(self.expected_sql);
  // 题目改成自然语言后，孪生卡片识别要靠保留下来的原卡片名（cardTitle）。
  const title = (c) => normName(c.cardTitle ?? c.question);
  const name = title(self);
  const ids = new Set([caseId]);
  for (const c of cases) {
    if ((sql && normSql(c.expected_sql) === sql) || (name && title(c) === name)) ids.add(c.id);
  }
  return [...ids];
}

export function writeHoldout(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

export function clearHoldout(file) {
  writeHoldout(file, { caseId: null, cardIds: [] });
}

/** 评测模式是否开启：只看环境变量，文件暂缺也算开启（get_golden_set 照样禁用）。 */
export function evalModeActive(env = process.env) {
  return Boolean(env[HOLDOUT_ENV]);
}

// P3 A/B：关闭 get_caliber_context 跑「无口径图」对照组。只在评测模式下生效，
// 避免有人把它误配进生产 .env 后把线上工具关掉（与 HOLDOUT_ENV 同为命令行临时开关）。
export const CALIBER_DISABLE_ENV = "BI_EVAL_DISABLE_CALIBER";
const CALIBER_TOOL = "get_caliber_context";
const TRUTHY = /^(1|true|yes|on)$/i;

export function caliberDisabled(env = process.env) {
  return evalModeActive(env) && TRUTHY.test(String(env[CALIBER_DISABLE_ENV] ?? "").trim());
}

/** 评测模式下不对外宣告的工具，tools/list 与调用闸门共用，避免两处判定漂移。 */
export function evalHiddenTools(env = process.env) {
  const hidden = new Set();
  if (evalModeActive(env)) hidden.add("get_golden_set");
  if (caliberDisabled(env)) hidden.add(CALIBER_TOOL);
  return hidden;
}

let cache = { key: null, ids: new Set() };

/** 当前留出的卡片 id 集合；按 mtime+size 缓存，文件没变不重复解析。读不到返回空集（fail-open：不隐藏任何卡片）。 */
export function heldOutCardIds(env = process.env) {
  const file = env[HOLDOUT_ENV];
  if (!file) return new Set();
  try {
    const { mtimeMs, size } = fs.statSync(file);
    const key = `${file}|${mtimeMs}|${size}`;
    if (cache.key === key) return cache.ids;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ids = new Set((Array.isArray(data.cardIds) ? data.cardIds : []).map(Number).filter(Number.isFinite));
    cache = { key, ids };
    return ids;
  } catch {
    return new Set();
  }
}

export function isHeldOut(cardId, env = process.env) {
  if (cardId == null) return false;
  return heldOutCardIds(env).has(Number(cardId));
}

/** 按卡片 id 读取/执行卡片的工具 → 卡片 id 所在参数。read_resource 仅 type=card 时算。 */
const CARD_ID_ARG = { get_card: "card_id", get_related_cards: "card_id", execute_query: "question_id", query: "question_id", construct_query: "question_id" };

export function cardIdArg(tool, args = {}) {
  if (CARD_ID_ARG[tool]) return args[CARD_ID_ARG[tool]] ?? null;
  if (tool === "read_resource" && args.type === "card") return args.id ?? null;
  return null;
}

/** 前缀供跑分器识别「评测模式确实生效」；措辞保持中性，不提示模型这是评测。 */
export const HOLDOUT_MARK = "[eval-holdout]";

/** 评测模式下的调用闸门：隐藏工具（get_golden_set / A/B 关闭的口径图）整体禁用；按 id 取/跑留出卡片拒绝。 */
export function evalGateRefusal(tool, args = {}, env = process.env) {
  if (!evalModeActive(env)) return null;
  if (evalHiddenTools(env).has(tool)) return `${HOLDOUT_MARK} 该工具当前不可用。`;
  const id = cardIdArg(tool, args);
  if (id != null && isHeldOut(id, env)) return `${HOLDOUT_MARK} 卡片 ${id} 当前不可用，请根据表结构自行编写 SQL。`;
  return null;
}

/** 列表类输出里剔除留出卡片（list_cards / search / 仪表盘卡片 / 按表找卡片 / 关联卡片）。 */
export function hideHeldOut(rows, key = "id", env = process.env) {
  const ids = heldOutCardIds(env);
  if (!ids.size || !Array.isArray(rows)) return rows;
  return rows.filter((r) => !ids.has(Number(r?.[key])));
}
