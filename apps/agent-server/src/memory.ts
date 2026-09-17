// 长期记忆：跨会话保留的稳定事实与偏好，注入系统提示，接口可查看/增删。
// 不自动脑补抽取——由用户显式写入，避免把噪声沉淀成"假事实"。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(__dirname, "..", ".data", "memory.json");
const MAX_ITEMS = Number(process.env.MEMORY_MAX_ITEMS || 50);
const MAX_TEXT_LEN = Number(process.env.MEMORY_MAX_TEXT_LEN || 500);

let cache: MemoryItem[] | null = null;

export function listMemory(): MemoryItem[] {
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

function persist(list: MemoryItem[]): void {
  cache = list;
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
    renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.warn(`[memory] 写入失败：${String((err as Error)?.message || err)}`);
  }
}

export function addMemory(raw: string): MemoryItem | null {
  const text = String(raw || "").trim().slice(0, MAX_TEXT_LEN);
  if (!text) return null;
  const list = listMemory().slice();
  if (list.some((item) => item.text === text)) return list.find((item) => item.text === text) || null;
  // 超出上限丢弃最旧的一条，保持注入体积可控。
  while (list.length >= MAX_ITEMS) list.shift();
  const item: MemoryItem = { id: randomUUID(), text, createdAt: Date.now() };
  list.push(item);
  persist(list);
  return item;
}

export function removeMemory(id: string): boolean {
  const list = listMemory().slice();
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return false;
  persist(next);
  return true;
}

export function clearMemory(): void {
  persist([]);
}

/** 渲染成注入系统提示的文本；无记忆时返回空串（不打扰模型）。 */
export function renderMemory(): string {
  const items = listMemory();
  if (!items.length) return "";
  const lines = items.map((item) => `- ${item.text}`).join("\n");
  return `以下是用户长期保留的记忆（跨会话生效，未确认的简单采纳，冲突时以当前对话为准）：\n${lines}`;
}
