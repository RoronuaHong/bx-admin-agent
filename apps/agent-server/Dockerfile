# syntax=docker/dockerfile:1

# ---------- Builder：装依赖 + esbuild 单文件打包 ----------
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable

# 先复制依赖清单以利用层缓存（pnpm 11 / packageManager 字段锁定版本）
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/agent-server/package.json apps/agent-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# 再复制源码并打包
COPY packages/shared ./packages/shared
COPY apps/agent-server ./apps/agent-server
RUN pnpm --filter @bx/agent-server build

# ---------- Runtime：仅生产依赖 + 打包产物 + 资源目录 ----------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

# pnpm 需要这些清单来解析 workspace 并安装 @bx/agent-server 的生产依赖
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/agent-server/package.json apps/agent-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --prod --frozen-lockfile --filter @bx/agent-server

# 运行时只需：打包后的服务 + 资源目录（MCP stdio 脚本 / skills / 静态资产）
COPY --from=builder /app/apps/agent-server/dist ./apps/agent-server/dist
COPY --from=builder /app/apps/agent-server/scripts ./apps/agent-server/scripts
COPY --from=builder /app/apps/agent-server/skills ./apps/agent-server/skills
COPY --from=builder /app/apps/agent-server/assets ./apps/agent-server/assets

WORKDIR /app/apps/agent-server
# HOST=0.0.0.0 才能在容器内被同网络访问；AGENT_DATA_DIR 挂卷到 /data 避免容器销毁丢数据
ENV HOST=0.0.0.0 PORT=8787 AGENT_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "dist/server.mjs"]
