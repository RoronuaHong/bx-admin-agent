/**
 * 巡检报告图片（供钉钉 markdown 内嵌 `![](url)` 使用）。
 *
 * 背景事实（2026-09 核实，两份来源一致）：
 * - 钉钉「自定义机器人 webhook」仅支持 text / link / markdown / actionCard / feedCard，
 *   **不支持 `msgtype=image`**（base64 图片属「企业内部应用机器人」的 media_id 通道，需 appkey/agentId）。
 * - 故内嵌图表的唯一可行路径 = markdown `![alt](url)`，且该 url 必须**公网可达**（钉钉服务端要能取到）。
 *
 * 渲染实现：零新增依赖——本机 Chrome（或 Edge）headless 对报告页整页截图。
 * 未装浏览器 / 未开启 ALERT_REPORT_IMAGE / 渲染失败 → 返回 null，调用方优雅降级（不影响推送主流程）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import PDFDocument from "pdfkit";

const REPORT_DIR = join(process.cwd(), ".data", "analytics-reports");
const PROFILE_ROOT = join(process.cwd(), ".data", "chrome-profiles");

/** 报告内嵌图片总开关（默认关：内网 base url 钉钉取不到，生产配公网域名后再开）。 */
export function reportImageEnabled(): boolean {
  const raw = (process.env.ALERT_REPORT_IMAGE ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** 跳过「公网可达性」检查、强制内嵌（私网自建钉钉确实能取到图时才用）。 */
export function reportImageForce(): boolean {
  const raw = (process.env.ALERT_REPORT_IMAGE_FORCE ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * URL 是否「公网可达」——钉钉服务端取图的前提。
 * 回环 / 私网 / 链路本地 / 组播 / 非 http(s) 一律视为不可达 → 不内嵌，避免群里出现裂图占位。
 * 纯通用判断（IP 段 + 保留域名），无业务词。
 */
export function isPubliclyReachableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a >= 224) return false;
    return true;
  }

  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return false; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return false; // fe80::/10 链路本地
  return true;
}

function candidateBrowserPaths(): string[] {
  const envPath = (process.env.ALERT_REPORT_CHROME_PATH || "").trim();
  const list: string[] = envPath ? [envPath] : [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    list.push(
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      ...(local ? [join(local, "Google\\Chrome\\Application\\chrome.exe")] : []),
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }
  return list.filter(Boolean);
}

/** 找到可用的 Chrome/Edge 可执行文件；找不到返回 null。 */
export function resolveBrowserPath(): string | null {
  for (const p of candidateBrowserPaths()) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export interface RenderPngOpts {
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  /** 小于该字节数视为无效（图表未渲染完/白屏），默认 5KB。 */
  minBytes?: number;
}

/** 拉起 headless 浏览器整页截图；成功返回 PNG 字节，失败/超时返回 null。 */
function screenshotToBuffer(
  browser: string,
  opts: { url: string; width: number; height: number; timeoutMs: number },
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const profileDir = join(PROFILE_ROOT, randomUUID());
    const shotPath = join(profileDir, "shot.png");
    try {
      mkdirSync(profileDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--virtual-time-budget=8000",
      `--window-size=${opts.width},${opts.height}`,
      `--user-data-dir=${profileDir}`,
      `--screenshot=${shotPath}`,
      opts.url,
    ];

    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* profile 清理失败不影响主流程 */
      }
      resolve(result);
    };

    const child = spawn(browser, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null);
    }, opts.timeoutMs);

    child.on("error", () => finish(null));
    child.on("exit", () => {
      // 必须在清理 profile 目录前把字节读出来
      try {
        if (existsSync(shotPath) && statSync(shotPath).size > 0) {
          finish(readFileSync(shotPath));
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }
    });
  });
}

/** 直接渲染并返回 PNG 字节；失败返回 null。 */
export async function renderReportPng(opts: RenderPngOpts): Promise<Buffer | null> {
  const browser = resolveBrowserPath();
  if (!browser) return null;
  const buf = await screenshotToBuffer(browser, {
    url: opts.url,
    width: opts.width ?? 1000,
    height: opts.height ?? 2400,
    timeoutMs: opts.timeoutMs ?? 25000,
  });
  if (!buf) return null;
  return buf.length >= (opts.minBytes ?? 5 * 1024) ? buf : null;
}

const inflight = new Map<string, Promise<Buffer | null>>();

/**
 * 取（或渲染并缓存）某 token 的报告 PNG 字节。报告是不可变快照，故按 token 缓存。
 * 同 token 并发请求共享同一渲染过程，避免重复拉起浏览器。
 */
export async function getReportPng(token: string, reportUrl: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const cached = join(REPORT_DIR, `${token}.png`);
  try {
    if (existsSync(cached) && statSync(cached).size > 0) return readFileSync(cached);
  } catch {
    /* 缓存读失败则重新渲染 */
  }

  const existing = inflight.get(token);
  if (existing) return existing;

  const job = (async () => {
    const buf = await renderReportPng({ url: reportUrl });
    if (!buf) return null;
    try {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(cached, buf);
    } catch {
      /* 缓存写失败也照样返回图片 */
    }
    return buf;
  })();

  inflight.set(token, job);
  try {
    return await job;
  } finally {
    inflight.delete(token);
  }
}

/** 从 PNG 字节读尺寸（解析 IHDR：宽在 16、高在 20，大端）；非 PNG 返回 null。 */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 把报告整页图包成 PDF：A4 宽、单页等比长图（所见即所得，图表/表格/文字同截图）。
 * 复用 png 缓存（同一 token 不重复渲染浏览器）；仅嵌图无文字，规避 pdfkit 中文字体问题。
 */
export async function getReportPdf(token: string, reportUrl: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const cached = join(REPORT_DIR, `${token}.pdf`);
  try {
    if (existsSync(cached) && statSync(cached).size > 0) return readFileSync(cached);
  } catch {
    /* 缓存读失败则重新生成 */
  }

  const png = await getReportPng(token, reportUrl);
  if (!png) return null;
  const size = pngSize(png);

  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  // A4 宽（595.28pt），高度按图片等比换算，单页完整呈现
  const A4_WIDTH = 595.28;
  if (size) {
    const height = Math.round((A4_WIDTH * size.height) / size.width);
    doc.addPage({ size: [A4_WIDTH, height], margin: 0 });
    doc.image(png, 0, 0, { width: A4_WIDTH, height });
  } else {
    doc.addPage({ size: "A4", margin: 0 });
    doc.image(png, 0, 0, { fit: [A4_WIDTH, 841.89] });
  }
  doc.end();

  const buf = await done;
  try {
    writeFileSync(cached, buf);
  } catch {
    /* 缓存写失败也照样返回 */
  }
  return buf;
}
