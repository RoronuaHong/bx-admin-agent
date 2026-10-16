# 取数类对话「零进展 23 分钟」事故复盘与修复计划（2026-10-14）

> **定位**：单次真实事故的完整复盘 + 对标最佳实践的分步修复计划 + 评测集固化方案。
> **边界**：只讲**韧性 / 收敛 / 资源治理**。取数正确性、只读安全、SQL 口径不在本文范围（见 `docs/text2sql-text2api-plan.md` §3.2/§8）。
> **取证口径**：全部结论可回溯到 `.data/traces/runs-202610.jsonl`、`spans-<runId>.jsonl`、`rounds-<runId>.jsonl`、`logs/agent-server-dev.out-17.log`、`logs/agent-server-dev.err-17.log` 与 MongoDB `bx_agent.chat_conversations`。无法从证据得出的部分一律标注为「推断」。

---

## 0. 结论速览

一次**多指标 + 多维度 + 归因分析**的复合取数请求，从用户发出到服务端放弃共 **1423.7 秒（23 分 44 秒）**，最终**零结论**。

三个数字解释了一切：

| 数字 | 含义 |
|---|---|
| **0** | 主循环 23 轮 + 子代理 5 轮，**综合轮（交正文的那一轮）出现 0 次** |
| **48 / 7** | 48 次外部工具调用，其中 7 次失败（6 次外部查询 + 1 次元数据） |
| **627 / 600** | 最后一次事件下发后静默 627 秒，被无进展看门狗（阈值 600s）主动收口 |

**一句话根因**：候选链开场先烧掉 4 个已耗尽配额的模型 → 真正干活的模型在取数工具上反复失败 → 失败因"连续计数"判据而始终不熔断 → 上下文治理把已取到的 45 条结果卸载成句柄 → 模型用"再探查"补偿 → 预算耗尽时正好卡在一个长耗时模型调用上 → 补位收尾因"被中止"不进 → 看门狗收口，落库兜底句。

---

## 1. 事故标识与影响

| 项 | 值 |
|---|---|
| 会话 | `conv_1791953046143_la5g79` |
| run | `run_c284e83d-e327-458c-ae6c-52de5a0d8bb1`（release `7eaabc5`） |
| task | `task_ff31f9be-61c7-406c-8e5a-e80e9f2c47f3` |
| 起止 | 12:44:06 → 13:07:49（1423.7s） |
| 终态 | `status=failed`；在线评测 `poor`（未达标 `converged`、`latency`）；异常检测 `duration_spike`、`tool_novelty` |
| 用户可见 | 会话列表红点「出错了」；助手气泡为兜底句「工具已经返回结果，但没有写出结论。」 |
| 影响面 | 该请求无结论；同源配额问题导致当日其它交互请求也反复空转候选链（见 §5 P0-1/P0-3） |

> 提问原文含具体国家线、指标与归因目标，记录在 `runs-202610.jsonl` 的 `userText` 字段。本文一律泛化表述，**不复述业务口径**。

---

## 2. 时间线取证

| 时间 | 事件 | 证据 |
|---|---|---|
| 12:44:06 | 工具注入完成：`mode=eager mcp=9/9`（单个 BI 适配器，9 工具） | out-17.log:24818 |
| 12:44:11–12:44:34 | 候选 1 跑完 5 轮后报 **429 free-models-per-day**；候选 2/3/4 各报同类 429 | rounds-trace 行1-5；log:24864-24867 |
| 12:44:40 | 候选 5 接手，跑至 round 22 | rounds-trace 行6-28 |
| 12:44–12:53 | 元数据探查占绝对多数：单一元数据工具 **24 次**（含批量并发每次 3–5 个），另有取值域 5 次、卡片 2 次、看板 2 次、库列表 2 次、检索 2 次 | log:24839-25886 |
| 12:48:09 / 12:48:21 / 12:51:26 | **代码聚合通道 3 次调用全部失败**（364ms / 4560ms / 1520ms） | spans 行27/30/33 |
| 12:48–13:06 | **外部查询 10 次：4 成功 / 6 失败**（5 次快速失败 + 1 次 30002ms 超时） | log:25015-25885 |
| 12:53:06 / 12:57:22 / 13:00:48 | 模型 **3 次 180s 硬超时**，每次再触发 2 次瞬时重试 | spans 行40/48/51；log `[chat:retry]` |
| 12:55 之后 | 上下文治理把 **45 条**工具结果卸载成句柄（`offloadedDelta` 累加），无一条被裁剪清空 | rounds-trace `offloadedDelta` 列 |
| 12:57:22 | **最后一次事件下发**（此后前端完全空白） | 由看门狗 627s 反推 |
| 12:57:22–13:07:49 | 第 23 轮委派**子代理**；子代理继承同一 runId 又跑 5 轮、其中 2 次 180s 超时 | rounds-trace 行29-33；spans 行49-56 |
| 13:07:49 | **看门狗收口**：静默 627s ≥ 阈值 600s → 发 `CHAT_TASK_STALLED` + abort | err-17.log:76 |
| 13:07:49 | abort 后候选链把剩余 10 个模型各打 3 次瞬时重试，全部 0–2ms 立即中断（39 条无效 span） | log:25939-25970；spans 行57-88 |
| 13:07:49 | 客户端此时已断开 → 服务端 `persistTaskOutcome` 代落库，正文为空 + 有工具调用 → 填兜底句 | log:25971；`app.ts:558` |
| 13:07:49 | 补位收尾（`wrapUpWith`）**未触发**（条件含 `!failure`，中止使 `failure` 非空） | 全日志无 `[chat:wrap-up]` |

**调用量统计**：模型调用 74 次（成功 34 / 失败 40，其中 39 次失败发生在 abort 之后）；外部工具调用 48 次（失败 7）；内置工具 5 次（失败 3）；子代理 1 次（空转 7.5 分钟）。

---

## 3. 根因链

| 层 | 现象 | 直接原因 | 上游成因 |
|---|---|---|---|
| L1 模型供给 | 开场 4 次 429 白烧 | 每日配额型 429 的冷却窗口（6h）短于配额重置周期（UTC 日切，≤24h） | 交互式自动链把"免费模型"排在"已验证付费模型"之前 |
| L2 工具韧性 | 同一外部查询 10 次失败 6 次仍继续调 | 失败熔断按**连续**失败计数，成功一次即清零 → 交替失败永不到阈值 | 判据只覆盖"连续抖一个工具"，不覆盖"错一半成功一半" |
| L3 上下文 | 45 条结果被卸载成句柄 | 单条结果超过回灌上限即卸载，未区分"可重取的元数据"与"不可重取的聚合结论" | 治理目标是控 token，缺 recall 优先原则与句柄复读路径 |
| L4 探索效率 | 单一元数据工具 24 次 | 跨轮重复提示只认"参数完全相同"，模型每次换对象即绕过 | 判据过窄，没有"同工具调用次数"这一维度 |
| L5 收敛 | 28 轮预算从未进入综合轮 | 预算耗尽型补位只在"自然耗尽"生效；本次是"卡在长耗时调用 + 被外部中止" | 补位触发条件把"失败"与"被中止"混为一谈 |
| L6 子代理 | 子代理空转 7.5 分钟且零产出 | 回传协议只有 `ok + 摘要`，无法区分"没找到"与"没跑完"；父轮把被取消的子代理当普通失败处理 | 缺结构化 `status/coverage/errors` 契约与父轮补偿路径 |
| L7 收口 | 39 条无效 span + 用户侧 10 分钟空白 | abort 后候选链仍逐个试完；看门狗阈值与真实模型超时（180s）不匹配 | 中止信号未短路候选链；阈值由默认 300s 推导而非实测值 |
| L8 可观测 | 6 次外部查询失败**至今无法复盘原因** | `tool_result` 正文只进事件流，`span` 只存 `ok` 布尔 | 工具错误缺少结构化分类与摘要落盘 |

---

## 4. 最佳实践对标

### 4.1 Anthropic《Effective context engineering for AI agents》（2025-09-29）

原文核心：上下文是**边际收益递减的注意力预算**；长任务三选一 —— **Compaction** / **Structured note-taking** / **Sub-agent isolation**。

| 原文要点 | 我们的现状 | 判定 |
|---|---|---|
| Compaction 调优顺序：**先最大化 recall，再提升 precision**；过度压缩是主要失败模式（丢掉当时看着微小、后续决定成败的细节） | 第 8 批已落地：`governToolResults` 改按**重取代价**分级排序（① 同输入已重放过 → ② 只读可原样重放 → ③ 重放有副作用 / 多轮推导产物），同级仍从旧到新；第③类**只卸载、绝不丢弃**（落盘失败保留原文，不清成占位符）。只读判定走执行闸门同一真源（`risk.ts` 登记表），不另立名单；第 2 批 P1-4 与第 3 批 P2-2 的留痕照旧 | ✅ 第 8 批（分级依据是协议层判据，见诚实边界） |
| 压缩不能只压文本，**必须同时保存任务状态、证据、失败信息与恢复路径** | 已覆盖：失败信息进 span `error.type`/`error.description`（P2-1/P2-1 并发批补齐）、证据摘录 `wrapEvidence` + 中止也收尾（P1-4）、被卸载结果可经 `fs_read` 取回（恢复路径） | ✅ P1-4 + P2-1/P2-2 |
| Sub-agent isolation 的头号风险：**子代理失败或空结果经摘要后消失，主智能体无法区分「没找到」与「没完成」**；应结构化返回 `status(scope/method/findings/no_findings/errors/coverage/artifacts/next_steps)` | 第 3 批 P1-3 已落地 `status(success｜partial｜no_findings｜failed)` + `coverage` + `errors`，交接文本 fail-closed（状态缺失按「未完成」呈现）；`scope/method/findings/artifacts/next_steps` 未逐项结构化（仍是摘要正文） | ✅ P1-3（核心四态已覆盖） |
| 摘要为空时不要"生成更短摘要"，而应回落上一版高召回摘要 + 拼接最近原始结果 + 显式标 `unknown` | `wrapUpWith` 已覆盖「无摘要」分支（第 2 批 P1-4）：叙述为空但有证据摘录时仍执行收尾，提示要求「缺的项如实说明没取到」——相当于用「最近原始结果 + 显式交代未取到」实现同一目标；「回落上一版摘要」这一具体形态未实现（我们的摘录机制取最近原始结果，不比旧摘要） | ✅ P1-4（形态不同、目标一致，见诚实边界） |

**落点**：P1-3（子代理结构化契约）、P1-4（补位覆盖中止）、P2-2（失败信息落盘）。

### 4.2 Anthropic《Writing effective tools for agents》（2025-09-11）

原文核心：工具描述是提示词工程对象；失败要返回**可操作**的错误；区分「无法完成」与「部分完成」；默认只回高信号内容。

