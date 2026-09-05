# 观影助手 Agent 方案（Web 先行）

> **建立时间**：2026-09-05  
> **优先级**：高  
> **宿主决策**：**不做 App**；先用本仓 **Web（`apps/web`）** 落地 Agent 应用形态与能力。  
> **定位**：对话式观影助手（对标瑞幸 AI Lucky / BOSS 职决的交互范式），与 **B 端后台管理 Agent** 并列、工具隔离。  
> **状态**：**V0 方案已定稿**（文档 only；缺能力用「占位」标出；**不写代码**）  
> **关联**：[MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md)、[A2A_INTEGRATION.md](./A2A_INTEGRATION.md)

---

## 1. 一句话定位

**在 Web 里先做出「能聊、能推片、能出卡片、能确认动作」的观影助手；用户用什么语言聊，助手就用什么语言回（模型能力范围内的世界语言）。App 不在本期。**

交互范式参考瑞幸（对话内闭环 + 确认后执行）与 BOSS（多轮收敛偏好 + 结构化结果卡），产品壳先挂在现有 `apps/web`。

---

## 2. 范围

| 做 | 不做（本期） |
|----|--------------|
| Web 独立入口页 / 路由（观影助手） | 原生 App / 小程序客户端 |
| Worker `consumer-viewing` + 工具白名单 | 后台运营写接口混入该 Worker |
| 文本对话 + 影片卡片 + 快捷芯片 + 确认条 | 语音 ASR、App 深链播放器 |
| **MVP 必补**：冷启动提示 / 同轮 refine / Why / 诚实拒答 / 双通道检索 / 硬过滤 / 库内白名单 / Scope lock | 对话内支付 / 自动开通会员 |
| **多语言（MVP）**：跟用户语言回复；英 / 印地 / 葡等凡模型能做的语言 | 为每种语言单独训模型；人工全量 UI 翻译（可渐进） |
| Mock / 占位片库（真实 API 未就绪时） | M2 子图拆分、独立观影微服务（可后置） |

---

## 3. 产品形态（Web）

### 3.1 入口

```
apps/web
  ├── /chat          ← 现有：后台管理助手（不动）
  └── /viewing       ← 新增：观影助手应用页（占位路由）
         · 会话区（复用 Chat 消息流思路）
         · 冷启动 Starter prompts（首屏）
         · 影片卡片区（含 Why）
         · 快捷芯片（含同轮 refine）
         · 动作确认条（Intent Preview）
```

可选：顶栏「观影助手」入口；与 `/chat` 会话、鉴权可共用或先共用登录（**占位**：C 端用户体系未定时，沿用当前 web 登录做联调）。

### 3.2 对标 → Web 落点

| 对标点 | Web 怎么做 |
|--------|------------|
| Netflix：预置心情问法 | 首屏 Starter prompts（本地化） |
| 瑞幸：确认后执行 | 确认条展示「将发生什么」，不静默改状态 |
| BOSS：多轮偏好 + 结果卡 | 反问 + `media_cards` + 必出 `reason` |
| Netflix：结果上继续改条件 | 同轮 refine 芯片，不强制新开会话 |

### 3.3 会话示意（多语言：跟用户）

```
User: Something light tonight, not too long
Assistant: Here are a few light picks under ~110 min:
      [Card A — why…] [Card B — why…] [Card C — why…]
      Chips: Show more | Free only | Shorter

User: दूसरा वाला चलाओ
Assistant: (印地语回复) 已选第二部… 确认后打开详情。
      [Confirm open]
```

原则：**检测/沿用用户当前轮语言**（也可读 Web `locale` / `Accept-Language` 作默认）；片名可保留原片名 + 本地化标题（片库字段占位）。

---

## 4. 与后台 Agent 边界

