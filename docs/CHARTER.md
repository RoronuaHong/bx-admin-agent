# 企业通用 AI Agent —— 总章程（CHARTER）

> 本文档为 bx-admin-agent 项目的最高指导文档（总章程），定义产品形态、最终需求目标、
> 总体架构与实现路线。技术细节见 `docs/SOLUTION.md`，二者以本文件为准。

---

## 1. 产品定义

面向企业内部用户的**多功能 AI 助手**，作为后台管理系统（bx-film-admin-in2）的分 Tab
能力提供：独立部署、复用企业账号登录；用户可以像聊天一样完成三件事：

1. **问与读**：接入多个大模型（前端可切换），读取本地文档、内网链接、上传文件，做问答与分析。
2. **调接口**：通过聊天自然语言调用企业内部项目的接口能力（增删改查）。
3. **用知识库**：企业内部知识库，分类管理，通过聊天增删改查。

三条能力不是并列的功能页，而是**同一个聊天界面内的统一入口**——用户不需要学习工具，
只说人话，Agent 负责判断该"直接回答 / 查知识库 / 调接口 / 组合以上"。

## 2. 最终需求目标（总纲）

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | 聊天调用企业接口 | 说"给我创建一个用户 xxx"→ Agent 收集参数→确认(写操作)→调真实接口→返回结果并自然语言汇报。增删改查均可 |
| G2 | 内部知识库 | 说"查一下知识库关于员工手册的内容"→ 检索返回；说"把刚才这段存进知识库（财务）分类"→ 归类写入；可改、可删、可看分类 |
| G3 | 多模型可切换 | 现有能力（已实现），前端切换模型不影响会话连续性 |
| G4 | 内容源读取 | 现有能力（已实现），本地文档/内网链接/上传文件均可作为上下文 |

## 3. 总体架构

```
apps/web（Vue3 聊天 UI）
  │  /agent/* 代理（vite）
  ▼
apps/agent-server（Hono）
  ├── auth    ：企业账号登录（realLogin 国家线）、会话、cookie
  ├── models  ：模型注册表（anthropic/openai/ollama 多协议统一调用层）
  ├── chat    ：编排中枢（唯一入口）
  │   ├─ 内容源注入：本地文档 @file: │ 内网链接 │ 上传文件 │ 图片转录
  │   ├─ 知识库检索：kb_search（需要时）
  │   └─ 工具循环：models 的 function calling ↔ tools.ts 接口代理执行
  ├── sources ：内容读取层（已实现）
  ├── tools   ：接口注册表 + 校验 + 代理执行 + 鉴权注入（新）
  └── kb      ：知识库存储 + 检索 + 工具实现（新）
```

编排中枢决策顺序（chat 流程）：

```
用户输入
  → 1. 识别内容源（@file: / URL / 上传附件）→ 注入内容块
  → 2. 是否需要知识库？ → kb_search 检索注入
  → 3. 调模型（带全部工具定义）→ 模型返回：
       ├─ 直接回答 → SSE 输出，结束
       └─ tool_use → 校验参数 → 工具执行（写操作先确认）→ tool_result 回填再调模型
            （循环上限 8 轮；每轮工具调用过程通过 SSE 展示给用户）
```

## 4. 能力一：多模型聊天 + 内容源（已实现，现状）

- 模型注册表：env 声明（MODEL_PROVIDERS=id1,id2），运行时切换，会话记忆。
- 协议适配：anthropic `/v1/messages`、openai `/chat/completions`、ollama `/api/chat`。
- 图片模式：`direct`（视觉模型直传）| `ocr`（转录注入）| `none`（拒绝）。
- 内容源注入当次请求生效不进历史，总量截断 20k 字符。
- 鉴权：国家线 realLogin + MOCK_UPSTREAM 切换；/models、/chat/upload、/chat/stream 均需登录。

## 5. 能力二：聊天调用企业内部接口（需求目标 G1）

### 5.1 接口注册表（声明式）

每个接口一条定义，放 `data/apis/*.yaml`，**白名单制：只声明了才能调**：

```yaml
name: user_create          # 工具名（模型看到的函数名）
label: 创建用户
method: POST
url: http://apiadmin.xxbbc.com/user-admin/users
headers: { X-From: agent }
auth: static-key           # 鉴权来源：static-key | passthrough(登录态透传) | menu(后台管理员)
params:                    # JSON Schema 风格，模型由此收集参数
  username: { type: string, required: true, desc: 用户名 }
  phone:    { type: string, required: false, desc: 手机号 }
  status:   { type: integer, enum: [0,1], default: 1 }
output: 接口响应 body 原样返回
```

支持：请求体/查询参数/路径参数、嵌套对象、枚举校验、默认值、分页参数约定、
响应截断（≤20k 字符）、超时（默认 10s，可逐接口覆盖）。

### 5.2 模型侧适配（models.ts 扩展）

| 协议 | 函数调用通道 | 说明 |
|---|---|---|
| anthropic（hy3） | `tools` / `tool_use` / `tool_result` | 已实测可用（13 工具 probe） |
| openai 兼容 | `tools` / `tool_calls` | DeepSeek、各家网关 |
| ollama | 模型支持则原生 tools | 不支持时走降级 |
| 无工具模型 | 降级：提示词约定 JSON 输出→服务端解析执行 | 兜底，提示词仅此场景注入，不动纯聊天路径 |

### 5.3 执行与安全

- **写操作确认**：GET/查询类直接执行；POST 创建/删除/修改默认 SSR 发 `confirm_request`
  事件，前端弹确认框，用户点确认后才真正发出。（可配免确认白名单）
