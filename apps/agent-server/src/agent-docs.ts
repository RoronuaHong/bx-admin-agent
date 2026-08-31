import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Agent 文档与 superpower 配置目录：bx-admin-agent/docs/agent（单一来源） */
const __dirname = dirname(fileURLToPath(import.meta.url));
export const AGENT_DOCS_DIR = resolve(__dirname, "../../../docs/agent");

export function agentDocPath(...parts: string[]): string {
  return resolve(AGENT_DOCS_DIR, ...parts);
}

export function defaultFieldMappingPath(): string {
  return process.env.FIELD_MAPPING_PATH || agentDocPath("field-mapping.json");
}

export function defaultClarificationPolicyPath(): string {
  return process.env.CLARIFICATION_POLICY_PATH || agentDocPath("clarification-policy.json");
}