| 原文要点 | 我们的现状 | 判定 |
|---|---|---|
| 错误必须可操作：指出**哪个参数 / 期望格式 / 下一步怎么改 / 能否重试**；禁止只给状态码与 traceback | 外部查询超时/被拒文案已重写（第 1 批 P1-5②）：「本次没有拿到数据 + 原样重试不会更快 + 四步可操作动作（缩小范围/先量后细/加过滤/换现成查询）」，零业务词 | ✅ P1-5② |
| **区分「无法完成」与「部分完成」**，部分结果要标注，避免模型重复请求已成功的数据 | 子代理回传已有四态结构化契约（第 3 批 P1-3：`partial` 带已产出内容 + 未完成原因）；BI 单条同步查询要么拿到要么没拿到，「部分完成」不适用其形态 | ✅ P1-3（BI 侧不适用，见诚实边界） |
| 超时错误应建议**缩小范围 / 加过滤 / 分页**，并给 `retryable` | 超时文案含四步动作与重试指引（「先改查询，再重试」）；只读工具带 `idempotentHint` 注解供网关判重试安全 | ✅ P1-5② |
| 默认只回高信号字段；提供 `concise/detailed` 双模式；截断时给出 `next_cursor` + 如何继续 | 第 6 批已落地：七个元数据工具默认 concise（只回高信号字段 + 硬上限），`detail="detailed"` 给全量；截断必带「仅返回前 N 条（共 M 条）+ 怎么继续」的 note | ✅ 第 6 批 |
| **大量重复调用可能表明分页或 token 限制设置不合理；大量参数错误说明工具描述不清** | 异常检测已产出 `tool_novelty` 信号，并与「重复度」阈值联动（第 4 批 `tool_repeat_spike`）；错误率走 P1-1 的进程内熔断（不双机制） | ✅ 第 4 批补齐 |
| **用真实、多步骤、基于真实数据的评估集验证设计，而不是只依赖单元测试或简单演示** | §6 四层已落地：L0 事故快照 fixture + L1 mock SSE 驱动真实主循环（多步）+ L2 落盘断言 + L3 在线评测；「真实 BI 数据端到端 gate」按 §6.5 属独立立项 | ✅ §6（真实数据 gate 除外，见 §6.5） |

**落点**：P1-1（错误率熔断）、P1-2（同工具重复维度）、P0-1/P1-5（错误可操作化 + 流内错误解析）、§6 评测集。

### 4.3 AWS Builders Library《Timeouts, Retries, and Backoff with Jitter》

原文核心：超时限制资源占用、重试处理瞬时错误、退避+抖动降负载；**重试必须被预算约束，否则局部故障被放大成系统性过载**。

| 原文要点 | 我们的现状 | 判定 |
|---|---|---|
| 超时值按**误超时率反推**（如 0.1% 误超时 → 取 p99.9），并覆盖跨公网最坏延迟 | 第 6 批已落地：查询侧按**实测成功延迟 p95 × 2** 自适应派生（保底 `BI_TIMEOUT_MS` 默认 30s、封顶 `BI_TIMEOUT_MAX_MS` 默认 120s，只收成功样本，变化时打日志）；模型侧见 P2-3（`max(2 × 实测模型超时, 240s)`） | ✅ 第 6 批 + P2-3 |
| **用外层 deadline 约束所有下游调用及其全部重试**，重试不得每次重置 deadline | 模型侧有 `AbortSignal.timeout(timeoutMs)`；**abort 现在会短路候选链**（第 5 批 C1，事故里「切候选各重计时」的最坏形态已除）；**key 轮换自第 8 批起也从同一份 run 级预算出账**（换 key 前先 `canRetry()`，取不到即停止横向铺开） | ✅ C1 + 第 8 批 |
| **重试预算（token bucket）**：限制整个调用群体的重试总量；只设"最大次数"防不住重试风暴 | 已有运行级重试预算（第 5 批 C3）：`MODEL_RUN_RETRY_BUDGET`（默认 8）跨候选共享，瞬时重试与空回合重试都从它支出，耗尽后只失败不重试 | ✅ C3 |
| **只在调用栈的一层重试**；否则 3^5 = 243 倍放大 | abort 后候选链短路 + 轮首守卫（第 5 批 C1）：不再有「中止后逐个候选各打 3 次」的 39 条无效调用；三层（每轮重试 × 候选切换 × **key 轮换**）自第 8 批起共用同一份预算——`canRetry()` 上提到轮循环外，同一回调同时喂给 `streamCall` 与 `models.ts` 的轮换 | ✅ C1 + C3 + 第 8 批 |
| 非幂等操作必须带幂等 token，否则宁可失败也不盲目重试 | 只读查询天然幂等；写操作有确认闸 | ✅ |
| circuit breaker 有代价（模式切换、难测试、恢复慢），AWS 更倾向局部 token bucket | 已换成滑动窗口错误率（第 2 批 P1-1：窗口 + 最小样本 + 只计依赖侧失败），不再用「连续失败即熔断」 | ✅ P1-1 |

**落点**：P1-1（滑动窗口错误率 ≈ 局部限流）、P0-2（冷却/预算持久化）、P1-5。

### 4.4 OpenRouter API Guides《Limits》（免费档配额口径）

官方口径：免费档（模型 ID 带 `:free`）两层限制 —— **每分钟 20 次**、**每日 50 次**（购买 ≥10 credits 后每日 1000 次）；**每日额度按 UTC 日计算，00:00 UTC 进入新周期**；可用 `GET /api/v1/key` 的 `free_model_daily_requests.remaining` 提前查询。

| 原文要点 | 我们的现状 | 判定 |
|---|---|---|
| 每日配额型 429 **等几分钟没用**，必须等 UTC 00:00；响应通常没有有意义的 `Retry-After` | 冷却已对齐下一个 UTC 日切 + 1min 缓冲（第 1 批 P0-1），且跨重启持久化（第 3 批 P0-2） | ✅ P0-1 + P0-2 |
| 长任务开始前查剩余额度；**非紧急请求排到下一个 UTC 日** | 已有额度预检（第 5 批 C4）：排候选前查密钥额度端点（OpenRouter `/api/v1/key`，TTL 60s 缓存 + 单飞 + fail-open），无人值守 + 已耗尽 → 候选整体跳过（排到下一个 UTC 日，调度侧收 429） | ✅ C4 |
| 区分**平台限流**（分钟级，有 `X-RateLimit-*`/`Retry-After`，退避即可）与**每日配额**（小时级） | 三类已分层：每日配额型 → UTC 日切（P0-1）；plain 429 → 分钟级短冷却档（第 5 批 C2，默认 90s 可调）；402/未开通 → 小时级。第三类「上游 provider 限流」与平台限流同为 plain 429，按分钟级处理（见诚实边界） | ✅ C2 + P0-1 |
| **流式响应开始后才发现限流，会以 SSE `error` 对象 + `finish_reason: "error"` 返回** | `models.ts` 已识别 `chunk.error` 与 `finish_reason:"error"`（第 1 批 P1-5①，Anthropic 分支认 `event.type==="error"`），归一化为 `model http 429: …` 进既有冷却/候选逻辑 | ✅ P1-5① |
| 避免额度接近耗尽时启动无法在当日完成的长任务 | 预检覆盖（第 5 批 C4）：无人值守运行在额度已耗尽时整体跳过并如实上报，不会再把预算烧在必然失败的候选上；「接近耗尽但未归零」的提前止步未做（端点只给精确剩余数，不做预测） | ✅ C4（预测性止步除外，见诚实边界） |

**落点**：P0-1（冷却对齐 UTC 日切）、P0-3（额度预算与分工）、P1-5（SSE 流内错误解析）、P2-2。

### 4.5 与既有文档的衔接

| 既有文档 | 关系 |
|---|---|
| `docs/text2sql-text2api-plan.md` §3.2「语句超时 默认 30s」 | **已记录但结论需修订**：它证明"外部调用必须有界"，未回答"超时后模型该怎么办 / 反复失败要不要摘除"。本文 §5 P1-5/P1-1 补上这一半，§3 那行应加指向本文的指针 |
| 同上 §8「已知缺口」（无行级权限、无 few-shot 池、看似对实则错） | 不重叠，本文不重复安全与口径议题 |
| `docs/BEST_PRACTICE_ALIGNMENT.md` | §9 实例可增补本例（一条真实轨迹同时命中 LLM02/ASI02/ASI08/ASI09 四类） |
| `docs/agent/PRODUCTION_READINESS.md` | 「评测」维度需补"真实回归集缺位"，见 §6 |

---

## 5. 分步修复计划

> 排序依据「止损速度 × 改动面」。每步给出**验收方式**与**回滚开关**；未验收不进入下一步。
> 全部改动遵守 `docs/agent/AGENT_CHARTER.md`：零业务词、语义判定交模型、失败时诚实降级。

### P0 · 止血（配置与小函数，风险低，可当天完成）

| 编号 | 现状 | 目标 | 改动位置 | 验收 | 回滚 |
|---|---|---|---|---|---|
| **P0-1** | 每日配额型 429 冷却 6h | 冷却到**下一个 UTC 00:00 + 1min** | `chat.ts` 新增纯函数 `dailyQuotaCooldownMs(now)`；`modelDownCooldownMs` 分流 `isDailyQuotaFailure` | 单测：给定 12:44 时刻 → 冷却至次日 00:01；18:44 不再重打 | env `MODEL_DAILY_QUOTA_COOLDOWN_MS` |
| **P0-2** | 冷却表是进程内 `Map`，重启即清空 | 冷却状态落盘（TTL 自愈、best-effort，参照 `task-store.ts` 降级口径） | `chat.ts` + 新增 `model-cooldown.ts` | 重启后首个会话**不再**出现已死模型的 429 | env `MODEL_COOLDOWN_PERSIST=off` |
| **P0-3** | 交互式自动链"免费优先"，已验证付费模型在链尾 | 交互式默认**稳定优先**，免费作兜底；定时任务反向（用免费额度） | `orderModelCandidates` 加 `stableFirst` 分支 + 开关 | 扩 `model-fallback.test.ts`：离线断言排序；线上同题重跑，开场 429 数 4 → 0 | env `MODEL_AUTO_STABLE_FIRST=off` |

> P0-3 需要一个"稳定性"数据源，最小实现读 `.data/eval/` 近 N 次 `stability` 判定；**不引入**新的持久化。

### P1 · 韧性（代码改动，中风险，需回归）

