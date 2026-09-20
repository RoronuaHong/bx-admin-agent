// 长期记忆：跨会话保留的稳定事实与偏好，注入系统提示，接口可查看/增删。
// 不自动脑补抽取——由用户显式写入，避免把噪声沉淀成"假事实"。
// 归属（轻量 owner 标注）：记忆按设备 owner 隔离；无主遗留数据对所有人可见（与对话同口径）。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, atomicWriteJson } from "./store-util.js";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  /** 设备 owner 标注；缺省 = 遗留数据（对所有人可见）。 */
  ownerKey?: string;
}

const STORE_PATH = resolve(DATA_DIR, "memory.json");
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
}

export function addMemory(raw: string, ownerKey?: string): MemoryItem | null {
  const text = String(raw || "").trim().slice(0, MAX_TEXT_LEN);
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
