/**
 * 用户偏好记忆单测（零网络）。
 *   pnpm exec tsx scripts/user-prefs.test.ts
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectReplyLanguageFromInput,
  formatReplyLanguageReminder,
  formatUserPrefsGuide,
  loadUserPreferences,
  normalizeReplyLanguage,
  resolveReplyLanguage,
  updateUserPreference,
  _prefsDirForTest,
} from "../src/user-prefs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`PASS | [user-prefs] ${name}${detail ? " | " + detail : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL | [user-prefs] ${name}${detail ? " | " + detail : ""}`);
  }
}

// 隔离测试目录：改环境变量不方便改 PREFS_DIR 常量，用独立 ownerKey 前缀 + 测后清理文件
const A = `test-prefs-a-${Date.now()}`;
const B = `test-prefs-b-${Date.now()}`;
const dir = _prefsDirForTest();
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

check("normalize en", normalizeReplyLanguage("en") === "en");
check("normalize zh-CN", normalizeReplyLanguage("zh-CN") === "zh-CN");
check("normalize follow_input", normalizeReplyLanguage("follow_input") === "follow_input");
check("normalize auto→follow", normalizeReplyLanguage("auto") === "follow_input");
check("normalize reject junk", normalizeReplyLanguage("!!!") === undefined);
check("detect zh input", detectReplyLanguageFromInput("你好，帮我查一下") === "zh");
check("detect hi input", detectReplyLanguageFromInput("नमस्ते, मदद करो") === "hi");
check("detect short latin ambiguous", detectReplyLanguageFromInput("ok") === undefined);
check("detect longer latin input", detectReplyLanguageFromInput("please help") === "en");

check("empty load", !loadUserPreferences(A).replyLanguage);

const w1 = updateUserPreference(A, "replyLanguage", "en");
check("update en ok", w1.ok === true && w1.ok && w1.prefs.replyLanguage === "en");
check("load persists", loadUserPreferences(A).replyLanguage === "en");

const w2 = updateUserPreference(A, "replyLanguage", "zh-CN");
check("overwrite zh-CN", w2.ok === true && w2.ok && w2.prefs.replyLanguage === "zh-CN");

check("isolation B empty", !loadUserPreferences(B).replyLanguage);
updateUserPreference(B, "replyLanguage", "es");
check("isolation A still zh", loadUserPreferences(A).replyLanguage === "zh-CN");
check("isolation B es", loadUserPreferences(B).replyLanguage === "es");

const badKey = updateUserPreference(A, "tone", "formal");
check("reject unknown key", badKey.ok === false);

const cleared = updateUserPreference(A, "replyLanguage", "clear");
check("clear replyLanguage", cleared.ok === true && cleared.ok && !cleared.prefs.replyLanguage);

const guideNo = formatUserPrefsGuide({ updatedAt: 0, version: 1 });
check("guide mirror default", /本轮用户输入语种/.test(guideNo) && !/replyLanguage=en/.test(guideNo));
check("guide anti-bias", /系统提示\/工具描述\/表头/.test(guideNo));
const guideEn = formatUserPrefsGuide({ replyLanguage: "en", updatedAt: 1, version: 1 });
check("guide fixed en", /replyLanguage=en/.test(guideEn));

const remMirror = formatReplyLanguageReminder({ updatedAt: 0, version: 1 });
check("reminder mirror", /\[workflow\/reply-language\]/.test(remMirror) && /本轮用户输入语种/.test(remMirror));
check("reminder anti chinese default", /勿默认中文/.test(remMirror));
const remEn = formatReplyLanguageReminder({ replyLanguage: "en", updatedAt: 1, version: 1 });
check("reminder fixed en", /必须使用 en/.test(remEn));
const resolvedByPref = resolveReplyLanguage({
  prefs: { replyLanguage: "pt-BR", updatedAt: 1, version: 1 },
  userText: "hello",
  sessionLastReplyLanguage: "zh",
  uiLocale: "hi",
});
check("resolve priority preference first", resolvedByPref.tag === "pt-BR" && resolvedByPref.source === "preference");
const resolvedByInput = resolveReplyLanguage({
  prefs: { replyLanguage: "follow_input", updatedAt: 1, version: 1 },
  userText: "你好，继续",
  sessionLastReplyLanguage: "en",
  uiLocale: "pt-BR",
});
check("resolve priority input before session", resolvedByInput.tag === "zh" && resolvedByInput.source === "input");
const resolvedBySession = resolveReplyLanguage({
  prefs: { updatedAt: 1, version: 1 },
  userText: "ok",
  sessionLastReplyLanguage: "hi",
  uiLocale: "pt-BR",
});
check("resolve session before ui fallback", resolvedBySession.tag === "hi" && resolvedBySession.source === "session");

// cleanup
for (const k of [A, B]) {
  const f = resolve(dir, k.replace(/:/g, "__") + ".json");
  // safeFileName replaces : with __; our keys have no colon
  try {
    rmSync(resolve(dir, `${k}.json`), { force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\nuser-prefs: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
