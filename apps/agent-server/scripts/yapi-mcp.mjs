// YApi MCP 适配器（stdio）：把 YApi 接口文档暴露为 MCP 工具，并支持**只读调用**真实接口。
//
// 文档侧鉴权走**登录态 cookie**：YApi 的开放 token 需要在「项目 → 设置 → token 配置」里生成（普通账号拿不到），
// 而账号密码可以 POST /api/user/login 换到 _yapi_token / _yapi_uid，能访问该账号可见的全部项目。
//
// 配置（由父进程继承 apps/agent-server/.env；本文件不落任何凭据）：
//   YAPI_BASE_URL          YApi 站点地址
//   YAPI_LOGIN_EMAIL       登录邮箱
//   YAPI_LOGIN_PASSWORD    登录密码
//   YAPI_COOKIE            可选：现成的 cookie 串（填了就跳过登录，便于排障）
//   YAPI_PROJECT_IDS       可选：限定搜索范围的项目 id（逗号分隔）
//   YAPI_CACHE_TTL         可选：接口元数据缓存分钟数（默认 10，0 = 不缓存）
//   YAPI_CALL_BASES        可选：调用真实接口的地址，格式 `项目id=基地址` 逗号分隔，如 23=http://x,69=http://y
//   YAPI_CALL_HEADERS      可选：全局请求头，格式 `名: 值` 逗号分隔（如 clientType: 5）
//   YAPI_CALL_HEADERS_<id> 可选：某项目的请求头（同上格式），优先级高于全局
//   YAPI_CALL_QUERY_<id>   可选：某项目的固定 query 参数（`键=值` 逗号分隔；某些服务缺了会返回加密响应，如 clientType=5）
//   YAPI_CALL_TOKEN        可选：固定 Bearer token（填了就不再自动登录）
//   YAPI_CALL_LOGIN_NAME   业务后台账号（自动登录换 token 用）
//   YAPI_CALL_LOGIN_PASSWORD 业务后台密码
//   YAPI_CALL_LOGIN_PATH_<id>  该项目的登录接口路径（POST，仅适配器内部调用，模型无法触发）
//   YAPI_CALL_LOGIN_FIELD_<id> 登录请求体里的账号字段名（默认 loginName）
//   YAPI_CALL_AUTH_SCHEME  可选：bearer | raw，固定 Authorization 写法（默认先 Bearer，401 自动换裸 token 再试）
//   YAPI_CALL_TIMEOUT_MS   可选：调用超时（默认 15000）
// 安全约束：call_api **只发 GET**（工具本身不提供 method 参数）；若路径在文档里是写操作接口，直接拒绝。
//          唯一的非 GET 请求是适配器内部的自动登录（换 token），不暴露成工具。
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.YAPI_BASE_URL || "").replace(/\/+$/, "");
const EMAIL = process.env.YAPI_LOGIN_EMAIL || "";
const PASSWORD = process.env.YAPI_LOGIN_PASSWORD || "";
const SCOPE = (process.env.YAPI_PROJECT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TTL_MS = Math.max(0, Number(process.env.YAPI_CACHE_TTL ?? 10) || 0) * 60_000;
/** 单次工具结果上限（字符）：超过就截断，避免一次把模型上下文塞满。 */
const MAX_TEXT = 8000;
/** call_api 可申请的最大响应体（字符）：比 MAX_TEXT 宽松，便于按需取完整数据。 */
const MAX_CALL_CHARS = 30_000;
/** 任何工具结果的绝对上限（字符）：为响应体转义（引号/换行会膨胀）留出余量，保证外层 JSON 不被截断。 */
const MAX_RESULT_CHARS = 70_000;
/** 搜索时一次最多扫描的项目数（防止账号可见项目过多导致请求风暴）。 */
const MAX_PROJECTS = 30;

function json(value, isError = false, maxText = MAX_TEXT) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const cap = Math.max(200, Math.min(num(maxText, MAX_TEXT), MAX_RESULT_CHARS));
  return {
    content: [{ type: "text", text: text.length > cap ? `${text.slice(0, cap)}\n…(已截断)` : text }],
    isError,
  };
}

