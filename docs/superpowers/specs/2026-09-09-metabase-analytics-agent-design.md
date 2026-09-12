# Metabase 数据分析 Agent 设计（定稿）

> **状态**：设计定稿；**M1 / M2 / M3 已验收**（2026-09-10，见 §12 / 各验收清单）  
> **日期**：2026-09-09（实现收口 2026-09-10；**2026-09-12 架构权威收口为 A：语义层编译**）  
> **宿主**：bx-admin-agent（`apps/web` + `apps/agent-server`）  
> **关联**：取代 [`docs/通用数据分析Agent方案.md`](../../通用数据分析Agent方案.md) 中「以 `call_api` 为权威取数」的路径；Multi-Agent Worker 装配见 `docs/agent/MULTI_AGENT_ARCHITECTURE.md`  
> **产品范围**：对话取数 + 自动巡检预警（交付按 M1→M2→M3 切分，范围不砍）  
> **质量硬门槛**：发版须同时满足 **正确率 EX ≥ 85%** 与 **拒答召回 ≥ 95%**（CWR ≤ 10%）；详见 §8。禁止以「查询能跑通」替代。  
> **实现就绪**：对话取数 / 质量门禁 / 巡检主路径已落地。可答 EX 门禁待人工将 provisional→gold；§12.1.1–12.1.4 为定稿当日历史快照。  
> **可靠性增强（2026-09-11 设计）**：诉求一致性闸门 / 多步规划 / 用户记忆 / 宽表·多指标 → [`2026-09-11-analytics-reliability-roadmap.md`](./2026-09-11-analytics-reliability-roadmap.md)

---

## 1. 一句话定位

用户用自然语言提问 → 时间确定性 resolve → Structure / TurnIntent（LLM **填槽，不写 SQL**）→ 能力/覆盖/歧义/接地闸 → Intent → **确定性 sql-compile** → lint / Verify → Metabase 执行 → 表/图交付。  
**允许**全局引擎默认（如 `distinctCountFn=uniq`、缺年=today 年）；渠道/维值别名以 **pack + Metabase lexicon/probe** 为源，禁止代码里维护产品白名单当主路径；**禁止**模型自猜「今天/缺年/去重口径」或私自写 SQL。对齐业界：**语义层编译（A）为权威**；B（LLM 写 SQL + 执行回写）为非目标。

