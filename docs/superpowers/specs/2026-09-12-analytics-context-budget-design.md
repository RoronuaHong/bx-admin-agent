# Analytics 上下文预算：分桶 · 投影 · 压缩层级

> **状态**：P0 + 可做 P1 已落地（2026-09-12 复检）；P2 明确不做  

> **日期**：2026-09-12  
> **宿主**：`apps/agent-server` Analytics 语义层（TurnIntent / Structure / schema-agent / diagnose）  
> **实现入口**：`src/analytics/context-pack.ts`  
> **关联**：  
> - [`2026-09-11-analytics-askstate-design.md`](./2026-09-11-analytics-askstate-design.md)（AskState 是工作记忆，本文件管「每次推理喂什么」）  
> - [`2026-09-09-metabase-analytics-agent-design.md`](./2026-09-09-metabase-analytics-agent-design.md)  
> **权威参考**：  
> - [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)  
> - 分桶预算：system / tools / history / tool_outputs / working + 5–10% headroom  

---

## 0. 一句话

上下文是**有限注意力**，不是硬盘。每次 LLM 调用只注入「本阶段最小高信号投影」：AskState + 本轮用户句 + 短近史 + 按需 Top-N。用户可见全文与模型所见必须分离。禁止把整段 transcript 当闸门或抽槽权威。

---

## 1. 问题与动机

未做预算时，Analytics 会把多轮原文、探库全量、clock/facts 一并塞进 Structure / schema-agent。后果与 AskState 缺陷同类：

| 现象 | 根因 |
|------|------|
| 新问被历史「三种小语种」带偏 | 模型吃全文，闸门也曾读 transcript |
| 「改成最近 / 八月初」沿用旧日期 | 历史区间盖过本轮；时间未先被代码否决 |
| 探库选项一多就挤掉本轮句 | 无 tool/probe 桶，JIT 变成预填百科 |
| 每轮 system 含 clock | 静态前缀每变，prompt cache 失效 |

窗口变大不能代替策展。Context rot：token 越多，单位召回越差。

---

## 2. 原则（强制）

1. **最小高信号集** — 只放本阶段做对这一步所必需的 token。  
2. **UI ≠ 模型所见** — `conversation` / session 全文保留；LLM 只吃 pack。  
3. **结构化记忆优先** — 已解析时间、AskState、facts 由代码写入，不靠模型从长历史回忆。  
4. **本轮用户句与 AskState 不可丢** — 压缩只动历史、探库、工具回包。  
5. **先便宜后昂贵** — 截断 / 滑窗 / head-tail → 丢最旧；**Analytics 默认不调用 LLM 做历史摘要**（对话短、摘要有损且贵）。管理后台 `chat.ts` 才在超预算后摘要。  
6. **关键信息放两头** — facts + AskState 在 user 消息开头；本轮用户句在末尾。中间只放近史和 Top-N。  
7. **静态前缀可缓存** — system = 规则 + pack catalog（随 pack version 变，不随 clock/用户变）。clock、已解析时间、AskState、本轮 NL 一律在 user。  
8. **按阶段组包** — TurnIntent / Structure / diagnose 各有预算，禁止一个超级 prompt。  
9. **失败可见** — 省略历史必须写明 `omitted`；禁止让模型从省略段「捞槽」。  
10. **用量可观测** — 每次 pack 记录分桶字符与 `tok≈chars/4`。Tokenizer 级计数为增强，不是 P0 门禁。

### 2.1 非目标

- 把管理后台 `chat.ts` 的 HISTORY_* 整套搬进 Analytics（两条链路会话形态不同）。  
- 各厂商 `cache_control` API 绑定（TokenHub / GLM 以「前缀字节稳定」为可移植做法）。  
- 用向量库检索旧轮原文当主路径（AskState + 近史足够）。  
- 让 LLM 写 SQL 或从超长探库里猜维值。

---

## 3. 目标形态

```
用户可见 conversation（完整）
        │
        ▼
packAnalyticsLlmContext(phase)
        │
        ├─ facts          代码时钟 / 已解析起止日 / prefs 摘要
        ├─ AskState       压缩 JSON（无 askId / 时间戳）
        ├─ recent history 近 N 条，可 head-tail / 丢最旧
        ├─ probe          Top-N 字符帽（可空）
        └─ current turn   最后一条用户句（钉死，放最后）
        │
        ▼
TurnIntent / Structure / schema-agent / diagnose
        │
闸门只读 lastUserText + AskState / merged，不读全文
        │
Intent compile → SQL（不带对话）
```

