# Metabase 数据分析 Agent 设计（定稿）

> **状态**：设计定稿（待实现计划）  
> **日期**：2026-09-09  
> **宿主**：bx-admin-agent（`apps/web` + `apps/agent-server`）  
> **关联**：取代 [`docs/通用数据分析Agent方案.md`](../../通用数据分析Agent方案.md) 中「以 `call_api` 为权威取数」的路径；Multi-Agent Worker 装配见 `docs/agent/MULTI_AGENT_ARCHITECTURE.md`  
> **产品范围**：对话取数 + 自动巡检预警（交付按 M1→M2→M3 切分，范围不砍）

---

## 1. 一句话定位

用户用自然语言提问 → LLM 理解并生成一条或多条 SQL → 确定性护栏校验 → 经 Metabase 并行执行 →（可选）结果校对 → 汇总为表/图交付；语义层只做说明书与安全带，不替代 LLM 写 SQL。

入口为独立应用页 `/analytics`，会话与后台管理 Agent（`/chat`）隔离。权威数据源仅为 Metabase（[bi.vmovs.com](https://bi.vmovs.com)），不经后台业务 `call_api` 取数。

---

## 2. 目标与非目标

### 2.1 目标

- 通用分析能力：换场景 = 加语义层场景包（pack）+ 评测用例，不改执行内核。
- 主链路：NL → SQL(s) → 护栏 → 并行执行 → 汇总展示（优先 Metabase 表/图能力）。
- V1 含对话分析与可配置的自动巡检预警（钉钉 + 应用内）。
- 质量闭环：离线评测门禁、执行前护栏、执行后 LLM 校对、自纠错、审计与用户反馈回流。

### 2.2 非目标（V1）

- 与 `/chat` 混用同一会话或混用后台写操作工具集。
- 按人绑定 Metabase 凭证（预留升级路径）。
- 修改正式 dashboard / 正式 collection。
- PII 列深治、行级多租户隔离（文档标明服务账号下的风险，后置）。
- Best-of-N 多候选 SQL、完整向量语义缓存、全量错误经验记忆库。

### 2.3 与旧方案关系

| 旧草案（2026-09-08） | 本定稿 |
|---------------------|--------|
| `call_api` 取投放数据 | **废止为本 Agent 权威路径** |
| 语义层偏「模板填槽」易被误解 | **LLM 主生成**；examples/question 仅加速 |
| 前端 ECharts 为主 | **dataset 默认**；按需 Metabase 临时 card；否则本地 ECharts |

旧文保留作历史参考，文首应指向本文。

---

## 3. 产品形态

### 3.1 入口与权限

- 路由：`/analytics`（独立页，类观影助手隔离方式）。
- 鉴权：复用现有 Web 登录 + **运营/数据白名单**。
- Metabase：服务端 **服务账号** 代查（MVP）；预留按人凭证。

### 3.2 意图模型（章程例外）

本 Agent **不**使用后台管理四元组 `[project, module, value, operation]`。

分析意图槽位（逻辑字段，实现时可 JSON schema 化）：

| 槽位 | 说明 |
|------|------|
| metrics | 指标列表 |
| dimensions | 维度与是否下钻 |
| time_range | 日粒度起止（缺则反问；语义层可标 required） |
| comparisons | 昨日 / 上周同期等 |
| filters | 渠道、语言、包体等 |
| output | table / chart / both |
| scenario_pack | 可选，命中已知 pack |

反问策略：一次只问一个缺失关键槽位（优先时间范围）。

### 3.3 写确认例外（章程例外）

- 在配置的 `tempCardCollectionId` 内 **自动创建临时 card：免人工确认**。
- 写入正式 collection / 修改 dashboard：**禁止**（或未来若开放则必须确认）。

---

## 4. 总体架构

```
用户 ──► apps/web /analytics（独立会话）
              │
              ▼
         agent-server
         ├─ 固定装配 Worker: analytics-bi
         │    tools: metabase_* / render_table / summarize_chart_data /
         │           export_dataset / request_clarification / …
         ├─ Semantic Layer（热更新 JSON，带 version）
         └─ Metabase Client ──► https://bi.vmovs.com
              run dataset | run question | explain estimate
              | create temp card（按需）| fetch viz（按需）

巡检：手工「运行巡检」或外部 cron
         ──► POST /internal/analytics/scan（异步 job）
         ──► 同执行内核 → 阈值判定（安静条件 + 父告警聚合）
         ──► 钉钉 kind=analytics（dedup）+ 应用内 + 深链
```

**设计选择（已拍板）**：配置驱动 Worker + **自研 `metabase_*` 薄封装为主**；社区 Metabase MCP 能接则接作补充，不作为能力正文的双主叙事。

### 4.1 `metabase_*` 最小工具集

| 工具 | 职责 |
|------|------|
| `metabase_run_dataset` | 执行原生 SQL / ad-hoc 查询，返回行列 |
| `metabase_run_question` | 执行已有 question（+ 参数） |
| `metabase_explain_estimate` | ClickHouse `EXPLAIN ESTIMATE` 类扫描估计 |
| `metabase_create_temp_card` | 仅写入临时 collection（按需） |
| `metabase_fetch_viz` | 拉取临时/已有 card 可视化信息 |
| （可选）list_questions / schema_introspect | 发现与对账 |

---

## 5. 语义层

### 5.1 定位

给 LLM 的 **说明书 + 安全带**：

- 有哪些表/字段、枚举、指标口径、参考 SQL、可绑定的 Metabase question。
- 表白名单、`required_filters`、LIMIT/超时/估计阈值、临时 card 目录。

**不是**「填槽拼死模板替代 LLM」的引擎。主路径始终是 LLM 生成 SQL（可多条）。`examples` 与 `questionBindings` 仅作加速与口径锚定。

### 5.2 配置（可热更新）

逻辑结构（文件路径实现阶段定，加载方式支持热更新）：

- `datasource`：引擎（ClickHouse）、`metabaseDatabaseId`
- `tables`：允许查询的表及字段说明（V1 **表级白名单强制**）
- `dimensions` / `metrics`：口径与枚举映射
- `required_filters`：如强制日期范围
- `examples`：参考 SQL（如人均时长）
- `questionBindings`：标准 question id
- `scenario_packs`：场景包（可扩展）
- `guards`：maxRows、timeout、estimate 阈值、并行度、maxRewriteRounds、tempCardCollectionId、tempCardTtl
- `version`：变更后语义缓存失效

**列级白名单**：后置；V1 不作为执行门禁。

### 5.3 场景包

投放相关维度/漏斗指标（日、渠道、语言、包体；曝光→点击→播放→支付；CTR/CVR/ROI）仅为 **示例 pack 之一**，不是需求全集。新场景 = 新 pack 配置 + 评测用例。

### 5.4 Schema 漂移

定期对比语义层声明与 Metabase/库实际字段；不一致则告警，相关 pack 可标 `degraded`。

---

## 6. 对话主链路（唯一叙述）

```
自然语言
  →（薄）语义缓存：归一化问句精确命中则复用已校验产物
  → LLM 理解 → 填充分析槽位；注入裁剪后的 schema 切片（薄：按 pack/关键词）
  → 生成 1..N 条 SQL；若命中 questionBinding 可直接 run_question
  → ① 确定性护栏（见 §7）
  → 并行在 Metabase 执行（并行度上限 + 限流退避）
  → 状态区分：success | empty | error
       empty ≠ 业务零；禁止把无数据说成「转化率为 0」或编造
  → 执行失败或校对失败 → 自纠错（默认 ≤ 2 轮）
  → ② LLM 校对（默认开）：问句 + SQL + 截断结果摘要/样例行
       短路：标准 question 未改写，或状态为 empty → 可跳过
  → 汇总（grain 规则，见 §6.1）
  → 展示（见 §6.2）
  → 来源条 + SQL 默认折叠可展开
  → 审计账本；UI「有用/有误」→ 回流评测集
```

**Prompt 注入**：用户原文不得升格为系统指令；越权/写操作只认护栏与工具策略结果。  
**进模型数据**：校对/总结只喂摘要与样例行（建议 ≤10–50 行），全量结果不进 LLM。  
**多轮（薄）**：继承上轮时间/渠道/语言/包体等槽位。  
**分步出数（薄）**：子查询完成可先上屏，再出汇总。

### 6.1 Grain 对齐与合并

- **同 grain**（相同时间粒度与主维度集合）：可合并为 **一张** 汇总表。
- **异 grain**：输出 **多表或多 card**，来源条标明各自 grain；**禁止**硬拼成一张宽表导致静默错数。

### 6.2 展示策略（唯一叙述）

| 情况 | 做法 |
|------|------|
| 默认 | `run_dataset` / question 结果 → 对话内表格 |
| 需要官方 Metabase 图，或用户要求保存到 BI，或巡检需固化 | 创建 **临时 card** + `fetch_viz` |
| 有结果但无合适 Metabase viz | 本地 `summarize_chart_data` + ECharts |
| Metabase 行截断 | 感知 `rows_truncated` / 导出上限；标明「预览截断」，大导出走 export 通道 |

**默认不每问建 card**，避免刷爆 Metabase 与触达 API 限流。

### 6.3 来源条（每张表/图必附）

- 使用的表、关键过滤、时间窗  
- 语义层 `version`  
- SQL（折叠）  
- 临时 card 链接（若有）  
- 子查询列表与 grain 说明（若多查）

---

## 7. 确定性护栏（执行前，强制）

使用 SQL 解析（如 sqlglot 思路），fail-closed：

1. 单条 `SELECT` / `WITH … SELECT`；禁止 DDL/DML/多语句。  
2. 引用表 ∈ 表白名单。  
3. 满足 `required_filters`（缺则拦截并反问，不执行）。  
4. 服务端强制 `LIMIT`（可配置上限）+ 语句超时。  
5. **扫描估计**：经 `EXPLAIN ESTIMATE`（或 Metabase 侧等价信息）检查估计 rows/marks/parts。  
   - **局限（必须写进实现与对用户文案）**：ClickHouse **无**精确 CPU/费用 dry-run；`EXPLAIN ESTIMATE` **可能忽略 LIMIT、偏高估**。  
   - V1 策略：估计阈值拒绝明显全表狂扫 + 硬超时 + 强制 LIMIT，不宣称「精确费用拦截」。  
6. Metabase 服务账号只读权限为第二道防线。

---

## 8. 质量闭环（唯一叙述）

### 8.1 离线评测

样例字段：`id | NL | gold SQL 或期望结果形状 | scenario_pack | should_refuse | difficulty`

指标：

- **EX**：执行结果与 gold 对齐（主指标；允许 SQL 写法不同）  
- 护栏命中率、拒答准确率、**CWR**（自信地错，越低越好）

发版/合并门禁：评测不达标不视为可发布。评测尽量钉死日期或使用只读快照，降低 EX 抖动。

种子集：先覆盖示例 pack（约 20–50 条）；每加 pack 必加回归用例。

### 8.2 运行时

- 执行前：§7  
- 执行后：LLM 校对（默认开，可配置关；含短路）  
- 自纠错：默认最多 2 轮，耗尽则拒答并写审计原因  

### 8.3 审计与反馈

落库：问句、SQL、护栏结果、估计摘要、校对结论、card id、耗时、rewrite 次数、失败分类、语义层 version、用户 id。

UI：有用 / 有误 + 错因标签 → 回流评测集。

### 8.4 明确不做（V1）

- Best-of-N 多候选 SQL  
- 全量 Memo 式错误经验库（有限自纠错足够）

---

## 9. 巡检预警

### 9.1 原则

- 与对话 **共用同一执行内核**（语义层、护栏、Metabase），避免双口径。  
- 巡检默认配置：**关闭二次 LLM 校对**；**不创建临时 card**（除非规则 `persistCard=true`），降低成本与 Metabase 写压力。  
- 护栏、`EXPLAIN ESTIMATE` 阈值、LIMIT/超时在巡检中仍强制。  
- 与对话请求 **配额隔离**（独立并行度/QPS 预算）。

### 9.2 触发与 API

1. 应用内「运行巡检」按钮（先验证逻辑）。  
2. 外部 cron / 调度 → 内部 API（需内部鉴权）。

**API 命名（中性，非绑死 ROI）**：`POST /internal/analytics/scan`  
- Body 示例字段：`ruleSetId`、`scanDate`（可选，默认按 §9.4 窗口）、`forceRerun`、`dryRun`（默认 false）  
- **异步**：立即返回 `{ jobId }`；通过 `GET /internal/analytics/scan/:jobId`（或等价）查状态与结果摘要。手工按钮与 cron 共用此模型，避免同步 HTTP 超时。  
- **`dryRun=true`**：完整取数与阈值计算，**不推钉钉、不写正式告警记录**（可写 job 结果供联调）；应用内可查看 dry-run 结果。

**内部鉴权（R29）**：V1 选定一种并写进部署说明——推荐 **内网-only + 共享密钥**（`Authorization: Bearer <SCAN_INTERNAL_TOKEN>`）；不采用「无鉴权仅靠路径隐蔽」。

不做「仅绑在聊天进程里的隐蔽 setInterval」作为唯一调度；与请求处理解耦。  
运维示例（部署时替换）：每日固定时刻 `curl -X POST .../internal/analytics/scan -H 'Authorization: Bearer …' -d '{"ruleSetId":"default"}'`。

### 9.2.1 Job 状态机（R19）

状态：`queued` → `running` → `succeeded` | `partial` | `failed` | `cancelled`。

- `jobTimeout`：超时未结束 → 标 `failed`，并发 **运维告警**（scan 未跑成），与业务 ROI 告警分离。  
- 同 `scanDate + ruleSetId` 已有 `running` → 返回 `scan_job_running`（拒绝或排队，配置二选一，默认拒绝）。

### 9.3 规则配置（可扩展，ROI 仅为默认示例）

规则集（`ruleSet`）配置化，字段逻辑包括：

| 字段 | 说明 |
|------|------|
| metrics | 如 ROI（可扩展 CTR/CVR 等） |
| baselines | 默认 `["dod","wow"]`（日环比、周同比） |
| baselineLogic | 默认 **`any`**：任一基线破线即 warn；文案必须写明对比的是 dod 还是 wow |
| threshold | 默认相对下降 &gt; 10%（ratio &lt; 0.9） |
| minAbsDelta | 最小绝对变化 ε（R20）；默认可 0；与相对阈值 **同时满足** 才发 warn（`ratio 破线 AND \|Δ\| ≥ ε`） |
| dimensions | 汇总维度（如 channel）；下钻维度（language、package…） |
| quietRules | 见 §9.5 |
| persistCard | 默认 false |
| maxChildAlerts | 下钻子告警上限（默认建议 ≤ 5） |
| businessTimezone | 见 §9.4 |
| freshnessCheck | 见 §9.4.1 |

禁止把公式与阈值写死为代码常量；进配置/语义层。

### 9.4 时间窗口与时区（R18）

- 配置 **`businessTimezone`**（待业务对齐，如运营约定时区）；**T-1 / T-2 / T-8 均按此时区切日**，禁止默默使用服务器本地时区。  
- 默认巡检对象为 **已闭合业务日**：扫描 **T-1** 完整日，与 **T-2（dod）**、**T-8（wow）** 对比。  
- `scanDate` 显式传入时仍按「该日完整日」解释，不默认「运行时刻的滚动 24h」。  
- 进数延迟由运维/配置约定（如每天 10:00 跑 T-1）。

### 9.4.1 数据就绪（R17）

跑阈值前先做 **freshness 检查**（配置 `freshnessCheck`），例如：

- 事实表 `max(业务日) ≥ scanDate`；或  
- 配置化 watermark SQL / Metabase question 返回就绪布尔值。

未通过 → job 记 `data_not_ready`，**不跑业务阈值告警**（可 info）；可发运维级「数据未就绪，巡检跳过」视配置而定（默认建议 info，避免与 ROI 告警疲劳混同）。

### 9.5 安静条件（不告警或降级为 info）

以下情况 **不发 warn/critical 业务异常告警**（可记 info「数据不足」或仅写巡检日志）：

- 结果 `empty`  
- 基线缺失、分母为 0、ROI 无定义  
- 样本过小（配置 `minSample`，如支付人数/消耗低于阈值）  
- 数据日未就绪（`data_not_ready`）  
- 相对破线但 `|Δ| < minAbsDelta`（未过绝对门槛）

避免把「没数」打成「ROI=0 暴跌」。

### 9.6 告警聚合、级别与部分失败（R21）

- **先发一条父告警**（渠道/规则汇总）；下钻细节进应用内详情或父告警正文摘要。  
- 子告警条数 ≤ `maxChildAlerts`；超出截断并注明「另有 K 个细分」。  
- 级别：`info`（数据不足/未就绪）/ `warn`（破阈值）/ `critical`（多渠道同时破线，或连续 N 天破线——N 可配置，V1 可先只实现多渠道同时）。  
- **部分实体查询失败**：job 状态 `partial`；成功实体照常做阈值；失败实体进入「巡检不完整」运维摘要，**不得**把执行失败解释为 ROI 暴跌。

### 9.7 通知通道

- **钉钉 + 应用内** 均要。  
- 扩展现有 `alert-notify`：新增独立 kind（如 `analytics`），**独立开关与 dedup 命名空间**，不与 `budget` / `degrade` 混用。  
- Dedup fingerprint：`ruleSetId + scanDate + metric + entityKey + baseline + severity [+ rerunSeq]`（见 §9.8）。  
- **多实例**：进程内存 dedup 在多 PM2 实例下会重复推。V1 约定其一：  
  - 仅指定实例跑巡检；或  
  - 指纹落到共享存储（DB/Redis）再推送。  
  文档与部署说明必须写清所选方案。  
- 文案含：指标、基线类型（dod/wow）、相对与绝对变化、时间窗、父/子摘要、**深链到 `/analytics`（预填时间与维度）**、**一句话 runbook**（R22：如「打开深链核对来源条 → 按语言/包体下钻 → 确认后可 forceRerun」）。

### 9.8 幂等与重跑（R28 定死默认）

- 同一 `scanDate + ruleSetId` 默认一天一套结果。  
- **`forceRerun=true`**：覆盖应用内结果并标 `rerun`；`rerunSeq` 递增；钉钉 fingerprint **包含 `rerunSeq`**，从而：  
  - 不会被「旧 fingerprint + dedup 窗口」吞掉真正的重跑通知；  
  - 也不会在未 force 时重复刷屏。  
- 禁止「覆盖了结果但 dedup 仍按旧指纹静默丢弃」的中间态。

### 9.9 巡检产物

- 汇总表 + 来源条 + job 记录（可查，含 dry-run）。  
- 默认不建临时 card；`persistCard=true` 时才写。  
- 应用内可浏览历史 job / 告警列表（M3 验收）。

### 9.10 本节后置（文档占位，V1 不做）

- 告警认领（ack）与值班表  
- 夜间静默 + 早高峰汇总推送  
- 破线恢复后再推「已恢复」通知（次日不再告警即可）  
- 完整 SLO / error-budget / 多窗口 burn-rate  
- 节假日/大促基线特殊规则  
- 多规则复杂 DAG（V1 用规则列表顺序执行）  
- 巡检专用只读副本 / 更低优先级队列  

---


## 10. 失败分类枚举

| 码 | 含义 |
|----|------|
| `guard_reject` | 解析/白名单/必选过滤未过 |
| `estimate_reject` | 扫描估计超阈值 |
| `exec_error` | Metabase/仓库执行错误 |
| `empty` | 执行成功但无行 |
| `verify_fail` | LLM 校对未通过 |
| `rate_limited` | Metabase/LLM 限流 |
| `metabase_down` | 依赖不可用（熔断） |
| `data_not_ready` | 巡检业务日数据未就绪（安静/info） |
| `scan_job_running` | 同 scanDate+ruleSet 任务仍在跑（幂等拒绝或排队） |
| `scan_job_timeout` | 巡检 job 超过 jobTimeout |
| `scan_partial` | 部分实体成功、部分执行失败（业务告警仅基于成功实体） |

熔断时：明确降级文案；可走精确问句缓存；**禁止用假数顶上**。巡检失败/超时发 **运维向**通知「巡检未跑成」，与业务阈值告警区分。

---

## 11. 非功能：V1 薄实现 vs 后置

| 项 | V1 薄 | 后置 |
|----|-------|------|
| 语义缓存 | 归一化问句精确命中；version 变失效 | 向量相似 |
| Schema 裁剪 | 按 pack/关键词 | 检索 Top-N |
| 临时 card 生命周期 | TTL + 配额配置 | 自动 GC job |
| 熔断 | 报错 + 禁假数 | 缓存应答顶上 |
| 凭证 | 服务账号 | 按人绑定 |
| 列/行安全 | 表白名单 + 服务账号权限 | 列白名单门禁、行级租户、PII |

并发：全局/每用户查询并行度上限；Metabase query API 退避重试。

---

## 12. 里程碑与验收

| 里程碑 | 验收标准 |
|--------|----------|
| **M1** | `/analytics` 可对话；NL→SQL→护栏→并行→表；来源条+SQL 折叠；示例 pack 真数或可说明的联调数据；空结果语义正确 |
| **M2** | 校对+自纠错+评测门禁；按需临时 card/双轨图；审计与点赞回流；截断感知 |
| **M3** | 手工巡检 + 外部 cron 调异步 `/internal/analytics/scan`；freshness + businessTimezone；job 状态机含 partial/timeout；相对+绝对阈值；dryRun；钉钉 `analytics` kind + rerunSeq dedup；应用内 job/告警列表与深链+runbook；多实例 dedup 方案已落地 |

---

## 13. 待业务 / BI 对齐清单（上线前必填）

- 各 pack 的表、字段、渠道/语言/包体枚举映射  
- CTR / CVR / ROI 公式与「消耗」等字段来源  
- Metabase `databaseId`、临时 collection、服务账号权限范围  
- 巡检默认监控对象（渠道集合等）、钉钉通知群、每日跑数时刻（T-1 闭合后）  
- `businessTimezone`、`freshnessCheck` / watermark、`minSample`、`minAbsDelta`、连续 N 天 critical、`maxChildAlerts`、`jobTimeout`  
- 示例 pack 中包体维度的真实取值（原「xxxxxx」占位）  
- 多实例部署下巡检指纹存储方案（单实例跑 vs Redis/DB）  
- `SCAN_INTERNAL_TOKEN`（或等价）与内网暴露方式

未对齐前：允许绑定已有 Metabase question 跑通编排；**禁止假装口径已定死进代码常量**。

---

## 14. 五层归属（对齐 AGENT_CHARTER）

| 层 | 本设计落点 |
|----|------------|
| workflow | `/analytics` 会话；Worker 装配；巡检 internal API；M1–M3 编排 |
| skill | 分析意图槽位、grain 合并、校对/拒答话术模板 |
| MCP | 自研 `metabase_*` 经 tools 注册并可 MCP 出口暴露；可选社区 Metabase MCP |
| tools | `metabase_*`、`render_table`、`summarize_chart_data`、`export_dataset`、`request_clarification` |
| superpower | 语义层 JSON、护栏与阈值配置、评测集、告警 dedup 配置 |

---

## 15. 自检记录（Spec Self-Review）

| 检查 | 结果 |
|------|------|
| Placeholder | 业务字段与 pack 细节显式列入 §13「待对齐」，无假装已定 |
| 内部一致性 | 已统一为 LLM 主生成；按需 card；CH 估计局限；无 call_api 双主路径 |
| 范围 | 产品含巡检；交付用里程碑切开，单计划可按 M1 起步 |
| 歧义 | 「一张表」已用 grain 规则消歧；「贵查询」已改为 ESTIMATE+超时+LIMIT |

---

## 16. 修订摘要（相对草案讨论）

- **FIX**：ClickHouse 费用模型；按需临时 card；grain 合并；分析意图；阈值配置化；里程碑表达。  
- **MERGE**：取消「路径 A/B 填槽」双叙事；出图/质量/MCP 各保留单一说法。  
- **CUT**：call_api 权威取数；后台四元组；列白名单门禁；Best-of-N；示例 pack=全集。  
- **ADD**：工具最小集；章程例外；截断/校对短路/dedup；失败枚举；联调清单；来源条。  
- **ADD（§9 巡检强化）**：中性异步 `/internal/analytics/scan`；固定 T-1 窗口；安静条件；父告警聚合；`analytics` 告警 kind；多实例 dedup；幂等；深链；默认关校对/关临时 card；baselines=`any` 语义写清。  
- **ADD（§9 第二轮）**：freshness 就绪检查；businessTimezone；job 状态机与 timeout；minAbsDelta；partial 失败语义；runbook 文案；dryRun；forceRerun+rerunSeq dedup 定死；内部鉴权方式点明。