| 编号 | 现状 | 目标 | 改动位置 | 验收 |
|---|---|---|---|---|
| **P1-1** | 失败熔断按连续失败计数，成功即清零 | 改为**滑动窗口错误率**（最近 6 次执行、样本 ≥3、错误率 ≥0.5 摘除）+ 保留"连续 ≥3 立即摘除"快路径；摘除时给模型"换工具/换路径/先给结论"三选一提示 | `chat.ts` `failedTools` → `toolHealth`（窗口结构） | 新单测：交替失败序列必须摘除；全成功不摘除；错误率回落需显式解除 |
| **P1-2** | 跨轮重复提示只认参数全等 | 增加「同工具单轮 >4 次」与「整轮累计 >12 次」两个维度，触发同一条提示语 | `chat.ts` 计数 + `repeatCallHint` 扩展 | 新单测 + 本次 trace 回放应能触发 |
| **P1-3** | 子代理回传仅 `ok + 摘要` | `SubagentResult` 增 `status: success｜partial｜no_findings｜failed` + `coverage` + `errors`；被中止时 `status=failed` 且**不计入父轮证据**；父轮据此续跑或如实收束 | `chat.ts` `runSubagent` / `runLoop` task 分支 | 新单测：子代理空结果/失败 → 父轮不得当结论；父轮收到 `failed` 后必须给用户一句如实交代 |
| **P1-4** | 补位收尾条件含 `!failure` | 区分「模型失败」与「外部中止」：后者若已有证据，仍执行一次**带独立短 deadline（≤20s）、忽略已中止 signal** 的收尾，产出「已取到什么 + 还缺什么」 | `chat.ts` `wrapUpWith` 调用条件 | 扩 `wrap-up-cap.test.ts`：中止后仍补位，且不因 signal 已中止而失败 |
| **P1-5** | SSE 解析不认流内错误；超时/失败文案只给运维不给模型 | ① 解析层识别 `chunk.error` 与 `finish_reason === "error"`，归一化为 `model http 429: …` 进入现有冷却/候选逻辑；② 工具失败文案补「模型侧下一步」（缩小范围/加过滤/分页/先取摘要再取明细）与 `retryable` | `models.ts` SSE 解析；`scripts/metabase-mcp.mjs` 错误文案 | 新单测：mock SSE 中途发 error 帧 → `outcome.failure` 含 429 且 `isModelDownFailure` 为真；超时文案含可操作建议 |

### P2 · 可观测与评测

| 编号 | 现状 | 目标 | 改动位置 | 验收 |
|---|---|---|---|---|
| **P2-1** | 工具错误只有 `ok` 布尔 | span 增 `errorKind`（`timeout｜denied｜upstream｜schema｜aborted`）+ 打码后的错误摘要（≤200 字） | `chat.ts` span 埋点、`redact.ts` 复用 | 单测：各错误类别打点正确；凭据形态被打码 |
| **P2-2** | 七维在线打分无"工具健康 / 综合轮 / 停滞 / 效率" | 增四维：`tool_health`（工具错误率）、`synthesis`（有工具调用但零综合轮）、`stall`（是否被看门狗收口）、`efficiency`（同工具重复度）；阈值全部走 env | `eval-online.ts` | **拿本次 run 回放应得 `poor` 且 `failed` 含 `tool_health`/`synthesis`/`stall`**（单测固定该判定） |
| **P2-3** | 看门狗阈值由默认 300s 推导，与实测 180s 不匹配 | 阈值 = `max(2 × 实测模型超时, 240s)`，并在启动日志打印推导依据 | `chat-tasks.ts` `STALL_MS` | 单测 + 启动日志可见 |

> P1-5 ② 的文案必须**零业务词**（禁止举真实字段/库名举例），只说「缩小时间范围 / 增加过滤 / 先取摘要再取明细」这类通用动作。

### 建议执行顺序

```
第 1 批（当天）  P0-1  P0-3  P1-5      ← 已实施（2026-10-14，见下）
第 2 批（本周）  P1-1  P1-2  P1-4  P2-1   ← 已实施（2026-10-14，见下）
第 3 批（下周）  P1-3  P0-2  P2-2  P2-3  §6 评测集 ← 已实施（2026-10-14，见下）
第 4 批（收尾）  §7 埋点缺口（task span / 轮级 mode）  §4.2 重复度门禁  L2 离线断言 ← 已实施（2026-10-14，见下）
第 5 批（候选链与重试治理）  C1 abort 短路  C2 限流三分层  C3 重试预算  C4 额度预检 ← 已实施（2026-10-14，见下）
第 6 批（工具人机工效）  concise/detailed 双模式  查询超时按实测派生  §4.5 文档指针 ← 已实施（2026-10-14，见下）
第 7 批（Jev 纳入统一治理）  超时按实测派生  冷却/限流分层  额度预检  llm span  classifier_健康度 ← 已实施（2026-10-14，见下方第 7 批实施记录与 support-jev-plan.md 治理段）
第 8 批（收尾两项）  上下文卸载 recall 优先  key 轮换纳入运行级预算 ← 已实施（2026-10-14，见下）
第 9 批（真实端到端复跑）  §5 四项验收  适配器启动即崩修复  解析门禁 ← 已实施（2026-10-15，见下）
第 10 批（探索效率 L4）  重复提醒跨轮阶梯化  可选运行级重复上限 ← 已实施（2026-10-15，见下）
第 11 批（上下文治理对齐 Micro-compact）  keep 硬下限显式化  [chat:compact] 可观测  （窗口收窄闸门刻意不采用） ← 已实施（2026-10-15，见下）
```

> 第 7 批的动因：本仓自建的两个「非对话模型调用方」（BI 查询适配器、客服分类器 Jev）都曾各写一套
> 超时/失败处置，于是第 5、6 批建立的治理只覆盖了对话模型这一条路。Jev 走 OpenRouter 时吃同一份额额、
> 却完全不受预检与限流分层保护——这类「同一个治理体系里有两个例外」正是事故里「查不出原因」的常见来源。
>
> 第 8 批的动因：第 6 批收尾时诚实标注了两处「改法已清楚、收益依赖真实轨迹复跑」的遗留——上下文卸载
> 的优先级（§4.1 第 1 行）与 key 轮换这层独立重试（§4.3 第 2/4 行）。它们正好是本文最后两条 ⚠️：
> 前者决定「45 条结果被卸成句柄后，模型还能不能靠留下来的东西收束」，后者决定「N 个 key × 每层重试」
> 的乘积会不会重现事故里 39 条无效调用那种放大。两项都收口后，§4 的对标表里不再有 ⚠️。

第 1 批完成后**用同一问题端到端复跑一次**（真实 BI），验收口径：开场 429 为 0、工具错误 ≤2 次、出现 ≥1 次综合轮、总耗时 < 300s。

### 第 1 批实施记录（2026-10-14）

| 项 | 落地位置 | 回归 |
|---|---|---|
| P0-1 | `chat.ts` 新增纯函数 `dailyQuotaCooldownMs(now, override)`；`modelDownCooldownMs` 按 `isDailyQuotaFailure` 分流；冷却日志带原因与时长 | `tests/daily-quota-cooldown.test.ts`（6 例：日切终点 / 临近日切不归零 / 恰好日切 / env 覆盖 / 分流不影响 402 与 500 / 每分钟限流不进日切） |
| P0-3 | 新增 `src/model-health.ts`（只读 `.data/eval` 的 `stability` 维度，纯函数三档 + 60s 缓存 + best-effort）；`orderModelCandidates` 新增第 7 参 `health`（**默认 null = 行为逐字节不变**，故既有单测零改动）；`chatStream` 仅在「自动模式 + 开关开」时传入；新增 5 分钟节流的分档日志 | `tests/model-health.test.ts`（6 例：聚合只认 stability / 窗口只取最近 N 条 / 分档中性规则 / 稳定重排 / 无数据不排序 / 开关回滚） |
| P1-5① | `models.ts` 新增纯函数 `normalizeInlineStreamError`；OpenAI SSE 循环识别 `error` 对象与 `finish_reason:"error"`；Anthropic 分支识别 `event.type==="error"`（overloaded→503，其余→502） | `tests/sse-inline-error.test.ts`（3 例：三类形态归一化 + 正常帧不误判 / 归一化后被判模型级失败且命中每日配额 / 端到端 mock SSE 切候选并出结论） |
| P1-5② | `scripts/metabase-mcp.mjs`：超时文案改为「本次没有拿到数据 + 原样重试不会更快 + 四步可操作动作」；上游拒绝文案加排查顺序 | `tests/sql-readonly-consistency.test.ts` 追加 3 例（文案含关键动作 / 拒绝分支有排查顺序 / 不再把 `BI_*` 运维变量当唯一指引） |

**新增环境变量（均带默认，不配即现状）**：
`MODEL_DAILY_QUOTA_COOLDOWN_MS`（配额型冷却毫秒数，不配=到下一个 UTC 日切+1min）·
`MODEL_AUTO_STABLE_FIRST=off`（关掉健康度重排）·
`MODEL_HEALTH_WINDOW`（默认 50）· `MODEL_HEALTH_MIN_SAMPLES`（默认 3）· `MODEL_HEALTH_FAIL_RATE`（默认 0.5）· `MODEL_HEALTH_CACHE_MS`（默认 60000）。

**验证**：`tsc --noEmit` 0 错误；全量 **84 文件 / 558 用例全绿**（较实施前 +3 文件 / +18 例，无回归）。

**诚实边界**：P0-3 只解决「长期不稳的模型排在开场」。它**不解决**配额突然耗尽——评测记录里的 `model` 是该轮实际服务模型，「某模型作为第一个候选被打死」不留痕，且配额是当天突然发生的（见 `src/model-health.ts` 顶部边界说明）。那部分由 P0-1 的探测 + 冷却兜底，跨进程重启后的重打由 P0-2（未做）解决。

### 第 2 批实施记录（2026-10-14）

