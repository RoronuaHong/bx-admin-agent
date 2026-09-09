import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleSet } from "./types.js";

const rulesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../config/analytics/rules");

/**
 * Load a ruleset JSON from `config/analytics/rules/{id}.ruleset.json`.
 * Does not invent missing fields — callers must use configured values.
 */
export function loadRuleset(id: string): RuleSet {
  const trimmed = String(id ?? "").trim();
  if (!trimmed) {
    throw new Error("ruleset id is required");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`invalid ruleset id: ${id}`);
  }
  const raw = readFileSync(join(rulesRoot, `${trimmed}.ruleset.json`), "utf8");
  return JSON.parse(raw) as RuleSet;
}
