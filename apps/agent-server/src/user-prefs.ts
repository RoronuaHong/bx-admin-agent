/**
 * 用户偏好记忆（L1，对齐 Cursor User Rules）：按 ownerKey 持久化，与会话历史分库。
 * 首期仅 replyLanguage；同 key 覆盖写；零业务词。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFS_DIR = resolve(__dirname, "..", ".data", "user-prefs");

/** 允许写入的偏好键（白名单，防任意膨胀） */
export const PREF_KEYS = ["replyLanguage"] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

export interface UserPreferences {
  /** BCP-47 语种标签，或 follow_input 表示始终跟本轮用户输入语种 */
  replyLanguage?: string;
  updatedAt: number;
  version: 1;
}

function safeFileName(ownerKey: string): string {
  const raw = String(ownerKey || "").trim() || "anonymous";
  return raw.replace(/[^a-zA-Z0-9._:@-]+/g, "_").replace(/:/g, "__") + ".json";
}

function prefsPath(ownerKey: string): string {
  return resolve(PREFS_DIR, safeFileName(ownerKey));
}

function emptyPrefs(): UserPreferences {
  return { updatedAt: 0, version: 1 };
}

export function loadUserPreferences(ownerKey: string): UserPreferences {
  if (!ownerKey?.trim()) return emptyPrefs();
  const path = prefsPath(ownerKey);
  if (!existsSync(path)) return emptyPrefs();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UserPreferences>;
    const out = emptyPrefs();
    if (typeof raw.replyLanguage === "string" && raw.replyLanguage.trim()) {
      out.replyLanguage = normalizeReplyLanguage(raw.replyLanguage);
    }
    out.updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
    out.version = 1;
    return out;
  } catch {
    return emptyPrefs();
  }
}

/** 规范化 replyLanguage：空 → 删除；follow_input 保留；其余 trim 为小写语种子标签为主 */
export function normalizeReplyLanguage(raw: string): string | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if (/^follow[_-]?input$/i.test(s) || /^mirror$/i.test(s) || /^auto$/i.test(s)) {
    return "follow_input";
  }
  // 允许 BCP-47 简写（en / zh / zh-CN / es / ja…），不做语种词典枚举
  const tag = s.replace(/_/g, "-");
  if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return undefined;
  return tag;
}

export function saveUserPreferences(ownerKey: string, prefs: UserPreferences): void {
  if (!ownerKey?.trim()) throw new Error("ownerKey required");
  if (!existsSync(PREFS_DIR)) mkdirSync(PREFS_DIR, { recursive: true });
  const path = prefsPath(ownerKey);
  const tmp = `${path}.${process.pid}.tmp`;
  const payload: UserPreferences = {
    version: 1,
    updatedAt: Date.now(),
    ...(prefs.replyLanguage ? { replyLanguage: prefs.replyLanguage } : {}),
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * 更新单项偏好。value 空字符串 / null / "clear" → 清除该键。
 * 未知 key 拒绝。
 */
export function updateUserPreference(
  ownerKey: string,
  key: string,
  value: unknown,
): { ok: true; prefs: UserPreferences } | { ok: false; error: string } {
  if (!ownerKey?.trim()) return { ok: false, error: "ownerKey missing" };
  if (!(PREF_KEYS as readonly string[]).includes(key)) {
    return { ok: false, error: `unknown preference key: ${key}; allowed: ${PREF_KEYS.join(", ")}` };
  }
  const cur = loadUserPreferences(ownerKey);
  if (key === "replyLanguage") {
    const raw = value == null ? "" : String(value).trim();
    if (!raw || /^clear$/i.test(raw) || raw === "-") {
      delete cur.replyLanguage;
    } else {
      const norm = normalizeReplyLanguage(raw);
      if (!norm) {
        return {
          ok: false,
          error: "invalid replyLanguage; use BCP-47 tag (e.g. en, zh-CN) or follow_input",
        };
      }
      cur.replyLanguage = norm;
    }
  }
  saveUserPreferences(ownerKey, cur);
  return { ok: true, prefs: loadUserPreferences(ownerKey) };
}

/** 注入 system 的短块（类 Cursor User Rules always-on） */
export function formatUserPrefsGuide(prefs: UserPreferences): string {
  const lines: string[] = [
    "[workflow/user-prefs]（用户级偏好，对齐 Cursor User Rules；次于项目底线，高于本轮默认）:",
  ];
  if (prefs.replyLanguage && prefs.replyLanguage !== "follow_input") {
    lines.push(
      `- replyLanguage=${prefs.replyLanguage}：面向用户的自然语言必须使用该语言（表格等结构化 UI 可中立）。`,
    );
  } else {
    lines.push(
      "- 无固定 replyLanguage：面向用户的自然语言必须与本轮用户输入语种一致（模型自判，勿默认某一语言）。",
    );
  }
  lines.push(
    "- 用户明确要求「以后用某语言回复 / 改回跟我说的语言」时，调用 update_user_preference 写入 replyLanguage（或 follow_input）。",
  );
  return lines.join("\n");
}

/** 测试用：覆盖 prefs 目录（仅单测） */
export function _prefsDirForTest(): string {
  return PREFS_DIR;
}
