// PM2 统一开发配置（dev 环境 = agent-server + web）
// 启动：pm2 start ecosystem.dev.config.cjs（或 pm2 startOrReload）
// 重启：pm2 restart ecosystem.dev.config.cjs
// 停止：pm2 stop ecosystem.dev.config.cjs / pm2 delete ecosystem.dev.config.cjs
// 保存：pm2 save
const path = require("path");
const SERVER_DIR = path.resolve(__dirname, "apps/agent-server");
const WEB_DIR = path.resolve(__dirname, "apps/web");

module.exports = {
  apps: [
    {
      name: "agent-server-dev",
      cwd: SERVER_DIR,
      script: "src/index.ts",
      interpreter: "node",
      // 不用 tsx --watch 也不用 PM2 watch：Windows 下 kill_timeout 对 SIGTERM 不可靠，
      // watch 重启时旧进程常残留占用 8787 → 新进程 EADDRINUSE 崩溃（pm2 显示 errored/online 但服务是旧代码）。
      // 改为纯手动重启：改代码后先 pm2 delete + 确认端口释放，再 pm2 start。
      // --import tsx 让 Node 从当前工作目录（apps/agent-server）解析本地 tsx，避免写死 pnpm store 路径。
      node_args: "--import tsx",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      watch: false,
      kill_timeout: 6000, // 优雅退出窗口
      listen_timeout: 15000, // 新进程 15s 内未监听则判定启动失败
      out_file: path.join(SERVER_DIR, "logs/agent-server-dev.out.log"),
      error_file: path.join(SERVER_DIR, "logs/agent-server-dev.err.log"),
      time: true,
      env: {
        // 避免继承 IDE/扩展注入的失效 preload，导致 PM2 启动时 MODULE_NOT_FOUND。
        NODE_OPTIONS: "",
        NODE_ENV: "development",
        PORT: "8787",
      },
    },
    {
      name: "web-dev",
      cwd: WEB_DIR,
      script: "node_modules/vite/bin/vite.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      out_file: path.join(WEB_DIR, "logs/web-dev.out.log"),
      error_file: path.join(WEB_DIR, "logs/web-dev.err.log"),
      time: true,
      env: {
        // 同 agent-server-dev：IDE/扩展注入的 preload 会让 vite 清缓存时走 safe-delete shim，
        // 在 Windows 上 spawnSync 超时（ETIMEDOUT）→ dev server 启动直接失败并无限重启。
        NODE_OPTIONS: "",
        NODE_ENV: "development",
      },
    },
  ],
};