# 客服助手 Jev（已接线）

> 2026-10-12。状态：**客服助手这一路已接上**。通用助手、观影助手、定时预警不调用。
> Jev 不生成回复，也不出现在对话模型名单里。写回复的仍是坐席当前选的模型。

## 做什么

一次 `POST /v1/systemone`（模型 `jev-latest`）问事先写死的封闭题。选项和阈值在 `src/jev.ts`，不写进人设。

客服助手跟坐席说话，会话事实从 Zoho SalesIQ 来。Jev 判的是坐席这条指令，不是访客情绪。访客逐句要等消息工具接上，在那之前不编一档访客情绪。

| 题 | 答案 | 代码怎么用 |
|---|---|---|
| 事项 | 查会话 / 查制度 / 起草回复 / 其他 | 只显示 |
| 是否要求代发 | 概率 | 只显示。不因此去调用发送工具 |
| 路由 | 留在客服 / 建议通用助手 / 其他 | 只显示。不跳转、不换角色、不换模型 |
| 是否越权 | 概率 | 只显示。现有定界、身份护栏、接地、确认卡照旧 |
| 草稿是否把退款说成已经答应 | 概率 | ≥ 0.9 标成高风险，正文不改；0.5–0.9 只标记；低于 0.5 不标记。是否题的标签带上概率。写在给访客的草稿里也算 |

代发工具（`sendMessageInConversation`、`replyToMessage` 等）目前不在白名单里。一旦坐席助手点名调用，概率 ≥ 0.9、安全检查没有结果，或正文是空的，都不会发出。中间一带仍走原来的确认卡。承诺达到 0.9、以及「要代发」「像越权」到达 0.9，用警示色。绿色只表示这一格很集中。

没有 `JEV_API_KEY`：不发请求。气泡写「未配置 Jev，这次没有调用」。调用失败或超时：气泡写「安全检查没有结果，不能视为已通过」。两种情况下查阅和普通回复都照旧发出。

## 配置

`JEV_API_KEY`、`JEV_BASE_URL`（缺省 `https://api.typesafe.ai`）、`JEV_MODEL`（缺省 `jev-latest`）。见 `apps/agent-server/.env.example`。走 OpenRouter 时端点改为 `https://openrouter.ai/api`，模型名仍用 `jev-latest`，密钥用 OpenRouter 的。

超时不再写死 8s（第 7 批，见下）：`JEV_TIMEOUT_MS`（显式覆盖，优先）· `JEV_TIMEOUT_FLOOR_MS`（保底，默认 8000）· `JEV_TIMEOUT_MAX_MS`（封顶，默认 30000）· `JEV_LATENCY_WINDOW`（成功延迟样本数，默认 20）。额度预检沿用对话模型那套开关（`MODEL_QUOTA_PREFLIGHT` / `MODEL_QUOTA_PREFLIGHT_HOSTS`）。

## 治理（第 7 批，2026-10-14）

此前 Jev 是「裸 `fetch` + 写死 8s 超时 + 只 `console.warn`」——失败不可复盘、慢端点被系统性误杀、走 OpenRouter 时不吃任何配额治理。现在它与对话模型共用同一套机制：

| 面 | 做法 | 与对话模型的关系 |
|---|---|---|
| 超时 | `clamp(2 × 实测成功 p95, 保底 8s, 封顶 30s)`；只收**成功**样本；样本 <3 时按保底 | 同一份派生实现（`scripts/adaptive-timeout.mjs`，BI 查询超时也在用） |
| 冷却 | 失败按共享判据归类（每日配额 → UTC 日切 / 分钟限流 → 短档 / 鉴权 → 小时 / 5xx → 调度周期），写共享冷却表并落盘 | 同一个 `noteDownFailure`，冷却键 `jev`，重启后仍然记得 |
| 额度预检 | `JEV_BASE_URL` 指向 openrouter.ai 时查该密钥的当日免费额度，耗尽则**不发请求**（冷却到 UTC 日切） | 与对话模型共用 `model-quota.ts`，按密钥聚合、TTL 缓存、fail-open |
| 留痕 | 每次调用一条 llm span（`gen_ai.operation.name=classify`，带 runId、耗时、成败、低基数 `error.type`） | 与对话模型的 llm span 同构，可在同一次运行的 trace 里对齐时间线 |
| 计数 | 调用/失败次数进 usage 事件 → RunTrace → 在线评测 `classifier_health`（阈值 `EVAL_MAX_CLASSIFIER_FAIL_RATE`，默认 0.2） | 单列维度，不混进收敛/效率类维度（Jev 不生成回复） |
| 可观测 | 启动日志打印一次当前生效阈值与推导依据（`jevTimeoutInfo()`：生效值 / 保底 / 封顶 / 样本数 / 是否被显式覆盖）；阈值变化时 stderr 再打一行 | 与 BI 查询超时同口径，排障时不用猜「这次为什么等了 N 秒」 |

