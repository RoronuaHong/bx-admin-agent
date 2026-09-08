import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
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
          if (id.includes("/node_modules/echarts/core/")) return "vendor-echarts-core";
          if (id.includes("/node_modules/echarts/charts/")) return "vendor-echarts-charts";
          if (id.includes("/node_modules/echarts/components/")) return "vendor-echarts-components";
          if (id.includes("/node_modules/echarts/renderers/")) return "vendor-echarts-renderers";
          if (id.includes("/node_modules/zrender/")) return "vendor-zrender";
          if (id.includes("/node_modules/echarts/")) return "vendor-echarts";
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
      },
    },
  },
});