| | 后台管理 Agent | 观影助手（本方案） |
|--|----------------|-------------------|
| 路由 | `/chat` | `/viewing`（Web） |
| Worker | `backend-api-*` / `knowledge` / `common` | **`consumer-viewing`** |
| 工具 | admin `call_api`、grep、导出… | 仅观影域工具（见 §6） |
| 数据源 | 后台 API | **用户端片库 API（占位 / Mock）** |
| 语言 | 偏中文运营场景 | **跟用户语言（世界语言，见 §5.2）** |

红线：观影会话 **不得** 暴露后台写配置工具；**不得** 推荐/打开 catalog 外或本区域无版权的片子。

---

## 5. 能力地图

### 5.1 P0（Web MVP）— 含业界必补

| 能力 | 状态 | 说明 |
|------|------|------|
| 意图理解 / 反问 | 规划 | 复用 `request_clarification`；反问文案跟用户语言 |
| **冷启动 Starter prompts** | **MVP 必补** | 首屏预置问法（心情/时长/类型）；随 locale 切换文案 |
| 搜片（点名） | **占位** | **关键词精确通道**（片名/演员） |
| 情境推荐 | **占位** | **语义通道**（轻松、下雨天…） |
| **同轮 refine** | **MVP 必补** | 「换一批 / 更短 / 只要免费」追加约束，不重开意图 |
| **Why this（可解释）** | **MVP 必补** | 每张卡片必出 `reason`（跟用户语言） |
| **硬过滤（检索前）** | **MVP 必补** | 时长 / 免费·会员 / 地区版权 / 年龄分级 → 再检索 |
| **库内白名单** | **MVP 必补** | 最终上屏 id 必须 ∈ catalog；禁止模型编造可播片 |
| **诚实拒答 / 空态** | **MVP 必补** | 无版权、下架、库外 → 明确说没有 + 给替代；不装有 |
| **Scope lock** | **MVP 必补** | 只做找片/续看/片单/详情；通识闲聊短拒或轻拒 |
| 影片卡片上屏 | 规划 | `render_media_cards` + Web 组件 |
| 「打开详情」确认 | **占位** | Intent Preview：「将打开《X》详情」→ 确认 → 路由 |
| 加片单 | **占位** | Mock；确认后可做（撤销留 P1） |
| 续看 | **占位** | `get_watch_progress` Mock |
| **多语言跟聊** | **MVP 必补** | 见 §5.2 |

### 5.2 多语言（MVP 必补）— 理解口径

**你的意思（已拍板进方案）**：

- 不绑死「只做中英」；**英语、印地语、葡萄牙语**以及 **当前所用模型能较好支持的世界语言** 都应能聊。
- 策略是 **跟用户语言**：用户本轮用什么语言，助手的话术 / Why / 芯片 / 确认条 / 拒答 就用什么语言。
- **不是**为每种语言单独做一个 Agent；**是**同一 Worker，输出语言跟随输入（+ 可选 UI locale 默认）。

| 层 | MVP 做法 | 占位 / 后置 |
|----|----------|-------------|
| 对话话术 / Why / 反问 / 拒答 | **模型跟用户语言生成**（主路径） | — |
| UI 壳（顶栏、按钮「确认」「换一批」） | 先跟 locale；缺翻译时可用英语兜底 | 全量 i18n 包渐进补齐 |
| Starter prompts | 按 locale 配置多套文案（en / hi / pt / zh…） | 更多语种文案占位 |
| 片名 / 简介 | 片库 `title` + 可选 `localizedTitle[lang]` | 无本地化则显示原名 |
| 语言检测 | 优先：用户消息语言；次选：Web `locale` / `Accept-Language`；可 `set_reply_language` 工具占位 | 手动切换控件 |

**首发验证语种（建议）**：`en` / `hi` / `pt` / `zh`（与现有印度 / 巴西站对齐）；其余语种 **不挡路**——模型能回就回，UI 壳可英语兜底。

**不做**：为小语种保证「母语级 UI 全翻译」作为 MVP 门槛；质量以「模型能聊通」为准。

### 5.3 P1（体验）

