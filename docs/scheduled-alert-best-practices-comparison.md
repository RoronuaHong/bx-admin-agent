# 定时预警 / 监控任务：业界最佳实践与竞品对照

> 状态：**调研文档**（2026-09-30）。**产品口径以 `scheduled-spike-detection-plan.md` 为准**。对齐清单 A1–A6 已落地，见 `best-practice-alignment-review.md`。  
> 关联：`scheduled-task-sessions-plan.md`、`agent-infrastructure.md` §8。

---

## 0. 一句话结论

| 维度 | 业界共识 | CodeBuddy 系 | 千问 / Qwen Code 系 | 我们（当前） |
|---|---|---|---|---|
| **调度持久化** | 报告型任务应落盘、可重启 | CLI `/loop`：**会话级、退出即失**；WorkBuddy 自动化：**本地持久** | CLI 默认同左；`--durable` / 托管 Deployment 可持久 | ✅ Mongo 持久 + pm2 常驻 |
| **检测频率 ≠ 通知频率** | Monitoring：meaningful 才推 | CLI 侧重「每轮都跑」；告警语义靠 prompt | `/loop` 固定间隔；动态唤醒可自调节奏；**无引擎级「仅异常推」** | ✅ `on_alert` + 标记协议；破线每期都推 |
| **先测后跑** | ChatGPT：普通对话试 prompt 再建 schedule | 会话内 `/loop` 即试即跑 | 同左 | ✅ 「设为数据预警」/「从对话带入」 |
| **盯盘 / 弹性节奏** | 平稳疏、异常密；事件驱动优于傻轮询 | `/loop` 跑完后可改间隔或结束 | **`ScheduleWakeup` + `monitor`** | ✅ 告警中加密下一拍（不改 cron）；`POST .../wake` 事件唤醒 |
| **无人值守产物纪律** | 监控宜短；勿刷图/长报告 | 无专用闸 | `monitor` 限流 | ✅ 预警硬摘图/导出 |
| **产品定位** | ChatGPT Monitoring / Datadog Monitor | CLI 轮询；WorkBuddy 办公自动化 | CLI / 云端 Deployment | 服务端常驻：报告 + 预警一条线 |

**不学**阈值一级表单化，也不把改 cron 交给模型。动态节奏和事件唤醒已由引擎落地。

---

## 1. 业界最佳实践（公开资料归纳）

### 1.1 ChatGPT Scheduled / Monitoring tasks

