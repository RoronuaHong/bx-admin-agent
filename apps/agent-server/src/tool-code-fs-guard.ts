/**
 * run_tool_code 的文件读取守卫（纵深防御，**不是沙箱**）。
 *
 * 背景：run_tool_code 执行的是**模型写出来的代码**（可能被 prompt 注入操控），而它在工具风险
 * 登记表里是 read 级、**免确认**。子进程环境已按白名单收窄（见 toolCodeEnv，凭据不进 env），
 * 但**文件读取完全没有闸门**：`fs.readFileSync("<绝对路径>/apps/agent-server/.env")` 就能拿到
 * MONGO_URI 与各家 API key，再配合不受限的出网外发——这是 ASI05 / LLM06 上真实存在的凭据外带路径。
 *
 * 为什么用**拒绝清单**而不是允许清单：
 * - 允许清单（只许读工作区）会把解释器自身的 stdlib / site-packages 也挡掉，工具直接不可用；
 *   大量正当读取（目标项目源码、CSV、数据文件）也会被误伤。
 * - 拒绝清单只拦「形态明确」的凭据文件，不改变其它任何行为，误伤面接近零。
 * 逃逸口留了 `TOOL_CODE_FS_ALLOW`（逗号分隔的 basename / 路径片段），确有正当需要时可精确放行。
 *
 * ⚠️ **它不是沙箱，挡不住决心明确的绕过**：`child_process` 再拉一个干净的 node/python 进程、
 * 原生插件、`process.binding` 等都不受此拦截。真实隔离仍需 OS 级手段（microVM / 容器）。
 * 本守卫的价值在于挡住 prompt 注入场景下**最直接**的那一步（让模型去读 .env）。
 * 语义与边界与 docs/SECURITY.md §8.4 一致。
 */

/** 精确匹配的 basename（小写比较）。形态明确、误报面接近零。 */
export const DENIED_BASENAMES = [
  // 环境与凭据文件
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  "credentials",
  "credentials.json",
  "kubeconfig",
  ".s3cfg",
  ".htpasswd",
  "azureprofile.json",
  // 私钥
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  // 云厂商密钥材料
  "service-account.json",
  "serviceaccount.json",
];

/** 后缀匹配（`*.pem` 这类）：私钥 / 证书私钥 / 密钥库。 */
export const DENIED_SUFFIXES = [".pem", ".key", ".pfx", ".p12", ".jks", ".keystore", ".kdbx", ".ppk", ".asc"];

/** 命中即拒的目录名（路径的目录部分出现即拒）。 */
export const DENIED_DIR_SEGMENTS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"];

/** 统一的拒绝提示（Node / Python 两侧一致，便于排障时对得上）。 */
export const DENY_MESSAGE =
  "该路径被 run_tool_code 的凭据文件守卫拒绝读取（形态匹配 .env / 私钥 / 云凭据等）。" +
  "如确需读取，请让用户以参数或工作区文件形式提供，或用 TOOL_CODE_FS_ALLOW 精确放行。";

/** 归一化分隔符：把 Windows 反斜杠转成斜杠。用 fromCharCode 规避模板字符串里的反斜杠转义。 */
const NORM_HINT = "String.fromCharCode(92)";

function norm(p: string): string {
  return p.split("\\").join("/");
}

function baseOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

