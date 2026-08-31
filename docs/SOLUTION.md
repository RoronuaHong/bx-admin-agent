# 企业通用 AI Agent 方案

> 定位：面向企业内部的多模型 AI 助手，作为后台管理系统（bx-film-admin-in2）的
> 分 Tab 能力提供；独立部署，与后台共用企业账号登录。

## 1. 产品形态：分 Tab 集成

```
浏览器
├── Tab 1（默认，现有） 后台管理系统  = D:\Code\bx-film-admin-in2
│   └── 菜单「AI Agent」→ 新 Tab/iframe 打开 Agent
└── Tab 2  AI Agent     = 本仓库 bx-admin-agent（web + agent-server 独立部署）
```

集成方式（vben 原生机制，零侵入）：

1. **后端菜单加记录**：后台菜单管理新增一条（如 name「AI Agent」/ englishName `AiAgent` / url 指向 Agent 地址）。
2. **前端路由模块**：`src/router/routes/modules/agent.ts` 新增路由，`meta.frameSrc` 指向 Agent web 地址（iframe 内嵌）或子路由 path 直接写完整 URL（新窗口打开）。
   - frameSrc 方式可让 Agent 直接嵌入后台布局；外链方式资源隔离更干净，推荐先用外链新窗口（`isUrl(path)` 自动 `openWindow`）。
3. **登录复用**：Agent 登录对接后台同一套账号（realLogin → `/v0.1/useraccount/loginForPassword`），企业账号体系不重复建设。

## 2. 架构

```
apps/web ──► /agent/* ──► apps/agent-server
                             ├── auth  ：登录（后台账号）、会话、cookie
                             ├── models：模型注册表（多 provider 可切换）
                             ├── chat  ：编排：注入内容源 → 调模型 → SSE 回复
                             └── sources：内容读取层
                                 ├── 上传文件（.data/uploads/，图片+文本）
                                 ├── 本地文档目录（AGENT_DOCS_DIR 白名单）
                                 └── 内网链接抓取（http/https，正文提取）
```

### 2.1 多模型接入（前端可切换）

env 注册多个模型，运行时任意切换，无需重启：

```env
MODEL_PROVIDERS=hy3,ollama          # 注册模型 id，逗号分隔；第一个为默认
MODEL_HY3_PROVIDER=anthropic        # 协议：anthropic | openai | ollama
MODEL_HY3_NAME=hy3
MODEL_HY3_BASE_URL=https://tokenhub.tencentmaas.com
MODEL_HY3_API_KEY=xxx
MODEL_HY3_VISION=ocr                # 图片处理：direct | ocr | none
MODEL_OLLAMA_PROVIDER=ollama
MODEL_OLLAMA_NAME=qwen3:8b
MODEL_OLLAMA_BASE_URL=http://localhost:11434
```

- 登录后前端 `GET /models` 拿可切换列表；当前模型随会话保存，前端下拉切换。
- 模型统一调用层 `models.ts`：anthropic（/v1/messages）、openai（/chat/completions）、ollama（/api/chat）三种协议适配，均返回文本。
- 图片：`direct` 直接图片 block 上送（视觉模型）；`ocr` 先转录（远程视觉端点优先，本地 ollama 兜底）；`none` 拒绝并提示。

### 2.2 内容源读取（Agent 知识输入）

优先级：本地文档 ≥ 内网链接 ≥ 上传文件。

| 来源 | 方式 | 安全 |
|---|---|---|
| 本地文档 | 服务端 `AGENT_DOCS_DIR` 白名单目录，用户可在对话指定文件名/路径读取 | 路径必须 resolve 后落在目录内 |
| 内网链接 | 用户对话中直接贴 URL，自动识别并抓取 | 仅 http/https；响应 ≤2MB；超时 15s；仅文本类注入 |
| 上传文件 | `/chat/upload` multipart，图片（png/jpeg/webp）+ 文本（txt/md/json/csv ≤2MB）；文本直接解析注入 | 类型白名单、TTL 10 分钟 |

- 抓取解析：HTML 去 script/style 后抽正文文本（strip 标签压缩空白），注入为
  `[链接内容 <url>]\n...`；图片链接转视觉转录（模型 ocr 模式）。
- 注入内容随当次请求生效，不进会话历史（避免上下文膨胀），并做总量截断（约 20k 字符）。

### 2.3 聊天流程

```
用户输入（text + 可选 images/files）+ 当前模型
  → chatStream
  → 链接识别（正则抠 URL，去重，逐条抓取/转录）→ 内容块
  → 读取本地文档（对话中显式引用文件名时）→ 内容块
  → 上传文件内容解析 → 内容块
  → 拼 user 消息（原文 + 附注内容块）→ 调当前模型 → SSE text/error/done
```

## 3. 目录结构（apps/agent-server/src）

```
app.ts        HTTP 路由：/auth/*、/models、/chat/stream、/chat/upload
config.ts     环境配置 + 模型注册表解析
models.ts     模型调用层（anthropic/openai/ollama 统一适配）
sources.ts    内容读取层（本地文档 / 链接抓取 / 输出截断）
uploads.ts    上传存储（图片 + 文本，TTL 清理）
vision.ts     图片转录（远程视觉端点 / ollama 兜底）
chat.ts       编排：内容注入 → 模型调用 → SSE 事件
auth.ts       登录（后台账号 realLogin / mock）、会话、cookie
```

## 4. 路线图

- [x] 多模型注册表 + 前端切换
- [x] 上传文件解析（文本类）+ 图片
- [x] 内网链接抓取 + 正文提取
- [ ] 本地文档目录接线（AGENT_DOCS_DIR 读指定文件）
- [ ] 前端文件上传按钮与预览（当前仅粘贴图片通道）
- [ ] pdf/docx 等富文档解析（视需要引入解析库）
- [ ] Tab 集成落地（后台路由模块 + 菜单配置）