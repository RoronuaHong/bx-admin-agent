// 观影画像：记录用户表达过的观影口味（看过 / 喜欢 / 不喜欢），按 ownerKey 一条。
// 存储走 Mongo（失败降级内存），与 conversations / schedules 同策略。
//
// 说明：ownerKey 目前是**设备 owner**（owner.ts 的 cookie，单机单用户部署下等价于「一位用户」）。
// 若将来接入登录体系，只需把 ownerKey 换成登录身份键，本模块与调用方不用改结构。
//
// 历史沿革：原「个性化推荐管线」（离线预计算 + 缓存 + 5 个 HTTP 端点 + 前端推荐面板 + 豆瓣 MCP）已于 2026-09-18 整体移除，
// 画像随之只保留「口味记录」用途——唯一写入口是内置工具 `record_watched_movies`（builtins.ts）。
import { MongoClient, type Collection, type Db } from "mongodb";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB_NAME || "bx_agent";
const COLL = "movie_profiles";

/** 观看历史条目（来源：对话中被识别的片）。 */
export interface MovieHistoryItem {
  id: string;
  title: string;
  year?: number;
  /** 用户评分（可选，来自对话）。 */
  rating?: number;
  at: number;
  /** 遗留字段：口味校准端点已移除，现仅由对话写入（"chat"）。旧文档可能仍是 "calibration"。 */
  source: "calibration" | "chat";
}

/** 显式反馈：喜欢 / 不感兴趣。 */
export interface MovieFeedbackItem {
  id: string;
  title: string;
  verdict: "like" | "dislike";
  at: number;
}

export interface MovieProfile {
  ownerKey: string;
  history: MovieHistoryItem[];
  feedback: MovieFeedbackItem[];
  updatedAt: number;
}

const MAX_HISTORY = 200;
const MAX_FEEDBACK = 200;

// ---- Mongo 单例（独立小集合；失败降级内存）----
let clientPromise: Promise<MongoClient> | null = null;
async function getColl(): Promise<Collection<MovieProfile> | null> {
  try {
    if (!clientPromise) {
      clientPromise = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 }).connect();
    }
    const client = await clientPromise;
    const db: Db = client.db(MONGO_DB);
    return db.collection<MovieProfile>(COLL);
  } catch {
    clientPromise = null;
    return null;
  }
}
const memory = new Map<string, MovieProfile>();

function emptyProfile(ownerKey: string): MovieProfile {
  return { ownerKey, history: [], feedback: [], updatedAt: Date.now() };
}

/** 补齐缺省字段（旧文档 / 半写文档都能安全使用）；推荐时代的字段（seen / watchlist / tasteTags / recs）直接忽略。 */
function normalize(raw: Partial<MovieProfile> | null, ownerKey: string): MovieProfile {
  const base = emptyProfile(ownerKey);
  if (!raw) return base;
  return {
    ownerKey,
    history: Array.isArray(raw.history) ? raw.history : [],
    feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
    updatedAt: Number(raw.updatedAt) || base.updatedAt,
  };
}

export async function getProfile(ownerKey: string): Promise<MovieProfile> {
  if (!ownerKey) return emptyProfile(ownerKey || "anonymous");
  const coll = await getColl();
  if (!coll) return normalize(memory.get(ownerKey) || null, ownerKey);
  try {
    const doc = await coll.findOne({ ownerKey });
    return normalize(doc, ownerKey);
  } catch {
    return normalize(memory.get(ownerKey) || null, ownerKey);
  }
}

export async function saveProfile(profile: MovieProfile): Promise<void> {
  const next = { ...profile, updatedAt: Date.now() };
  memory.set(next.ownerKey, next);
  const coll = await getColl();
  if (!coll) return;
  try {
    await coll.updateOne({ ownerKey: next.ownerKey }, { $set: next }, { upsert: true });
  } catch {
    /* 落库失败不影响内存态：本轮仍可用，下次再写 */
  }
}

function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((item) => (item.id && !seen.has(item.id) ? (seen.add(item.id), true) : false));
}

/** 写入历史（去重，最新的排前面）。 */
export async function addHistory(
  ownerKey: string,
  items: Array<{ id: string; title: string; year?: number; rating?: number; source?: MovieHistoryItem["source"] }>,
): Promise<MovieProfile> {
  const profile = await getProfile(ownerKey);
  const now = Date.now();
  const incoming: MovieHistoryItem[] = items
    .filter((it) => it.id && it.title)
    .map((it) => ({
      id: String(it.id),
      title: String(it.title),
      ...(it.year ? { year: Number(it.year) } : {}),
      ...(it.rating ? { rating: Number(it.rating) } : {}),
      at: now,
      source: it.source === "calibration" ? "calibration" : "chat",
    }));
  // 已在历史里的用新数据覆盖（保留位置语义：最新的在前）
  const merged = dedupeById([...incoming, ...profile.history]).slice(0, MAX_HISTORY);
  const next: MovieProfile = { ...profile, history: merged, updatedAt: now };
  await saveProfile(next);
  return next;
}

/** 写入「喜欢 / 不喜欢」反馈（同片覆盖，最新的在前）。 */
export async function setFeedback(
  ownerKey: string,
  item: { id: string; title: string; verdict: "like" | "dislike" },
): Promise<MovieProfile> {
  const profile = await getProfile(ownerKey);
  const rest = profile.feedback.filter((f) => f.id !== item.id);
  const feedback = [
    { id: String(item.id), title: String(item.title), verdict: item.verdict, at: Date.now() },
    ...rest,
  ].slice(0, MAX_FEEDBACK);
  const next: MovieProfile = { ...profile, feedback, updatedAt: Date.now() };
  await saveProfile(next);
  return next;
}