| 能力 | 状态 |
|------|------|
| 口味画像 / 多轮诊断 | 占位 |
| 会员权益说明 | 占位 |
| 加片单 Undo | 占位 |
| 会话历史持久化 | 规划 |
| UI 全语种静态文案包 | 占位 |
| 观影态问答（播中问是谁） | 占位（Web 无播放器） |

### 5.4 P2（后置）

| 能力 | 状态 |
|------|------|
| App / 小程序壳 | 明确不做本期 |
| 剧情搜 / 跳看 | 占位 |
| Skill / MCP / A2A | 占位 |
| 独立 viewing 服务 | 占位 |

---

## 6. 架构（Web + 同进程 Worker）

```
浏览器 apps/web  /viewing   (locale / Accept-Language)
        │  SSE（复用 /chat/stream 或 /viewing/stream【占位】）
        ▼
┌──────────────────────────────────────────────┐
│ agent-server                                 │
│ preprocess → understand ⇄ tool → final       │
│   · 注入 reply-language 提示（跟用户）         │
│   · Scope lock 系统约束                      │
│        │                                     │
│   route_to_agent(consumer-viewing)           │
│        ▼                                     │
│ Worker：硬过滤 → 双通道检索 → 白名单校验       │
│        → render_media_cards（含 reason）      │
└──────────────────────────────────────────────┘
        │
        ▼
 MockCatalog / UserApiAdapter【占位】
```

### 6.1 检索双通道（MVP 必补）

| 通道 | 触发 | 工具落点 |
|------|------|----------|
| **Keyword** | 点名片名、演员、精确标题 | `search_titles`（精确/模糊元数据） |
| **Semantic** | 心情、情境、模糊口味 | `recommend_titles`（向量/规则 Mock 占位） |

流水线顺序（逻辑）：**解析约束 → 硬过滤 → 双通道取候选 → catalog 白名单校验 → 卡片 + Why → （可选）refine 只改过滤条件重查**。

### 6.2 工具清单（含占位）

| 工具 | 读写 | 实现状态 |
|------|------|----------|
| `route_to_agent` | — | 已有，扩展 domain |
| `request_clarification` | 读 | 已有；文案跟用户语言 |
| `search_titles` | 读 | **占位**（Keyword + 硬过滤参数） |
| `recommend_titles` | 读 | **占位**（Semantic + 硬过滤参数） |
| `refine_recommendations` | 读 | **占位**（同轮追加约束；可并入 recommend） |
| `get_title_detail` | 读 | **占位** |
| `get_watch_progress` | 读 | **占位** |
| `render_media_cards` | 读 | **占位**；**强制**每卡 `reason` |
| `open_title` | 写意图 | **占位**（确认后 Web 详情） |
| `add_to_watchlist` | 写 | **占位** |
| `explain_vip_entitlement` | 读 | **占位** |
| `set_reply_language` | — | **占位**（用户显式锁语言时） |

禁止：`call_api`（admin）、`write_code_file`、`git_commit_push`。

服务端护栏（实现时）：上屏前 **丢弃不在 catalog 的 id**；空结果走诚实拒答模板（跟用户语言，可由模型生成，但不得捏造片）。

### 6.3 Web 事件契约（shared，占位）

```ts
type ViewingAssistantEvent =
  | { type: "text"; text: string; lang?: string }
  | { type: "media_cards"; items: MediaCard[] }
  | { type: "chips"; items: { id: string; label: string }[] }  // label 已本地化
  | { type: "starter_prompts"; items: { id: string; label: string }[] }
  | { type: "confirm_action"; action: "open_title" | "add_list"; preview: string; payload: object }
  | { type: "empty_result"; message: string; alternatives?: MediaCard[] }
  | { type: "navigate"; path: string };
```

`MediaCard`：**必填** `id` / `title` / `reason`；可选 `posterUrl` / `tags` / `durationMin` / `needVip` / `localizedTitle`。

### 6.4 Mock / API（占位）

- Mock：`apps/agent-server/.data/viewing/mock-catalog.json`（含多语标题字段占位）。  
- Env：`VIEWING_API_BASE` / `VIEWING_API_TOKEN`（空则 Mock）。