> **研究先行的两个关键修正**（动手前对齐了 Fowler《Circuit Breaker》、OTel recording-errors、Anthropic《Building Effective Agents》三份权威原文）：
> 1. Fowler 明确「按异常类型设置不同策略：客户端参数错误 / 服务端业务拒绝**通常不应**触发熔断」——本次事故的 6 次失败性质是「查询语义被拒」，若不分类就熔断会把健康工具误摘除。故 **P2-1（错误分类）必须先于 P1-1（熔断）**，实施顺序与最初计划一致但未颠倒。
> 2. OTel 规范：`error.type` 必须是**低基数稳定分类值**，禁止把消息文本塞进去（会炸基数 + 泄露）。原计划的「自创字段名 + 200 字摘要」据此改为官方 `error.type` + `error.description`（脱敏截断）。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **P2-1** 工具错误分类 + span | OTel `error.type` 低基数；Fowler「按异常类型分策略」 | 新增 `src/tool-failure.ts`：`ToolErrorKind` 六类（`upstream`/`timeout`/`denied`/`schema`/`aborted`/`other`）+ 纯函数 `classifyToolFailure`（结构优先于文本）；`chat.ts` 工具 span 补 `error.type`（失败且无分类时不写，符合「已被正常处理的错误不应记录」）+ `error.description`（脱敏截断）；**并发批此前完全没 span（本次 53 次调用只 17 条 span 即因此），已补齐并加 `gen_ai.tool.concurrent` 标记** | `tests/tool-failure-window.test.ts` 含静态断言：`error.type`/`error.description` 字段名钉死、并发批有 span（10 例覆盖分类与窗口，外加该静态断言） |
| **P1-1** 熔断改滑动窗口错误率 | Fowler「一次成功就清零过于乐观」「比率必须配最小样本数」 | `src/tool-failure.ts` 新增 `ToolHealthWindow`（环形缓冲；`failRate + minSamples` 慢路径 + `consecutive` 快路径）；`failedTools` Map 替换为该实例；`classifyToolFailure` 结果驱动记账；`TOOL_FAILURE_LIMIT` 降为连续阈值 | 同上 `tests/tool-failure-window.test.ts`（交替失败 3/6 必须熔断 / 成功不洗白 / 样本不足不算 / 非依赖侧不进分母 / 连续快路径 / lastKind 人话） |
| **P1-2** 同工具重复维度 | AWS 重试预算（占比而非绝对次数）；Fowler 比率配最小样本数；Anthropic「重复调用是信号」 | 新增 `src/repeat-budget.ts`：`repeatBudgetNotice`（单轮次数上限 + 累计占比上限，只提示不硬拦）；`chat.ts` 按工具名累计 + 轮末判据回灌（每工具只提示一次） | `tests/repeat-budget.test.ts`（6 例：单轮超限 / 占比超限 / 样本不足不误判 / 均匀不提示 / 阈值可注入 / 24 次换参数探查必触发） |
| **P1-4** 中止时受控收尾 | Anthropic「达到预算/时间上限 → 返回当前最佳结果并说明未完成」 | `wrapUpWith` 新增 `abortedRun` 选项：中止时用**独立 deadline**（`WRAP_UP_ON_ABORT_DEADLINE_MS` 默认 25s）替代已死的 signal，并换用如实说明中止原因的提示；循环后补位条件扩到「中止且有证据」分支 | `tests/wrap-up-abort.test.ts`（端到端：取到证据后被中止 → 用独立 deadline 补一次收尾、final 含中止结论、**不再**落通用兜底句） |

**修复的一个真实缺陷**（测试抓到）：`chatStream` 失败分支在 `signal?.aborted` 时不 `yield` 正文——即使 `wrapUpWith` 已产出中止收尾文本，也会被丢弃，前端只看到空屏。已改为该分支也 `yield` 正文（用户主动「停止」时任务已 `finishTask`，事件被 status 守卫丢弃，无副作用）。

**新增环境变量（均带默认，不配即现状）**：
`MCP_TOOL_FAILURE_WINDOW`（默认 6）· `MCP_TOOL_FAILURE_MIN_SAMPLES`（默认 3）· `MCP_TOOL_FAILURE_RATE`（默认 0.5）· `MCP_TOOL_REPEAT_PER_ROUND`（默认 4）· `MCP_TOOL_REPEAT_SHARE`（默认 0.4）· `WRAP_UP_ON_ABORT_DEADLINE_MS`（默认 25000）。

**验证**：`tsc --noEmit` 0 错误；全量 **87 文件 / 577 用例全绿**（较第 1 批后 +3 文件 / +19 例，无回归）。

**诚实边界**：
- P1-1 的熔断**只计入 `upstream`/`timeout`**（依赖侧真问题）。闸门拒绝 `denied`、参数语义错 `schema`、被中止 `aborted`、未知 `other` 都不计入——这是 Fowler 的明确要求，但也意味着「模型反复用错误参数打同一个工具」不会触发熔断（那类由 P1-2 的重复预算提示 + 既有 Doom Loop 同签名硬拦覆盖）。
- 本次事故 6 次 `run_native_query` 失败若多为 `schema`（语义被拒）而非 `upstream/timeout`，则**仍不会熔断**——因为按 Fowler 那本就不该熔断，正确做法是 P1-5② 的可操作文案 + 模型换路径。这是设计取舍，不是遗漏。
- P2-1 只补了 `error.type` 落盘与并发批 span；要从 `error.type` 反推「哪一步失败」仍需配合第 3 批 P2-2（评测扩维）与可观测页面。

### 第 3 批实施记录（2026-10-14）

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **P1-3** 子代理结构化契约 | Anthropic 子代理隔离的结构化返回（status/coverage/errors） | `chat.ts`：`SubagentResult` 增 `status: success｜partial｜no_findings｜failed` + `coverage` + `errors`（纯函数 `subagentHandoffText` 生成交接文本，fail-closed：状态缺失/越界按「未完成」呈现）；失败但已产出内容 → `partial`（旧实现把已产出的内容整个丢掉）；父轮**只有 `success` 计入接地证据**（`no_findings`/`failed` 不得当结论），句柄摘要按状态分流 | `tests/subagent-status-contract.test.ts`（4 例：四种状态交接文本 / fail-closed / servers 不可用 → 结构化 failed 且不计证据 / 零发现 → `no_findings` 且不计证据——以 `[chat:integrate]` 不打点证明） |
| **P0-2** 冷却状态持久化 | 本仓 `task-store.ts` 成熟范式直接复用 | 新增 `src/model-cooldown.ts`（Mongo `model_cooldowns` 集合 + `expiresAt` TTL 索引 + 内存降级 + best-effort，同任务留档口径）；`chat.ts` 冷却写入时 fire-and-forget 落盘、新增 `restoreModelCooldowns()` 启动恢复（读路径 `orderModelCandidates` 零改动）；`index.ts` 启动接线；回滚 `MODEL_COOLDOWN_PERSIST=off` | `tests/model-cooldown.test.ts`（5 例：读写回 / 过期失效 / 同模型取更晚 until / 开关静默 / 状态码随条目保留） |
| **P2-2** 在线评测扩四维 | OTel 低基数 + 「判不了的就不判」 | `trace.ts` `RunTrace` 增 `toolFailures`/`synthesisRounds`/`toolRepeatMax`/`stalled`；`shared` usage 事件增前三项（`stalled` 由 `app.ts` 从看门狗 error 码识别）；`chat.ts` 埋点（真实执行失败 / 综合轮四处收束路径 + 补位收尾 / 同工具重复峰值，跨候选累加）；`eval-online.ts` 增 `tool_health`/`synthesis`/`stall`/`efficiency` 四维，阈值 `EVAL_MAX_TOOL_FAIL_RATE`(0.2)/`EVAL_MAX_TOOL_REPEAT`(8) 等全走 env，**缺字段不计入分母** | `tests/eval-online.test.ts` 扩 8 例：**事故轨迹回放固定判 `poor` 且 `failed` 含 `tool_health`/`synthesis`/`stall`/`efficiency`**；健康运行不误伤；零工具运行不判；边界与 env 阈值 |
| **P2-3** 看门狗阈值按实测派生 | AWS「超时值按实测分位数反推」 | `chat-tasks.ts`：`deriveStallMs()` 纯函数 = `max(2 × 实测模型超时, 240s)`（实测值取注册表最大 `timeoutMs`——旧口径在本文件读了一个与 `config.ts` 不同的 300s 默认，真实部署每模型 180s，推出 600s 与实测不匹配）；env `CHAT_TASK_STALL_MS` 覆盖优先；`stallThresholdInfo()` + 启动日志打印推导依据 | `tests/stall-threshold.test.ts`（6 例：180s→360s / 下限兜底 / env 覆盖与 60s 绝对下限 / 读不到实测值不产出 NaN / 启动信息自洽 / 判据不变） |

**新增环境变量（均带默认，不配即现状）**：
`MODEL_COOLDOWN_PERSIST`（默认 on，`off` 回滚到进程内 Map）·
`EVAL_MAX_TOOL_FAIL_RATE`（默认 0.2）· `EVAL_MAX_TOOL_REPEAT`（默认 8）·
`CHAT_TASK_STALL_FLOOR_MS`（默认 240000，看门狗阈值下限）。

**验证**：`tsc --noEmit` 0 错误；全量 **90 文件 / 599 用例全绿**（较第 2 批后 +4 文件 / +33 例，无回归——含第 1、2 批全部用例）。

**诚实边界**：
- P0-2 持久化的只是「这个模型短时间不会自己好」这一**状态**，不重放任何调用；恢复发生在启动后（`initModelCooldown().then(...)`），与首个请求存在竞态——窗口内的第一个请求可能仍会打到已冷却的模型（best-effort 语义，与任务留档同口径）。
- P2-2 的 `tool_health` 只计**真实执行**的失败：闸门拒绝 / 同轮跳过 / 熔断摘除都不进分母（它们各有计数与提示），混在一起会让「工具坏了」与「没让工具跑」分不开。
- P2-2 的 `synthesis` 把补位收尾（`wrapUpWith`）产出的结论也计为综合轮——靠补位救回来的运行确实写出了答案，不该在收敛质量上被记零。
- P2-3 的实测值取**注册表最大值**：某个模型配更长超时时阈值跟着涨（不误杀），代价是阈值按最慢模型定（保守方向）。
- 第 3 批**未做真实端到端复跑**（需要真实 BI 与额度恢复窗口）；本批验收以单测固定判定 + 全量回归为准，复跑口径见 §5 第 1 批末段。

### 第 4 批实施记录（2026-10-14，收尾：可观测缺口 + L2 断言 + 基线检测）

> 动手前对齐（用户要求「按最佳实践对齐后再改动」）：
> ① OTel GenAI 语义约定「每次工具执行都应有 span」——§7 明示「父轮 `task` 调用没有 span」，
>    子代理空转 7.5 分钟在 span 层不可见；子代理结构化状态（P1-3）作为**低基数** attr 落盘，
>    与 P2-1 已确立的 `error.type`/`error.description` 同口径，可直接聚合「多少委派是空转/失败」。
> ② 轮级 `mode` 让「综合轮出现 0 次」可数——`RoundTrace.mode` 类型一直声明 `synthesis` 却从未
>    写过（综合轮 `break` 直接跳出轮级循环，绕过轮末埋点），这是 L2 断言的前提。
> ③ Anthropic「重复调用是设计信号」+ §4.2 的 🟡「有信号无门禁」——由「只报不管」的基线检测补
>    `tool_repeat_spike`；**错误率刻意不进异常检测**：它的正确机制是 P1-1 的进程内滑动窗口熔断
>    （已接线），双机制只会各自误报。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **task span 埋点**（§7 第 3 行） | OTel GenAI：每次工具执行都该有 span；低基数 error.type | `chat.ts` task 分支：一次委派一行 tool span（墙钟时间 + `gen_ai.tool.subagent.status` 四值 + `gen_ai.tool.subagent.calls`；失败带 `error.type`/`error.description`），并补 `bx_agent_tool_calls_total`/`bx_agent_tool_duration_ms` 指标（此前 task 调用从不进指标） | `tests/round-trace.test.ts` L2②/L2③：成功委派 span ok=true 且无 `error.*`；失败委派 ok=false 且带 `error.type`/`error.description` |
| **轮级 mode=synthesis** | 事故核心数字「综合轮 0 次」必须可数；压缩/留痕须保存任务状态 | `chat.ts`：轮末埋点提成 `traceRound()` 闭包，综合轮 4 个出口（接地放行×2 / 诚实兜底 / 正常收尾）break 前均落一行；**顺带修了一个潜在缺陷**：per-round 状态（`roundExecuted`/`executedSigs`）的重置原在工具路径里，综合轮 break 会跳过它——下一轮 mode 误判、同参调用被误判「本轮已执行过」而跳过，重置移到轮首 | `tests/round-trace.test.ts` L2①：直接收束的运行落 `mode=synthesis`；L2②：父轮 tool 行 + 收束 synthesis 行 |
| **anomaly tool_repeat_spike**（§4.2 🟡 → ✅） | Anthropic「重复调用是设计信号」；比率配绝对增量下限（同 rounds_spike） | `anomaly.ts`：`RunSample`/`OwnerBaseline` 增 `toolRepeatMax` 维（只收集用过工具的 run，缺字段不判、不稀释中位数）；`observeRun` 从 `RunTrace.toolRepeatMax`（P2-2 已埋）透传 | `tests/anomaly-memory.test.ts` +3 例：突增被抓 / 持平不判 / 缺字段不判 + observeRun 端到端 |

