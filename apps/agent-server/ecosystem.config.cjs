// PM2 托管配置：agent-server
// 用 node 解释器 + tsx loader 直接跑 TS 源码（等价于 `tsx src/index.ts`）。
// 启动：pm2 start ecosystem.config.cjs
// 保存：pm2 save
module.exports = {
  apps: [
    {
      name: "agent-server",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: "node",
      node_args: "--import file:///D:/Code/bx-admin-agent/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      out_file: "./logs/agent-server.out.log",
      error_file: "./logs/agent-server.err.log",
      time: true,
      env: {
        // 避免继承 IDE/扩展注入的失效 preload，导致 PM2 启动时 MODULE_NOT_FOUND。
        NODE_OPTIONS: "",
        NODE_ENV: "production",
      },
    },
  ],
};
