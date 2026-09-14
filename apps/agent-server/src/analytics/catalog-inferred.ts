/**
 * Temporary inferred table descriptions for Metabase tables with no official description.
 * Source: config/analytics/catalog-inferred.json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InferredTableDoc = {
  schema?: string;
  basedOn?: string[];
  description: string;
  identity?: string;
  synonyms?: string[];
};

type InferredFile = {
  version?: string;
  tables?: Record<string, InferredTableDoc>;
};

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../config/analytics/catalog-inferred.json");

let cache: Record<string, InferredTableDoc> | null = null;

export function loadInferredTableDocs(): Record<string, InferredTableDoc> {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = {};
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as InferredFile;
    cache = raw.tables && typeof raw.tables === "object" ? raw.tables : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function inferredDescriptionFor(tableName: string): string | undefined {
  const doc = loadInferredTableDocs()[String(tableName || "").trim()];
  const text = String(doc?.description || "").trim();
  return text || undefined;
}

export function _resetInferredDocsForTest(): void {
  cache = null;
}

/** Human doc generated from catalog-inferred.json (do not hand-edit the markdown). */
export function formatInferredCatalogMarkdown(
  docs: Record<string, InferredTableDoc> = loadInferredTableDocs(),
): string {
  const names = Object.keys(docs).sort((a, b) => a.localeCompare(b));
  const bySchema = new Map<string, string[]>();
  for (const name of names) {
    const doc = docs[name]!;
    const schema = String(doc.schema || "?").trim() || "?";
    const list = bySchema.get(schema) || [];
    list.push(name);
    bySchema.set(schema, list);
  }
  const lines: string[] = [
    "# Analytics 无官方说明表（暂存推断）",
    "",
    "> 由 `apps/agent-server/config/analytics/catalog-inferred.json` **生成，不要手改本文件**。",
    "> 对照同族已有 Metabase 说明 + 列名推断，**不是仓库官方文档**。官方说明补上后删 JSON 对应条目并重跑 `pnpm --filter @bx/agent-server catalog-digest`。",
    "",
    `- 表数：${names.length}`,
    "- 问数选表会读取 JSON；观看人数 / 完播 / 人均时长默认仍走 `elt_watch_detail`。",
    "",
  ];
  for (const schema of [...bySchema.keys()].sort()) {
    lines.push(`## Schema \`${schema}\``, "");
    for (const name of bySchema.get(schema) || []) {
      const doc = docs[name]!;
      const based = (doc.basedOn || []).map((t) => `\`${t}\``).join("、") || "（无）";
      lines.push(`### \`${schema}.${name}\``, "");
      lines.push(`- 对照：${based}`);
      lines.push(`- ${String(doc.description || "").trim().replace(/\n/g, "\n")}`, "");
    }
  }
  return lines.join("\n");
}
