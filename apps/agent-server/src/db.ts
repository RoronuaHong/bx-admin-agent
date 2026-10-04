// 共享 MongoDB 连接：全服务唯一 MongoClient 单例（懒连接 + 失败冷却），
// 避免各模块（conversations / task-store / schedules / movie）各开一套连接池。
// 各模块仍各自保留「连不上 → 内存降级」的 fallback 语义，本文件只负责把「拿到一个 client」这件事统一掉。
import { MongoClient } from "mongodb";

export const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "bx_agent";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const CONNECT_RETRY_COOLDOWN = 30_000;

let clientPromise: Promise<MongoClient> | null = null;
let lastConnectFail = 0;

/** 共享 MongoClient 单例：懒连接 + 失败冷却（30s 内不重试），冷却中 reject。 */
export function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;
  if (Date.now() - lastConnectFail < CONNECT_RETRY_COOLDOWN) {
    return Promise.reject(new Error("MongoDB 连接冷却中（上次失败 30s 内）"));
  }
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  clientPromise = client
    .connect()
    .then((c) => {
      console.log(`[db] MongoDB 已连接 ${MONGO_URI}/${MONGO_DB_NAME}`);
      return c;
    })
    .catch((err) => {
      clientPromise = null;
      lastConnectFail = Date.now();
      console.warn(`[db] MongoDB 连接失败：${String((err as Error)?.message || err)}`);
      throw err;
    });
  return clientPromise;
}
