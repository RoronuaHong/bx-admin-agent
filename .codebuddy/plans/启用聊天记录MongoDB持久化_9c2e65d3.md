---
name: 启用聊天记录MongoDB持久化
overview: 在 agent-server 运行时配置补上 MONGO_URI，让聊天记录持久化走 MongoDB（bx_agent.chat_conversations）而非进程内存，刷新页面后历史从库恢复。代码层 conversations.ts 已完整支持，仅需启用配置+重启验证。
todos:
  - id: add-mongo-env
    content: 在 .env 新增 MONGO_URI 与 MONGO_DB_NAME 启用 MongoDB
    status: completed
  - id: restart-server
    content: pm2 重启 agent-server-dev 并确认 8787 释放后生效
    status: completed
    dependencies:
      - add-mongo-env
  - id: verify-persist
    content: 发消息刷新页面验证历史从库恢复并查 mongo 落库
    status: completed
    dependencies:
      - restart-server
---

## 用户需求
聊天记录刷新后消失，要求以后端数据库为权威源恢复历史，不依赖前端 localStorage。

## 产品概述
现有会话持久化逻辑（conversations.ts）已完整实现 MongoDB 落库能力，但因运行时 `.env` 未配置 `MONGO_URI`，导致存储降级为进程内存 Map，进程重启即清空，刷新页面后历史丢失。本次只需启用后端 MongoDB 持久化，让历史记录可靠落库、刷新后从库恢复。

## 核心功能
- 在 agent-server 运行时配置中启用 MongoDB 连接（补 `MONGO_URI`）。
- 会话记录按登录用户归属（`countryId:loginName`）写入 `bx_agent.chat_conversations` 集合。
- 重启服务后，前端刷新页面从历史接口（`GET /chat/conversations`）读取后端权威数据，恢复聊天记录。
- 保留 conversations.ts 既有降级与容错逻辑不变，仅切换存储后端为 MongoDB。

## 技术栈
- 后端：Node.js + TypeScript（tsx 运行），Hono 服务，MongoDB 驱动 mongodb@7.5.0（已安装）。
- 存储：MongoDB（dev 机 docker `cms-mongo`，宿主 27017），数据库 `bx_agent`，集合 `chat_conversations`。

## 实现方案
### 总体策略
根因已确认：`apps/agent-server/.env` 缺失 `MONGO_URI`，使 `conversations.ts` 的 `initConvoStore` 第一行 `if (!process.env.MONGO_URI) return false` 直接返回 false，全部读写降级到进程内存 `mem`。`conversations.ts` 与 `app.ts` 的 REST 接口（list/create/upsert/delete/clear）均已实现完整 Mongo 路径，无需改逻辑代码，只需在 `.env` 注入连接串启用即可。

### 关键技术决策
1. **复用既有 Mongo 实例**：dev 机已运行 docker `cms-mongo`（宿主 27017），直接复用 `mongodb://127.0.0.1:27017`，零新依赖、零新服务。
2. **独立数据库名**：`MONGO_DB_NAME=bx_agent`（代码默认值），与澄清指标库 `bx_agent_metrics`（`.env.example:65`）隔离，互不干扰。
3. **不改动前端**：用户明确要求“不需要前端，直接用后端数据库”。当前前端 `restoreConversations` 本就以服务端为权威源覆盖本地（README 方案 C 设计），启用 Mongo 后刷新即从库恢复；前端 localStorage 仅作离线兜底保留，符合既有架构，无需改动。
4. **保留降级容错**：`getColl()` 连接失败时回退内存并打 warn，确保 Mongo 偶发不可达时不阻断对话，符合现有健壮性设计。

### 性能与可靠性
- MongoClient 单例懒连接、进程级复用，无每次新建连接开销。
- 写入走 `upsert`，按 `ownerKey + id` 定位，O(1) 索引命中（建议对 `ownerKey` 建索引，见实现备注）。
- 前端 `restoreConversations` 仅拉取最近 20 会话、每会话最近 80 条，数据量可控。

## 实现备注
- 仅在 `.env` 新增两行（紧邻现有配置段，参考 `.env.example:63-65` 的 URI 写法）：
  - `MONGO_URI=mongodb://127.0.0.1:27017`
  - `MONGO_DB_NAME=bx_agent`
- 改完必须 `pm2 delete agent-server-dev` → 确认 8787 释放 → `pm2 start ecosystem.dev.config.cjs --only agent-server-dev`（进程名是 agent-server-dev，非 agent-server，沿用既有运维约定）。
- 启动后查日志确认 `[conversations] MongoDB 已连接 mongodb://127.0.0.1:27017/bx_agent`。
- 可选增强：在 `getColl()` 首次获取集合后为 `ownerKey` 建索引（`createIndex({ ownerKey: 1 })`），提升多用户查询效率；属性能优化，非功能必须。
- 验证：浏览器发一条消息 → 刷新页面 → 历史恢复；并用 mongo 客户端确认 `bx_agent.chat_conversations` 有文档。

## 架构设计
数据流（启用后）：
```
前端 streamChat 完成 → ChatPage.saveConversations()
  → POST /chat/conversations/:id/messages（upsert）
  → conversations.upsertMessages() → getColl() → Mongo 集合写入
刷新页面 → ChatPage.restoreConversations()
  → GET /chat/conversations → listConversations() → Mongo 读取 → 前端渲染
```
无架构改动，仅将存储后端由“进程内存”切换为“MongoDB”。

## 目录结构
```
apps/agent-server/
└── .env                      # [MODIFY] 新增 MONGO_URI 与 MONGO_DB_NAME，启用 MongoDB 持久化。
```
无需改动任何源码文件（conversations.ts / app.ts 逻辑已完备）。