**语义没变**：Jev 仍不在 `MODEL_PROVIDERS` / `listModels()` 里（不在模型下拉、不进自动候选链），结果仍不回灌写回复的模型；承诺 ≥0.9 仍拒发、0.5–0.9 仍只标记。改的只是「它自己那一次调用怎么被对待」。

新增环境变量均带默认值，不配即上表所写的默认口径。回归见 `apps/agent-server/tests/jev-governance.test.ts`（11 例：超时派生/覆盖、冷却短路、计数不虚增、span 字段、三个代发检查点都带 runId、解析与拒发阈值未变）。

## 落点

| 文件 | 作用 |
|---|---|
| `apps/agent-server/src/jev.ts` | 题目、解析、阈值、代发拒绝 + 第 7 批治理（超时派生 / 冷却 / 预检 / span / 计数） |
| `apps/agent-server/src/model-availability.ts` | 第 7 批抽出：Jev 与对话模型**共用**的失败分类、冷却表与记账入口 |
| `apps/agent-server/src/chat.ts` | 仅 `agentId === support` 且不是定时运行时调用；结果不回灌模型；三个代发检查点都带 `runId` |
| `apps/agent-server/src/trace.ts` | RunTrace 的 `classifierCalls` / `classifierFailures`（第 7 批新增，只记次数不记内容） |
| `apps/agent-server/src/app.ts` | usage 事件 → RunTrace 的字段映射 |
| `apps/agent-server/src/eval-online.ts` | 在线评测新维度 `classifier_health`（`EVAL_MAX_CLASSIFIER_FAIL_RATE`，默认 0.2；`calls=0` 时该维度缺席而非记失败） |
| `apps/agent-server/src/index.ts` | 启动日志打印 Jev 超时的生效值与推导依据 |
| `apps/agent-server/scripts/adaptive-timeout.mjs` | 超时派生的**共享纯函数**（BI 查询超时与 Jev 超时同一份实现） |
| `packages/shared` 的 `support_labels` | 事件；同文件另有 usage 事件协议字段 `classifierCalls` / `classifierFailures` |
| 客服页气泡 | 标签。随消息快照保存，刷新还在。客户端断开时，服务端落库同样带上标签 |
| run trace | `supportLabels` |
| `apps/agent-server/.env.example` | 第 7 批四个开关（`JEV_TIMEOUT_MS` / `JEV_TIMEOUT_FLOOR_MS` / `JEV_TIMEOUT_MAX_MS` / `JEV_LATENCY_WINDOW`）与预检开关说明 |
| `apps/agent-server/tests/jev-governance.test.ts` | 第 7 批回归 11 例 |

人设只改听众：对坐席说话，不把坐席当成访客。工具循环、接地护栏、定时预警不动。`listModels()` 不含 `jev`。

## 优势：哪些已经成立

厂商的能力，和本仓库实际用到的程度，不是同一件事。