function clip(value, n) {
  if (value === undefined || value === null) return value;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > n ? `${s.slice(0, n)}…(共 ${s.length} 字符，已截断)` : s;
}

// ---- 登录态 ----
let cookie = (process.env.YAPI_COOKIE || "").trim();
let loginFailed = "";

function cookiePairs(setCookies) {
  return setCookies
    .map((c) => String(c).split(";")[0].trim())
    .filter((c) => c.startsWith("_yapi_token=") || c.startsWith("_yapi_uid="));
}

async function login() {
  if (!BASE || !EMAIL || !PASSWORD) {
    loginFailed = "未配置 YAPI_BASE_URL / YAPI_LOGIN_EMAIL / YAPI_LOGIN_PASSWORD";
    return false;
  }
  try {
    const res = await fetch(`${BASE}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: `${BASE}/`, Origin: BASE },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const pairs = cookiePairs(raw);
    const body = await res.json().catch(() => null);
    if (!pairs.length) {
      loginFailed = body?.errmsg || `登录失败（HTTP ${res.status}）`;
      return false;
    }
    cookie = pairs.join("; ");
    loginFailed = "";
    console.error("[yapi] 登录成功，cookie 已获取（仅内存保存）");
    return true;
  } catch (err) {
    loginFailed = `登录异常：${String(err?.message || err)}`;
    return false;
  }
}

async function api(path, params = {}, retried = false) {
  if (!cookie && !(await login())) {
    return { ok: false, code: undefined, message: `登录失败：${loginFailed || "未登录"}` };
  }
  const url = new URL(`${BASE}/api${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  let data = null;
  try {
    const res = await fetch(url, {
      headers: { Cookie: cookie, Accept: "application/json", Referer: `${BASE}/` },
    });
    data = await res.json().catch(() => null);
    if (data === null) return { ok: false, code: "BAD_RESPONSE", message: `HTTP ${res.status}（返回非 JSON）` };
  } catch (err) {
    return { ok: false, code: "NETWORK", message: String(err?.message || err) };
  }
  // 40011 = 请登录：cookie 过期时用账号密码重登一次再重试。
  if (data.errcode === 40011 && !retried && !process.env.YAPI_COOKIE) {
    cookie = "";
    if (await login()) return api(path, params, true);
  }
  if (data.errcode !== 0) {
    return { ok: false, code: data.errcode, message: data.errmsg || "YApi 返回错误" };
  }
  return { ok: true, data: data.data };
}

async function must(path, params = {}) {
  const r = await api(path, params);
  if (!r.ok) throw new Error(`${r.message}${r.code ? ` (errcode=${r.code})` : ""}`);
  return r.data;
}

// ---- 缓存（接口元数据变动不频繁，避免每次都全量拉）----
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && (TTL_MS === 0 ? false : Date.now() - hit.at < TTL_MS)) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/** 某个分组下的项目清单。 */
async function projectsOfGroup(groupId, groupName) {
  const list = asList(await must("/project/list", { group_id: groupId }));
  return list.map((p) => ({
    project_id: String(p._id ?? p.id),
    project_name: p.name,
    group_id: String(groupId),
    ...(groupName ? { group_name: groupName } : {}),
  }));
}

/** 可访问的项目清单：按分组展开（YApi 没有「一次列出全部项目」的接口）。 */
async function allProjects() {
  return cached("projects", async () => {
    const groups = asList(await must("/group/list"));
    const out = [];
    for (const g of groups) {
      const gid = g._id ?? g.id;
      if (gid === undefined || gid === null) continue;
      try {
        out.push(...(await projectsOfGroup(gid, g.group_name ?? g.name)));
      } catch {
        continue;
      }
    }
    return out;
  });
}

function scopedProjects(projects) {
  return SCOPE.length ? projects.filter((p) => SCOPE.includes(p.project_id)) : projects;
}

/**
 * 项目菜单：分类名 + 分类下接口（id/名称/路径/方法/标签），一次请求拿全，带缓存。
 * 选 /interface/list_menu 的原因：/interface/getCatMenu 对非项目成员返回 406；
 * /interface/list 不支持服务端关键字过滤（keyword/path 参数被忽略），反正要全量拉，就用这个更小的菜单。
 */
async function projectMenu(projectId) {
  return cached(`menu:${projectId}`, async () => {
    const cats = asList(await must("/interface/list_menu", { project_id: projectId }));
    return cats.map((c) => ({
      cat_id: String(c._id ?? c.id ?? ""),
      name: c.name,
      apis: asList(c.list).map((a) => ({
        api_id: String(a._id ?? a.id),
        title: a.title,
        path: a.path,
        method: String(a.method || "").toUpperCase(),
        tags: Array.isArray(a.tag) ? a.tag.filter(Boolean).map(String) : [],
      })),
    }));
  });
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---- 真实接口调用（只读）----
const CALL_TIMEOUT_MS = num(process.env.YAPI_CALL_TIMEOUT_MS, 15_000);

/** 解析 `项目id=基地址` 列表（不用 JSON：.env 里少一层引号，PowerShell 传参也不容易坏）。 */
function parseBases(raw) {
  const map = new Map();
  for (const item of String(raw || "").split(",")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const id = item.slice(0, eq).trim();
    const base = item
      .slice(eq + 1)
      .trim()
      .replace(/\/+$/, "");
    if (id && base) map.set(id, base);
  }
  return map;
}

/** 解析 `头名: 值` 列表。 */
function parseHeaders(raw) {
  const out = [];
  for (const item of String(raw || "").split(",")) {
    const idx = item.indexOf(":");
    if (idx <= 0) continue;
    const name = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

/** 解析 `键=值` 列表（用于项目级固定 query 参数）。 */
function parsePairs(raw) {
  const out = [];
  for (const item of String(raw || "").split(",")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key) out.push([key, value]);
  }
  return out;
}

/** 该项目调用时要带的请求头：全局 + 项目级（覆盖同名），不含 Authorization。 */
function baseHeaders(projectId) {
  const merged = new Map();
  for (const h of [...parseHeaders(process.env.YAPI_CALL_HEADERS), ...parseHeaders(process.env[`YAPI_CALL_HEADERS_${projectId}`])]) {
    merged.set(h.name.toLowerCase(), h);
  }
  return Object.fromEntries([...merged.values()].map((h) => [h.name, h.value]));
}

/** 从登录响应里找 token（不同后端字段命名不一，按常见路径依次尝试）。 */
function pickToken(body) {
  const candidates = [
    body?.data?.token,
    body?.token,
    body?.data?.accessToken,
    body?.data?.access_token,
    body?.access_token,
  ];
  const hit = candidates.find((v) => typeof v === "string" && v.trim());
  return hit ? String(hit).trim() : "";
}

/**
 * 取调用用的 token：
 * 1. YAPI_CALL_TOKEN 优先（手工填的固定 token）；
 * 2. 否则用 YAPI_CALL_LOGIN_NAME / _PASSWORD + YAPI_CALL_LOGIN_PATH_<项目id> 自动登录换 token（进程内缓存）。
 * 注意：自动登录是适配器**内部**的固定登录请求，不暴露成工具，模型无法触发。
 */
const tokenCache = new Map();
async function bizToken(projectId, { refresh = false } = {}) {
  const fixed = (process.env.YAPI_CALL_TOKEN || "").trim();
  if (fixed) return fixed;

  const loginPath = (process.env[`YAPI_CALL_LOGIN_PATH_${projectId}`] || "").trim();
  const name = (process.env.YAPI_CALL_LOGIN_NAME || "").trim();
  const password = process.env.YAPI_CALL_LOGIN_PASSWORD || "";
  if (!loginPath || !name || !password) return "";
  if (!refresh && tokenCache.has(projectId)) return tokenCache.get(projectId);

  const base = await callBaseFor(projectId);
  if (!base) return "";
  // 登录网关可能与调用域名不同（同一账号体系下的不同服务域名）
  const loginBase =
    (process.env[`YAPI_CALL_LOGIN_BASE_${projectId}`] || "").trim().replace(/\/+$/, "") || base;
  const nameField = (process.env[`YAPI_CALL_LOGIN_FIELD_${projectId}`] || "loginName").trim();
  const res = await fetch(`${loginBase}${loginPath.startsWith("/") ? loginPath : `/${loginPath}`}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders(projectId) },
    body: JSON.stringify({ [nameField]: name, password }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  const token = pickToken(body);
  if (!token) {
    const reason = body?.msg || body?.message || `HTTP ${res.status}`;
    throw new Error(
      `登录失败（${reason}）；请确认 YAPI_CALL_LOGIN_NAME / YAPI_CALL_LOGIN_PASSWORD 是 ${base} 这套后台的账号`,
    );
  }
  tokenCache.set(projectId, token);
  console.error(`[yapi] 项目 ${projectId} 登录成功，token 已缓存（仅内存）`);
  return token;
}

/** 调用地址：优先 .env 里的 YAPI_CALL_BASES，退路是 YApi 项目环境配置里的真实域名（跳过 127.0.0.1/localhost 占位）。 */
async function callBaseFor(projectId) {
  const configured = parseBases(process.env.YAPI_CALL_BASES).get(String(projectId));
  if (configured) return configured;
  try {
    const project = await cached(`project:${projectId}`, () => must("/project/get", { id: projectId }));
    const domain = (project?.env || [])
      .map((e) => e.domain)
      .find((d) => d && !/127\.0\.0\.1|localhost/i.test(String(d)) && /^https?:\/\//i.test(String(d)));
    return domain ? String(domain).replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

/**
 * Authorization 的写法在不同后端不一样：有的要 `Bearer <token>`，有的直接放裸 token。
 * 实测：电影后台网关（13100）对 Bearer 返回 401，stat-report 对 Bearer 返回 400，
 * 所以默认先按裸 token 试，鉴权不符（401 或 400 参数校验错）自动换另一种，成功的在进程内记住
 * （也可用 YAPI_CALL_AUTH_SCHEME 固定）。
 */
const AUTH_BEARER = "bearer";
const AUTH_RAW = "raw";
const authStyleCache = new Map();
function authHeaderValue(token, style) {
  return style === AUTH_RAW ? token : `Bearer ${token}`;
}
function authStyles(projectId) {
  const configured = String(
    process.env[`YAPI_CALL_AUTH_SCHEME_${projectId}`] || process.env.YAPI_CALL_AUTH_SCHEME || "",
  )
    .trim()
    .toLowerCase();
  if (configured === "raw") return [AUTH_RAW];
  if (configured === "bearer") return [AUTH_BEARER];
  const cachedStyle = authStyleCache.get(projectId);
  if (cachedStyle) return [cachedStyle, cachedStyle === AUTH_RAW ? AUTH_BEARER : AUTH_RAW];
  return [AUTH_RAW, AUTH_BEARER];
}

const normPath = (p) =>
  String(p || "")
    .split("?")[0]
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

const TOOLS = [
  {
    name: "list_projects",
    description:
      "列出 YApi 上当前账号可访问的项目（分组 / 项目 id / 项目名）。可传 group_id 只看指定分组（用于「我的分组」里没列出但有权限的分组）。",
    inputSchema: {
      type: "object",
      properties: { group_id: { type: "string", description: "分组 id（可选）" } },
    },
    async run({ group_id }) {
      const projects = group_id
        ? await projectsOfGroup(String(group_id))
        : scopedProjects(await allProjects());
      if (!projects.length) {
        return json(
          group_id
            ? `分组 ${group_id} 下没有取到项目（可能是分组不存在或账号无该分组权限）。`
            : "没有取到项目：请确认账号权限，或 YAPI_PROJECT_IDS 限定是否写错。",
          true,
        );
      }
      return json({ total: projects.length, projects });
    },
  },
  {
    name: "list_categories",
    description:
      "列出某个项目下的接口分类及各分类的接口数量。include_apis=true 时附上每个分类里的接口清单（接口多的大项目建议改用 search_apis 按关键字定位）。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 id（来自 list_projects）" },
        include_apis: { type: "boolean", description: "是否附上每个分类下的接口清单（默认 false）" },
      },
      required: ["project_id"],
    },
    async run({ project_id, include_apis }) {
      const cats = await projectMenu(String(project_id));
      return json({
        project_id: String(project_id),
        total_interfaces: cats.reduce((n, c) => n + c.apis.length, 0),
        categories: cats.map((c) => ({
          cat_id: c.cat_id,
          name: c.name,
          count: c.apis.length,
          ...(include_apis === true
            ? { apis: c.apis.map((a) => `${a.method} ${a.path} · ${a.title} (api_id=${a.api_id})`) }
            : {}),
        })),
      });
    },
  },
  {
    name: "search_apis",
    description:
      "按关键字搜索接口（匹配接口名称、路径、分类名与标签，不区分大小写；多个关键字用空格分隔表示同时包含）。默认在所有可见项目里搜，不要先猜项目；已明确项目时传 project_id 更快。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键字（如 登录日志、user、list；多个用空格分隔）" },
        project_id: { type: "string", description: "限定项目 id（可选）" },
        limit: { type: "number", description: "最多返回条数（默认 20）" },
      },
      required: ["keyword"],
    },
    async run({ keyword, project_id, limit }) {
      const needles = String(keyword || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (!needles.length) return json("keyword 不能为空", true);
      const max = num(limit, 20);
      let projects = scopedProjects(await allProjects());
      if (project_id) projects = projects.filter((p) => p.project_id === String(project_id));
      if (!projects.length) return json("没有匹配的项目范围（检查 project_id 或 YAPI_PROJECT_IDS）。", true);
      const scanned = projects.slice(0, MAX_PROJECTS);

      const results = [];
      let total = 0;
      for (const p of scanned) {
        const cats = await projectMenu(p.project_id);
        for (const c of cats) {
          for (const a of c.apis) {
            const hay = `${a.title || ""} ${a.path || ""} ${c.name || ""} ${a.tags.join(" ")}`.toLowerCase();
            if (!needles.every((n) => hay.includes(n))) continue;
            total += 1;
            if (results.length < max) {
              results.push({
                api_id: a.api_id,
                method: a.method,
                path: a.path,
                title: a.title,
                project_id: p.project_id,
                project_name: p.project_name,
                category: c.name,
              });
            }
          }
        }
      }
      return json({
        keyword,
        total,
        returned: results.length,
        scanned_projects: scanned.length,
        ...(projects.length > scanned.length
          ? { note: `仅扫描前 ${scanned.length}/${projects.length} 个项目，可用 project_id 缩小范围` }
          : {}),
        results,
      });
    },
  },
  {
    name: "get_api_desc",
    description:
      "获取接口详情：请求方法 / 路径 / 说明、请求参数（路径参数、query、body 表单、body 原文、header）、响应定义。",
    inputSchema: {
      type: "object",
      properties: { api_id: { type: "string", description: "接口 id（来自 search_apis / list_categories）" } },
      required: ["api_id"],
    },
    async run({ api_id }) {
      const id = String(api_id ?? "").trim();
      if (!/^\d+$/.test(id)) {
        return json(`api_id 必须是接口 id（数字），收到的是「${id}」。要按路径/名称找接口，请先用 search_apis。`, true);
      }
      const d = await must("/interface/get", { id });
      if (!d || typeof d !== "object") return json(`未取到接口 ${api_id} 的详情`, true);
      const rows = (arr, keys) =>
        asList(arr).map((x) => Object.fromEntries(keys.filter((k) => x[k] !== undefined && x[k] !== "").map((k) => [k, x[k]])));
      return json({
        api_id: String(d._id ?? api_id),
        title: d.title,
        method: String(d.method || "").toUpperCase(),
        path: d.path,
        project_id: d.project_id === undefined ? undefined : String(d.project_id),
        catid: d.catid === undefined ? undefined : String(d.catid),
        tag: Array.isArray(d.tag) ? d.tag : undefined,
        desc: d.desc,
        ...(d.markdown ? { markdown: clip(d.markdown, 1500) } : {}),
        req_params: rows(d.req_params, ["name", "desc", "example"]),
        req_query: rows(d.req_query, ["name", "required", "example", "desc"]),
        req_headers: rows(d.req_headers, ["name", "required", "value", "desc"]),
        req_body_type: d.req_body_type,
        req_body_form: rows(d.req_body_form, ["name", "type", "required", "example", "desc"]),
        ...(d.req_body_other ? { req_body_other: clip(d.req_body_other, 3000) } : {}),
        res_body_type: d.res_body_type,
        ...(d.res_body ? { res_body: clip(d.res_body, 3000) } : {}),
        ...(d.res_body_is_json_schema ? { res_body_is_json_schema: true } : {}),
      });
    },
  },
  {
    name: "call_api",
    description:
      "只读调用接口：按文档里的路径发一个 **GET** 请求，拿真实响应。用户问到某类数据时，先用它调用接口拿到真实数据，再整理成表格回答。仅支持 GET —— 写操作（POST/PUT/DELETE）一律不执行、也不要尝试。鉴权由服务端配置（固定 token 或自动登录），调用方不需要也不能传 token。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 id（决定调用哪个环境的地址）" },
        path: { type: "string", description: "接口路径（照文档抄，如 /v0.1/xxx/get）" },
        query: { type: "object", description: "query 参数（可选）" },
        response_chars: { type: "number", description: "响应体最大字符数（默认 4000，需要更多可调大）" },
      },
      required: ["project_id", "path"],
    },
    async run({ project_id, path, query, response_chars }) {
      const pid = String(project_id || "").trim();
      const apiPath = String(path || "").trim();
      if (!pid) return json("project_id 不能为空", true);
      if (!apiPath) return json("path 不能为空", true);

      // 文档里若标注为非 GET，这里直接拒绝：本工具只做只读调用。
      const target = normPath(apiPath);
      const cats = await projectMenu(pid).catch(() => []);
      for (const c of cats) {
        for (const a of c.apis) {
          if (normPath(a.path) !== target || !a.method) continue;
          if (a.method !== "GET") {
            return json(`已拒绝：文档里该接口是 ${a.method}（写操作），本工具只允许 GET。`, true);
          }
        }
      }

      const base = await callBaseFor(pid);
      if (!base) {
        return json(
          `项目 ${pid} 没有可用的调用地址。请在 .env 的 YAPI_CALL_BASES 里配置，格式：${pid}=http://接口域名 ` +
            `（多个项目用逗号分隔）；或到 YApi 项目「设置 → 环境配置」里把域名从 127.0.0.1 改成真实地址。`,
          true,
        );
      }

      let url;
      try {
        url = new URL(`${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`);
      } catch {
        return json(`调用地址拼接失败：${base} + ${apiPath}`, true);
      }
      // 项目级固定 query 优先（某些服务缺了它会返回加密响应），用户传的同名参数可覆盖
      for (const [k, v] of parsePairs(process.env[`YAPI_CALL_QUERY_${pid}`])) url.searchParams.set(k, v);
      for (const [k, v] of Object.entries(query || {})) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }

      let token = "";
      try {
        token = await bizToken(pid);
      } catch (err) {
        return json(String(err?.message || err), true);
      }

      const sendTo = (target, bearer, style) => {
        const headers = { Accept: "application/json", ...baseHeaders(pid) };
        if (bearer) headers.Authorization = authHeaderValue(bearer, style);
        return fetch(target, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      };

      const started = Date.now();
      const cap = Math.max(200, Math.min(num(response_chars, 4000), MAX_CALL_CHARS));
      let res = null;
      let text = "";
      let usedStyle = "";
      let prefixNote = "";
      /** 该网关鉴权写法不符时的表现：401，或 400 + Parameter checking failed。 */
      const authLooksBad = () =>
        res && (res.status === 401 || (res.status === 400 && /parameter checking failed/i.test(text)));
      try {
        const runOnce = async (target, bearer, style) => {
          res = await sendTo(target, bearer, style);
          text = await res.text();
          usedStyle = style;
        };
        const fixed = Boolean((process.env.YAPI_CALL_TOKEN || "").trim());
        for (const style of authStyles(pid)) {
          await runOnce(url, token, style);
          if (!authLooksBad()) break;
        }
        // 鉴权仍不符：token 过期（自动重登）或写法不对（换另一种），两种都各试一次
        if (authLooksBad() && !fixed) {
          const fresh = await bizToken(pid, { refresh: true }).catch(() => "");
          if (fresh) {
            for (const style of new Set([...authStyles(pid), AUTH_BEARER, AUTH_RAW])) {
              await runOnce(url, fresh, style);
              if (!authLooksBad()) break;
            }
          }
        }
        if (res && res.status < 400) authStyleCache.set(pid, usedStyle);

        // 404：文档路径可能缺网关前缀 —— 该组织的 YApi 习惯把前缀写在分类名里（如「…接口（/stat-report）」）。
        if (res && res.status === 404) {
          const prefixes = new Set();
          for (const c of cats) {
            for (const m of String(c.name || "").matchAll(/[(（](\/[A-Za-z0-9._-]+)[)）]/g)) prefixes.add(m[1]);
          }
          for (const prefix of [...prefixes].slice(0, 3)) {
            const alt = new URL(url.toString());
            alt.pathname = `${prefix}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
            await runOnce(alt, token, usedStyle || authStyles(pid)[0]);
            if (res.status !== 404) {
              url = alt;
              prefixNote = `文档路径 404，已按分类标注的网关前缀 ${prefix} 重试`;
              break;
            }
          }
        }
        return json(
          {
            request: `GET ${url.toString()}`,
            status: res.status,
            ms: Date.now() - started,
            ...(token ? { auth: usedStyle === AUTH_RAW ? "裸 token" : "Bearer" } : {}),
            ...(prefixNote ? { note: prefixNote } : {}),
            bytes: text.length,
            ...(res.headers.get("content-type") ? { content_type: res.headers.get("content-type") } : {}),
            ...(res.status === 401
              ? {
                  hint: token
                    ? "鉴权失败：token 过期或该账号无此接口权限。"
                    : "未带 token：请配置 YAPI_CALL_TOKEN，或配置 YAPI_CALL_LOGIN_NAME/_PASSWORD 与 YAPI_CALL_LOGIN_PATH_<项目id> 让适配器自动登录。",
                }
              : {}),
            body: clip(text, cap),
            ...(text.length > cap ? { truncated: true, full_bytes: text.length } : {}),
          },
          res.status >= 400,
          cap * 2 + 1500,
        );
      } catch (err) {
        return json(`调用失败：GET ${url.toString()} → ${String(err?.message || err)}`, true);
      }
    },
  },
];

const server = new Server({ name: "yapi-docs", version: "1.0.0" }, { capabilities: { tools: {} } });

/**
 * 工具注解（MCP 标准字段 ToolAnnotations）：本适配器**全部工具都是只读的**——
 * 文档查询只读 YApi；call_api 在 run 内把方法硬编码为 GET（文档里标注为非 GET 的路径直接拒绝）；
 * 唯一的非 GET 请求是适配器内部自动登录换 token，不暴露成工具。
 * 声明事实而非放行：服务端风险闸门（src/risk.ts 第 4 条注解判定）据此按只读处理，不再对每个只读查询弹确认卡。
 * 若某服务存在非规范的 GET 写接口，在服务器配置（MCP_BUILTIN_SERVERS 的 toolRisks）里覆盖本声明即可——
 * 服务端策略优先级高于工具自述。
 */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return json(`未知工具：${req.params.name}`, true);
  if (!BASE) return json("未配置 YAPI_BASE_URL", true);
  try {
    return await tool.run(req.params.arguments || {});
  } catch (err) {
    return json(`工具执行失败：${String(err?.message || err)}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[yapi-docs] stdio MCP server started (base=${BASE || "未配置"}, auth=${cookie ? "cookie" : EMAIL ? "登录" : "未配置"})`,
);
