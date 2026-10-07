/**
 * run_tool_code 的文件读取守卫（纵深防御，**不是沙箱**）。
 *
 * 背景：run_tool_code 执行的是**模型写出来的代码**（可能被 prompt 注入操控），而它在工具风险
 * 登记表里是 read 级、**免确认**（`verdictNeedsConfirm` 为 false，任何模式下都不弹确认卡）。
 * 子进程环境已按白名单收窄（见 toolCodeEnv，凭据不进 env），但**文件读取**需要这一层：
 * `fs.readFileSync("<绝对路径>/.env")` 就能拿到 MONGO_URI 与各家 API key，再配合不受限出网外发。
 * 这是 ASI05 / LLM06 上真实存在的凭据外带路径，也是本工具与 `.env` 之间**唯一**的屏障。
 *
 * 为什么用**拒绝清单**而不是允许清单：
 * - 允许清单（只许读工作区）会把解释器自身的 stdlib / site-packages 也挡掉，工具直接不可用；
 *   大量正当读取（目标项目源码、CSV、数据文件）也会被误伤。
 * - 拒绝清单只拦「形态明确」的凭据文件，不改变其它任何行为，误伤面接近零。
 *
 * 拦截形态（2026-10-07 收紧，见 `docs/SECURITY.md` §8.3）：
 * - Node 侧走 **`--require` 预加载（CJS）**，在 ESM 门面创建**之前**就把 `node:fs` 打上补丁。
 *   这是关键：`node:fs` 的 ESM **命名导出是模块求值期的快照**，只在用户代码之后打补丁的话
 *   `const { readFileSync } = await import("node:fs")` 拿到的仍是未包装的原函数（实测可绕过）。
 *   预加载先于一切 import，快照捕获到的就是补丁后的函数。
 * - Python 侧同时包装 `builtins.open` / `io.open` / `os.open`：只包 `builtins.open` 时
 *   `io.open` 一行即破，而 `pathlib.Path.read_text()` 内部正是走 `io.open`。
 *
 * ⚠️ **它仍然不是沙箱**：`child_process` 再拉一个干净进程、原生插件、`process.binding` 都不受拦截
 * （Python 侧 `os.popen` / `subprocess` 更是直接任意命令执行）。本守卫的价值是挡住 prompt 注入
 * 场景下**最直接**的那一步，真实隔离仍需 OS 级手段。另见 `run_command` / `run_script`：它们
 * 不在本守卫覆盖范围内（那是「用户批准执行任意命令」的语义，属不同信任模型）。
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

/** 统一的错误码（测试与排障据此识别「是守卫拦的」而非普通 ENOENT）。 */
export const DENY_CODE = "BX_FS_GUARD_DENIED";

function norm(p: string): string {
  return p.split("\\").join("/");
}

function baseOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

