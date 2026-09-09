import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AnalyticsPack {
  version: string;
  id: string;
  datasource: { engine: string; metabaseDatabaseId: number };
  tables: Array<{ name: string; fields: string[] }>;
  probeDimensions: string[];
  required_filters: string[];
  time: { businessTimezone: string; missingYearDefault: string };
  guards: {
    distinctCountFn: "uniq" | "uniqExact";
    maxRows: number;
    maxProbeRounds: number;
    maxRewriteRounds: number;
    parallelism: number;
    defaultMovieTypes: number[];
  };
  examples: Array<{ nl: string; sqlHint: string }>;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../config/analytics");

export function loadAnalyticsPack(id = "watch-detail"): AnalyticsPack {
  const raw = readFileSync(join(root, `${id}.pack.json`), "utf8");
  return JSON.parse(raw) as AnalyticsPack;
}

export function assertTableAllowed(pack: AnalyticsPack, table: string): void {
  if (!pack.tables.some((t) => t.name === table)) {
    throw new Error(`table not in whitelist: ${table}`);
  }
}