**验证**：`tsc --noEmit` 0 错误；全量 **90 文件 / 604 用例全绿**（较第 3 批后 +0 文件 / +5 例，无回归——含 deep-agent-live、cross-round-repeat 等走真实工具循环的用例）。

**诚实边界**：
- task span 的墙钟时间对**并发批**是近似值（批内各子代理并行，共用批次起点）——它回答「这批委派花了多久」，不回答单个子代理的精确耗时；单个子代理内部的 llm/tool span 已按各自时刻落盘（与父轮共用 runId）。
- `rounds-<runId>.jsonl` 里父子轮次混排（子代理与父轮共用 runId，与 §2 时间线记录一致）：数「父轮综合轮」时要按最后一行/轮次推进方向读，L2 断言已按此写法固定。
- 被接地护栏作废的轮次（`continue` 路径）仍不落轮迹——它的模型调用有 llm span 留痕；刻意不每轮都写，避免把「作废重试」的噪音混进轮级形态。
- 第 4 批同样**未做真实端到端复跑**；复跑口径见 §5 第 1 批末段。

### 第 5 批实施记录（2026-10-14，候选链与重试治理）

> 动手前对齐（用户要求「按最佳实践对齐后再改动」）：AWS《Timeouts, Retries, and Backoff with Jitter》
> 「重试预算限制整个调用群体的总量；只在调用栈的一层重试，否则局部故障被放大成系统性过载」+
> OpenRouter《Limits》「长任务开始前查剩余额度；非紧急请求排到下一个 UTC 日；平台限流与每日配额
> 恢复时间差一个数量级」。四项分别对着 §4.3 第 3/4 行与 §4.4 第 2/3/5 行。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **C1 abort 短路候选链** | AWS「重试不得把局部故障放大」；事故 L7（abort 后 39 条 0-2ms 无效调用） | `chat.ts`：候选循环顶部 `signal.aborted → break`（不再尝试剩余候选）；轮级循环顶部同判据（不再发起模型调用，消除无效 llm span）。补位收尾（P1-4）不受影响 | `tests/abort-candidate-shortcircuit.test.ts`：mockb 零调用、mocka 仅 2 次请求（工具轮 + 补位收尾）、llm span 恰 1 条、结论仍交付 |
| **C2 限流三分层** | OpenRouter「平台限流（分钟级）与每日配额（小时级）恢复时间不同」 | `chat.ts`：`modelDownCooldownMs` 新增 plain 429 → 短冷却档（`rateLimitCooldownMs()`，默认 90s、下限 5s、调用时读 env）；`isModelDownFailure` 纳入 429（进冷却表、切候选） | `tests/daily-quota-cooldown.test.ts` 改 1 例 + 新增 env 覆盖例；`tests/model-fallback.test.ts` 既有例同步更新口径 |
| **C3 运行级重试预算** | AWS「重试预算（token bucket）：限制整个调用群体的重试总量」 | `chat.ts`：`runRetryBudget()`（`MODEL_RUN_RETRY_BUDGET` 默认 8，调用时读 env）；`LoopContext.retryBudget` 跨候选共享；瞬时重试与空回合重试都从它支出，耗尽后只失败不重试（每轮至多一条告警日志） | `tests/model-retry-budget.test.ts`：预算=1 时 mocka 重试 1 次、mockb 零重试；预算=8 时两候选各满 3 次（不收紧正常路径） |
| **C4 额度预检** | OpenRouter「长任务开始前查剩余额度；非紧急请求排到下一个 UTC 日」 | 新增 `src/model-quota.ts`：`GET {origin}/api/v1/key`（形状 `data.free_model_daily_requests.{used,limit,remaining}`，2026-10-14 对真实端点实测）；按密钥聚合 + 60s TTL 缓存 + 单飞 + 3s 超时 + fail-open；`chat.ts` 排候选前调用，耗尽者按「每日配额型」冷却到 UTC 日切（无人值守整体跳过、交互式排到队尾、状态码上报全部复用既有链路） | `tests/model-quota-preflight.test.ts` 6 例：解析纯函数（limit 缺失不判）/ 无人值守跳过且零模型调用且 modelStatus=429 / 交互式 fail-open / 端点 404 fail-open / 按密钥聚合 |

**新增环境变量（均带默认，不配即现状）**：
`MODEL_RATE_LIMIT_COOLDOWN_MS`（默认 90000，plain 429 短冷却档）·
`MODEL_RUN_RETRY_BUDGET`（默认 8，运行级重试总量）·
`MODEL_QUOTA_PREFLIGHT`（默认 on，`off` 回滚）· `MODEL_QUOTA_PREFLIGHT_HOSTS`（默认 `openrouter.ai`）·
`MODEL_QUOTA_PREFLIGHT_CACHE_MS`（默认 60000）· `MODEL_QUOTA_PREFLIGHT_TIMEOUT_MS`（默认 3000）。

**验证**：`tsc --noEmit` 0 错误；全量 **93 文件 / 614 用例全绿**（较第 4 批后 +3 文件 / +10 例，无回归）。

**诚实边界**：
- C4 只对声明了额度端点契约的提供商生效（默认 OpenRouter——唯一实测过 `/api/v1/key` 形状的）；其它提供商要么加 `MODEL_QUOTA_PREFLIGHT_HOSTS`（且其端点形状一致），要么保持关闭。**当前这台开发机的 OpenRouter key 当日免费额度已耗尽**（实测 used 54 / limit 50）：本批上线后，自动模式的候选链会直接跳过这些模型（TokenHub 模型不受影响）——这是修复的预期行为，不是回归。
- C4 不做「接近耗尽就提前止步」的预测（端点只给精确剩余数）；`limit` 缺失时绝不判耗尽（防字段变更误杀健康模型）。
- C2 把「上游 provider 限流」与「平台分钟级限流」都按 plain 429 的短档处理——两者在没有提供商专属头部可读时无法可靠区分（文档 §4.4 的第三类）；短档对两者都是改进（旧行为是不冷却）。
- C3 的预算只管 `chat.ts` 的两层重试（每轮瞬时重试、空回合重试）与候选切换的放大；`models.ts` 的 key 轮换是第三层，未纳入预算（多 key 池的轮换有独立的 429/5xx 判据），以其为对象的预算属独立改动。
- C1 之后 abort 仍可能产生**至多 1 个候选**的收尾调用（补位收尾，P1-4 的既定行为）——那是交付已取到结论的最后机会，不是无效重试。
- 本批同样**未做真实端到端复跑**（需要真实 BI 与额度恢复窗口）；复跑口径见 §5 第 1 批末段。

### 第 6 批实施记录（2026-10-14，工具人机工效 + 文档收口）

> 动手前对齐：Anthropic《Writing effective tools for agents》「默认只回高信号字段；提供 concise/detailed
> 双模式；截断时给出 next_cursor + 如何继续」+ AWS《Timeouts, Retries, and Backoff with Jitter》「超时值按
> 误超时率反推」。两项分别对应 §4.2 第 4 行与 §4.3 第 1 行——**本文最后两条未清零的对标项**。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **concise/detailed 双模式** | Anthropic「默认只回高信号字段 + 双模式 + 截断给 next_cursor」 | 新增 `scripts/metabase-concise.mjs`（纯函数 `detailMode` / `projectRows` + 共用说明句 `DETAIL_HINT`）；`scripts/metabase-mcp.mjs` 七个元数据工具（`list_databases` / `get_database_schema` / `get_field_values` / `list_cards` / `list_dashboards` / `get_dashboard` / `get_card`）默认 concise：只回高信号字段 + 硬上限，截断必带「仅返回前 N 条（共 M 条）+ 怎么继续」的 note；`detail="detailed"` 给全量 | `tests/bi-tool-ergonomics.test.ts` [A][B][C]（投影语义）+ [G]（七工具 schema/描述静态断言，防「加了参数没接线」）+ [J]（说明句一处定义） |
| **查询超时按实测派生** | AWS「超时值按误超时率反推」 | 新增 `scripts/metabase-query-timeout.mjs`（`deriveQueryTimeoutMs` 纯函数 + `QueryLatencyWindow` 环形缓冲）；适配器按 `max(p95×2, BI_TIMEOUT_MS)`、`≤ BI_TIMEOUT_MAX_MS` 派生，**只收成功样本**（超时的真实耗时未知会污染分布），派生值变化时 stderr 打一行；模型可见的超时文案用**生效值**而非配置常量 | `tests/bi-tool-ergonomics.test.ts` [D][E][F]（样本不足回落 / p95×2 派生 / 离群值不影响 / 封顶生效 / 窗口淘汰）+ [H][I]（共享模块不内联第二份、采样口径静态断言） |
| **§4.5 文档指针** | — | `docs/text2sql-text2api-plan.md` §3.2 已有指针（早前随 P1-5② 补）；本批补 `docs/BEST_PRACTICE_ALIGNMENT.md` §9.17 实例十四（一条真实轨迹命中 LLM02/ASI02/ASI08/ASI09 四类 + 两个「靠运气没暴露」的盲区）与 `docs/agent/PRODUCTION_READINESS.md` §2.4（真实回归集缺位已由 §6 四层收口） | 文档改动，无代码影响 |

**新增环境变量（均带默认，不配即现状）**：`BI_TIMEOUT_MAX_MS`（默认 120000，自适应上限）· `BI_LATENCY_WINDOW`（默认 50，成功延迟样本数）。

**验证**：`tsc --noEmit` 0 错误；全量 **94 文件 / 624 用例全绿**（较第 5 批后 +1 文件 / +10 例，无回归）。