| 说法 | 接上之后 |
|---|---|
| 概率可以拿来设阈值 | 成立的是接口返回概率，代码能分支。承诺 ≥ 0.9 只标高风险，不改正文；代发在 ≥ 0.9 或没有结果时拒绝。0.5–0.9 只标记。没有做成「> 0.9 自动执行、0.7–0.9 改走大模型、< 0.7 转人工」。选择题上的 `confidence` 表示分布有多集中，不是「这条标签有多大概率是对的」；本项目也还没有用中文标注数据校准过 |
| 非自回归，适合每条消息都判 | 客服助手每一轮会问两次（输入一次、草稿一次）。通用助手、观影、定时预警不问。延迟和 $0.042 / 百万输入 token、输出免费，是厂商公开价，本仓库没有自己计量。单次等待**保底 8 秒**（与既有体感一致），并按实测成功延迟 p95 × 2 自适应派生、封顶 30 秒（第 7 批；样本不足 3 条时按保底走）。失败或超时就当没有结果 |
| 类型化输出，格式有保证 | 调用成功时答案是封闭题，解析只认 `choice` / `probability`。失败、超时、没密钥时没有结构，不编一个标签 |
| 标签事先写死，不会冒出新类 | 事项和路由都有「其他」，看不出时不必硬归进某一档 |
| 与写回复的模型分开 | 分开的是两次调用：Jev 不在 `MODEL_PROVIDERS` 里，结果不回灌对话模型。写回复的模型每一轮仍然会跑，不会因为 Jev 分高就跳过 |

## 劣势：本项目怎么兜

| 限制 | 现在的做法 |
|---|---|
| 中文准确率通常低于英文 | 中文标签只显示给坐席。不按事项、路由自动改派或改写。承诺达到 0.9 也只标高风险，不改正文。定界、接地、确认卡仍在 Jev 外面。坐席已经在场，中间带不再另叫一次大模型复核 |
| 不擅计数、日期先后、接近的数字、双重否定 | 会话条数仍走 `count_list_by_time`。Jev 不判有没有超过 300，也不排日期 |
| 没有原生弃权 | 事项和路由都有「其他」。选了「其他」或置信度低时只显示，不改回复 |
| 选择题最多 255 项 | 现在最多 4 项，不分层 |
| 长文塞进去会变差 | 送去判断的是带说话人的一小段：坐席原文，或助手草稿。最长 8000 字，不把整段历史或整份会话记录塞进去 |
| 不做长链推理、制度论证、看图 | 这些仍由当前对话模型写。制度原文走 `search_knowledge`，不走 Jev |

## 不是「向量召回 → Jev 精分 → 大模型兜底」

当前客服一轮是三条线并行，没有串成这一条：

1. 知识库：对话模型自己决定要不要调 `search_knowledge`。库内是词法加可选向量，两路用 RRF 融合；向量不可用就只剩词法。Jev 看不到命中的片段，也不负责从片段里挑一条。
2. Jev：只给这一句原文和最后的草稿打封闭标签。
3. 对话模型：每一轮都写回复。Jev 分低不会把这一轮改成「改由大模型写」——它本来就在写。分高也不会改成「不必再写」。

所以不存在「先召回、再精分、分不准再兜给大模型」。向量召回在知识库工具里，Jev 在标签上，大模型在回复上，三者没有按置信度交接。

Jev 也不负责从 Zoho 的工具里挑一个。事项标签不回灌模型，不变成 `search_tools` 的查询。两百多个工具怎么收成几个，写在 `support-salesiq-plan.md` 的「不要把控制台上的两百多个工具交给模型」。

## 七、网上最佳实践对齐（2026-10-16 复盘）

> 来源：TypeSafe 官网（System One 定位：接收 `state` + 类型化问题，70–500ms 返回带校准概率的结构化答案，输出空间预设不越界）；CSDN《Jev 使用完整指南》（基于 TypeSafe 官方文档 2026-09-21 快照）；AISIX AI 网关 classifier 配置范式（`type:jev` + `min_confidence` + `timeout_ms` + `on_failure`）；jev-xyz 实测（$0.02/千次决策、96% 精度、warm p50 312ms、往返 281–944ms 被网络主导）。

### 7.1 网上最佳实践要点（提炼）

