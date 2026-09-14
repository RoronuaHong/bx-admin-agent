/**
 * Shared analytics LLM model preference (Structure / TurnIntent / pipeline).
 */

import { listModels, type ModelEntry } from "../config.js";

const EOL = /nvstepflash|step-3\.7-flash|stepflash/i;

function isDsFlash(m: ModelEntry): boolean {
  return m.id === "dsflash" || /deepseek-v4-flash/i.test(m.name) || /deepseek-v4-flash/i.test(m.label);
}

function isGlm5Base(m: ModelEntry): boolean {
  return m.id === "glm5" || /^glm-5$/i.test(m.name) || /^glm-5$/i.test(m.label);
}

/** Prefer ANALYTICS_DEFAULT_MODEL → dsflash → glm-5 → glm5turbo → flash → first usable. */
export function pickAnalyticsModel(modelId?: string): ModelEntry | null {
  const models = listModels().filter((m) => (m.apiKeys?.length || 0) > 0 || Boolean(m.apiKey));
  if (!models.length) return null;
  const envDefault = (process.env.ANALYTICS_DEFAULT_MODEL || "").trim();
  return (
    (modelId ? models.find((m) => m.id === modelId) : undefined) ||
    (envDefault ? models.find((m) => m.id === envDefault) : undefined) ||
    models.find((m) => isDsFlash(m) && !EOL.test(m.id) && !EOL.test(m.name)) ||
    models.find((m) => isGlm5Base(m) && !EOL.test(m.id) && !EOL.test(m.name)) ||
    models.find((m) => /glm5turbo/i.test(m.id) && !EOL.test(m.id) && !EOL.test(m.name)) ||
    models.find((m) => /flash/i.test(m.id) && !EOL.test(m.id) && !EOL.test(m.name)) ||
    models.find((m) => !EOL.test(m.id) && !EOL.test(m.name)) ||
    models[0] ||
    null
  );
}
