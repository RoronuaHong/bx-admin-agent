import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // @bx/shared 以 TS 源码形式经 workspace 链接；不预打包，让 vite 走常规转换管线处理 .ts。
  optimizeDeps: { exclude: ["@bx/shared"] },
  plugins: [
    vue(),
    {
      name: "spa-history-fallback",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const url = req.url || "/";
          const acceptsHtml = String(req.headers.accept || "").includes("text/html");
          const pathname = url.split("?")[0] || "/";
          const isAsset =
            pathname.startsWith("/@") ||
            pathname.startsWith("/src/") ||
            pathname.startsWith("/node_modules/") ||
            pathname.startsWith("/agent/") ||
            pathname.includes(".");
          if (!acceptsHtml || isAsset) return next();

          const htmlPath = resolve(server.config.root, "index.html");
          const html = await readFile(htmlPath, "utf8");
          const transformed = await server.transformIndexHtml(pathname, html, req.originalUrl);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(transformed);
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/markdown-it/") || id.includes("/node_modules/dompurify/")) {
            return "vendor-richtext";
          }
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/agent": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/agent/, ""),
        configure: (proxy) => {
          // 只关闭上游压缩，避免代理侧对分块流做缓冲。
          // 不要再注册 proxyRes 监听里手动 pipe：http-proxy 默认已自动透传响应，
          // 手动再 pipe 会叠加成双管道，导致每个流事件重复两遍。
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Accept-Encoding", "identity");
          });
        },
      },
    },
  },
});
