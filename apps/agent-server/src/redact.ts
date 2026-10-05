/**
 * 出站密钥脱敏（对齐 OWASP ASI05 Data Leakage / LLM06 Sensitive Information Disclosure）。
 *
 * Agent 会读文件、读环境、调外部系统——一旦把「读到的密钥」原样写进回答、导出文件或日志，
 * 就是一次凭据外带。这里给出站文本加最后一道过滤：命中已知凭据形态即打码。
 *
 * 设计取舍：
 * - 只认**形态明确**的凭据（前缀可识别、长度足够），不做宽泛的「看起来像密码」启发式——
 *   后者在业务数据上误报率极高，会把正常回答改坏。
 * - 打码保留类型标记（[REDACTED:OPENAI_KEY]），让人知道「这里有东西被去掉了」而不是静默消失。
 * - 是**最后一道**防线，不是唯一一道：真正的防线是「子进程不继承服务端环境」（tool-code.ts）
 *   与「凭据不入日志/trace」。
 */
interface SecretPattern {
  name: string;
  re: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: "OPENAI_KEY", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "GITHUB_TOKEN", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "GITLAB_TOKEN", re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { name: "AWS_ACCESS_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "SLACK_TOKEN", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "BEARER", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/gi },
  // PEM 私钥：整块替换（含中间内容），避免只打码一行却把密钥主体留下来。
  {
    name: "PRIVATE_KEY",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

/** 纯函数：把文本里命中凭据形态的片段替换为打码标记。 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = String(text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, `[REDACTED:${p.name}]`);
  }
  return out;
}

/** 纯函数：统计命中次数（用于告警与观测，不修改文本）。 */
export function countSecretHits(text: string): number {
  if (!text) return 0;
  let hits = 0;
  const out = String(text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const matches = out.match(p.re);
    if (matches) hits += matches.length;
  }
  return hits;
}

// ───────────────────────── 通用 PII（可选，默认关闭） ─────────────────────────
/**
 * 与凭据不同，PII 在业务数据里**真的会出现**（订单号像卡号、编号像身份证），
 * 默认开启会把正常回答改坏。所以：
 * - 默认**关闭**；`REDACT_PII=on` 才启用。
 * - `REDACT_PII_TYPES` 可只开某几类（逗号分隔：email,phone,idcard,bankcard），默认全开。
 * 启用后仍只打码「形态明确」的几类，不做姓名/地址这类无形态可依的识别（那必然靠词典，误报不可控）。
 */
const PII_PATTERNS: SecretPattern[] = [
  { name: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "CN_PHONE", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: "CN_ID_CARD", re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: "BANK_CARD", re: /(?<!\d)\d{16,19}(?!\d)/g },
];

function piiTypes(): Set<string> {
  const raw = (process.env.REDACT_PII_TYPES || "").trim();
  const all = new Set(PII_PATTERNS.map((p) => p.name));
  if (!raw) return all;
  // 类型名大写（EMAIL / CN_PHONE …），用户输入大小写随意 → 统一转大写再比对。
  const picked = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  return new Set([...picked].filter((t) => all.has(t)));
}

/** 是否启用 PII 打码（每次现读，便于测试与即时生效）。 */
export function piiEnabled(): boolean {
  return process.env.REDACT_PII === "on";
}

/** 纯函数：按当前启用的类型打码 PII。 */
export function redactPii(text: string): string {
  if (!text) return text;
  const enabled = piiTypes();
  let out = String(text);
  for (const p of PII_PATTERNS) {
    if (!enabled.has(p.name)) continue;
    p.re.lastIndex = 0;
    out = out.replace(p.re, `[REDACTED:${p.name}]`);
  }
  return out;
}

/**
 * 出站统一入口：凭据**总是**打码（形态明确、误报极低），PII 按开关。
 * chat 与导出路径都应走这里，而不是各自挑一个。
 */
export function redactSensitive(text: string): string {
  return piiEnabled() ? redactPii(redactSecrets(text)) : redactSecrets(text);
}
