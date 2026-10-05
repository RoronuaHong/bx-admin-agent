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
  let out = String(text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const matches = out.match(p.re);
    if (matches) hits += matches.length;
  }
  return hits;
}