**诚实边界**：
- concise 默认改变了**元数据工具的默认输出形状**（如 `list_cards` concise 只给 id/name、`get_card` concise 不编译也不回 SQL）。这是刻意取舍（认路阶段不需要明细），但**依赖旧形状的既有提示词/用法可能需要一次真实 BI 复跑确认**——本批同样未做真实端到端复跑。
- 自适应超时**只收执行类调用**（`run_native_query`、`get_field_values` 的聚合查询）的成功耗时；元数据 GET 与只编译不执行的 `/dataset/native` 不进样本（混进来会把 p95 稀释到失真的低值）。
- 冷启动没有样本时按配置值走——第一次重查询仍可能被 30s 砍掉，之后阈值才自适应上来；这不是「按查询形态分类」，是按**实测分布**回退。
- `search` 与 `run_native_query` 未接双模式：前者输出本已精简，后者是数据工具且必须回显 SQL 供核对口径（`run_native_query` 的 `limit` 截断已带「共 N 行」提示）。

### 第 7 批实施记录（2026-10-14，Jev 纳入统一治理）

> 动手前对齐：AWS《Timeouts, Retries, and Backoff with Jitter》「超时按实测分位数反推、失败按可重试性
> 分类冷却」+ OTel GenAI 语义约定（分类不是 chat 也要落 span）+ OWASP ASI09（失败必须可观测）。
> 动因：本仓**两个非对话模型调用方**（BI 查询适配器、客服分类器 Jev）曾各写一套超时/失败处置，
> 第 5、6 批建立的治理只覆盖了对话模型这一条路——「同一个治理体系里有两个例外」正是事故里
> 「查不出原因」的常见来源。完整设计见 `docs/agent/support-jev-plan.md`「治理（第 7 批）」段。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **超时按实测派生** | AWS「超时值按误超时率反推」；事故里一次 30002ms 的合法聚合被写死值打断是同一类问题 | `jev.ts` 删掉写死的 `AbortSignal.timeout(8000)`，改 `currentJevTimeoutMs()` = `clamp(p95×2, 保底 8000, 封顶 30000)`，**只收成功样本**，样本 <3 走保底；与 BI 查询超时**共用** `scripts/adaptive-timeout.mjs`；`index.ts` 启动日志打印生效值与推导依据 | `tests/jev-governance.test.ts` [A][B][C]：保底仍是 8s 但不再是常量 / 显式覆盖优先 / 保底封顶可调且与 BI 同源 |
| **失败分类与冷却** | AWS「按可重试性分类」 | 新增 `src/model-availability.ts`（抽出对话模型与 Jev **共用**的失败判据、`noteDownFailure` 与冷却表，避免 `jev.ts → chat.ts` 循环依赖）；Jev 用独立冷却键 `jev`，冷却落盘 + TTL 自愈（第 3 批 `model-cooldown.ts`） | [D]：冷却键 `jev` 与对话模型共用同一张表，但不互相污染 |
| **额度预检** | 第 5 批 C4 的同一套开关 | 仅当 `quotaPreflightEnabled()` 且 host 命中（默认 `openrouter.ai`）时查当日免费额度，耗尽则**不发请求**并冷却到 UTC 日切；fail-open | [E][F]：未配置 / 冷却中都不发请求，且**不计数**（没调过≠坏了） |
| **失败可观测** | ASI09 | 每次调用落一条 llm span：`gen_ai.operation.name=classify` + provider/model + `bx.jev.questions` + 失败带低基数 `error.type`，runId 贯穿 | [H][I]：span 字段；三个代发检查点都带 `runId`（漏传 = 查不出来的失败） |
| **在线评测新维度** | §6.2 L3 | `ClassifierStats` → usage 事件 → `RunTrace.classifierCalls/classifierFailures`（`app.ts` 映射）→ `classifier_health`（`EVAL_MAX_CLASSIFIER_FAIL_RATE` 默认 0.2），**单列**，不混进收敛类维度（Jev 不生成回复） | [J][K]：解析与拒发阈值未变（≥0.9 拒发、0.5–0.9 只标记）；代发工具名单不变（治理改造不扩权） |

**新增环境变量（均带默认，不配即上表的默认口径）**：`JEV_TIMEOUT_MS`（显式覆盖）· `JEV_TIMEOUT_FLOOR_MS`（8000）· `JEV_TIMEOUT_MAX_MS`（30000）· `JEV_LATENCY_WINDOW`（20）。额度预检沿用 `MODEL_QUOTA_PREFLIGHT*` 一套。

**语义没变**：Jev 仍**不在** `MODEL_PROVIDERS` / `listModels()` 里（不进模型下拉、不进自动候选链，[G] 断言这一点），结果仍不回灌写回复的模型。改的只是「它自己那一次调用怎么被对待」。

**验证**：`tsc --noEmit` 0 错误；全量 **95 文件 / 635 用例全绿**（较第 6 批 +1 文件 / +11 例，无回归）。

**诚实边界**：
- 共用冷却表但**冷却键独立**（`jev`）：Jev 挂了不拖累对话模型的候选链，反之亦然。但走 OpenRouter 时两者吃**同一份**当日免费额度——预检命中会让客服路的「承诺/代发检查」整段处于「没有结果」状态（fail-open：回复照发，**代发不放行**）。这是既定取舍，不是回归。
- 计数只在**真的发出请求**时递增（未配置 / 冷却中 / 预检跳过都不计），因此 `calls=0` 时 `classifier_health` 维度**缺席**——既不记满分也不记失败（缺字段的维度不计入分母，沿用第 9 轮在线评测的口径）。
- 超时派生只收成功样本且样本 <3 走保底：**冷启动那几次仍是 8s**，之后才自适应；与 BI 共用一份实现，改一处两边同时生效（也意味着 BI 的调参会顺带影响 Jev）。
- 本批**未做真实端到端复跑**（需 Jev 可用密钥 + 客服路真实请求）。第 9 批只复跑了 BI 路，**Jev 路仍未复跑**——它的 `classifier_health` 与冷却行为目前只有单测证据。
- **本批之后仍未做的两处**（§4.1 第 1 行 / §4.3 第 2 行的诚实边界）：① `governToolResults` 的卸载策略仍是「按预算统一卸载」；② `models.ts` 的 key 轮换未纳入运行级预算。**两处已在第 8 批收口**（见下）。

### 第 8 批实施记录（2026-10-14，上下文 recall 优先 + key 轮换纳入预算）

> 动手前对齐：Anthropic《Effective context engineering for AI agents》「Compaction 调优顺序：**先最大化
> recall，再提升 precision**；过度压缩是主要失败模式」+ AWS《Timeouts, Retries, and Backoff with Jitter》
> 「**只在调用栈的一层重试**；重试预算限制整个调用群体的总量」。两项分别对应 §4.1 第 1 行与 §4.3 第 2/4 行
> —— 第 6 批收尾时诚实标注的最后两条 ⚠️。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **卸载按重取代价分级** | Anthropic「先最大化 recall」；事故 L3（45 条结果被卸成句柄 → 模型用再探查补偿） | 新增 `src/tool-result-governance.ts`（纯函数 `classifyRecall` / `orderByRecallCost` / `recallRank`，不读 env、不碰注册表、不做 IO）；`chat.ts` `governToolResults` 由「按预算从旧到新」改为「按重取代价升序、同级仍从旧到新」：① `replayed`（同工具 + 同参数在上下文里还有一份）② `refetchable`（只读，原样重放无副作用）③ `irreplaceable`（重放有副作用 / 多轮推导产物） | `tests/tool-result-recall.test.ts` [A][B]（分级与稳定排序）+ [C]（只差一条预算时先卸可重放的）+ [E]（同输入重放过的先卸） |
| **不可重放的只卸不丢** | 同上「过度压缩是主要失败模式」 | 第③类落盘失败时 `continue`：**保留原文**，不清成占位符（丢掉就再也拿不回来，重放还会再产生一次副作用）；预算账只扣「真正摘掉的原文」，保留分支不扣 | `tests/tool-result-recall.test.ts` [D]（内容超单文件上限 → 落盘必失败；`cleared=0` 且原文逐字节保留） |
| **只读判定与闸门同真源** | 单真源，防「文档写 recall 优先、代码另立一套名单」 | `chat.ts` `isRecallableCall(name)` = `resolveToolRisk(name).level === "read"`（执行闸门同一张登记表）；子代理交接在 push 时标 `derived: true`（`task` 本身登记为 read，只有这个标记能表达「多轮推导、重放不出来」） | `[F]` 静态断言：共享模块 import、`resolveToolRisk(...).level === "read"`、`cls === "irreplaceable"` 保留分支、`derived: true` |
| **key 轮换纳入运行级预算** | AWS「只在一层重试 / 重试预算」；事故 L7（多层叠加的 39 条无效调用） | `models.ts`：`CallOptions.spendRetry` + `fetchWithKeyRotation(model, attempt, spendRetry)`——换下一个 key 前先取预算，取不到就**原样返回失败响应**（交上层冷却分类 / 切候选），网络错误分支同理；`chat.ts`：`canRetry` 上提到轮循环外，`streamCall` 新增 `spendRetry` 参数透传进 `callAgent` opts，于是每轮重试 / 空回合重试 / 换 key / 切候选共用一份预算 | `tests/model-key-rotation-budget.test.ts`：预算=1 时 3 key 池只发 2 次请求且跨候选共享；预算充足时照旧试满 3 个 key（不收紧正常路径） |

**验证**：`tsc --noEmit` 0 错误；全量 **97 文件 / 643 用例全绿**（较第 7 批后 +2 文件 / +8 例，无回归——含 `context-budget.test.ts` 既有治理用例）。

**诚实边界**：
- 分级依据是**协议层判据**（只读与否 / 是否重放过 / 是否推导产物），**不是**「元数据 vs 聚合结论」的语义分类——后者要靠工具名或内容形态写死，违反零业务词红线。因此它保证的是「代价低的先被卸、代价高的绝不丢」，不保证「恰好留下的是当时最有用的那一条」。
- 未登记 / 当前查不到的工具（含 MCP 断开期间）按**不可重放**保守处理：只卸载、不丢弃。宁可少卸一点，不可丢证据。
- 「同输入已重放过」只在**候选集合内**比较（保留窗口内的最近 N 组不参与），且只认参数原文全等——换参数重试（事故 L4 的形态）不算重复，这是刻意的：它由 P1-2 的重复预算提示管，不靠卸载顺序兜。
- key 轮换的预算取用只在**多 key 池**生效（单 key 直接发起，连回调都不调用）；`MODEL_RUN_RETRY_BUDGET` 未注入（测试 / 直连路径）时 `spendRetry` 为 undefined，行为与从前一致。
- ~~本批同样**未做真实端到端复跑**~~ → **已在第 9 批完成**（见下）。

### 第 9 批实施记录（2026-10-15，真实端到端复跑 + 复跑抓到的缺陷）

> 第 1～8 批每一批的诚实边界里都写着同一句「本批未做真实端到端复跑」。这一批把它做掉：
> **用事故 run 的原始提问、真实 MCP、真实模型跑一次**，按 §5 的验收口径逐项对账。

