// 长期记忆：跨会话保留的稳定事实与偏好，注入系统提示，接口可查看/增删。
// 不自动脑补抽取——由用户显式写入，避免把噪声沉淀成"假事实"。
// 归属（轻量 owner 标注）：记忆按设备 owner 隔离；无主遗留数据对所有人可见（与对话同口径）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR, atomicWriteJson } from "./store-util.js";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  /** 设备 owner 标注；缺省 = 遗留数据（对所有人可见）。 */
  ownerKey?: string;
}

const STORE_PATH = resolve(DATA_DIR, "memory.json");
/** 完整性摘要（sidecar）：记录「上次由本服务写入时的内容指纹」，用于发现带外篡改。 */
const DIGEST_PATH = resolve(DATA_DIR, "memory.digest.json");

/**
 * 控制符与不可见字符的字符类。
 *
 * ⚠️ 必须带 `u` 标志并用 `\u{...}` 写 5 位码点（Tag 块 E0000–E007F）：
 * 不加 `u` 时 `\uE0000` 会被解析成 `\uE000` + 字面量 `0`，
 * 于是 `\uE0000-\uE007F` 变成「从 `0` 到 `\uE007`」的巨大区间——几乎匹配所有字符，
 * 清洗时等于把整条记忆抹空（真实踩过，靠单测发现）。
 */
const CONTROL_CLASS =
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\uFE00-\\uFE0F\\u{E0000}-\\u{E007F}]";
/** 清洗用（全局）。 */
const controlRe = (): RegExp => new RegExp(CONTROL_CLASS, "gu");
/** 校验用（非全局，`.test()` 不受 lastIndex 影响）。 */
const controlTestRe = (): RegExp => new RegExp(CONTROL_CLASS, "u");

/** 纯函数：写入前的清洗（去控制符 + 截长度）。保留 \t \n \r。 */
export function sanitizeMemoryText(raw: string): string {
  return String(raw || "")
    .replace(controlRe(), "")
    .trim()
    .slice(0, MAX_TEXT_LEN);
}
const MAX_ITEMS = Number(process.env.MEMORY_MAX_ITEMS || 50);
const MAX_TEXT_LEN = Number(process.env.MEMORY_MAX_TEXT_LEN || 500);
/**
 * 注入系统提示的记忆总字符上限（动态段必须有硬上限）。
 * 条数上限（MAX_ITEMS）管不住单条长度累加：50 × 500 字足以把动态段撑到 25k 字，
 * 挤掉历史与工具结果的预算。故按「总字符」再收一道，且优先保留**最近**的记忆。
 */
const INJECT_CHARS = Number(process.env.MEMORY_INJECT_CHARS || 2000);

let cache: MemoryItem[] | null = null;

function loadAll(): MemoryItem[] {
  if (cache) return cache;
  try {
    if (existsSync(STORE_PATH)) {
      const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as unknown;
      if (Array.isArray(parsed)) {
        cache = parsed.filter(
          (item): item is MemoryItem => Boolean(item && typeof item === "object" && (item as MemoryItem).text),
        );
        // 载入即校验（ASI04）：篡改过的记忆会被无条件拼进之后每一轮的系统提示，
        // 早发现比事后归因便宜得多。只告警不擅自改写（改数据要留给用户决定）。
        const issues = validateMemoryItems(cache);
        if (issues.length) {
          console.warn(`[memory] 完整性校验发现 ${issues.length} 处异常：${issues.slice(0, 3).join("；")}`);
        }
        return cache;
      }
    }
  } catch (err) {
    console.warn(`[memory] 读取失败，按空记忆处理：${String((err as Error)?.message || err)}`);
  }
  cache = [];
  return cache;
}

function visibleTo(items: MemoryItem[], ownerKey?: string): MemoryItem[] {
  if (!ownerKey) return items;
  return items.filter((item) => !item.ownerKey || item.ownerKey === ownerKey);
}

export function listMemory(ownerKey?: string): MemoryItem[] {
  return visibleTo(loadAll(), ownerKey);
}

function persist(list: MemoryItem[]): void {
  cache = list;
  atomicWriteJson(STORE_PATH, list, { logLabel: "memory" });
  // 每次由本服务写入后刷新指纹；写入失败只告警（不能因为摘要没写成就把记忆丢了）。
  try {
    writeFileSync(DIGEST_PATH, `${JSON.stringify({ digest: canonicalDigest(list), count: list.length, at: Date.now() })}\n`, "utf-8");
  } catch (err) {
    console.warn(`[memory] 摘要写入失败：${String((err as Error)?.message || err)}`);
  }
}