来源：[OpenAI Automations 文档口径](https://learn.chatgpt.com/docs/automations)、社区对 Monitoring 的归纳（Skilldential / Iziraa / Designs24hr 等，2025–2026）。

三类任务应分清：

| 类型 | 行为 | 通知 |
|---|---|---|
| One-off | 到点跑一次 | 通常总是通知 |
| Recurring report | 按表到点出报告 | 通常总是通知 |
| **Monitoring** | 周期检查，但只在「有意义变化」时打扰 | **安静为默认** |

Monitoring 指令必须写清五件事：

1. **盯什么**（源 / 指标 / 范围）  
2. **什么叫有意义**（阈值、相对变化、排除项）  
3. **多久查一次**（检测 cadence ≠ 通知 cadence）  
4. **没事时怎么办**（静默 / 一行状态，禁止长篇「无变化」）  
5. **何时停**（截止日期、事件结束）

可复用指令骨架（业界模板合并版）：

```text
Purpose: [可衡量结果]
Schedule: [检测频率] @ [时区]
Sources: [权威数据源 / 工具]
Threshold: [超过 / 变化超过 … 才算异常]
Notify: 仅当 [条件]；若无 meaningful change → 不推送长报告
Failure: 取不到数据就说明阻塞，不要猜
Stop: [日期或事件]
```

对我们的映射：表单只暴露「用途=预警 / 频率 / 仅异常」；上表其余进 **指令** + 运行时协议标记。

### 1.2 告警工程常识（Datadog / AIO playbook）

- **检测频率 ≠ 通知频率**：可每 5～10 分钟查一次，但同一异常冷静期内只吵一次。  
- **分级**：P1 打断工作流；P2 通知；P3 进周报。AI 监控任务默认应偏 **P2 + 冷静期**，避免模型抖动刷屏。  
- **可行动**：每条告警应带当前值、阈值、窗口、下一步（或链到对话）。无 runbook 的告警应降级为日志。  
- **多跑确认**（AIO / 品牌监控）：非确定性输出建议多采样再告；运维计数类指标则应用 **确定性取数**（SQL/API），少依赖模型「感觉像暴涨」。

### 1.3 Agent 监控特有坑（本仓库已踩到）

| 坑 | 现象 | 业界/自研应对 |
|---|---|---|
| 工具结果截断 | 大 JSON 只剩 12KB 头 → 估数、出图 | 缩字段/limit；截断 → `[NO_DATA]`；禁止估数 |
| 报告型指引污染监控 | 「必须 render_chart」 | 预警专用指引 + 硬摘出图工具 |
| 同会话上下文复用旧结论 | 不查源直接复述上期 | `taskGuide`：每期必须重新取数；可选每期新会话 |
| 轮次空转 | 30+ 步、数分钟 | 预警轮次上限；Doom Loop 熔断 |
| 无总数 API 硬分页 | 人肉翻页计数 | `count_list_by_time` 在服务端翻完，只回小时计数；`complete: false` 标 `[NO_DATA]`。直接翻第二页或换窗口再取会被拒绝。小时桶以外用 `run_tool_code` |

---

## 2. CodeBuddy 系怎么做

### 2.1 CodeBuddy Code CLI（[定时任务文档](https://www.codebuddy.ai/docs/zh/cli/scheduled-tasks)）

| 项 | 实现 |
|---|---|
| 入口 | `/loop <间隔> <指令>`；自然语言一次性提醒；`CronCreate` / `CronList` / `CronDelete` |
| 作用域 | **会话级**：进程退出任务清除，**不写盘** |
| 最小间隔 | 1 分钟（秒向上取整） |
| 上限 | 每会话 ≤ 50 个；循环任务 **创建 3 天后过期** |
| 触发时机 | 仅会话 **空闲** 时；忙则顺延；**不补跑**错过的触发 |
| 智能点 | `/loop` 每轮结束后，模型可据结果 **提前 / 延后 / 维持 / 结束** 下一轮（偏「盯流水线」） |
| 不做的事 | 无独立「仅异常通知」引擎；无冷静期状态机；无 IM 通道旁路（会话内回话） |

**适合**：开发者本机开着 CLI，轮询 CI / 构建 / 短时盯梢。  
**不适合**：7×24 业务预警、钉钉推送、进程重启后仍要跑。

### 2.2 WorkBuddy 自动化（[自动化指南](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide)）

同一产品家族里的 **办公自动化** 形态，更接近我们的「常驻报告任务」：

| 项 | 实现 |
|---|---|
| 配置 | 本地持久：名称、prompt、调度、工作目录、权限模式、模型/技能/连接器 |
| 调度 | 周/月多天规则；频率与并发、最大执行时长受控 |
| 通知 | 可选推送 **小程序 / 企业微信 bot**（执行完推结果；失败不堵任务） |
| 安全 | 无人值守提示；建议先低频试跑；文件写删需审慎 |
| 模板 | 新闻推送、周报等——偏 **周期报告**，不是 Datadog 式 Monitor |

与 CodeBuddy CLI 的分工可以概括为：

```text
CodeBuddy CLI /loop  → 会话内、短命、可自调间隔的「盯一下」
WorkBuddy 自动化     → 落盘、办公向、跑完就推的「到点报告」
```

**对我们的启发**：CLI 的「跑完可改节奏 / 可结束」值得参考；WorkBuddy 的「结果推 IM、先试跑再提频」已与我们接近。两者都 **没有** 把「SPIKE 冷静期」做成引擎能力——业务阈值仍在 prompt 里口述。

---

## 3. 千问系怎么做（Qwen Code / Qoder）

### 3.1 Qwen Code 定时任务（[官方文档](https://qwenlm.github.io/qwen-code-docs/zh/users/features/scheduled-tasks/)）

与 CodeBuddy CLI **高度同构**（同属「会话内 cron」范式）：

| 项 | Qwen Code |
|---|---|
| 入口 | `/loop 5m …`；默认间隔常为 **10m**；`CronCreate/List/Delete` |
| 作用域 | 默认会话级、退出清除；可用配置延长过期；文档提及 **durable / 磁盘恢复** 与通道侧持久调度 |
| 抖动 | 循环任务最多延迟周期 10%（上限 15m），打散 API 尖峰 |
| 过期 | 默认循环 **7 天** 过期（可用 `QWEN_CODE_CRON_MAX_AGE_DAYS=0` 关过期） |
| 自主 `/loop` | 无 prompt 时做「推进当前对话未完成工作」的自主循环 |
| 限制 | 空闲才触发、不补跑、重启丢会话任务（非 durable） |

### 3.2 Qoder / Loop Engineering：动态唤醒 + Monitor（[阿里云开发者文](https://developer.aliyun.com/article/1753198)、[monitor 工具](https://qwenlm.github.io/qwen-code-docs/zh/developers/tools/monitor/)）

这是相对 CodeBuddy **拉开差距** 的一块，也是「盯盘 / 告警」叙事的核心：

| 机制 | 作用 |
|---|---|
| **`/goal`** | 交出终点：可验证完成条件，到达即停（不适合「持续盯阈值」） |
| **`/loop 5m`** | 交出固定节奏：每轮新上下文，适合巡检 |
| **`/loop`（无固定间隔）** | 交出判断权：每轮末调用 **`ScheduleWakeup(delay)`**（约 60s～1h）；不调 = 结束 |
| **`monitor`** | 挂长跑 shell（`tail -f`、健康轮询等），**每行输出 → 事件唤醒** Agent；有 `max_events`、空闲超时、行长截断、速率限制 |

盯盘推荐组合（原文口径）：

```text
Monitor（事件秒级） + ScheduleWakeup（心跳 / 异常时加密）
平稳：稀疏唤醒；破线：加密 + 通知；目标消失：不再 ScheduleWakeup
```

**对我们的启发（高）**：

1. **弹性节奏**比「一律 */5」更省 token、更贴业务峰谷。  
2. **事件源**（日志 / webhook / 队列）应优先于「Agent 自己翻 API 分页」。  
3. `monitor` 对输出做截断与限速——和我们「大工具结果预算」是同一类工程问题，他们放在事件入口，我们放在 MCP 结果出口。

### 3.3 千问办公（QwenWork，不是上面的 Qwen Code CLI）

公开文档：[网页端定时任务](https://qwenwork.cn/docs/web/scheduled-tasks)、[桌面端定时任务](https://help.aliyun.com/zh/qwenwork/qwenwork-scheduled-tasks-desktop)。

| 项 | 网页端 | 桌面端 |
|---|---|---|
| 跑在哪 | 云端。关浏览器、退出登录仍跑 | 本机。睡眠或关机不会触发；重要任务建议「保持系统唤醒」 |
| 怎么建 | 页面填写、对话里说、预置模板 | 同左，先在普通对话跑通再转定时（文档称这是最重要的一条） |
| 时间 | 一次、间隔、每小时/天/周/月、自定义表达式 | 以电脑时区为准 |
| 停用 | 停用后不触发；再启用从**下一个**计划时间继续 | 同左 |
| 立即执行 | 多跑一次，**不改变**原周期 | 同左 |
| 结果 | 每次一个任务会话；删除任务后历史会话保留 | 点开执行记录里的对话看全过程 |
| 对外发送 / 删文件 | 走现有权限确认；没权限就做不成，执行记录仍留 | 同左 |
| 告警引擎 | 公开文档没有独立的「仅异常推」状态机；异常条件写在指令里 | 同左 |

和我们的差别：我们已有引擎级 `on_alert`，他们没有。立即执行、删除任务仍留历史会话，两边都有。桌面「必须保持唤醒」不适用于服务端。

**输出**：千问办公的执行记录分开写状态、触发方式（定时 / 手动）、开始时间、耗时，结论在任务会话里。CodeBuddy 的完成通知是一段人能读的 summary，状态另计。推送正文按这个顺序：先结论，再任务名 / 状态 / 触发 / 时间 / 耗时，项与项之间空行（钉钉会把单个换行粘成一行）。关键词贴在末行，不单独成段。

### 3.4 千问云端托管 Agent

[千问 AI 平台 Deployment](https://platform.qianwenai.com/docs/api-reference/agent-infra/managed-agents/deployment/create) 提供 `schedule.type=cron` + `initial_events`，形态接近「云端到点跑 Agent」，偏报告/批处理，**公开文档未见** SPIKE 冷静期协议。

---

## 4. 三方对照总表

| 能力 | ChatGPT Monitoring | CodeBuddy CLI | WorkBuddy | Qwen `/loop` | Qwen 动态唤醒 + monitor | **bx-admin-agent** |
|---|---|---|---|---|---|---|
| 持久调度 | 云端账号级 | ❌ 会话 | ✅ 本地 | 默认❌ / durable 可选 | 会话+可持久化叙事 | ✅ 服务端 |
| 固定 cron | ✅ | ✅ | ✅ | ✅ | 可选 | ✅ |
| Agent 自调间隔 | 弱（产品侧 monitoring） | ✅ 跑完可改 | ❌ | 弱 | ✅ `ScheduleWakeup` | ❌ |
| 事件驱动 | ❌（无 webhook 官方口径） | ❌ | ❌ | ❌ | ✅ `monitor` | ❌（可接钉钉/自建 webhook 作未来项） |
| 仅异常通知（引擎） | ✅ meaningful | ❌ prompt | ❌ 跑完就推 | ❌ prompt | ❌ prompt（可自抑） | ✅ `on_alert` |
| 冷静期 / 恢复 | 产品侧去重叙事 | ❌ | ❌ | ❌ | 靠 Agent 自控 | 破线不去重；恢复要 2×NORMAL |
| 结论协议 | 自然语言约定 | 无 | 无 | 无 | 无 | ✅ `[SPIKE]` 等 |
| IM / 通道投递 | 应用内通知 | 会话 | 企微/小程序 | 通道文档另述 | 会话/通知 | ✅ 钉钉/飞书 |
| 出图/长报告闸 | 监控任务宜短 | 无专用闸 | 报告向 | 无专用闸 | monitor 限流 | ✅ 预警硬摘图/导出 |
| 最小间隔 | 产品限制 | 1m | 产品限制 | 1m | 唤醒 ≥~60s | 5/10/15/30m（预警） |

---

## 5. 我们已对齐 / 未对齐

### 5.1 已对齐（保持）

- 预警 = 用途 + 指令阈值 + 仅异常推（ChatGPT Monitoring 主路径）。  
- **先测后跑**（对话试跑 → 设为预警 / 从对话带入）。  
- 恢复通知要连续 2 期 `[NORMAL]`。破线不去重：每一期 `[SPIKE]` 都推（2026-10-08）。  
- 服务端持久调度 + 专属对话 / 每期会话（强于两家 CLI）。  
- 预警产物纪律：禁止图表/HTML 估数、截断标 `[NO_DATA]`。  
- 无总数列表的跨页小时计数由服务端翻完（`count_list_by_time`），不让模型逐页累加。  
- 长跑后按跑完时刻推进下一拍（避免短 cron 连环补跑）。

### 5.2 明确差距（按价值排序）

| 优先级 | 差距 | 学谁 | 备注 |
|---|---|---|---|
| P2 | **指令模板 / 占位符**（源、窗口、阈值、静默规则、失败规则） | ChatGPT 模板 | ✅ 表单脚手架 +「填入模板」 |
| P2 | **取数优先走聚合 / 短窗口**，避免列表截断螺旋 | 自研踩坑 + monitor「入口限流」思想 | ✅ 写入 `SCHEDULE_ALERT_GUIDE` 与占位文案 |
| P2.5 | **先测后跑**：对话确认口径 → 再挂预警（勿逼用户空表单写工具名） | ChatGPT Automations「test prompt first」 | ✅ 气泡「设为数据预警」+ 表单提示；完整 Agent 起草可后续 |
| 已落地 | **定时运行拒绝** `manage_schedule` / `fs_delete` / `run_command` / `run_script`；跑途中暂停/删除不被收尾写回 | WorkBuddy 非交互拒绝未批准动作；千问办公敏感操作没权限就做不成 | 2026-09-30。拒绝记入本期工具记录。报告型仍可出图、导出 |
| 已落地 | **钉钉一律 markdown**，去掉工具轨迹，避开 `_` / `[NORMAL]`；问号任务名不当标题 | 推送正文必须可读 | 2026-09-30。保存时也拒绝几乎全是问号的名称/指令 |
| 已落地 | **立即执行**（不改原周期） | 千问办公 | `POST /chat/schedules/:id/run` |
| 已落地 | **删除任务保留历史会话**；执行记录可筛成功/失败 | 千问办公 | 2026-09-30 |
| 已落地 | **动态节奏**（告警中加密、恢复后回到 cron） | CodeBuddy 改间隔 + Qwen `ScheduleWakeup` | 引擎算下一拍，不改已存 cron，也不交给模型改 |
| 已落地 | **事件唤醒** | Qwen `monitor` | `POST /chat/schedules/:id/wake`，带原因，不改原周期。外部日志流接入仍由调用方发这个请求 |
| 不做 | 阈值 / 维度一级表单化 | — | 继续「条件进指令」，避免 Datadog 重表单 |

### 5.3 不建议照搬的点

- **CLI 会话级、退出即死**：与我们「无人值守业务预警」目标相反。  
- **循环任务 3～7 天自动过期**：可作为「临时盯梢」选项，不应成为默认业务预警行为。  
- **把通知完全交给模型「自己决定推不推」**：无标记协议时，投递旁路无法做冷静期与审计；我们应继续 **模型只打标、引擎决定推**。

---

## 6. 产品叙事（摘要）

心智分档与主路径文案、指令脚手架的**唯一正文**在 `scheduled-spike-detection-plan.md` §0 / §2 / §4。  
此处不重复脚手架，避免改一处漏一处。

```text
周期报告  → 完整结论（可出图）；每期都推
数据预警  → 先测后跑 → 仅判定；仅异常推；短正文
临时盯梢  → （P3）类 /loop，不必进主表单
```

---

## 7. 参考链接

| 主题 | URL |
|---|---|
| ChatGPT Automations | https://learn.chatgpt.com/docs/automations |
| Monitoring 指令写法综述 | https://iziraa.com/how-to-schedule-tasks-with-chatgpt/ |
| AIO 告警节奏 playbook | https://getcito.com/how-to-choose-aio-monitoring-cadence-and-build-high-impact-alerts |
| CodeBuddy 定时任务 | https://www.codebuddy.ai/docs/zh/cli/scheduled-tasks |
| WorkBuddy 自动化 | https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide |
| Qwen Code 定时任务 | https://qwenlm.github.io/qwen-code-docs/zh/users/features/scheduled-tasks/ |
| Qwen `monitor` | https://qwenlm.github.io/qwen-code-docs/zh/developers/tools/monitor/ |
| Qoder `/loop` 动态唤醒 | https://developer.aliyun.com/article/1753198 |
| 千问办公网页定时任务 | https://qwenwork.cn/docs/web/scheduled-tasks |
| 千问办公桌面定时任务 | https://help.aliyun.com/zh/qwenwork/qwenwork-scheduled-tasks-desktop |
| WorkBuddy 权限模式（非交互） | https://cloud.tencent.cn/document/product/1831/137058 |
| 对齐总清单（A1–A6 已落地） | `docs/best-practice-alignment-review.md` |
| 本仓库预警方案（SSOT） | `docs/scheduled-spike-detection-plan.md` |

---

## 8. 文档自检

- [x] 竞品能力来自公开文档/文章  
- [x] 与已落地 P1～P2.5 无矛盾；产品正文不在本文重复  
- [x] 动态节奏与事件唤醒已落地；「条件进指令」与「引擎只认标记」红线仍在 §5