### 3.1 阶段与分桶（字符，约 token×4）

总帽故意远小于模型窗口，并预留约 25% 给标签行与输出，避免「窗口有多大塞多大」。

| 阶段 | 职责 | total | facts | state | history | probe | current | tool | 近史条数 |
|------|------|------:|------:|------:|--------:|------:|--------:|-----:|--------:|
| `turn_intent` | 本轮对 Ask 做什么 | 3500 | 200 | 1500 | 0 | 0 | 2000 | 0 | 0 |
| `structure` | 填槽 / 单次前向 | 8000 | 800 | 1500 | 3500 | 1200 | 2000 | 2000 | 6 |
| `diagnose` | 失败解释（禁写 SQL） | 2800 | 200 | 400 | 1600 | 0 | 800 | 0 | 4 |

- **system**（另计，不进上表 user total）：规则 + catalog；随 pack 版本变，不随请求 clock 变。  
- **tool**：schema-agent 每条 tool 回包硬帽；不进 user transcript，但计入本阶段 tool 桶。  
- 单句进模前仍受 `ANALYTICS_MAX_NL_CHARS = 4000`（护栏，与 current 桶同时生效，取更严）。

### 3.2 压缩层级（必须按序）

1. **探库 / 工具结果截断** — Top-N + 字符帽；`truncated` 标记。  
2. **滑窗** — 只保留本轮之前最近 `keepRecent` 条。  
3. **单条 head + tail** — 近史过长时留头 400 / 尾 200。  
4. **丢最旧近史** — 仍超 `history` 或折算后的剩余总帽，从最旧一条丢掉。  
5. **不默认 LLM 摘要** — Analytics 问数轮次短；需要跨很多轮的「故事」应写进 AskState.summary，而不是再烧一次模型。

### 3.3 User 投影拼装顺序（强制）

```
Deterministic facts
AskState
（若有）Earlier messages omitted: N. Do not recover slots from omitted history.
Recent history
Dimension probe (Top-N)     ← 可空
Current user turn           ← 必须最后
```

解析策略（`lastUserUtterance` / 短澄清）只准看该投影，尤其是最后一条 `用户:`。

### 3.4 各阶段喂什么

| 阶段 | 必留 | 可空 | 禁止 |
|------|------|------|------|
| TurnIntent | 本轮原文 + 完整 AskState + lastClarifySlot | facts | 全文、探库、旧轮「三种小语种」 |
| Structure / schema-agent | facts + AskState + 本轮 + 近史 | probe Top-N | 「use ALL turns」、未截断探库 |
| 闸门（覆盖/能力/语言/口径） | lastUserText + merged/AskState | — | 完整 transcript |
| 时间 | 本轮代码解析；未谈时间才沿用 AskState | — | LLM 猜日期；模糊时间沿用上一问 |
| diagnose | 瘦 pack + stage/error | 短 SQL preview | 完整表、LLM 写 SQL |
| sql-compile | Intent JSON + pack | — | 任何对话 |

---

## 4. 与管理后台 chat 的边界

`chat.ts` 已有独立预算：历史 24K 字 / 近 8 轮、steps 60K、先折叠表再可选 LLM 摘要。那是工具循环长会话。

Analytics **不复用**那套常量。共享的只是原则：投影、先 prune、本轮不可丢、`tok≈chars/4`。

---

## 5. 对照检查（2026-09-12 复检）

查过：`context-pack.ts`、`schema-agent.ts`、`pipeline.ts`、`turn-intent-llm.ts`、`input-guard.ts`、`conversation-structure.ts`、`chat.ts`。

