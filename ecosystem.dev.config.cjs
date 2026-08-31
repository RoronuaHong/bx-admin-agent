// PM2 统一开发配置（dev 环境 = agent-server + web）
// 启动：pm2 start ecosystem.dev.config.cjs
// 重启：pm2 restart ecosystem.dev.config.cjs
// 停止：pm2 stop ecosystem.dev.config.cjs / pm2 delete ecosystem.dev.config.cjs
// 保存：pm2 save
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
      node_args:
        "--import file:///D:/Code/bx-admin-agent/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs",
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
        NODE_ENV: "development",
      },
    },
  ],
};