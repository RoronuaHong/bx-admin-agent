import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RouterPolicy {
  version: number;
  name: string;
  guards: {
    requireOperation: boolean;
    strictIndexPath: boolean;
    pcLogAlignmentOnly: boolean;
    postWriteReadback: boolean;
    denyUnknownOperation: boolean;
  };
  runtimeHints: {
    readbackTimeoutMs: number;
    maxToolRounds: number;
  };
  // auto 模式模型路由：写操作/复杂统计优先 strongModels，简单列表走 fastModels。
  autoModel?: {
    strongModels?: string[];
    fastModels?: string[];
    // 模型额度耗尽（402/401008）时的降级链：按顺序尝试下一个可用模型。
    // TokenHub 免费体验额度逐模型耗尽，strong/fast 首个耗尽不应让整类请求全挂。
    fallbackModels?: string[];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(__dirname, "..", "data", "superpower-router-policy.json");

const DEFAULT_POLICY: RouterPolicy = {
  version: 1,
  name: "default-router-policy",
  guards: {
    requireOperation: false,
    strictIndexPath: false,
    pcLogAlignmentOnly: true,
    postWriteReadback: false,
    denyUnknownOperation: true,
  },
  runtimeHints: {
    readbackTimeoutMs: 30000,
    maxToolRounds: 12,
  },
  autoModel: {
    strongModels: [],
    fastModels: [],
    fallbackModels: [],
  },
};

let cache: RouterPolicy | null = null;

export function getRouterPolicy(): RouterPolicy {
  if (cache) return cache;
  const policyPath = process.env.ROUTER_POLICY_FILE || DEFAULT_POLICY_PATH;
  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    const parsed = JSON.parse(raw) as RouterPolicy;
    cache = {
      ...DEFAULT_POLICY,
      ...parsed,
      guards: { ...DEFAULT_POLICY.guards, ...(parsed.guards || {}) },
      runtimeHints: { ...DEFAULT_POLICY.runtimeHints, ...(parsed.runtimeHints || {}) },
      autoModel: {
        strongModels: parsed.autoModel?.strongModels || [],
        fastModels: parsed.autoModel?.fastModels || [],
        fallbackModels: parsed.autoModel?.fallbackModels || [],
      },
    };
    return cache;
  } catch {
    cache = DEFAULT_POLICY;
    return cache;
  }
}