| 条款 | 现状 | 判定 |
|------|------|------|
| UI ≠ 模型所见 | Structure / schema-agent / diagnose / TurnIntent 走 pack；conversation 仍完整 | 已落地 |
| AskState 工作记忆 | `compactAskStateForLlm`；闸门 `askScopeNl` = 本轮 + merged | 已落地 |
| 本轮钉死在末尾 | `currentTurn` 单独渲染，放最后 | 已落地 |
| 模糊时间不猜不沿用 | `resolveAskTimeRange` + pipeline 无日期即 `time_range` | 已落地（另一条线） |
| 分桶数字 | `PHASE_CAPS` 已写 | 已落地 |
| 压缩层级 1–4 | pack 内已做；`enforceTotal` 超 `caps.total` 再压 probe→history；tool 回包 `capToolResult` | 已落地 |
| system 不含 clock/facts | Structure / schema-agent system 已移出动态 facts | 已落地 |
| 用量日志 | `[analytics:context] phase/chars/tok≈/buckets`；LLM span `meta.context` | 已落地 |
| TurnIntent 走 pack 阶段 | `phase: "turn_intent"` + wrap；`lastClarifySlot` 另附可信块 | 已落地 |
| 渲染后 total 硬顶 | `enforceTotal`：先 probe 再丢最旧 history；不切 current / AskState / facts | 已落地 |
| 只 wrap 不可信用户句 | `wrapPackedAnalyticsUserText` 只包 history + current | 已落地 |
| probe JIT | 仅 `neededProbeFields` 对应维才探（语种集合→contentLang，影片类型→movieType）；澄清只探该槽 | 已落地 |
| 总帽权威 | 仅 `ANALYTICS_MODEL_TRANSCRIPT_CHARS` = `PHASE_CAPS.structure.total`（8000）；已删 12000 别名与 `guardTranscriptLines` | 已落地 |
| 策略不读 pack chrome | `userFacingTranscript` / `lastUserUtterance` 丢掉 facts / AskState / probe；`mergedNl` 禁止回退成 pack 投影 | 已落地 |
| system 无 clock 形参 | `buildStructureSystemPrompt(pack)`；clock 只在 user facts | 已落地 |
| catalog 长度 | system `Known metrics` 超过 24 条截断并标 `+N more` | 已落地 |
| tool 用量进 usage.buckets | `applyToolUsage` 在 schema-agent 回包累加 | 已落地 |
| Tokenizer | 无；与 chat 一样 chars/4 | 有意非 P0 |
| cache_control API | 无；只保证 system 前缀稳定 | 有意非 P0 |
| LLM 历史摘要 | Analytics 无 | 有意非目标 |

---

## 6. 落地顺序

### P0（已落地）

1. TurnIntent 改为 `phase: "turn_intent"` 的 pack（本轮 + AskState + 可选 facts），去掉平行手写拼接。  
2. `render` 之后若 `transcript.length > caps.total`，按层级再压一次（先 probe，再 history），**不得切掉 current / AskState**。  
3. 只对 history + current 做 untrusted wrap；facts / AskState 保持可信块。  
4. 总帽只认 `ANALYTICS_MODEL_TRANSCRIPT_CHARS`（= structure.total 8000）。  
5. `usage.buckets.tool` 在 schema-agent 回包时累加。

### P1（可做项已落地；断点缓存仍等网关）

1. Structure 默认不预注入全维 probe；仅 `needsDimensionProbe`（`contentLang` 集合无成员 / 影片类型）时再探。  
2. system catalog：`Known metrics` 超过 24 条截断并标 `+N more`。  
3. pack `usage` 写入 TurnIntent / Structure / schema-agent / diagnose / fallback 的 LLM span `meta.context`。  
4. 若网关稳定支持 prefix cache，再加断点；不断点也能靠「system 稳定」受益（未做）。

### P2（明确不做，除非单独立项）

- Analytics 路径 LLM compact / 滚动摘要。  
- 按 tiktoken/厂商编码器做门禁（可做校验脚本，不进热路径）。  
- 与 `chat.ts` 合并成一个通用 ContextBroker。

---

## 7. 验收

- 长会话第 N 轮「FoxA呢？」：pack 含 AskState 与本轮，**不含**第 1 轮「三种小语种」原文。  
- 首轮短问：`omittedMessages=0`，本轮原文完整。  
- Structure system 文本不含 `today_date` / `resolved_time_range`；这些只出现在 user facts。  
- 探库或 tool JSON 超过桶帽时带 `truncated`，且 current / AskState 仍在。  
- 闸门用例：历史有完播率，本轮「FoxA呢？」不重开口径；历史有小语种，本轮「电影观看人数」不逼语言。  
- `test:analytics` 含 `analytics-context-pack.test.ts`，断言顺序（facts < AskState < current）与省略行为。

---

## 8. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| Analytics 是否 LLM 摘要历史 | 否 | 轮次短；槽位应进 AskState；摘要会丢掉日期/渠道码 |
| 预算单位 | 字符 + chars/4 | 与现网 chat 一致；热路径零依赖 |
| 历史权威 | 本轮 + AskState | 全文当权威已多次答非所问 |
| 模糊时间 | 代码解析失败即 clarify | 不猜、不沿用 |
| 与 chat 预算合并 | 不合并 | 会话形态不同，只共享原则 |