/** 从 `TOOL_CODE_FS_ALLOW` 解析放行名单：逗号分隔，按 basename 或路径片段匹配（大小写不敏感）。 */
export function parseFsAllow(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 纯函数：判断该路径是否应被拒绝读取（默认无逃逸口）。
 * allow 非空时命中名单（basename 相等或路径包含该片段）即放行——精确逃逸，不做通配。
 */
export function isDeniedToolCodePath(filePath: string, allow: string[] = []): boolean {
  const p = String(filePath || "");
  if (!p) return false;
  const low = norm(p).toLowerCase();
  const base = baseOf(p);
  // 放行优先：运维显式声明的 basename / 路径片段不受限。
  if (allow.some((a) => base === a || low.includes(a))) return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (DENIED_BASENAMES.includes(base)) return true;
  if (DENIED_SUFFIXES.some((suf) => base.endsWith(suf))) return true;
  // 目录片段命中（只看目录部分，不含文件名本身）。
  const dirs = low.split("/").slice(0, -1);
  if (dirs.some((s) => DENIED_DIR_SEGMENTS.includes(s))) return true;
  return false;
}

/** 共享给子进程的名单数据（单一来源，避免注入的代码与本模块判定不一致）。 */
export function guardPayload(): { basenames: string[]; suffixes: string[]; dirs: string[] } {
  return { basenames: DENIED_BASENAMES, suffixes: DENIED_SUFFIXES, dirs: DENIED_DIR_SEGMENTS };
}

/** 生成 Node 侧守卫源码（ESM，前置于用户代码）。 */
export function nodeFsGuardSource(): string {
  const g = guardPayload();
  return `// ---- run_tool_code 凭据文件守卫（服务端注入，勿删）----
const __BX_BS = String.fromCharCode(92);
const __BX_GUARD = ${JSON.stringify(g)};
const __BX_ALLOW = (process.env.TOOL_CODE_FS_ALLOW || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const __bx_norm = (s) => String(s).split(__BX_BS).join("/");
const __bx_base = (s) => { const n = __bx_norm(s).toLowerCase(); const i = n.lastIndexOf("/"); return i >= 0 ? n.slice(i + 1) : n; };
const __bx_denied = (p) => {
  const raw = p == null ? "" : String(p);
  if (!raw) return false;
  const low = __bx_norm(raw).toLowerCase();
  if (__BX_ALLOW.some((a) => __bx_base(raw) === a || low.includes(a))) return false;
  const b = __bx_base(raw);
  if (b === ".env" || b.startsWith(".env.")) return true;
  if (__BX_GUARD.basenames.indexOf(b) >= 0) return true;
  if (__BX_GUARD.suffixes.some((s) => b.endsWith(s))) return true;
  const dirs = low.split("/").slice(0, -1);
  return dirs.some((s) => __BX_GUARD.dirs.indexOf(s) >= 0);
};
const __bx_wrap = (fn) => function (p, ...rest) {
  if (__bx_denied(p)) { const e = new Error(${JSON.stringify(DENY_MESSAGE)}); e.code = "BX_FS_GUARD_DENIED"; throw e; }
  return fn.call(this, p, ...rest);
};
const __bx_fs = (await import("node:fs")).default;
for (const __n of ["readFileSync", "openSync", "createReadStream", "readdirSync", "statSync", "lstatSync", "realpathSync", "existsSync"]) {
  if (typeof __bx_fs[__n] === "function") __bx_fs[__n] = __bx_wrap(__bx_fs[__n]);
}
if (__bx_fs.promises) {
  for (const __n of ["readFile", "open", "readdir", "stat", "lstat", "realpath"]) {
    if (typeof __bx_fs.promises[__n] === "function") __bx_fs.promises[__n] = __bx_wrap(__bx_fs.promises[__n]);
  }
}
// ---- 凭据文件守卫结束 ----
`;
}

/** 生成 Python 侧守卫源码（前置在用户代码之前）。同样只拦形态明确的凭据文件。 */
export function pyFsGuardSource(): string {
  const g = guardPayload();
  return `# ---- run_tool_code 凭据文件守卫（服务端注入，勿删）----
import builtins as __bx_builtins, os as __bx_os
__BX_GUARD = ${JSON.stringify(g)}
__BX_ALLOW = [s.strip().lower() for s in (__bx_os.environ.get("TOOL_CODE_FS_ALLOW") or "").split(",") if s.strip()]
__BX_MSG = ${JSON.stringify(DENY_MESSAGE)}
def __bx_denied(p):
    try:
        raw = "" if p is None else str(p)
    except Exception:
        return False
    if not raw:
        return False
    low = raw.replace(chr(92), "/").lower()
    base = low.rsplit("/", 1)[-1]
    for a in __BX_ALLOW:
        if base == a or a in low:
            return False
    if base == ".env" or base.startswith(".env."):
        return True
    if base in __BX_GUARD["basenames"]:
        return True
    if any(base.endswith(s) for s in __BX_GUARD["suffixes"]):
        return True
    return any(s in __BX_GUARD["dirs"] for s in low.split("/")[:-1])
__bx_open = __bx_builtins.open
def __bx_guarded_open(file, *a, **kw):
    if __bx_denied(file):
        raise PermissionError(__BX_MSG)
    return __bx_open(file, *a, **kw)
__bx_builtins.open = __bx_guarded_open
# ---- 凭据文件守卫结束 ----
`;
}

/** 自检：两侧守卫源码至少包含关键标记，避免注入静默失效（回归用）。 */
export function guardSourceLooksIntact(src: string): boolean {
  return src.includes("BX_FS_GUARD_DENIED") || src.includes("__bx_guarded_open");
}

void NORM_HINT;