**复跑方法（可复用）**：`node scripts/_stall-replay.mjs replay [<runId>]`。脚本**不内置提问原文**
（零业务词红线），而是从 `.data/traces/runs-*.jsonl` 里按 runId 取 `userText` 原样回放；
跑完再从落盘的 `rounds-<runId>.jsonl` / `spans-<runId>.jsonl` 算四项指标。
本次回放的是 `run_c284e83d-e327-458c-ae6c-52de5a0d8bb1`（即本文那一条，release `d13a801` + 前 8 批改动）。

**第一次复跑就抓到一个真缺陷**：

| 现象 | 根因 | 为什么 8 批单测全绿都没发现 |
|---|---|---|
| 启用 MCP 时回 `connected:false / MCP error -32000: Connection closed`，模型只能如实答「未取到」 | `scripts/metabase-mcp.mjs:41` 残留 TS 返回类型标注 `function currentTimeoutMs(): number` —— `.mjs` 被 Node 当纯 JS 解析，**启动即 `SyntaxError`**，MCP 握手前进程就退出 | 既有断言全是「读源码做静态断言 / import 共享纯函数」，**从未解析或启动过适配器本身**。这类缺陷的特征正是「代码看着对、测试也全过、只有真跑才炸」 |

修复：删掉该标注（第 6 批把两个共享模块改成纯 JS 时漏了适配器这一处）；
新增**执行侧门禁** `tests/mcp-adapter-syntax.test.ts`：`node --check` 逐个解析 `scripts/*.mjs`，
并先用合成反例自检门禁有效（[A]），再断言全部脚本可解析（[B]）。

**修复后的复跑结果（真实 MCP + 真实模型）**：

| 验收项（§5） | 事故当时 | 本次复跑 | 判定 |
|---|---|---|---|
| 开场 429 | 4 次（候选 1-4 各一次每日配额 429） | **0**（额度预检把 10 个已耗尽模型直接冷却到 UTC 日切，首个候选即付费模型接手） | ✅ |
| 工具错误 ≤2 | 7 次（外部查询 6 + 元数据 1） | span 级 **11 次**，但构成见下 | ⚠️ 见诚实边界 |
| ≥1 次综合轮 | **0 次**（本文标题那个数字） | **1 次**（`synthesisRounds=1`） | ✅ |
| 总耗时 <300s | 1423.7s（被 600s 看门狗收口） | **205.2s**（28 轮 / 83 次工具调用，看门狗未触发） | ✅ |
| 上下文治理 | 45 条卸载、**无一条被清空** | 卸载 60、清空 **0**（recall 优先：可重放的先卸，重放不出来的只卸不丢） | ✅ 第 8 批生效 |

**验证**：`tsc --noEmit` 0 错误；全量 **98 文件 / 645 用例全绿**（较第 8 批 +1 文件 / +2 例）。

**诚实边界**：
- **11 次工具失败的构成**：6 次是护栏**主动拒绝**（「每个列表工具本轮只允许直接调用一次」×5、技能前置门「先读完业务取数技能再调连接器」×1），2 次是模型把卸载句柄的 `call_01_/call_02_` 前缀抄成 `call_00_` 导致 `fs_read` 落空（文件确在，路径抄错，属模型侧），1 次 `run_tool_code` 退出码 1（Python traceback），余下为同类。**真正「工具故障」只有 1 次**——§5 那条「≤2」当年是针对「外部查询持续失败」写的，把护栏拒绝计入会掩盖这个区别，故此处如实拆分而不是凑数。
- **样本量**：一个模型、一条提问、一次成功复跑。`ds4flash0731` 是当前唯一有额度的候选（其余免费档当日已耗尽，由 C4 预检冷却），**没有验证到多 key 池轮换**，也没有验证到「开场 429」在配额恢复后的表现——那需要另一个窗口。
- **探索效率仍是耗时大头**：单工具本轮最多被调用 **32 次**（`toolRepeatMax=32`），28 轮 / 83 次工具调用里绝大多数是同一批元数据反复探查。P1-2 的重复预算提示会拦，但本次靠轮次上限兜底。**这是 L4 的形态仍在**（护栏拦得住单点，收不住总量），属下一轮该看的项，本批未改。
- 复跑用的提问原文含业务口径，脚本刻意不落盘、不进仓库（从 trace 现取），否则违反零业务词红线。

### 第 10 批实施记录（2026-10-15，探索效率 L4：重复提醒跨轮阶梯化 + 可选运行级上限）

> 承接第 9 批复跑留下的唯一硬信号：单工具累计 **32 次**、28 轮 / 83 次工具调用，绝大多数是同一批
> 元数据反复探查。观测早就是红的（`toolRepeatMax` → anomaly 的 `tool_repeat_spike` → eval 的
> `efficiency`，阈值 `EVAL_MAX_TOOL_REPEAT=8`），缺的是**跟着走的提醒**。

| 项 | 对标依据 | 落地位置 | 回归 |
|---|---|---|---|
| **提醒不再「只提示一次」** | AWS「重试预算用比例而非绝对次数」；Anthropic《Building Effective Agents》「重复本身就是信号，要给出上限或替代动作」 | `src/repeat-budget.ts` 新增纯函数 `repeatEscalationStep` / `repeatEscalation`：按累计次数的**翻倍台阶**（8 → 16 → 32）每上一级提醒一次，文案逐级加重（第二级起明确「本轮结束前请给结论」）；`chat.ts` 轮末用 `repeatEscalatedStep` 记住已提示到哪一级 | `tests/repeat-budget.test.ts` 新增 7 例：阶梯取值（7→0 / 8→8 / 16→16 / 32→32 / 100→64）、阈值可注入、同台阶不刷屏、上台阶文案加重、复跑形态回放（累计 32 → **3 次**提醒，改动前全程 1 次）、静态接线 |
| **可选运行级重复上限** | 同上（硬拦留给可选项：重复有时是正当的） | 新增 `repeatBudgetStop` / `repeatStopNotice`；`chat.ts` `executeOne` 在累计达上限时**停止执行该工具**并回灌替代动作（不是静默丢弃，否则模型会当工具坏了反复重试 → Doom Loop）。`TOOL_REPEAT_STOP_AFTER` **默认 0 = 关闭**，行为不变 | 单测：默认恒 false（不硬拦）、注入后边界正确、停止文案含替代动作 |

**新增环境变量（均带默认，不配即现状）**：`TOOL_REPEAT_ESCALATE_FIRST`（8，与 `EVAL_MAX_TOOL_REPEAT` 同口径）· `TOOL_REPEAT_ESCALATE_FACTOR`（2）· `TOOL_REPEAT_STOP_AFTER`（0 = 只提示不拦）。

**验证**：`tsc --noEmit` 0 错误；全量 **98 文件 / 652 用例全绿**（较第 9 批 +7 例，无回归）。

**诚实边界**：
- 阶梯只解决「**提醒跟着走**」，不保证模型照做——它仍是提示（回灌一条 user 消息），不是硬拦。真要收住总量得开 `TOOL_REPEAT_STOP_AFTER`，而**打开后长任务可能因此取不到数据**（例如确实需要 N 次分页/分桶取数的场景），所以默认关，需要按部署评估后再开。
- 首阶 8 次是**与评测阈值对齐**的选择（让「评测判红的量」与「运行时提醒的量」对得上），不是实测出来的最优值；倍率 2 同理。
- 阶梯统计只算**真实执行**的调用（被闸门拦下、同轮去重跳过的都不计，与既有 `noteToolCall` 同口径），因此「被拒绝 5 次」不会因为拒绝而继续推高阶梯。
- 本批**未做真实端到端复跑**：阶梯提醒有没有让模型少走几轮，要同一问题再跑一次对比 `toolRepeatMax` 与轮数才能证明（第 9 批的 32 次是改动前的基线）。

### 第 11 批实施记录（2026-10-15，上下文治理对齐 CodeBuddy 的 Micro-compact 方案）

> 用户指令「完全对齐最佳实践，参考 CodeBuddy 的实现」。CodeBuddy 文档站是 SPA（正文在 JS chunk，抓不到；
> 浏览器实例被占用），故以本仓库 `.codebuddy/plans/steps_上下文膨胀优化_Micro-compact___token_闸门___探索折叠__*.md`
> 这份 CodeBuddy 此前为本项目写的方案为参照——它本身建在**已被移除的 steps 架构**上，本批是在当前
> deep-agent 架构（conversation turns）下重新对照、采纳**安全子集**。

**对照结论（先说诚实边界）**：本项目的 `governToolResults` 当前架构**已经覆盖了 Micro-compact 的安全子集**——
· 保留最近 `keep` 组（最近 N 轮）+ token 预算压老结果（recall 优先、offload 到工作区可恢复）；
· 白名单 `MCP_TOOL_RESULT_PROTECT`。CodeBuddy 方案里**多出来的「保留窗口逐级收窄」token 闸门，本批刻意不采用**：
它会越过 keep 窗口去丢**最近一批**证据，与本项目既有的 keep 窗口硬保证冲突，也正好是 Anthropic 警告的
「过度压缩是主要失败模式」。所以本批没有引入该闸门，收口交给历史压缩（history compact）。

| 项 | 对标依据 / 参照 | 落地位置 | 回归 |
|---|---|---|---|
| **keep 窗口硬下限（显式化）** | CodeBuddy Micro-compact「保留最近 N 轮」+ Anthropic「过度压缩是主要失败模式」 | `chat.ts` `governToolResults`：候选只取 `index < len - keep`，**绝不越过**；预算压力来自最近一批时停止压缩，交给历史压缩 | `tests/tool-result-recall.test.ts` [G]：5 条 fat 结果，预算 450，压掉 2 条老结果后即停，最近 3 条整组保留；`tests/context-budget.test.ts` [4] `fresh` 段：显式 `keep=6` 时整批留下 |
| **压缩可观测日志** | CodeBuddy 方案「可观测：每轮打印压缩前后条数/字符/折叠数」 | `governToolResults` 末尾 `console.log('[chat:compact] …')`：工具结果条数、压缩前后字符、预算、卸载/清空数、硬下限标注 | 静态接线：`tests/tool-result-recall.test.ts` [F] 断言 `chat.ts` 含 `[chat:compact]` 与 `keep 窗口为硬下限` |
| **（未采用）窗口收窄 token 闸门** | CodeBuddy 方案决策 4「压缩后仍超阈值则逐级回退」 | **刻意不落地**：会丢最近证据，与 keep 硬保证冲突 | 由上述两条反证——`fresh` 与 [G] 锁死「最近一批不被压缩」 |

**过程中删掉的两段（自证为何不采用）**：
- 第一稿加了「每工具最后一次只读结果保护」（动态判定，不写死工具名）。**撤销**：真实 MCP 工具名每次调用唯一，
  在默认 `unknownToolPolicy=allow` 下每条都算「最后一次」→ 单调用结果全被保住、**压缩完全失效**；而对重复工具，
  最后一次本就在 keep 窗口内（必然保留），该保护纯属冗余且有害。
