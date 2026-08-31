import { MongoClient } from "mongodb";

export interface ClarificationPolicy {
  version: number;
  enabled: boolean;
  maxClarificationTurnsPerIntent: number;
  askThreshold: number;
  ambiguityDefaultAction: "request_clarification";
  mongoUri: string;
  mongoDbName: string;
  mongoCollection: string;
}

const DEFAULT_POLICY: ClarificationPolicy = {
  version: 1,
  enabled: true,
  maxClarificationTurnsPerIntent: 2,
  askThreshold: 0.55,
  ambiguityDefaultAction: "request_clarification",
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  mongoDbName: process.env.MONGO_DB_NAME || "bx_agent_metrics",
  mongoCollection: process.env.MONGO_METRICS_COLLECTION || "clarification_metrics",
};

let cache: ClarificationPolicy | null = null;
let lastMongoErrorAt = 0;
const MONGO_ERROR_COOLDOWN_MS = 60_000;

export function getClarificationPolicy(): ClarificationPolicy {
  if (cache) return cache;
  cache = DEFAULT_POLICY;
  return cache;
}

async function insertMetricToMongo(payload: Record<string, unknown>): Promise<void> {
  const p = getClarificationPolicy();
  if (!p.enabled) return;
  if (!p.mongoUri) return;
  let client: MongoClient | null = null;
  try {
    client = new MongoClient(p.mongoUri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const coll = client.db(p.mongoDbName).collection(p.mongoCollection);
    await coll.createIndex({ ts: -1 });
    await coll.createIndex({ type: 1, ts: -1 });
    await coll.insertOne({ ts: new Date(), ...payload });
  } catch (error) {
    const now = Date.now();
    if (now - lastMongoErrorAt > MONGO_ERROR_COOLDOWN_MS) {
      lastMongoErrorAt = now;
      console.error("[clarification-metrics] mongo unavailable:", error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

async function appendClarificationMetricAsync(payload: Record<string, unknown>) {
  const p = getClarificationPolicy();
  if (!p.enabled) return;
  await insertMetricToMongo(payload);
}

export function appendClarificationMetric(payload: Record<string, unknown>) {
  void appendClarificationMetricAsync(payload);
}