/** 从 `TOOL_CODE_FS_ALLOW` 解析放行名单：逗号分隔，小写归一。 */
export function parseFsAllow(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 放行判定：
 * - **basename 相等**才放行（`.env` 只放行叫 .env 的文件）；
 * - 只有含 `/` 的片段才做路径包含匹配（`D:/proj/` 放行整个目录）。
 *
 * 为什么不能一律用子串包含（2026-10-07 修复）：`TOOL_CODE_FS_ALLOW=.` 会让**几乎任何路径**都
 * `includes(".")`，守卫被一条配置全局关停；`env`、`C:` 之类短片段同理。这是「运维想精确放行、
 * 结果整体失效」的反向失败模式，比误伤更危险。
 */
function allowedBy(allow: string[], p: string): boolean {
  if (!allow.length) return false;
  const base = baseOf(p);
  const low = norm(p).toLowerCase();
  return allow.some((a) => base === a || (a.includes("/") && low.includes(a)));
}

/**
 * 纯函数：判断该路径是否应被拒绝读取。
 * 这是**判定口径的单一来源**——注入到子进程的 JS / Python 副本必须与它一致，
 * 由 `tests/tool-code-fs-guard.test.ts` 的「三份实现一致性」用例在真实子进程中逐条比对钉住。
 */
export function isDeniedToolCodePath(filePath: string, allow: string[] = []): boolean {
  const p = String(filePath || "");
  if (!p) return false;
  if (allowedBy(allow, p)) return false;
  const base = baseOf(p);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (DENIED_BASENAMES.includes(base)) return true;
  if (DENIED_SUFFIXES.some((suf) => base.endsWith(suf))) return true;
  // 目录片段命中（只看目录部分，不含文件名本身）。
  const dirs = norm(p).toLowerCase().split("/").slice(0, -1);
  return dirs.some((s) => DENIED_DIR_SEGMENTS.includes(s));
}

/** 子进程读不到服务端模块，故名单数据内联进注入源码（唯一来源，避免三处各写一份）。 */
export function guardPayload(): { basenames: string[]; suffixes: string[]; dirs: string[] } {
  return { basenames: DENIED_BASENAMES, suffixes: DENIED_SUFFIXES, dirs: DENIED_DIR_SEGMENTS };
}

/** 共用判定体的生成器入参（两侧注入源码都从这里取，保证口径一致）。 */
const NAMES_PAYLOAD = () => JSON.stringify(guardPayload());
const MSG_PAYLOAD = () => JSON.stringify(DENY_MESSAGE);
const CODE_PAYLOAD = () => JSON.stringify(DENY_CODE);

/**
 * Node 侧守卫：**CJS 预加载**（配合 `node --require <本文件> script.mjs`）。
 *
 * 必须在 ESM 门面创建前打补丁：`node:fs` 的命名导出是求值期快照，晚一步就拦不住
 * `const { readFileSync } = await import("node:fs")`。预加载先于所有 import 执行。
 */
export function nodeFsGuardPreloadSource(): string {
  const BS = "String.fromCharCode(92)";
  return `// ---- run_tool_code 凭据文件守卫（服务端注入的 CJS 预加载，勿删）----
(function () {
  var __BX_BS = ${BS};
  var __BX_GUARD = ${NAMES_PAYLOAD()};
  var __BX_MSG = ${MSG_PAYLOAD()};
  var __BX_CODE = ${CODE_PAYLOAD()};
  var __BX_ALLOW = (process.env.TOOL_CODE_FS_ALLOW || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  function __bx_norm(s) { return String(s).split(__BX_BS).join("/"); }
  function __bx_base(s) { var n = __bx_norm(s).toLowerCase(); var i = n.lastIndexOf("/"); return i >= 0 ? n.slice(i + 1) : n; }
  function __bx_allow(p) {
    if (!__BX_ALLOW.length) return false;
    var b = __bx_base(p);
    var low = __bx_norm(p).toLowerCase();
    return __BX_ALLOW.some(function (a) { return b === a || (a.indexOf("/") >= 0 && low.indexOf(a) >= 0); });
  }
  function __bx_denied(p) {
    var raw = p == null ? "" : String(p);
    if (!raw) return false;
    if (__bx_allow(raw)) return false;
    var b = __bx_base(raw);
    if (b === ".env" || b.indexOf(".env.") === 0) return true;
    if (__BX_GUARD.basenames.indexOf(b) >= 0) return true;
    for (var i = 0; i < __BX_GUARD.suffixes.length; i++) { if (b.length > __BX_GUARD.suffixes[i].length && b.lastIndexOf(__BX_GUARD.suffixes[i]) === b.length - __BX_GUARD.suffixes[i].length) return true; }
    var dirs = __bx_norm(raw).toLowerCase().split("/").slice(0, -1);
    for (var j = 0; j < dirs.length; j++) { if (__BX_GUARD.dirs.indexOf(dirs[j]) >= 0) return true; }
    return false;
  }
  globalThis.__bx_denied = __bx_denied;
  function __bx_wrap(fn) {
    return function (p) {
      if (__bx_denied(p)) { var e = new Error(__BX_MSG); e.code = __BX_CODE; throw e; }
      return fn.apply(this, arguments);
    };
  }
  try {
    var __bx_fs = require("node:fs");
    var __bx_sync = ["readFileSync", "openSync", "createReadStream", "readdirSync", "statSync", "lstatSync", "realpathSync", "existsSync", "copyFileSync", "cpSync", "openAsBlob", "readlinkSync", "opendirSync",
      // 回调式：与 Sync/promises 是**不同的函数**，漏了就是一条直达通道
      "readFile", "open", "readdir", "stat", "lstat", "realpath", "copyFile", "cp", "opendir", "readlink"];
    for (var k = 0; k < __bx_sync.length; k++) {
      if (typeof __bx_fs[__bx_sync[k]] === "function") __bx_fs[__bx_sync[k]] = __bx_wrap(__bx_fs[__bx_sync[k]]);
    }
  } catch (e) {}
  try {
    var __bx_p = require("node:fs/promises");
    var __bx_pn = ["readFile", "open", "readdir", "stat", "lstat", "realpath", "copyFile", "cp", "opendir", "readlink"];
    for (var m = 0; m < __bx_pn.length; m++) {
      if (typeof __bx_p[__bx_pn[m]] === "function") __bx_p[__bx_pn[m]] = __bx_wrap(__bx_p[__bx_pn[m]]);
    }
  } catch (e2) {}
})();
// ---- 凭据文件守卫结束 ----
`;
}

/**
 * Python 侧守卫（前置在用户代码之前）。
 * 同时包 `builtins.open` / `io.open` / `os.open`：
 * - 只包 builtins.open 时 `import io; io.open(...)` 一行即破；
 * - `pathlib.Path.read_text()` 内部走 `io.open`，包住 io.open 才能覆盖；
 * - `os.open` 是独立函数，需单独包（只按形态拦，合法路径照常放行，不影响 stdlib）。
 */
export function pyFsGuardSource(): string {
  return `# ---- run_tool_code 凭据文件守卫（服务端注入，勿删）----
import builtins as __bx_builtins, os as __bx_os, io as __bx_io
__BX_GUARD = ${NAMES_PAYLOAD()}
__BX_MSG = ${MSG_PAYLOAD()}
__BX_ALLOW = [s.strip().lower() for s in (__bx_os.environ.get("TOOL_CODE_FS_ALLOW") or "").split(",") if s.strip()]
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
        if base == a or ("/" in a and a in low):
            return False
    if base == ".env" or base.startswith(".env."):
        return True
    if base in __BX_GUARD["basenames"]:
        return True
    if any(base.endswith(s) for s in __BX_GUARD["suffixes"]):
        return True
    return any(s in __BX_GUARD["dirs"] for s in low.split("/")[:-1])
def __bx_guard(fn):
    def _w(file, *a, **kw):
        if __bx_denied(file):
            raise PermissionError(__BX_MSG)
        return fn(file, *a, **kw)
    return _w
try:
    __bx_builtins.open = __bx_guard(__bx_builtins.open)
except Exception:
    pass
try:
    __bx_io.open = __bx_guard(__bx_io.open)
except Exception:
    pass
try:
    __bx_os.open = __bx_guard(__bx_os.open)
except Exception:
    pass
# ---- 凭据文件守卫结束 ----
`;
}

/** 自检：注入源码结构完整（防静默失效）。生产路径也会调用一次（见 tool-code.ts）。 */
export function guardSourceLooksIntact(src: string): boolean {
  return src.includes(DENY_CODE) || src.includes("__bx_guard");
}