- **工具调用过程透明**：SSE 事件 `tool_use` / `tool_result` / `confirm_request`，
  前端展示"Agent 正在调用接口：创建用户(apiadmin.xxbbc.com)…"
- **异常兜底**：接口 4xx/5xx/超时 → `tool_error` → 模型向用户解释原因。
- **权限**：（决策点 D3）按用户/角色过滤可见工具集。

## 6. 能力三：企业内部知识库（需求目标 G2）

### 6.1 存储模型（SQLite 单文件 `data/kb.db`）

```
kb_category   id, name, parent_id, sort        -- 两级分类
kb_docs       id, category_id, title, content, tags, created_by, updated_at, version
kb_versions   id, doc_id, content, updated_at  -- 历史版本（可选）
```

### 6.2 检索

- **正式版**：SQLite FTS5 全文检索（对中文按字符粒度可工作）+ 分类/标签过滤 + Top N 排序。
- **升级项（D4 拍板，推荐后置）**：embedding 语义检索（本地 nomic-embed-text 或上游
  embedding API），提升"意思相近但字面不同"的命中率。

### 6.3 聊天操作（一组知识库工具）

| 工具 | 触发话术例 | 动作 |
|---|---|---|
| `kb_search` | "查一下知识库关于员工手册" | 关键词+分类检索，Top5 摘要入上下文 |
| `kb_add` | "把这段存进知识库 xx 分类" | 创建文档（title/分类/标签由模型提炼，用户可改） |
| `kb_update` | "把 xx 那篇改成…" | 定位 → 更新 + 版本记录 |
| `kb_delete` | "删除 xx 那篇" | 二次确认后删除 |
| `kb_list` | "知识库里有什么" | 分类树 + 文档列表 |

### 6.4 内容入库来源（与内容源打通）

- 聊天口述 / 对话摘要（模型提炼后写入）
- 上传文件 → "导入知识库 xx 分类"（现有上传通道）
- `@file:` 本地文档 → "收录到知识库"

## 7. 安全总原则

1. **接口白名单**：未在注册表声明的内网地址一律不可被模型调用（链接抓取仅读取，绝不留写入口）。
2. **写操作确认**：一切非查询类动作（接口写操作、kb_delete）默认需用户确认。
3. **SSRF 控制**：工具执行目标只能是注册表声明的 URL 模板；参数仅可影响其路径/查询/请求体，不可改写 URL 主机。
4. **凭证管理**：API Key 只存服务端 env，不下发前端；前端永远看不到真实接口凭证。
5. **上下文卫生**：工具结果与大文档内容截断注入，不进会话历史，防膨胀。

## 8. 开发运维约定

1. **所有 node 服务一律用 PM2 启动 dev**：根目录 `ecosystem.dev.config.cjs` 是唯一启动入口
   （`pm2 start ecosystem.dev.config.cjs`）。禁止用 `node`、`npm run dev` 等手动方式常驻运行服务进程。
2. **新增服务进程必须登记**：任何新的 node 常驻进程（新增端口/新项目服务）都要在
   `ecosystem.dev.config.cjs` 注册，不允许裸跑；临时验证用的进程也要用 `pm2 start` 起、验证完 `pm2 delete`。
3. 重启/日志：`pm2 restart ecosystem.dev.config.cjs`、`pm2 logs <name>`；配置变更后执行 `pm2 save` 固化进程列表。
4. 开机自启已配置：`pm2-startup`（登录时 resurrect）；更换机器后需重新 `pm2-startup install` + `pm2 save`。

## 9. 待拍板决策点（D1-D5）

| 编号 | 问题 | 推荐 | 备选 |
|---|---|---|---|
| D1 | 写操作是否默认需确认 | 需要，可配免确认名单 | 全部直接执行（仅日志记录） |
| D2 | 接口鉴权方式 | 静态 Key + 每接口 header 映射 | 调用者登录态透传 |
| D3 | 知识库写入权限 | 登录用户均可写 | 仅配了角色的人可写 |
| D4 | 检索方式 | 先 FTS5 关键词，语义后置 | 直接上 embedding 语义检索 |
| D5 | 第一版示例接口 | 用户/影片 CRUD 各 2-3 个（India 线） | 由后台项目方提供清单 |

## 10. 路线图

### 阶段 0（已完成）
- [x] 多模型注册表 + 前端切换（G3）
- [x] 上传文件/图片、内网链接抓取、内容注入（G4）
- [x] 鉴权、分 Tab 方案定稿（docs/SOLUTION.md）

### 阶段 1：接口工具链路（G1）
- [ ] `data/apis/` 注册表加载 + 参数校验 + 代理执行（tools.ts）
- [ ] models.ts 工具循环（tool_use 解析 / tool_result 回填 / 降级 JSON 解析）
- [ ] chat.ts 编排接入；SSE 增加 `tool_use`/`tool_result`/`confirm_request` 事件
- [ ] 前端：确认弹窗 + 工具调用过程展示条
- [ ] 示例接口落地（D5 决定）
- [ ] 真机联调：创建/查询/修改/删除 全链路

### 阶段 2：知识库（G2）
- [ ] kb.db 建表 + FTS5 检索（kb.ts）
- [ ] 五个 kb 工具接入工具循环
- [ ] 写操作确认 + 导入入口（上传文件/本地文档入库）
- [ ] 前端对话联调 + 分类浏览

### 阶段 3：收尾
- [ ] 权限过滤（D3 决定后）
- [ ] 语义检索升级（D4 决定后）
- [ ] Tab 集成落地（in2 路由模块 + 菜单）
- [ ] PDF/docx 富文档解析（视需要）