# syntax=docker/dockerfile:1

# ---------- Builder：装全部依赖 + esbuild 单文件打包 ----------
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable

# 先复制依赖清单以利用层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/agent-server/package.json apps/agent-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# 再复制源码并打包
COPY packages/shared ./packages/shared
COPY apps/agent-server ./apps/agent-server
RUN pnpm --filter @bx/agent-server build

# ---------- Runtime：复用 builder 的依赖与产物 ----------
# 与 builder 同用 node:22-bookworm（glibc），保证 pnpm 软链结构与任何原生模块兼容，
# 且无需在 runtime 二次联网安装（受限网络下 alpine 的二次 pnpm install 会失败）。
# 体积换可靠性；后续若要瘦身可改用 pnpm deploy / slim + prune（需保证 registry 可达）。
FROM node:22-bookworm AS runtime
WORKDIR /app
COPY --from=builder /app /app
WORKDIR /app/apps/agent-server
ENV HOST=0.0.0.0 PORT=8787 AGENT_DATA_DIR=/data NODE_ENV=production
EXPOSE 8787
CMD ["node", "dist/server.mjs"]