- 第二稿加了「预算闸门逐级收窄 keep 窗口到 1」。**撤销**：直接触发 `tests/context-budget.test.ts` [4] 的 `fresh`
  断言失败（该用例锁「刚返回、还没整合的一批必须整批留下」），证明它会丢最近证据——与既定保证冲突，故去。

**验证**：`tsc --noEmit` 0 错误；全量 **98 文件 / 653 用例全绿**（较第 10 批 +1 例 [G]，无回归）。

**诚实边界**：
- 本批是**安全子集对齐 + 可观测补强**，不是把 CodeBuddy 方案逐条搬过来。逐条搬的「窗口收窄闸门」经实践验证会破坏
  既有保证，已记录为何不采用（而非静默带入）。
- 上下文治理的**真实收益**仍依赖一次长轨迹复跑验证（同 §7 第 9 批遗留）：压缩日志有没有在真实 run 里把体积压下来、
  `[chat:compact]` 输出是否合理。

---

## 6. 评测集：把本例固化下来

### 6.1 为什么值得固化

这不是"又一个 bug 用例"，而是**首个覆盖四种信号的真实样本**：

1. **候选链**：开场多模型配额耗尽 → 是否仍逐个重打。
2. **工具韧性**：同一外部工具错误率 60% → 是否熔断。
3. **收敛**：长任务被外部中止 → 是否仍有结论。
4. **可观测**：能否从落盘数据复原"哪一步失败、为什么失败"（本次**不能**，本身就是待修项）。

并且它暴露了一个**从未被触发的解析盲区**（P1-5①），这类"靠运气没暴露"的缺陷最适合做回归锚点。

### 6.2 四层方案

| 层 | 形态 | 落地物 | 闸门 |
|---|---|---|---|
| **L0 事故快照** | 脱敏后的轨迹特征 + 期望行为，作为 case 定义 | `apps/agent-server/tests/fixtures/stall-incident-cases.json`（✅ 已落地，10 个 case） | 随仓库走，供 L1/L2 引用 |
| **L1 确定性回归** | mock SSE 驱动真实 `chatStream`，断言护栏行为 | ✅ 已落地：`tests/sse-inline-error.test.ts`（P1-5①）、`tests/daily-quota-cooldown.test.ts`（P0-1 + 第 5 批 C2 三分层）、`tests/model-health.test.ts`（P0-3）、`tests/sql-readonly-consistency.test.ts` 追加段（P1-5②）、`tests/tool-failure-window.test.ts`（P1-1 + P2-1 字段静态断言）、`tests/repeat-budget.test.ts`（P1-2）、`tests/wrap-up-abort.test.ts`（P1-4 中止路径）、`tests/subagent-status-contract.test.ts`（P1-3，含 §6.3 矩阵最后一行）、`tests/model-cooldown.test.ts`（P0-2）、`tests/stall-threshold.test.ts`（P2-3）、`tests/eval-online.test.ts` 扩维段（P2-2 事故回放固定 poor）、`tests/round-trace.test.ts` 扩 3 例（第 4 批 L2）、`tests/abort-candidate-shortcircuit.test.ts`（第 5 批 C1，对应 §6.3「中止短路候选链」行）、`tests/model-retry-budget.test.ts`（C3）、`tests/model-quota-preflight.test.ts`（C4）、`tests/bi-tool-ergonomics.test.ts`（第 6 批：双模式投影 + 自适应超时 + 适配器静态断言）、`tests/tool-result-recall.test.ts`（第 8 批：卸载分级/排序 + 不可重放只卸不丢 + 共享模块接线静态断言）、`tests/model-key-rotation-budget.test.ts`（第 8 批：预算=1 时 3 key 池只发 2 次请求、跨候选共享；预算充足时照旧试满）、`tests/jev-governance.test.ts`（第 7 批：Jev 超时派生/覆盖、冷却短路、计数不虚增、span 字段、三个代发检查点都带 runId）、`tests/mcp-adapter-syntax.test.ts`（第 9 批：`node --check` 逐个解析 `scripts/*.mjs` + 合成反例自检门禁有效，防「适配器启动即崩而单测全绿」） | **进 CI**（`pnpm test`，现有唯一闸门） |
| **L2 trace 断言** | 真实服务跑一次后读 `rounds-*.jsonl` / `spans-*.jsonl` 断言形态 | ✅ 离线断言部分已进 `tests/round-trace.test.ts`（mock 驱动 + 临时 trace 目录，随 CI 跑）：轮级 `mode` 按 tool/synthesis 落盘（「综合轮 0 次」可数）、父轮 task 调用有 span 且带低基数结构化状态与 `error.type`；真实服务复跑仍人工触发 + 可观测页面核对 | 离线断言随 CI；真实复跑人工 |
| **L3 在线评测** | 七维扩到十二维（§5 P2-2；第 7 批再增 `classifier_health`），真实运行持续打分 | `eval-online.ts` + env 阈值 | 只观测、不断言（真实模型不可靠） |

### 6.3 L1 断言矩阵（修复后应全绿）

| 用例 | 注入 | 必须成立 |
|---|---|---|
| 配额型 429 | 首候选返回每日配额 429 | 冷却到 UTC 日切；同进程内第二个请求**不再**打它 |
| 工具交替失败 | 同一工具 6 次里 3 次失败（成功夹在中间） | 达阈值后摘除；回灌提示含"换工具/换路径/先给结论" |
| 长任务被中止 | 末轮外部中止 + 已有证据 | 仍产出一次收尾；正文含"已取到什么 + 还缺什么"；不落兜底句 |
| 子代理空结果 | 子代理返回零发现 | 父轮拿到 `status=no_findings`；不计入证据；不得直接当结论 |
| 子代理失败/被中止 | 子代理启动期失败（servers 无可用工具）或被外部中止 | 父轮拿到 `status=failed` + 结构化原因；不计入证据；交接文本如实写「未完成」 |
| 流内限流 | SSE 中途发 `error` 帧 | 归一化为 429；进冷却；切候选 |
| 超时可操作 | 外部查询超时 | 回灌文案含"缩小范围/加过滤/分页"与 `retryable`，不含运维 env 名以外的实现细节 |

### 6.4 防过拟合

Anthropic 明确建议"保留测试集，避免只对少数任务过拟合"。本仓做法：

- **L0 fixture 分 `public` / `private`**：`public` 进仓库供 CI；`private` 只本地跑（保底：把真实失败正文、真实库表名留在 private，**public 只留形态与计数**）。
- **不把真实业务口径写进任何 case**：本次事故的业务特征（国家线/指标/归因目标）一律用占位符表达，符合零业务词红线。

### 6.5 现状提醒

`scripts/eval-*.mjs`（`eval-core` / `eval-trace-gate` / `eval-intent-routing`）已随 2026-09 的一次拆分被清理，**现 CI 判定口径只有 agent-server `tsc` + `vitest`**。因此本方案刻意全部落在 `tests/` 与 `src/eval-online.ts`，**不依赖已删除的脚本层**；若要重建"真实端到端 gate"，属独立立项，不在本文范围。

---

## 7. 遗留与诚实边界

| 项 | 状态 |
|---|---|
| 6 次外部查询失败的具体原因 | **无法复原**（错误正文不落库）→ 正是 P2-1 要修的；本文相关推断已标注。第 2 批起失败带 `error.type` 分类 + 脱敏摘要落 span，同类问题此后可复盘 |
| 3 次代码聚合通道失败的确切退出码 | 推断为「桥接内调用失败向外 reject，模型代码未捕获 → 子进程非 0 退出」。**历史三次不可复原**（发生在退出码文案与 span 埋点之前）；现状 `run_tool_code` 失败即回「代码退出码 N + stderr 尾部」（tool-code.ts），并经 P2-1 的 `error.description` 落 span，此后可诊断（退出码类归 `other`，保守不计熔断） |
| 子代理空转 7.5 分钟 | 时间线与"第 23 轮单工具调用阻塞 7 分钟、子代理轮次另起 runId 计数"完全吻合。**第 4 批已补父轮 task 调用的 span**（墙钟时间 + 结构化状态 attr），同类空转此后在 span 层直接可见；历史当次无 span 仍不可复原 |
| 本次是否本可救回 | 至少两次机会：L2 熔断生效（少 6 次无效调用）、L5 补位覆盖中止（保住 39 条证据的结论） |
| 真实复跑的覆盖面 | 第 9 批只复跑了 **BI 路**（事故 run 原始提问 + 真实 MCP + 真实模型，四项验收见 §5）；**客服路的 Jev 未复跑**（需可用密钥 + 客服真实请求），第 7 批对它的治理目前只有单测证据 |
| 探索效率（L4） | 复跑里单工具累计最多被调用 **32 次**、全程 28 轮 / 83 次工具调用，绝大多数是同一批元数据反复探查。第 10 批已把重复提醒改为**跨轮阶梯**（8/16/32 各提醒一次，改动前全程只提醒 1 次），并提供默认关闭的运行级重复上限 `TOOL_REPEAT_STOP_AFTER`。**仍未验证的是「模型会不会因此少走几轮」**——需同一问题再复跑一次对比 `toolRepeatMax` 与轮数（基线：32 次 / 28 轮） |
| 上下文治理对标（Best Practice §4.4） | 第 11 批对照 CodeBuddy 的 Micro-compact 方案：采纳安全子集（keep 硬下限显式化 + `[chat:compact]` 可观测），**刻意不采用**其「保留窗口逐级收窄」token 闸门（会丢最近证据，与 keep 保证冲突）。**仍未验证的是真实长轨迹里压缩日志是否真把体积压下来**——需一次复跑观察 `[chat:compact]` 输出 |
| 未涉及 | 取数口径正确性、只读安全、图表与导出链路（另见 `docs/text2sql-text2api-plan.md`） |

---

## 8. 参考

| 来源 | 日期 | 本地用到的部分 |
|---|---|---|
| Anthropic《Effective context engineering for AI agents》 | 2025-09-29 | Compaction 的 recall 优先与过度压缩失败模式；Sub-agent isolation 的结构化返回契约；"不能只压缩文本，还要保存状态/证据/失败/恢复路径" |
| Anthropic《Writing effective tools for agents》 | 2025-09-11 | 错误可操作化；无法完成 vs 部分完成；超时建议缩小范围；`concise/detailed`；重复调用作为设计信号；真实多步评估集 |
| AWS Builders Library《Timeouts, Retries, and Backoff with Jitter》 | 2026-06 | 超时按误超时率取分位数；外层 deadline 约束全部重试；重试预算与 token bucket；只在一层重试（3^5 放大）；breaker 的代价 |
| OpenRouter API Guides《Limits》 | — | 免费档每分钟 20 / 每日 50（UTC 日切）；两类 429 的恢复时间差异；额度预检；**流内限流以 SSE `error` + `finish_reason:"error"` 返回** |
| 本仓既有 | — | `docs/text2sql-text2api-plan.md`、`docs/BEST_PRACTICE_ALIGNMENT.md`、`docs/agent/PRODUCTION_READINESS.md`、`docs/agent/AGENT_CHARTER.md` |
