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
    // @antv/g2、/g6 在组件里是按需 `import()` 懒加载（图表/关系图才拉取），
    // 单独成块就不会进首屏，也别让兜底 vendor 把它们并成一个巨型块。
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (id.includes("/@antv/")) return "vendor-antv";
          if (id.includes("/markdown-it/") || id.includes("/dompurify/")) return "vendor-richtext";
          if (id.includes("/echarts/") || id.includes("/zrender/")) return "vendor-echarts";
          if (id.includes("/mermaid/")) return "vendor-mermaid";
          if (id.includes("/highlight.js/") || id.includes("/lowlight/")) return "vendor-highlight";
          if (id.includes("/monaco-editor/") || id.includes("/vscode/")) return "vendor-monaco";
          if (id.includes("/vue/") || id.includes("/vue-router/") || id.includes("/pinia/")) return "vendor-vue";
          return "vendor";
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