/** 纯函数：内容的稳定指纹（与顺序无关，避免「只是顺序变了」被误判成篡改）。 */
export function canonicalDigest(items: MemoryItem[]): string {
  const canonical = items
    .map((item) => ({
      id: String(item.id || ""),
      text: String(item.text || ""),
      ownerKey: item.ownerKey || "",
      createdAt: Number(item.createdAt) || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** 纯函数：逐条校验，返回人类可读的问题列表（空数组 = 无异常）。 */
export function validateMemoryItems(items: MemoryItem[]): string[] {
  const issues: string[] = [];
  for (const item of items) {
    if (!item?.id) {
      issues.push("缺少 id");
      continue;
    }
    if (!item.text || !String(item.text).trim()) {
      issues.push(`${item.id}: 内容为空`);
      continue;
    }
    if (controlTestRe().test(String(item.text))) {
      issues.push(`${item.id}: 含控制符/不可见字符（疑似伪造提示结构）`);
    }
    if (String(item.text).length > MAX_TEXT_LEN) {
      issues.push(`${item.id}: 超长度上限 ${MAX_TEXT_LEN}`);
    }
  }
  return issues;
}

export interface MemoryIntegrity {
  /** true = 与上次写入的指纹一致且逐条校验通过。 */
  ok: boolean;
  count: number;
  /** 缺失基线（首次运行 / 摘要未生成）不算篡改——诚实区分「没基线」与「对不上」。 */
  baseline: "match" | "mismatch" | "missing";
  issues: string[];
}

/** 只读：校验当前记忆是否被带外篡改。 */
export function verifyMemoryIntegrity(items?: MemoryItem[]): MemoryIntegrity {
  const list = items || loadAll();
  const issues = validateMemoryItems(list);
  let baseline: MemoryIntegrity["baseline"] = "missing";
  try {
    if (existsSync(DIGEST_PATH)) {
      const saved = JSON.parse(readFileSync(DIGEST_PATH, "utf-8")) as { digest?: string };
      baseline = saved.digest && saved.digest === canonicalDigest(list) ? "match" : "mismatch";
    }
  } catch {
    baseline = "missing";
  }
  return { ok: baseline !== "mismatch" && issues.length === 0, count: list.length, baseline, issues };
}

export function addMemory(raw: string, ownerKey?: string): MemoryItem | null {
  // 记忆投毒（OWASP ASI04）的第一道防线是「存进来的东西先过一遍」：
  // 控制符（NUL / 零宽 / 双向覆盖 / 变体选择符）能伪造提示结构、在注入时改变语义，
  // 而记忆会被无条件拼进后续每一轮的系统提示——污染一次影响很久。保留 \t \n \r。
  const text = sanitizeMemoryText(raw);
  if (!text) return null;
  const list = loadAll().slice();
  if (list.some((item) => item.text === text)) return list.find((item) => item.text === text) || null;
  // 上限按「当前 owner 可见的条数」计：超出丢弃自己最旧的一条，保持注入体积可控。
  const own = visibleTo(list, ownerKey);
  if (own.length >= MAX_ITEMS) {
    const drop = own[0]!.id;
    persist(list.filter((item) => item.id !== drop));
  }
  const fresh = loadAll().slice();
  const item: MemoryItem = {
    id: randomUUID(),
    text,
    createdAt: Date.now(),
    ...(ownerKey ? { ownerKey } : {}),
  };
  fresh.push(item);
  persist(fresh);
  return item;
}

export function removeMemory(id: string, ownerKey?: string): boolean {
  const list = loadAll().slice();
  const target = list.find((item) => item.id === id);
  if (!target) return false;
  // 只能删自己的 + 无主遗留（与可见性同口径）。
  if (target.ownerKey && target.ownerKey !== ownerKey) return false;
  persist(list.filter((item) => item.id !== id));
  return true;
}

export function clearMemory(ownerKey?: string): void {
  persist(loadAll().filter((item) => item.ownerKey && item.ownerKey !== ownerKey));
}

/** 渲染成注入系统提示的文本；无记忆时返回空串（不打扰模型）。 */
export function renderMemory(ownerKey?: string): string {
  const items = listMemory(ownerKey);
  if (!items.length) return "";
  // 倒序累积（最新优先）后回正：超上限时丢的是最旧的记忆，且尾部注明省略条数（不静默丢数据）。
  const kept: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const line = `- ${items[i]!.text}`;
    if (used + line.length > INJECT_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const omitted = items.length - kept.length;
  const tail = omitted > 0 ? `\n…（另有 ${omitted} 条较早记忆未注入，超出注入上限）` : "";
  return `以下是用户长期保留的记忆（跨会话生效，未确认的简单采纳，冲突时以当前对话为准）：\n${kept.join("\n")}${tail}`;
}