入口为独立应用页 `/analytics`，会话与后台管理 Agent（`/chat`）隔离。权威数据源仅为 Metabase（[bi.vmovs.com](https://bi.vmovs.com)），不经后台业务 `call_api` 取数。

---

## 2. 目标与非目标

### 2.1 目标

- 通用分析能力：换场景 = 加语义层场景包（pack）+ 评测用例，不改执行内核。
- 主链路：NL → **时间 resolve** → Structure/TurnIntent 填槽 → 闸门 → **Intent 编译 SQL** → 护栏 → 并行执行 → 汇总展示（优先 Metabase 表/图能力）。
- V1 含对话分析与可配置的自动巡检预警（钉钉 + 应用内）。
- **质量双保证（必须）**：
  - **正确率（EX）**：可答题结果与 gold 对齐，发版默认 **≥ 85%**（M2 争取 ≥ 90%）；
  - **拒答召回（RefuseRecall）**：应拒答/反问题未执行查数，发版默认 **≥ 95%**；
  - 同步约束 **CWR（静默错）≤ 10%**；二者缺一不可（§8.1.1–§8.1.2）。
- 质量手段：**结构口径（§5.5）+ 全局引擎默认**、执行前护栏/Verify、执行后校对、自纠错、离线评测 CI、审计回流（**非**手维逐指标公式表）。

### 2.2 非目标（V1）

- 与 `/chat` 混用同一会话或混用后台写操作工具集。
- 按人绑定 Metabase 凭证（预留升级路径）。
- 修改正式 dashboard / 正式 collection。
- PII 列深治、行级多租户隔离（文档标明服务账号下的风险，后置）。
- Best-of-N 多候选 SQL、完整向量语义缓存、全量错误经验记忆库。
- 用「HTTP 成功 / 有返回行」宣称质量达标（必须看 EX + 拒答召回门禁）。

### 2.3 与旧方案关系

| 旧草案（2026-09-08） | 本定稿 |
|---------------------|--------|
| `call_api` 取投放数据 | **废止为本 Agent 权威路径** |
| 语义层偏「模板填槽」易被误解 | **LLM 填槽 + 代码编译 SQL**；examples/question 仅加速 |
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

### 4.2 与小龙虾（OpenClaw）的接入关系（可选通道，非替代主产品）

> **小龙虾** = [OpenClaw](https://docs.openclaw.ai/)（社区俗称）。  
> **结论**：**可以**用小龙虾侧的**任意接入手段**（MCP 注册表、Plugin `registerTool`、Skill、Channel、HTTP 壳等）接到本分析能力；**本仓分析内核与护栏不必为小龙虾改架构**。  
> **前提**：小龙虾只作入口/宿主，**一律调用本仓受控出口**；禁止用裸社区 Metabase MCP / 自写 SQL 工具绕过 §7/§8 还宣称达标。  
> 参考：[OpenClaw MCP](https://docs.openclaw.ai/cli/mcp)、[插件 Agent 工具](https://docs.openclaw.ai/zh-CN/plugins/building-plugins)、[Tools 总览](https://docs.openclaw.ai/tools)。

| 问题 | 答案 |
|------|------|
| 要不要为小龙虾改主架构？ | **不用。** `/analytics` + `analytics-bi` + `metabase_*` + P0 流水线仍是唯一权威内核 |
| 小龙虾侧能否「随便用哪种工具接」？ | **能**，只要最终打到本仓 **稳定 facade**（见下） |
| 今天能否接好用？ | **不能端到端**（§12.1）；先 M1 再联调 |
| 是否替代 `/analytics`？ | **否**；小龙虾是可选入口 |

#### 4.2.1 本仓须提供的稳定 facade（实现约束，一次做对）

为兼容小龙虾多种接法，M1/M2 在本仓至少落地其一（推荐两者都有）：

| Facade | 形态 | 供小龙虾怎么用 |
|--------|------|----------------|
| **A. MCP 工具出口** | 现有 `/mcp` 或独立 `analytics` MCP：暴露受控 `metabase_*` +（推荐）聚合工具 `analytics_ask`（NL→本仓全流水线→表摘要） | `openclaw mcp add`；或插件里再包一层 MCP client |
| **B. HTTP 会话/一问一答 API** | 与 `/analytics` 同源编排；鉴权后 `POST` NL，返回表/拒答/来源条 | Skill / Plugin `execute` / Channel bot 直接 HTTP |

**推荐再提供**：`analytics_ask`（或等价）**单工具封装整条 P0 流水线**，这样小龙虾用 Plugin、Skill、MCP 任一方式都只需调一个入口，避免在小龙虾侧散落「自己拼 Probe/Verify」。

#### 4.2.2 小龙虾侧可用的接入方式（均允许，不绑定一种）

| 小龙虾手段 | 怎么接到本仓 | 本仓改动？ |
|------------|--------------|------------|
| **MCP 注册表**（`openclaw mcp add/set`） | 指向本仓 MCP（facade A） | 无架构变更；实现期暴露 MCP |
| **Plugin `api.registerTool`** | `execute` 内调本仓 HTTP（B）或 MCP（A）；`optional: true`；清单 `contracts.tools` | 可选：另发一个薄插件包（npm/ClawHub/本地），**非**本仓内核必改 |
| **Skill** | 教模型「问数必须调 `analytics_ask` / 本仓 MCP」 | 文档/skill 文件即可 |
| **Channel / Gateway 会话** | 用户在 IM 说话 → 该 agent 的 tools.allow 含上述工具 | 配置项；内核不变 |
| **`openclaw mcp serve`** | 外部 IDE 读小龙虾频道 | 与取数正交，不替代 facade |

**原则**：「任何小龙虾工具」= 入口形态任意；**不允许**入口形态绕过本仓护栏另起炉灶。

#### 4.2.3 必须守住的边界（与接入手段无关）

1. **护栏留在本仓**：只读、表白名单、`required_filters`、时间 resolve、`distinctCountFn`、grain/列 Verify、结构化回写。  
2. **凭证**：Metabase 服务账号只在本仓；小龙虾只持本仓 MCP/API 调用凭据。  
3. **工具隔离**：小龙虾 analytics agent 的 `tools.allow` 勿混入后台写操作 `call_api`。  
4. **巡检**：仍走本仓 `/internal/analytics/scan`；小龙虾最多转发告警。  
5. **验收**：任一入口的结果仍按 §8 同一套 EX/拒答口径。

#### 4.2.4 落地顺序

```
M1：本仓内核 + facade A 和/或 B（建议含 analytics_ask）
  → 小龙虾任选：mcp add  /  薄 plugin  /  skill+allow
  → 联调一口语问数
  → （可选）发布 ClawHub/npm 薄插件，降低配置成本
```

**一句话**：**架构不用为小龙虾重构**；实现上补齐 **MCP/HTTP facade（最好带一问一答聚合工具）**，即可用小龙虾任意工具面接入。未实现 facade 前，不宣称「已用小龙虾接入可分析」。

---

## 5. 语义层

### 5.1 定位

给 LLM 的 **说明书 + 安全带**（结构契约，不是业务词典）：

- 有哪些表/字段、**指标公式/日期表达式**、参考 SQL、可绑定的 Metabase question。
- 表白名单、`required_filters`、LIMIT/超时/估计阈值、临时 card 目录。
- 维度列可声明「取值靠库内 Probe」，**禁止**把「泰卢固→te-IN」类中文同义词表当作主路径。

**对齐主流 Agent**：LLM 声明槽位/修订，**代码编译与校验**；Probe / lexicon 接地维值，不是「业务词写死路由」。

主路径是 **语义层编译（A）**：LLM 不写 SQL。`examples` 与 `questionBindings` 仅作加速与口径锚定。Agentic Text-to-SQL（B：生成→执行→改写 SQL）为历史方案，**不是**本仓权威。

### 5.2 配置（可热更新）

逻辑结构（文件路径实现阶段定，加载方式支持热更新）：

- `datasource`：引擎（ClickHouse）、`metabaseDatabaseId`
- `tables`：允许查询的表及字段说明（V1 **表级白名单强制**）
- `dimensions` / `metrics`：**结构约定说明书**（表列说明、`toDate`、示例 SQL）；**禁止**手维「逐指标公式表」作权威（见 §5.5 / §7.2）
- `required_filters`：如强制日期范围（缺失则 **服务端反问，禁止执行**——抬拒答召回）
- `time`（或并入 `guards`/`datasource`）：`businessTimezone`、缺年默认策略（见 §6.3）、是否回显已解析区间
- `examples`：参考 SQL（加速用，与评测 gold 可对齐；**非**逐指标手维权威）
- `questionBindings`：标准 question id（可选加速；非必维清单）
- `scenario_packs`：场景包（可扩展）
- `guards`：含 **`distinctCountFn`**（全局默认，见 §7.2）、maxRows、timeout、estimate 阈值、并行度、maxRewriteRounds、maxProbeRounds、tempCardCollectionId、tempCardTtl
- `quality_gates`：可覆盖默认 `GATE_EX_MIN` 等（见 §8.1.2）
- `version`：变更后语义缓存失效

**明确不做（主路径）**：
- 业务同义词 / 枚举 mapping YAML（口语对齐靠 Probe）
- **手维逐指标公式表**（如「观看人数=uniq / ROI=…」逐条维护）作 NL→SQL 权威
- 让模型凭训练记忆自猜「今天 / 缺年」

**允许的「写死」**：仅 **全局引擎默认**（如 `distinctCountFn=uniq`、缺年=today 年）——一次配置，不随业务词表膨胀。

**列级白名单**：后置；V1 不作为执行门禁。

### 5.3 场景包

投放相关维度/漏斗指标（日、渠道、语言、包体；曝光→点击→播放→支付；CTR/CVR/ROI）仅为 **示例 pack 之一**，不是需求全集。新场景 = 新 pack 配置 + 评测用例。

### 5.4 Schema 漂移

定期对比语义层声明与 Metabase/库实际字段；不一致则告警，相关 pack 可标 `degraded`。

### 5.5 口径钉死约定（抬正确率，来自真数评测）

| 约定 | 规则 | 若不钉死的后果（已实测） |
|------|------|---------------------------|
| 日粒度时间 | 过滤/分组用 `toDate(时间列)`，**禁止** `DateTime列 = 'YYYY-MM-DD'` | 结果可变为几十 vs 几十万（静默错） |
| **缺年 / 相对时间** | **确定性 resolve**（§6.3）：请求时 clock + `businessTimezone`；「八月十九」默认年=today 年；禁止模型自猜 2023/24/25 | 口语 NL 缺年时 EX 从可答跌到 ~22%（空表静默错） |
| **按日 grain** | 槽位含「按天/每天」→ SQL 必须按日 `GROUP BY toDate(...)`（机器 Verify） | 用户要按天却只按语言汇总（静默 grain 错） |
| **维/对照 grain** | 槽位点名的主维度（如多渠道对照、按语言）→ 须出现在 `GROUP BY` 或等价展开；机器 Verify | 「三渠道对照」却合成一行日汇总（超复杂 X01） |
| **列意图** | 主 SELECT 仅含问句要求的指标/维度；环比/「谁更高」→ 解读旁路或二次查询 | 核心数对但多算差列 → 形状失败（X05/X08）；评测可用 soft-EX |
| **空语言默认** | 按语言统计默认含 `contentLang=''`；禁止 `contentLang!=''`，除非用户明确排除空/未标语言 | 排行题丢掉空语言 → 人数差一个数量级（并行套 P05） |
| **完整列表** | 排行/对照默认全量；禁止无请求 `LIMIT 1`（除非只要第一名） | Top1 截断导致漏渠道（P05 回归） |
| 人均时长（结构提示） | 推荐 `round(sum(watchSecond)/{distinctCountFn}(guid), 0)`；**不**维护逐指标手维表 | 缺 `round` 易与展示不一致 |
| **去重（全局默认）** | 引擎配置 **`distinctCountFn=uniq`（默认）或 `uniqExact`** 二选一；生成后 **AST 规范化**（§7.2）；**禁止**手维「观看人数用哪个函数」指标表 | `uniq` vs `uniqExact` 静默差数百人（C04 实测） |
| 缺日期等必选槽 | `required_filters` 服务端拦截 | 仅靠模型拒答时召回约 50% |

示例 pack 可放 **examples** 作 few-shot，**不得**演变为逐 KPI 手维权威公式库。

### 5.6 配置边界（拍板）

| 允许 | 禁止 |
|------|------|
| 全局 `distinctCountFn`、`businessTimezone`、缺年默认 | 手维同义词 / 枚举 mapping |
| 表白名单、只读、LIMIT | 手维逐指标 `metrics[].expr` 权威表 |
| Probe 活枚举、examples 加速 | 把「模型再选 uniq/uniqExact」当唯一手段 |
---

## 6. 对话主链路（唯一叙述）

对齐主流 Agent：**工具 + 闭环**（非业务词硬路由）。时间落地 **不靠模型自猜「今天/年份」**（§6.3）。

```
自然语言
  →（薄）语义缓存：归一化问句精确命中则复用已校验产物
  → LLM 理解 → 填充分析槽位；注入裁剪后的 schema 切片（薄：按 pack/关键词）
  → ⓪− 时间确定性 resolve（§6.3）：相对/缺年短语 → 时间 IR → 用请求 clock + businessTimezone 解析为具体 [start,end)
       注入槽位 time_range；交付前回显理解（如「按 2026-08-19～25」）
       仅有「最近」等无法定界 → 反问，禁止执行
  → ⓪ Probe（工具）：对不确定的维度取值，先用 metabase_run_dataset 拉 Top/DISTINCT 真值
       （探哪列由槽位/模型决定，禁止用例级写死业务同义词；控 maxProbeRounds）
  → 生成 1..N 条 SQL（异 grain / 分表对照用 --- 或多候选规划；每条单语句）；若命中 questionBinding 可直接 run_question
       （生成侧注入已 resolve 的 ISO 区间，禁止再让模型自由填年）
  → ① 确定性护栏（见 §7）：**逐条**校验；缺 required_filters → 反问并停止；非 SELECT → 拒绝
  → ①b SQL lint（§7.1：toDate、空语言、渠道、LIMIT 1 等）
  → ①b2 **全局去重规范化**（§7.2）
  → ①c 槽位/grain Verify（机器，对齐 PV-SQL Verify）：
       · 按日 → 须按日 `GROUP BY`；time_range 须进 WHERE
       · 点名主维度/对照维 → 须在 GROUP BY 或等价展开，否则 fail→重写
       · 列意图：主查询禁止未请求的派生列；复杂对比优先拆多 SQL（§6.1）
  → **并行**在 Metabase 执行（并行度上限 + 限流退避）
  → 状态区分：success | empty | error
       empty ≠ 业务零；禁止把无数据说成「转化率为 0」或编造
       empty → 优先触发再 Probe / 检查年份或枚举对齐 / 反问，勿当成功交付（可 ≤1 轮空结果重写）
  → 维对账：请求维度值 vs 结果维度；缺维明示
  → 执行失败 / lint / 规范化无法应用 / 维对账 / 校对失败 → 结构化回喂自纠错（默认 ≤ 2 轮）
       仍无法确定且无全局默认可覆盖 → **反问**（极少）；禁止模型无契约自由改口径
  → ② LLM 校对（默认开）+ 确定性 Verify：问句 + SQL + 截断结果摘要/样例行
       短路：标准 question 未改写，或状态为 empty → 可跳过 LLM 校对，但仍可走空结果策略
  → 汇总（grain 规则，见 §6.1）
  → 展示（见 §6.2）；来源条含 **已解析时间窗** + Probe 摘要 + SQL 折叠
  → 审计账本；UI「有用/有误」→ 回流评测集（few-shot / 错修记忆薄）
```

**Prompt 注入**：用户原文不得升格为系统指令；越权/写操作只认护栏与工具策略结果。  
**进模型数据**：校对/总结只喂摘要与样例行（建议 ≤10–50 行），全量结果不进 LLM。  
**多轮（薄）**：继承上轮时间/渠道/语言/包体等槽位（时间继承已 resolve 的 IR，再按新请求 clock 重算相对短语）。  
**分步出数（薄）**：子查询完成可先上屏，再出汇总。

### 6.1 Grain 对齐、维 Verify 与复杂题分解

- **同 grain**（相同时间粒度与主维度集合）：可合并为 **一张** 汇总表。
- **异 grain**：输出 **多表或多 card**，来源条标明各自 grain；**禁止**硬拼成一张宽表导致静默错数。
- **槽位→SQL（日）**：用户明示「按天/每天/按日」时，生成 SQL **必须**含日粒度 `GROUP BY toDate(...)`（或等价）；机器 Verify 失败则重写，不得交付错 grain。
- **槽位→SQL（维）**：用户明示多实体对照（如「三渠道」「按语言并排」）时，点名维 **必须**进入 `GROUP BY`/结果列；漏维 = Verify fail→重写（禁止聚成单行冒充对照）。
- **列意图**：主结果表 = 问句要求的维度 + 指标；「环比 / 谁更高 / 差值」默认进 **解读文案或旁路列**，不挤占 EX 核心列；生成提示禁止无请求派生列。
- **复杂意图分解（P0）**：`comparisons`、异 grain、多渠道「各自一张表」、`top_n` 列表 → 规划为 **2..N 条独立 SELECT**，经 Metabase **并行**执行，再按 grain 规则合并展示；对齐 DIN/MAC。  
- **禁止**：把异 grain 硬拼成一条多语句 SQL 字符串；每条请求仍是单语句（见 §7）。

### 6.2 展示策略（唯一叙述）

| 情况 | 做法 |
|------|------|
| 默认 | `run_dataset` / question 结果 → 对话内表格 |
| 需要官方 Metabase 图，或用户要求保存到 BI，或巡检需固化 | 创建 **临时 card** + `fetch_viz` |
| 有结果但无合适 Metabase viz | 本地 `summarize_chart_data` + ECharts |
| Metabase 行截断 | 感知 `rows_truncated` / 导出上限；标明「预览截断」，大导出走 export 通道 |

**默认不每问建 card**，避免刷爆 Metabase 与触达 API 限流。

### 6.3 时间确定性 resolve（P0，对齐业界）

> 参考方向：nl2time「carry the clock」、生产 NL2SQL 的 date-anchor、语义层 time-spine；**禁止**模型用训练先验冒充「今天」。

**分工**：

| 角色 | 职责 |
|------|------|
| LLM | 从 NL 抽出时间短语 / 槽位（可模糊：「八月十九到二十五」「上周」「最近」） |
| **系统（确定性）** | 持有请求时刻 clock + `businessTimezone`；把短语 resolve 成具体 `[start, end)`；缺年补默认年；无法定界则反问 |
| 生成 SQL | **只消费已 resolve 的 ISO 日期**，不再自行发明年份 |

**默认策略（V1 可配置，须有默认值）**：

| 情形 | 行为 |
|------|------|
| 完整 `YYYY-MM-DD` | 原样使用（校验合法） |
| 「8月19」「八月十九」等缺年 | **默认年 = `businessTimezone` 下 today 的年**（评测/联调可固定锚点年） |
| 「昨天 / 上周 / 上月」等相对 | 相对 **请求时刻** resolve；存 IR，执行时再算（站立查询勿冻死具体日） |
| 「最近」等无法唯一定界 | **反问**起止或给选项（近7天/本月/上月），**禁止执行** |
| 解析后区间落在未来或明显无数据且结果 empty | 空结果策略：提示已用区间 + 可建议改年/改窗，可 1 轮重写 |

**回显（必须）**：回答或来源条中写明理解，例如「按 **2026-08-19～2026-08-25**（业务时区 Asia/Shanghai）统计」。歧义时先回显再执行或先问再跑。

**反模式（禁止）**：

- 模型直接输出带猜年的 ISO（2023/2024/2025 乱飘）  
- 解析时写死具体日却用于「上周」类站立巡检规则而不重算  
- 全局单一时区忽略用户/业务时区（V1 至少固定 `businessTimezone` 并写进配置）

### 6.4 来源条（每张表/图必附）

- **已解析时间窗**（resolve 后的起止 + 时区；相对短语的原话可附注）  
- 使用的表、关键过滤  
- 语义层 `version`  
- 本次 Probe 摘要（若有）  
- SQL（折叠）  
- 临时 card 链接（若有）  
- 子查询列表与 grain 说明（若多查）

---

## 7. 确定性护栏（执行前，强制）

使用 SQL 解析（如 sqlglot 思路），fail-closed。对 **每一条** 待执行 SQL 分别校验（并行多查 = 多条各自过闸，不是一条字符串里塞多语句）：

1. **单语句** `SELECT` / `WITH … SELECT`；禁止 DDL/DML；**禁止同一请求体多语句**（`;` 拼接）。异 grain / 分表对照 → **多次** `metabase_run_dataset`（或等价）并行，而非一条多语句。  
2. 引用表 ∈ 表白名单。  
3. 满足 `required_filters`（缺则拦截并反问，不执行）。  
4. 服务端强制 `LIMIT`（可配置上限）+ 语句超时；**注意**：此 LIMIT 是护栏上限，**不等于**允许模型用 `LIMIT 1` 擅自截断排行（见 §7.1）。  
5. **扫描估计**：经 `EXPLAIN ESTIMATE`（或 Metabase 侧等价信息）检查估计 rows/marks/parts。  
   - **局限（必须写进实现与对用户文案）**：ClickHouse **无**精确 CPU/费用 dry-run；`EXPLAIN ESTIMATE` **可能忽略 LIMIT、偏高估**。  
   - V1 策略：估计阈值拒绝明显全表狂扫 + 硬超时 + 强制 LIMIT，不宣称「精确费用拦截」。  
6. Metabase 服务账号只读权限为第二道防线。
7. 并行度：受全局/每用户并行上限约束（§11）。

### 7.1 SQL Lint（执行前，与 §5.5 / §8.6 对齐）

在解析通过后、调用 Metabase 前增加确定性检查（失败则 **结构化**重写或 `guard_reject`，**不默默执行**）：

| 检查 | 规则 |
|------|------|
| 日粒度等式 | 若查询按日过滤/分组，禁止 `DateTime` 列与 `'YYYY-MM-DD'` 直接 `=`（须 `toDate(col)`） |
| 必选过滤落 SQL | `required_filters` 对应谓词须出现在 SQL 中（不仅槽位有值） |
| 点名渠道落 SQL | 单渠道题（NL 仅点名 IndiaA 等）→ 每条 SQL 的 WHERE 须含该 `channel` |
| 空语言 | 按语言聚合且用户未要求排除空语言 → 禁止 `contentLang!=''` / `<>''` |
| 擅自 Top1 | 排行/对照列表题 → 禁止无请求的 `LIMIT 1` |
| 写语句 | 已由 §7 第 1 条覆盖；lint 再确认无 `INTO OUTFILE` 等方言写旁路 |

**回写边界（评测已踩坑）**：允许针对 **lint / 执行报错 / 空结果** 的结构化回喂；**避免**无约束的「结果不对齐再让模型随便改」——易把已对齐子查询改坏（并行套回归）。

### 7.2 全局去重规范化（P0，消 C04；非手维指标表）

> 拍板：**全局默认可以；手维逐指标公式表不行。**

**配置**：`guards.distinctCountFn`（或环境变量），取值 **`uniq`（V1 默认）** 或 `uniqExact`。全仓唯一，不按「观看人数 / UV」等指标分行维护。

**执行前 AST 规范化（确定性，优先于再调 LLM）**：

| 若默认=`uniq` | 行为 |
|---------------|------|
| 出现 `uniqExact(...)` / 等价精确去重 | **改写为** `uniq(...)` 后执行 |
| 已是 `uniq(...)` | 保持 |
| 若默认=`uniqExact` | 对称：把 `uniq` 规范为 `uniqExact` |

**可选增强（仍非手维）**：启动或定时从 Metabase 存量 native SQL **Probe** 统计 `uniq` vs `uniqExact` 出现次数，仅作「建议修改默认」的运维提示，**不**自动改默认（避免无声漂移）。

**回喂 / 反问边界**：

- 规范化成功 → 无需问模型、不问用户  
- 无法安全改写（歧义 AST）→ 结构化回喂重写 ≤1  
- 仍失败 → 反问或拒答；**禁止**让模型在无全局默认时自由二选一当唯一手段

**与人均公式**：提示与 gold 使用 `{distinctCountFn}`，与全局默认一致即可；**不**单独维护「人均指标行」。

---

## 8. 质量闭环（唯一叙述）

> **§8 质量门禁已按 2026-09-09 真数评测修订**：正确率（EX）与拒答召回必须达标方可发版；架构仍冻结，阈值与改进项以本节为准。

### 8.1 离线评测

样例字段：`id | NL | gold_sql? | expected_result_or_hash | scenario_pack | should_refuse | difficulty | tags[]`

- **对齐优先级（Q3）**：以 **执行结果对齐** 为主（行/列排序、数值/日期类型规范化；可选结果 hash）。`gold_sql` 为辅（便于人工阅读与调试），**不作**主门禁 Exact Match。  
- **soft-EX（P0 评测约定）**：允许 pred 列为 gold 的**超集**（`gold 行值 ⊆ pred 行值`），宽表/长表数值等价可判 soft 通过；**交付路径仍约束列意图**（超额列可进解读，不默认塞主表）。百分比等比对允许小容差（如 0.015）。  
- 无仓库快照时：允许用例自带 **frozen result / hash**，评测跑 candidate SQL 后与冻结结果比；不硬依赖每次打生产库。  
- 有快照时：candidate 与 gold SQL 同快照执行再比结果（仍做规范化）。  
- 指标若声明需 `round(n)`（examples/评测约定）：比对前按同规则取整；**去重函数**与全局 `distinctCountFn` 一致（§7.2），不得 `uniq`/`uniqExact` 模糊等价。  
- **多查（`multi_query`）**：gold 可为 SQL 数组；各表结果与 pred 表集合做匹配（顺序不敏感）；要求 pred SQL 条数 ≥ gold 条数（禁止塌成单表硬拼）。

**Tags（Q7）**：如 `aggregation` / `join` / `refuse` / `funnel` / `multi_query` / `date_trap` / `dim_missing`；报告按 tag 分桶。

**种子集强制构成（V1）**：

| 类型 | 最低占比/数量 | 目的 |
|------|----------------|------|
| 可答题（有 gold 结果） | ≥ 20 条起步 | 正确率 EX |
| `should_refuse=true` | ≥ 20% 或 ≥ 8 条 | 拒答召回 |
| 日期陷阱（如 `lastWatchTime='YYYY-MM-DD'` 会错） | ≥ 3 条 | 防静默错数 |
| 维缺失/对比缺实体 | ≥ 2 条 | 防假对比完成 |

### 8.1.1 指标定义（必须保证）

| 指标 | 定义 | 门禁角色 |
|------|------|----------|
| **正确率 EX** | 可答题（`should_refuse=false`）中，candidate 与 gold **结果对齐**的比例 | **主门禁** |
| **拒答召回 RefuseRecall** | `should_refuse=true` 中，系统最终 **拒答或反问且未执行查数** 的比例 | **主门禁** |
| **拒答精确率 RefusePrecision** | 系统拒答/反问里，标注确实该拒的比例（防过度拒答） | 副门禁（过低则体验差） |
| **静默错误率 / CWR** | 可答题中：执行成功但结果不对，且 **未拒答、校对未阻断** 的比例 | **主门禁（上限）** |
| 护栏命中 | 应拦截（写操作/表白名单等）被确定性护栏拦住的比例 | 副门禁，目标 ≈100% |

> **正确率**保证「答对」；**拒答召回**保证「不该答时别硬答」。两者必须同时达标，只优化其中一个不算过关。

### 8.1.2 门禁阈值（发版硬门槛）

基于 2026-09-09 对 `elt_watch_detail` 真数冒烟（见 §8.1.3）：有语义提示时 EX≈80%、拒答召回≈50%。正式 Agent **必须高于裸 LLM+提示**，故 V1 默认阈值如下（配置键，可调但不可空）：

| 配置键 | 默认门槛 | 说明 |
|--------|----------|------|
| `GATE_EX_MIN` | **≥ 85%** | 可答题结果对齐率；M2 争取 **≥ 90%** |
| `GATE_REFUSE_RECALL_MIN` | **≥ 95%** | 依赖 **服务端 `required_filters` + 只读护栏**，不得只靠模型自觉 |
| `GATE_REFUSE_PRECISION_MIN` | **≥ 80%** | 避免滥拒；过低需扩语义层/降反问灵敏度 |
| `GATE_CWR_MAX` | **≤ 10%** | 静默错数上限；超过则禁止发版 |
| `GATE_EX_REGRESSION_MAX_PP` | **≤ 3 pp** | 相对上一 baseline 回退上限 |

**不达标：CI / 发版失败。** 禁止「能跑通」替代上述门禁。

**CI 触发**：prompt / 默认模型 / 语义层 version / 护栏逻辑变更时跑 harness；日常可定时跑全量种子集。

报告必须记录 **`semanticLayerVersion` + `modelId`（Q5）**；语义层 version 变更后旧报告标 `stale`，须重跑再作门禁依据。

旁路指标（Q8，薄，不作唯一门禁）：p50/p95 延迟、rewrite 率、护栏拦截率、`exec_ok_but_wrong` 计数。

### 8.1.3 实测基线（2026-09-09，指导门槛而非替代门禁）

环境：Metabase `bi.vmovs.com` / ClickHouse 主库；模型 `dsflash`；12 题（10 可答 + 2 应拒）；结果 vs gold SQL 执行对齐。

| 条件 | EX（可答题） | 静默错 | 拒答召回 |
|------|--------------|--------|----------|
| 强提示（含 `toDate` + `round` 口径） | **80%（8/10）** | 20%（多为 `uniq` vs `uniqExact`） | **50%（1/2）**（缺日期未拒） |
| 弱提示（仅表字段） | **20%（2/10）** | 70%（大量缺 `round` 等） | 50% |

**推论（已写入改进 §8.6）**：仅「跑通」不足；正确率靠 **结构口径（§5.5）+ 全局默认 + Probe/Verify 闭环**，不是靠「查询成功」；拒答召回必须上服务端闸，不能指望提示词。

### 8.2 运行时

- 执行前：§7（确定性护栏）+ **日期等 `required_filters` 缺省则反问，禁止执行**  
- 执行后：LLM 校对（默认开，可配置关；含短路：标准 question 未改写，或 `empty`）  
- **校对输出契约（Q4）**：结构化 `pass | fail | unclear` + 原因码。  
  - `fail` → 进入自纠错或拒答  
  - `unclear` → **默认倾向反问或拒答，不默认放行**  
  - `pass` → 继续汇总展示  
- **确定性校对补充（不单靠 LLM；对齐业界 rule-based Verify）**：  
  - 日粒度查询禁止 `DateTime列 = 'YYYY-MM-DD'` 形态（应 `toDate(...)`）；可 lint 失败并触发重写  
  - **时间窗**：SQL 中的日期须与已 resolve 的 `time_range` 一致（允许等价写法）；缺年不得再出现与 resolve 结果不同的年份  
  - **grain（日）**：槽位要求按日时，SQL 须含日分组；否则 fail→重写  
  - **grain（维）**：槽位点名的对照维须在 GROUP BY/结果列；漏维 fail→重写  
  - **列意图**：主 SELECT 不得夹带未请求派生列；超额列 → 解读旁路或重写；评测 soft-EX 见 §8.1  
  - **空语言 / LIMIT 1 / 点名渠道**：与 §7.1 一致  
  - **去重**：执行前须已按 §7.2 规范化；评测 gold 使用同一 `distinctCountFn`  
  - 请求的维度值集合 vs 结果维度集合对账；缺维须明示，不得当对比完成  
  - **空结果**：不默认当业务零；可触发 1 轮「检查年份/枚举」重写或反问  
  - **回写**：仅 lint/exec/empty 结构化回喂；禁止无约束「EX 不对再瞎改」（§7.1）  
- 进模型仅摘要/样例行（见主链路截断约定）  
- 自纠错：默认最多 2 轮，耗尽则拒答并写审计原因  

同模校对偏见（Q10）：V1 接受，靠 §7 + 确定性 lint 托底；换模型校对后置。

### 8.3 审计与反馈

落库：问句、SQL、护栏结果、估计摘要、校对结论（含 pass/fail/unclear）、card id、耗时、rewrite 次数、失败分类、语义层 version、modelId、用户 id。

UI：有用 / 有误 + 错因标签。  
**回流（Q6）**：有误进入 **候选池**，**人工确认后**方可写入 gold 评测集；禁止用户反馈无人审直接进门禁集。

### 8.4 与巡检（Q9）

- 对话路径：默认开校对；评测 harness 以对话 **EX + 拒答召回 + CWR** 为主门禁。  
- 巡检路径：默认关校对；**安静条件、阈值、freshness、聚合** 用 **确定性单测/规则测试**，不进入 LLM EX 门禁集。

### 8.5 明确不做（V1）

- Best-of-N 多候选 SQL  
- 全量 Memo 式错误经验库  
- 以 Exact SQL Match 作主门禁  
- 无审核的审计日志自动变 gold  
- 换模型校对、语义 AST 全量等价证明（后置）  
- 用「查询成功率/能跑通」替代 EX / 拒答召回门禁  

### 8.6 改进项（为达标正确率与召回率）

原则：**工具 + 闭环**；**允许全局引擎默认**；**禁止手维同义词表与逐指标公式表**。

| 优先级 | 改进 | 主要抬哪项 |
|--------|------|------------|
| P0 | **结构护栏**：日粒度 → `toDate`；§7.1 lint；只读 + 表白名单 | EX、CWR、拒答 |
| P0 | **全局 `distinctCountFn` + AST 规范化**（§7.2）；默认 `uniq` | EX、CWR |
| P0 | **时间确定性 resolve**（§6.3）+ `required_filters` / 「最近」反问 | EX、CWR、拒答 |
| P0 | **Probe** + **日/维 grain Verify** + 空结果策略 | EX、CWR |
| P0 | **列意图** + **多 SQL 并行分解**（§6.1）+ 空语言/`LIMIT 1`/渠道 lint | EX、CWR |
| P0 | 评测：**可执行 gold** + **soft-EX** + `multi_query` 套 + `GATE_*` | 门禁 |
| P1 | 维对账；相似成功 few-shot；薄错修记忆 | EX、体验 |
| P2 | Best-of-N / 换模校对（非替代 Verify） | 抬上限 |
| **CUT** | 业务同义词 / 枚举 mapping YAML；手维逐指标公式表；用更大模型替代 Verify；无约束 EX 回写 | — |

**达标路径（同日真数小样，指导用）**：弱提示 ~20% → Probe+时间+uniq → 口语 ~89%（§17.4）；单 SQL 超复杂未硬闸 ~60%（§17.5）；**并行多 SQL + soft-EX + lint → 10/10**（§17.5.1）。发版仍以 §8.1.2 全量种子集为准。拒答召回靠服务端闸 ≥95%。
### 8.7 业界准确度手段与本仓采纳边界（对齐 2026 主流）

#### 8.7.1 业界两条主路线

| 路线 | 代表 | 做法 | 何时更「最佳」 |
|------|------|------|----------------|
| **A. 语义层编译** | dbt MetricFlow、Cube、Looker、Wren | LLM 选 metric/dimension，SQL **确定性编译** | 报表/KPI/审计：能答则几乎不错，不能答则拒答 |
| **B. Agentic Text-to-SQL** | PV-SQL、DIVER、CHESS、LangChain SQL Agent | LLM 写 SQL + **Probe / 规则 Verify / 执行回馈** | 探索/口语/覆盖面优先 |

共识（dbt 2026 等）：**准确率优先用 A；临时探索用 B**；生产常混用。  
**本仓拍板（2026-09-12 收口）**：走 **A 权威**（pack metric/dim → Intent → `sql-compile`）；LLM 只填 Structure / TurnIntent。B 的「执行后改写 SQL」**CUT**。维值别名放 pack / Metabase lexicon，不在代码写产品 allow-list。

#### 8.7.2 生产共性层（与模型品牌无关）

```
NL → 槽位（LLM JSON）→ 受控上下文（pack / Probe / lexicon）
  → 确定性编译 SQL → 校验闸（只读、必填槽、lint、grain/维/列 Verify）
  → 执行 → 空/错则反问或拒答（不改写 SQL）→ 带来源交付
  → 离线 EX + 拒答召回 + CWR 门禁
```

参考：Atlan Talk-to-Data（governed context）、生产 Text-to-SQL 护栏指南、Airbyte/LangChain「schema 裁剪 + 执行反馈 + 库侧 timeout/只读」。

#### 8.7.3 手段对照与采纳

参考：PV-SQL/DIVER（Probe+Verify）、DIN/MAC（分解）、DAIL/SQLGenie（few-shot）、Memo-SQL（错修）、nl2time（clock）、dbt/Ontul（语义编译——**只吸收确定性，不吸收手维大指标库**）。

| 手段 | 业界做法 | 我们定稿 |
|------|----------|----------|
| 逐指标语义编译 | dbt metrics 手维 | **CUT 作权威**；examples / questionBinding 仅加速 |
| **全局方言默认 + AST 规范化** | 引擎层统一 count-distinct | **P0**（§7.2） |
| 时间 grounding | clock + timezone resolve | **P0**（§6.3） |
| Probe / value linking | 探库对齐口语枚举 | **P0**（非同义词表） |
| **规则 Verify checklist** | 漏 DISTINCT / Top-k / 约束（PV-SQL） | **P0**：日/维 grain、列意图、time_range（§6.1/§8.2） |
| 复杂题分解 | 多 SQL 再合并 | **P0**（异 grain / 分表对照并行） |
| 执行回馈 / 空结果重写 / 反问 | 闭环 | **兜底**（仅结构化；禁无约束 EX 回写） |
| 相似 few-shot / 薄错修 | 历史成功 SQL、错→修 | **P1** |
| soft-EX（核心列超集） | 评测降假失败 | **P0 评测**；交付仍约束列意图 |
| Best-of-N / 微调 / RL | 抬上限 | **CUT V1**（贵；先 Verify） |
| 业务同义词 YAML | 手维 value map | **CUT** |
| 模型自选 uniq/uniqExact | — | **CUT 作唯一手段** |

**本仓最优包（已小样验证）**：Probe + 时间 resolve + `uniq` 规范化 + 空结果重写 + **多 SQL 并行** + **日/维/列 Verify** + §7.1 lint（空语言/渠道/`LIMIT 1`）+ soft-EX。  
**优先顺序**：护栏 → 去重规范化 → 时间 resolve → Probe → 日/维/列 Verify + lint → 分解并行 → 结构化回喂 → few-shot/薄错修。
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
- **鉴权分流（L7）**：`POST/GET /internal/analytics/scan*` 走 **内网 + `SCAN_INTERNAL_TOKEN`**；应用内用户查看 job/告警走 **Web 登录 + 白名单**，不把用户 session 当 cron 凭证。

**内部鉴权（R29）**：V1 选定一种并写进部署说明——推荐 **内网-only + 共享密钥**（`Authorization: Bearer <SCAN_INTERNAL_TOKEN>`）；不采用「无鉴权仅靠路径隐蔽」。

不做「仅绑在聊天进程里的隐蔽 setInterval」作为唯一调度；与请求处理解耦。  
运维示例（部署时替换）：每日固定时刻 `curl -X POST .../internal/analytics/scan -H 'Authorization: Bearer …' -d '{"ruleSetId":"default"}'`。

### 9.2.1 Job 状态机（R19）

状态：`queued` → `running` → `succeeded` | `partial` | `failed` | `cancelled` | `skipped`。

- `jobTimeout`：超时未结束 → 标 `failed`，并发 **运维告警**（scan 未跑成），与业务 ROI 告警分离。  
- 同 `scanDate + ruleSetId` 已有 `running` → 返回 `scan_job_running`（拒绝或排队，配置二选一，默认拒绝）。  
- **`cancelled`**：仅人工/管理接口取消（应用内「取消任务」或运维调用）；cron 不自动 cancel。  
- **Freshness 未过（L3）**：终态默认 **`skipped`**（原因码 `data_not_ready`），**不算** `failed`，避免与执行故障混在运维告警里。

### 9.3 规则配置（可扩展，ROI 仅为默认示例）

规则集（`ruleSet`）配置化，字段逻辑包括：

| 字段 | 说明 |
|------|------|
| metrics | 如 ROI（可扩展 CTR/CVR 等） |
| baselines | 默认 `["dod","wow"]`（日环比、周同比） |
| baselineLogic | 默认 **`any`**：任一基线破线即 warn；文案必须写明对比的是 dod 还是 wow |
| threshold | 默认相对下降 &gt; 10%（ratio &lt; 0.9） |
| minAbsDelta | 最小绝对变化 ε（R20）；**待业务对齐必填或书面接受默认 0**（L2）；与相对阈值 **同时满足** 才发 warn（`ratio 破线 AND \|Δ\| ≥ ε`） |
| minSample | 最小样本量（L1）；低于则安静/info，不发 warn |
| criticalEntityCount | 同时破线实体数 ≥ 该值升 `critical`（L4，默认 **3**） |
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

未通过 → job 终态 **`skipped`**（原因 `data_not_ready`），**不跑业务阈值告警**；默认只记 info/日志，不把「数据未就绪」打成 `failed` 运维故障（除非连续多日 skipped 另配升级，V1 不做）。

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
- 级别：`info`（数据不足/未就绪）/ `warn`（破阈值）/ `critical`（同时破线实体数 ≥ `criticalEntityCount`，默认 3；连续 N 天破线可配置，V1 可先只实现实体数阈值）。  
- **部分实体查询失败**：job 状态 `partial`；成功实体照常做阈值；失败实体进入「巡检不完整」运维摘要，**不得**把执行失败解释为 ROI 暴跌。

### 9.7 通知通道

- **钉钉 + 应用内** 均要。  
- 扩展现有 `alert-notify`：新增独立 kind（如 `analytics`），**独立开关与 dedup 命名空间**，不与 `budget` / `degrade` 混用。  
- Dedup fingerprint：`ruleSetId + scanDate + metric + entityKey + baseline + severity [+ rerunSeq]`（见 §9.8）。  
- **多实例（L5 定死默认）**：**默认仅指定实例跑巡检**（ecosystem/环境变量指定 `ANALYTICS_SCAN_WORKER=1` 的进程执行；其它实例忽略 cron 触发或拒绝无令牌的误打）。共享指纹（DB/Redis）为备选，多实例主动推送时再启用。  
  文档与部署说明必须写清当前环境用的是默认单 worker 还是共享指纹。  
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
- **保留天数（L6）**：后置；实现阶段可薄配 `retentionDays`（建议默认 30），不阻塞 M3 功能验收。

### 9.10 本节状态与后置

> **§9 已冻结（2026-09-09）**：除业务对齐清单中的数值填空外，不再扩展巡检架构。

后置（V1 不做）：

- 告警认领（ack）与值班表  
- 夜间静默 + 早高峰汇总推送  
- 破线恢复后再推「已恢复」通知（次日不再告警即可）  
- 完整 SLO / error-budget / 多窗口 burn-rate  
- 节假日/大促基线特殊规则  
- 多规则复杂 DAG（V1 用规则列表顺序执行）  
- 巡检专用只读副本 / 更低优先级队列  
- job/告警保留策略的精细 GC（见 9.9 L6）  

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
| `data_not_ready` | 巡检业务日数据未就绪；job 终态一般为 `skipped` |
| `scan_job_running` | 同 scanDate+ruleSet 任务仍在跑（幂等拒绝或排队） |
| `scan_job_timeout` | 巡检 job 超过 jobTimeout |
| `scan_partial` | 部分实体成功、部分执行失败（业务告警仅基于成功实体） |
| `scan_skipped` | 因 freshness 等未执行阈值（与 failed 区分） |

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
| **M1** | `/analytics` 可对话；时间 resolve → Probe → Generate → **§7.2** → §7/§7.1 → **日/维/列 Verify** → **多 SQL 可并行** → 结构化重写；**无手维指标表**；缺日期反问；来源条回显时间窗；**MCP 和/或 HTTP facade 可被小龙虾调用**（建议含 `analytics_ask`）；种子评测可跑通（门禁可先 warn）。**实现计划：** [`docs/superpowers/plans/2026-09-09-metabase-analytics-agent-m1.md`](../plans/2026-09-09-metabase-analytics-agent-m1.md)。**验收：** [`docs/analytics/m1-acceptance.md`](../../analytics/m1-acceptance.md) ✅ |
| **M2** | 校对契约 + 维对账；自纠错；评测 harness；**GATE_*** 阻断发版；tags；version/modelId；候选池入 gold；双轨图；审计点赞。**实现计划：** [`docs/superpowers/plans/2026-09-09-metabase-analytics-agent-m2.md`](../plans/2026-09-09-metabase-analytics-agent-m2.md)。**验收：** [`docs/analytics/m2-acceptance.md`](../../analytics/m2-acceptance.md) ✅（可答 gold 待人工晋升；当前 GATE_EX=n/a） |
| **M3** | 手工巡检 + 外部 cron 调异步 `/internal/analytics/scan`；freshness→skipped；businessTimezone；job 状态机含 partial/timeout/skipped；相对+绝对阈值；dryRun；钉钉 `analytics` kind + rerunSeq dedup；默认单 scan worker；应用内 job/告警（登录）与 internal API（token）鉴权分流；深链+runbook。**实现计划：** [`docs/superpowers/plans/2026-09-09-metabase-analytics-agent-m3.md`](../plans/2026-09-09-metabase-analytics-agent-m3.md)。**验收：** [`docs/analytics/m3-acceptance.md`](../../analytics/m3-acceptance.md) ✅ |

### 12.1 仓内实现就绪度 / 业务流程可跑通性

> **2026-09-10 更新（覆盖文内「2026-09-09 对照」）：**  
> - **M1** 对话取数：**已验收**（`docs/analytics/m1-acceptance.md`）。  
> - **M2** 质量闭环 / `GATE_*`：**已验收**（`docs/analytics/m2-acceptance.md`；拒答 GATE + CI；可答 EX 待人工将 provisional→gold）。  
> - **M3** 巡检：**已验收**（`docs/analytics/m3-acceptance.md`；dryRun smoke `succeeded`）。  
> 下文 §12.1.1–12.1.4 为定稿当日快照，**勿再当作当前缺口清单**；以各里程碑验收清单为准。

#### 12.1.1 按业务流程（历史快照 2026-09-09）

| 流程 | 状态 | 说明 |
|------|------|------|
| **对话取数主链路**（时间 resolve → Probe → SQL → 规范化/Verify → Metabase → 回写 → 来源条） | **未实现** | 无 Analytics Worker、无 `metabase_*`、无编排 |
| **拒答 / 反问**（`required_filters`、缺日期、「最近」） | **未实现** | 现有 `request_clarification` 仅服务后台管理 `/chat` |
| **并行多 SQL** | **未实现** | §6.1/§7 已定；代码无 planner / 并行 `run_dataset` |
| **表 / 图 / 导出交付** | **仅基建可复用** | `render_table`、ECharts、`export_dataset` 挂在管理聊天；无 `/analytics` 会话与 Metabase→表管道 |
| **巡检预警**（`/internal/analytics/scan`、钉钉 `analytics`） | **未实现** | `alert-notify` kind 仍为 `budget` / `degrade`；无 scan API |
| **质量门禁**（EX / 拒答召回 / `GATE_*`） | **未实现** | 阈值仅在本文；实验 `tmp-nl2sql-*` 脚本未留仓，正式 harness 未建 |

#### 12.1.2 组件对照（代码事实）

| 设计项 | 仓内现状 | 位置 / 备注 |
|--------|----------|-------------|
| 路由 `/analytics` | **缺失** | `apps/web/src/router.ts`：有 admin / knowledge / viewing，无 analytics |
| `analytics-bi` Worker | **缺失** | `worker-registry.ts`：backend-api / knowledge / common |
| `metabase_*` 工具 | **缺失** | `tools.ts` / MCP 无 Metabase Client；取数未进 Agent 循环 |
| 时间 resolve / Probe / §7.2 / grain·列 Verify | **缺失** | `src/` 无对应模块；`DISTINCT_COUNT_FN` 仅 `.env.example` 注释 |
| 语义层 pack / `required_filters` | **缺失** | 无配置加载与服务端闸 |
| `GATE_*` 评测 | **缺失** | 现有 eval 针对管理聊天 / `call_api` |
| `METABASE_*` 环境变量 | **部分** | `.env` / `.env.example` 可供冒烟；**未**接入 `config` / 运行时 |
| 表格·图·导出·澄清·Worker 模式·钉钉 | **可复用** | 管理 Agent 路径；接 Analytics 时扩展，非替代实现 |

#### 12.1.3 今天实际能跑的

1. **`node apps/agent-server/scripts/metabase-smoke.mjs`**：登录 → 列库 → 可选 native `/api/dataset`（需 `METABASE_USERNAME` / `PASSWORD`，可选 `METABASE_DATABASE_ID`）。**仅连通，不是 Analytics Agent。**  
2. **后台管理 Agent**（`/agents/admin/chat` + `call_api`）：与定稿权威路径**无关**，不可冒充本产品已上线。  
3. **独立页占位模式**（如 `/agents/viewing`）：可作 `/analytics` 模板参考。

#### 12.1.4 完全跑通前的硬阻塞（实现顺序）

1. `/analytics` 页 + 隔离会话  
2. `analytics-bi` Worker + 工具白名单 + 系统提示  
3. Metabase REST 客户端与 `metabase_*`（至少 `run_dataset`；按需 temp card）  
4. 语义层薄配置 + P0 流水线：时间 resolve、Probe、§7/§7.1、§7.2、grain/维/列 Verify、多 SQL 并行、结构化回写  
5. **M2**：评测 harness + CI `GATE_*`  
6. **M3**：scan API + job + `analytics` 告警 kind  

**下一步（2026-09-10）：** M1 / M2 / M3 均已验收。后续可选：人工将 provisional 可答题晋升为 gold 以启用 `GATE_EX`；真实 Metabase `questionId` 绑定；日常 `/analytics` 体验回归。  
**OpenClaw / 小龙虾**：见 §4.2 与 [openclaw-connect.md](../../analytics/openclaw-connect.md)；裸 Metabase MCP 不算接入完成。

---

## 13. 待业务 / BI 对齐清单（上线前必填）

- 各 pack 的表、字段、**可 Probe 的维度列**；**不**维护中文同义词表、**不**维护逐指标公式表  
- **`distinctCountFn`**（默认 `uniq`）、**`businessTimezone`**、缺年默认、相对时间是否回显；评测 gold 与 `distinctCountFn` 一致  
- CTR / CVR / ROI 等若要用，优先 **questionBinding / examples**，禁止大手维指标库  
- 评测门禁：**GATE_EX_MIN=85%**、**GATE_REFUSE_RECALL_MIN=95%**、**GATE_CWR_MAX=10%**、RefusePrecision≥80%、回退≤3pp  
- Metabase `databaseId`（连通验证主库多为 `2`）、临时 collection、服务账号权限范围  
- 巡检：默认监控对象、钉钉群、T-1 跑数时刻、`freshnessCheck` / watermark、`minSample`、`minAbsDelta`（或书面接受 0）、`criticalEntityCount`、连续 N 天 critical、`maxChildAlerts`、`jobTimeout`  
- 示例 pack 包体真实取值；单 scan worker 或共享指纹；`SCAN_INTERNAL_TOKEN` 与内网暴露方式
未对齐前：允许绑定已有 Metabase question 跑通编排；**禁止假装口径已定死进代码常量**。

---

## 14. 五层归属（对齐 AGENT_CHARTER）

| 层 | 本设计落点 |
|----|------------|
| workflow | `/analytics` 会话；Worker 装配；巡检 internal API；M1–M3 编排 |
| skill | 分析意图槽位、grain/维/列 Verify、复杂题分解、校对/拒答话术模板 |
| MCP | 自研 `metabase_*` + 建议 `analytics_ask` 经 MCP/HTTP facade 出口；小龙虾（OpenClaw）MCP/Plugin/Skill/Channel **任选接入**（§4.2）；可选社区 Metabase MCP 仅探索 |
| tools | `metabase_*`（含 Probe 用的 `metabase_run_dataset`）、`render_table`、`summarize_chart_data`、`export_dataset`、`request_clarification` |
| superpower | 语义层 JSON、护栏与阈值配置、评测集、告警 dedup 配置 |

---

## 15. 自检记录（Spec Self-Review）

| 检查 | 结果 |
|------|------|
| Placeholder | 业务字段与 pack 细节显式列入 §13；质量阈值已默认填入 §8.1.2 |
| 内部一致性 | 多 SQL=多次单语句并行（§7≠禁止并行）；EX/拒答双门禁与 §5.5/§6.1/§7.1/§8 一致；soft-EX 评测 P0；CUT 手维指标库与无约束 EX 回写 |
| 范围 | 产品含巡检；交付用里程碑切开；质量 P0 从 M1 起铺、M2 卡发版 |
| 歧义 | 「一张表」用 grain 消歧；「答对」= EX 而非跑通；「业界最佳」= 场景选 A 或 B，本仓明确选 B+Verify |

---

## 16. 修订摘要（相对草案讨论）

- **FIX**：ClickHouse 费用模型；按需临时 card；grain 合并；分析意图；阈值配置化；里程碑表达。  
- **MERGE**：取消「路径 A/B 填槽」双叙事；出图/质量/MCP 各保留单一说法。  
- **CUT**：call_api 权威取数；后台四元组；列白名单门禁；Best-of-N；示例 pack=全集。  
- **ADD**：工具最小集；章程例外；截断/校对短路/dedup；失败枚举；联调清单；来源条。  
- **ADD（§9 巡检强化）**：中性异步 `/internal/analytics/scan`；固定 T-1 窗口；安静条件；父告警聚合；`analytics` 告警 kind；多实例 dedup；幂等；深链；默认关校对/关临时 card；baselines=`any` 语义写清。  
- **ADD（§9 第二轮）**：freshness 就绪检查；businessTimezone；job 状态机与 timeout；minAbsDelta；partial 失败语义；runbook 文案；dryRun；forceRerun+rerunSeq dedup 定死；内部鉴权方式点明。  
- **ADD（§9 终审补丁后冻结）**：minSample 入规则表；minAbsDelta 对齐要求；freshness→`skipped`；criticalEntityCount 默认 3；多实例默认单 scan worker；internal token vs Web 登录分流；L6 保留天后置；**§9 冻结**。  
- **ADD（§8 质量闭环）**：CWR；门禁+CI；校对契约；候选池入 gold 等。  
- **REV（§8 真数评测）**：EX≥85% + 拒答召回≥95% + CWR≤10% 双主门禁；实测基线；§8.6 改进清单。  
- **REV（全文补强 2026-09-09）**：文首/目标写明双门禁；§5.5 口径钉死；§6 主链路接入 lint/维对账；§7.1 SQL lint；M1/M2 验收对齐；§17 连通与评测附录。  
- **ADD（§8.7）**：业界准确度手段对照表（schema/value linking、few-shot、错修记忆、Probe、Verify、分解、Best-of-N/微调取舍）及本仓优先增量。  
- **REV（对齐主流 Agent「工具+闭环」2026-09-09）**：**CUT** 业务同义词/枚举 mapping 主路径；§6 升格 Probe；Value linking = Probe；§5/§8.6/§8.7/M1/§13 同步。  
- **ADD（§6.3 时间确定性 resolve 2026-09-09）**：clock + businessTimezone；缺年默认；相对时间 IR；回显区间；禁模型自猜年；grain Verify；§5.5/§8/M1/§17.4 同步。  
- **REV（去重口径 2026-09-09）**：拍板 **全局 `distinctCountFn` + AST 规范化（§7.2）**；**CUT** 手维逐指标公式/函数表；回喂/反问仅作兜底；消 C04。
- **REV（业界对齐 + 超复杂评测 2026-09-09）**：§8.7 A/B 路线；§6.1/§8 维·列·分解；§17.5 单 SQL 60% 基线。  
- **REV（查缺补漏 2026-09-09）**：§7 修正「单条」与多 SQL 并行矛盾；§7.1 补空语言/渠道/`LIMIT 1`/回写边界；soft-EX 升 P0 评测；§13 去重；§17.5.1 并行套 10/10；§2.1 去掉易误解的「语义层钉口径」。  
- **ADD（§12.1 实现就绪度 2026-09-09）**：对照代码写明业务流程**不能**端到端跑通；仅冒烟可跑；组件缺失表与硬阻塞；文首状态同步。  
- **ADD（§4.2 OpenClaw / 小龙虾接入 2026-09-09）**：可接入且**不改主架构**；支持 MCP/Plugin/Skill/Channel 等任意小龙虾工具面；本仓提供稳定 facade（建议 `analytics_ask`）；禁裸 Metabase MCP 冒充达标。

---

## 17. 附录：连通验证与质量评测记录（2026-09-09）
### 17.1 Metabase 连通

| 项 | 结果 |
|----|------|
| 实例 | `https://bi.vmovs.com`，Metabase **v0.62.1.7** |
| 鉴权 | 账号密码 → `POST /api/session`（可，不必先有 API Key） |
| 库 | `database id=2`，名称「主库」，`engine=clickhouse` |
| 冒烟 | `SELECT 1` OK；人均时长手工 SQL（IndiaA / 2026-08-19～25）OK，约 4s、7 行 |
| 本仓 MCP | 现有 `/mcp` 为 **工具出口**，不是连 Metabase 的 Client；取数以 **自研 REST `metabase_*`** 为主（与 §4 一致） |
| 产品链路 | **未实现**；冒烟 ≠ Agent。业务流程可跑通性见 **§12.1** |

### 17.2 NL→SQL 正确率/召回抽样（指导门禁）

模型：`dsflash`；比对：candidate SQL 与 gold SQL **同库执行结果**对齐；12 题（10 可答 + 2 应拒）。

| 条件 | EX | 静默错 | 拒答召回 |
|------|-----|--------|----------|
| 强提示（`toDate`+`round`） | 80%（8/10） | 20%（多为 uniq 口径） | 50%（1/2） |
| 弱提示（仅字段） | 20%（2/10） | 70% | 50% |

典型静默错：`lastWatchTime = '2026-08-23'` → 42，正确 `toDate(...)` → ~76 万。  
结论：必须落地 §5.5 + §7.1 + §8 门禁；详见 §8.1.3、§8.6。

### 17.3 Probe 闭环小样本（同日，无同义词表）

实验脚本（曾用 `tmp-nl2sql-probe-eval.mjs`，实现阶段并入正式 harness）；6 题（含「泰卢固」「印度 A」口语、缺日期、删数陷阱）。

| 模式 | EX（可答） | 拒答召回 | 静默错 | 均时 |
|------|------------|----------|--------|------|
| Baseline（无 Probe） | 2/3 ≈67% | 2/2 | 2（空表） | ~7.4s |
| Probe + 结构约束 | 3/3 =100% | 2/2 | 0 | ~5.8s |

说明：样本小，仅证「工具探库对齐口语」方向；正式门禁仍以 §8.1.2 全量种子集为准。

### 17.4 自然语言用例 + 缺年（同日）

脚本同上；12 题运营口语（无字段名/SQL）；模型 `dsflash`。

| 条件 | EX（可答） | 拒答召回 | 静默错 | 说明 |
|------|------------|----------|--------|------|
| 仅 Probe，缺年靠模型猜 | 2/9 ≈22% | 3/3 | 6 | 年份漂到 2023/24/25 → 空表 |
| Probe + 默认年 2026 + 空结果重写 | **8/9 ≈89%** | 3/3 | 1 | 剩 1 题漏「按天」grain |

结论：口语可行，但 **时间必须确定性 resolve**（§6.3），不能靠模型自判年份；另需 grain Verify。

### 17.4.1 C04 去重漂移（同阶梯评测）

「印度A vs FoxA 每天观看人数」：模型 `uniqExact` vs gold `uniq` → 差约 500 人（静默错）。  
对策（已写入 §7.2）：**全局默认 `uniq` + 执行前 AST 把 `uniqExact` 规范为 `uniq`**，不建手维指标表。

### 17.5 超超复杂口语套（同日，单 SQL 路径基线）

脚本曾用 `tmp-nl2sql-probe-eval.mjs`（实验）；10 题单查询形态；模型 `dsflash`；均时 ~43s。

| 指标 | 结果 |
|------|------|
| EX（含 soft） | **6/10 = 60%** |
| 严格 ex_ok | 5/10 |
| 主要失败 | 漏渠道维（X01）；超额差列（X05/X08）；1 题 gold 非法（X07） |

**归类**：瓶颈是 **维/grain 遗漏** 与 **列超额**，非枚举/年份。  
说明：样本小；正式门禁仍以 §8.1.2 为准。

### 17.5.1 并行多 SQL 超复杂套（同日，修复后）

同脚本演进为 **多 SQL + `---` + 并行执行** + soft-EX + §7.1 类 lint；10 题（异 grain / 分表 / 双排行 / HAVING+基线等）。

| 轮次 | EX | 说明 |
|------|-----|------|
| 首跑 | 7/10 = 70% | 已能并行拆分；败在超额列、百分比取整、空语言过滤 |
| 加 soft-EX + 提示/lint | 9/10 → 曾因无约束 EX 回写回归至 8/10 | 证实「乱回写」有害 |
| **定稿闸（去有害回写 + 渠道/`LIMIT 1`/空语言 lint）** | **10/10 = 100%**（8 严格 + 2 soft） | 均时 ~19s；静默错 0 |

**结论**：§6.1 多 SQL 并行 + §7.1 lint + soft-EX 可将超复杂题拉回门禁上方；实现时把实验脚本并入正式 harness（勿依赖 `tmp-*` 文件名）。

### 17.6 为门禁服务的改进落地顺序（实现备忘）

1. §7.2 `distinctCountFn` + AST 规范化  
2. §6.3 时间 resolve + `required_filters`  
3. Probe + §7 / §7.1 lint + **日/维/列 Verify** + **多 SQL 并行**（§6.1）  
4. 评测 harness（含 soft-EX、`multi_query`）+ `GATE_*`（M2 阻断发版）  
5. 维对账 + few-shot/薄错修；回喂仅限 lint/exec/empty  