1. **三原语**：`state`（打包证据而非结论，命名 JSON；state 不可信，对抗文本会偏置，发送前先过滤）+ 一组**类型化问题**（Choice / Score / Noul，共享同一 state、并行评估）。
2. **写题规则**：一题一判；Choice 必带 `其他/未知`；Score 描述"情境"而非"程度"；Noul 的 `true` 必须映射"是"；**near 0.5 = "不知道"→ 升级，不猜**。
3. **置信阈值按风险分级，不用全局阈值**：`<0.5` 转人工；`0.5–0.7` 让用户确认；`0.7–0.9` 升级旗舰 LLM 复核；`>0.9` 仅低风险可自动执行。Noul≈0.5 升级不硬猜。
4. **CJK 场景抬高地板到 0.6–0.7**（模型英文优先，中文精度更低）。
5. **绝不用在**：生成文本/代码、计数/算术/日期比较、需要可解释推理链的合规、非英文主输入、当计算器或日期排序器、微调。
6. **部署前必须校准**：用标注业务数据跑 Jev → 按置信度分桶算真实精度 → 校准各动作阈值；**中文重校不是可选项**。
7. **可观测**：代码里**锁定模型版本，绝不用 `jev-latest`**（别名漂移会破坏阈值）；每次调用记录 `resp.model`（返回真实版本而非别名）与 `resp.usage`；按置信度分桶并接人工抽检反馈闭环。
8. **Speculative Fan-Out**：一次调用里把所有可能要问的题全发出去（并行，几乎零额外延迟）。

### 7.2 当前实现 vs 最佳实践 差距

| 最佳实践 | 当前实现（`src/jev.ts`） | 状态 | 待办 |
|---|---|---|---|
| 锁定模型版本，不用 `jev-latest` | `JEV_MODEL` 缺省 `jev-latest`（alias） | ⚠️ 部分(已加未钉告警 + 记录真实版本；默认仍 alias 待运维钉死) | 默认改钉版本 + 记录真实版本 |
| 每次调用记录 `resp.model` + `resp.usage` | span 只记请求侧 `gen_ai.request.model`（别名），无 usage | ✅ 已实施(2026-10-16) | 解析响应顶层 `model`/`usage` 进 span |
| CJK 地板 0.6–0.7 | `JEV_REVIEW_AT=0.5`（低于 CJK 地板） | ✅ 已实施(`JEV_REVIEW_AT` 默认 0.6) | 抬到 0.6（可经 `JEV_REVIEW_AT` 覆盖） |
| Noul≈0.5 升级不硬猜（send 闸门 fail-open） | `supportSendAllowed(p)` 在 `p∈[0.5,0.9)` 放行；`p=0.5` 视为可发 | ✅ 已实施(仅 `p<0.6` 且非 null 放行) | 仅当 `p<地板` 且非 null 才放行 |
| 按风险分级阈值，非全局 | 全局 0.9/0.5 套用 4 类题（现地板抬到 0.6） | ✅ 已实施(高利害题复用抬高地板) | 高利害题（promise/send/override）用更高地板 |
| 中文校准（分桶精度 + 抽检闭环） | 文档已自陈"未用中文标注数据校准"；只有 `classifier_health` 失败率 | ❌ 缺口 | 加置信度分桶指标 + 人工抽检回流 |
| state 不可信 / 对抗偏置 | `supportSeatState` 直接塞坐席/草稿原文（8000 字截断，未净化） | ⚠️ 已知 | 文档标注：依赖 fail-open + 人在环，未剥离"指令型"文本 |
| Choice 必带 `其他` | task/route 均有"其他" | ✅ 已符合 | — |
| 一题一判 / Fan-Out 一次多发 | `classifySupportInput` 一次发 4 题 | ✅ 已符合 | — |
| Fail-open 不编造 | `supportSendAllowed(null)=false`；失败/超时/未配置均"没有结果" | ✅ 已符合（且超出官网文档） | — |
| 结果只展示不回灌 | `buildSupportLabels` 仅出标签，正文不改 | ✅ 已符合 | — |
| 计数/日期外包 | 会话条数走 `count_list_by_time` | ✅ 已符合 | — |
| 自适应超时 / 低基数 span / 共享冷却 / 额度预检 | 第 7 批已落地 | ✅ 已符合（且超出官网文档） | — |

### 7.3 待实施优化（含片段）

**① 钉版本 + 记录真实版本与用量**（P0）
- `.env.example` / `jevConfig()`：默认由 `jev-latest` 改为钉版本（如 `jev-1.13.0`，以实际可用版本为准），保留 `JEV_MODEL` 覆盖。
- `postSystemOne` 解析响应顶层 `model` / `usage`，写入 span：
  ```ts
  const resolved = (json && typeof json === "object" && (json as any).model) || cfg.model;
  const usage = (json && typeof json === "object" && (json as any).usage) || null;
  // span attrs 增加 "gen_ai.response.model": resolved, "bx.jev.input_tokens": usage?.input_tokens
  ```
  保留 `gen_ai.request.model`（请求别名）以对比漂移。