### 6.5 Scope lock（MVP 必补）

助手 **只** 处理：找片、推荐、refine、续看、详情、片单、权益说明。  
超出范围（作业、编程、无关闲聊）：短拒 + 拉回观影（跟用户语言）。  
实现：Worker systemPrompt + 工具面收窄；不靠词表路由。

---

## 7. Web 页面结构（占位清单）

| 路径 / 组件 | 作用 | 状态 |
|-------------|------|------|
| `pages/ViewingPage.vue` | 主对话 + 冷启动区 | 占位 |
| `pages/ViewingTitlePage.vue` | 确认后详情 | 占位 |
| `components/MediaCards.vue` | 卡片 + Why | 占位 |
| `components/ActionChips.vue` | refine / starter | 占位 |
| `components/ConfirmActionBar.vue` | Intent Preview 确认条 | 占位 |
| `i18n/viewing/*.json` | UI 壳文案 en/hi/pt/zh… | 占位 |
| `router` `/viewing`、`/viewing/title/:id` | 路由 | 占位 |

---

## 8. MVP 验收口径（文档级）

| 项 | 通过标准 |
|----|----------|
| Starter | 首屏可见预置问法；点击可发问 |
| Refine | 出卡后点「更短/免费」不丢上下文，结果变化 |
| Why | 每张卡有非空 `reason`，语言与用户一致 |
| 双通道 | 点名走 search；心情走 recommend（可测 Mock） |
| 硬过滤 | 指定「只要免费」结果不含 needVip |
| 白名单 | 模型若瞎编 id，上屏被滤掉或空态 |
| 诚实拒答 | 库外片名 → 明确无 + 替代，不假装能播 |
| Scope | 问「帮我写代码」→ 短拒并拉回观影 |
| 多语言 | 同会话切 en / hi / pt（或 zh）提问，回复语言跟随 |

---

## 9. 分期

| 阶段 | 目标 | 产出 |
|------|------|------|
| **V0** | 方案定稿 | 本文（含 MVP 必补 + 多语言） |
| **V1** | Web 可演示 | Worker + Mock + ViewingPage + 必补项 + 多语言跟聊 |
| **V2** | 真实片库 | `VIEWING_API_BASE`；版权/地区硬过滤接真 |
| **V3** | 体验 | 画像、Undo、UI 全语种包、会话持久化 |
| **以后** | App / 独立服务 | 不在本期 |

---

## 10. 已拍板

| 项 | 结论 |
|----|------|
| 宿主 | **Web only**；App 不做 |
| 引擎 | 同进程 Worker `consumer-viewing` |
| 片库 | 先 Mock，API 后接 |
| MVP 必补 | Starter / refine / Why / 诚实拒答 / 双通道 / 硬过滤 / 白名单 / Scope lock |
| **多语言** | **跟用户语言**；en / hi / pt / zh 首发验证；模型能做的其它语言不挡路 |
| 会员支付 | 不做对话内支付 |
| 展示名 | 默认「观影助手」（UI 随 locale） |

---

## 11. 进度

| 日期 | 进展 |
|------|------|
| 2026-09-05 | 初稿（偏 App） |
| 2026-09-05 | 修订：Web 先行；缺能力占位 |
| 2026-09-05 | **纳入 MVP 必补（业界实践）+ 多语言跟聊（en/hi/pt/世界语言·模型能力范围）** |
| 2026-09-05 | **V0 定稿收尾**：与 MULTI_AGENT 总文档对齐登记；本期仅文档、不开代码 |

---

## 12. 文档收尾

- [x] 本文 V0 定稿（含 MVP 必补 + 多语言）。  
- [x] [MULTI_AGENT_ARCHITECTURE.md](./MULTI_AGENT_ARCHITECTURE.md) 已登记 `consumer-viewing`（高优）。  
- [x] [README.md](./README.md) 已挂索引。  

**实现计划 / 写代码**：另开需求后再做（本期只要文档）。
