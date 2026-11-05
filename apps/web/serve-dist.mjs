// 生产构建产物的静态托管 + /agent 反向代理。
//
// 为什么需要它：IM 推送里的「打开对话」链接（WEB_ORIGIN）之前指向 Vite *开发*服务器（5173）。
// 开发服务器是开发期进程——会随代码改动重编译、会被 pm2 重启（今天已重启 7 次），
// 钉钉内嵌 webview 点开时若它正好在重编译 / 没起来，就只剩一个「页面异常」的空壳。
//
// 这里托管的是**预构建的** dist（静态、无重编译、无 HMR），只在代码改动后重新 build+重启一次，
// 平时稳如磐石。API 走同源 /agent 代理到 agent-server，不额外暴露任何管理端点。
import { createServer, request } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const API_HOST = (process.env.API_HOST || "127.0.0.1").replace(/^https?:\/\//, "");
const API_PORT = Number(process.env.API_PORT || 8787);
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

if (!existsSync(DIST)) {
  console.error(`[web-dist] dist 目录不存在：${DIST}。请先运行 \`npm run build\`。`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/agent")) return proxyAgent(req, res, pathname, url);

  serveStatic(req, res, pathname).catch((err) => {
    res.statusCode = 500;
    res.end("internal error: " + (err?.message || String(err)));
  });
});

// ---- /agent 反向代理（流式 pipe，转发 cookie / set-cookie）----
function proxyAgent(req, res, pathname, url) {
  const targetPath = pathname.replace(/^\/agent/, "") || "/";
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    headers[k] = v;
  }
  const upstream = request(
    {
      host: API_HOST,
      port: API_PORT,
      method: req.method,
      path: targetPath + (url.search || ""),
      headers,
    },
    (upres) => {
      res.statusCode = upres.statusCode || 502;
      const pass = {};
      for (const [k, v] of Object.entries(upres.headers)) {
        const lk = k.toLowerCase();
        if (lk === "connection" || lk === "transfer-encoding") continue;
        pass[k] = v;
      }
      res.writeHead(res.statusCode, pass);
      upres.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("bad gateway: " + err.message);
    } else {
      res.destroy();
    }
  });
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
    req.pipe(upstream);
  } else {
    upstream.end();
  }
}

// ---- 静态文件 + SPA fallback ----
async function serveStatic(req, res, pathname) {
  let filePath = normalize(join(DIST, pathname));
  // 防路径穿越：必须仍在 DIST 内
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (pathname.endsWith("/")) filePath = join(filePath, "index.html");
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(DIST, "index.html"); // SPA：未知路径回落首页
  }
  const data = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[extname(filePath).toLowerCase()] || "application/octet-stream");
  res.end(data);
}

server.listen(PORT, HOST, () => {
  console.log(`[web-dist] serving ${DIST} on http://${HOST}:${PORT} (proxy /agent -> ${API_HOST}:${API_PORT})`);
});