**② CJK 地板 + send 闸门 fail-open**（P0/P1）
```ts
export const JEV_ACT_AT = 0.9;
export const JEV_REVIEW_AT = Math.min(0.9, Number(process.env.JEV_REVIEW_AT || 0.6)); // CJK 地板 0.6
// send 闸门：仅当"明确不是承诺"才放行，模糊与未知一律拒（fail-open）
export function supportSendAllowed(probability: number | null): boolean {
  if (probability == null) return false;        // 无结果 → 拒
  return probability < JEV_REVIEW_AT;           // 只在低置信"不是"时放行
}
```
`draftPromiseAction` 同步用 `JEV_REVIEW_AT` 作下限（≥0.6 才 flag）。

**③ 高利害题单独抬地板**（P1）
promise/send/override 视为高利害，复用已抬到 0.6 的 `JEV_REVIEW_AT`；task/route 维持展示用途，低置信仅显示"其他/未判断"。当前已是这套区分，把地板从 0.5 抬到 0.6 即生效。

**④ 置信度分桶 + 人工抽检闭环**（P0-calibration）
- `classifier_health` 之外新增按 `confidence` 分桶（0–0.5 / 0.5–0.7 / 0.7–0.9 / 0.9–1）记录命中数与"高风险被坐席推翻"的抽检数，验证 `conf≈精度`。
- 标签 UI 留"这个标签对不对"的轻量反馈入口，回流成校准集（中文重校的最小闭环）。

**⑤ state 净化（可选，低优先）**
不剥离"指令型"文本（否则会削弱 override 检测）；仅在文档标注：state 含用户/坐席原文，对抗性"把我判成安全"类话术可能偏置，缓解靠 fail-open + 人在环。

### 7.4 结论
当前 jev 接线在**治理与 fail-open** 上已超出官网公开文档的要求；主要缺口集中在**三处可量化项**：① 模型版本未钉（用 `jev-latest`）、② 未记录真实版本与用量、③ 中文置信度未校准且 CJK 地板偏低（0.5）。这三项按 7.3 的片段补上即可与网上最佳实践对齐；其中 ①②③ 已于 2026-10-16 落到 `src/jev.ts`（见下方「实施记录」），④ 为持续性校准工作。

### 7.5 实施记录（2026-10-16）
- `jev.ts:jevConfig` 默认版本由 `jev-latest` 钉为 `jev-1.13.0`（多源印证 jev-latest 解析到 jev-1.13.0）；仍显式用别名（*-latest）时启动告警一次；base 增加 trim。
- `postSystemOne` 的 span 新增 `gen_ai.response.model` 与 `bx.jev.usage`（取自响应顶层），请求别名仍记 `gen_ai.request.model` 以便对比漂移。
- `JEV_REVIEW_AT` 默认值 `0.5 → 0.6`（CJK 地板），可经 `JEV_REVIEW_AT` 覆盖；`supportSendAllowed` 改为「仅 `p<0.6` 且非 null 才放行」（fail-open：模糊/无结果一律拒发，由坐席确认卡兜底）。
- 行为变更提醒：代发闸门以前在 `p∈[0.6,0.9)` 放行（交确认卡），现在该一带直接拒发；这是更保守的 fail-open，与网上最佳实践一致。回归见 `tests/jev-governance.test.ts`（[J] 已同步更新地板断言）。
- **连通性实测（2026-10-16）**：本实现打 TypeSafe 私有路由 `POST /v1/systemone`。① 直连 `api.typesafe.ai` 用 OpenRouter key → 401（key 不属 TypeSafe）；② 走 `openrouter.ai/api/v1/systemone`（key 有效）→ 400 schema（OpenRouter 不代理该路由，只走 `/api/v1/chat/completions` + `typesafe/jev-1.13`，另一套集成）。**结论：`.env` 指 OpenRouter 时 jev 每次调用都失败并 fail-open（标签恒「没有结果」、代发永不放行）——安全但无产出。要真正启用须 `JEV_BASE_URL=https://api.typesafe.ai` + 一个 TypeSafe API key；`jev-latest`/OpenRouter slug 分别为 `jev-1.13.0`/`typesafe/jev-1.13`。**
