# syntax=docker/dockerfile:1

# ---------- Builder：构建前端静态产物 ----------
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm --filter @bx/web build

# ---------- Runtime：nginx 托管静态文件 + 反代 /agent ----------
FROM nginx:1.27-alpine AS runtime
# SPA history fallback + 同源反代后端（去掉 /agent 前缀，与 vite dev proxy 行为一致）
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
