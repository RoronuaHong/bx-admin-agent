# BI 护栏综合整改方案（业界最佳实践对齐 + 多方向评估）

> 本文是整改**总方案**，整合三份支撑文档：
> - `BI_GUARDRAIL_BEST_PRACTICE_PLAN.md`（专名护栏专项方案）
> - `REVIEW_FINDINGS_2026-10-17.md`（护栏/测试/文档，3 子 agent 审查的 50+ 条）
> - `REVIEW_FINDINGS_OUTPUT_QUALITY_2026-10-17.md`（**输出质量**：SQL 质量/结果正确率/总结/排版，3 子 agent 审查 + 最佳实践对照）
>
> 生成依据：联网检索的最佳实践 + 本项目多方向实测证据（SETTINGS 回归、专名护栏误伤、方向 C 复验、BI 库实测核验、前端黄色状态）。

---

## 一、现状快照（2026-10-17）

**已改、工作区未提交**（功能验证已通过，待 commit）：
| 改动 | 验证 |
|---|---|
| SETTINGS 回归（`max_estimated_execution_cost`→`max_estimated_execution_time` + 跳过 0 值） | 已在 `c168883` 提交推送（前序 commit） |
| 方向 C·专名护栏技能闸（读过 `business-data-query`→信任模型，不再词形硬拦） | 单测 13 passed + 端到端复验通过 |
| `hasDateWindow` 窗口判据（裸列双比较算真实跨度、单日等值 0 跨度） | 单测 24 passed + 端到端复验通过 |
| 未执行→黄色警告（`tool_result` 补 `executed` + 前端 `refused` 状态 + 配色） | 前端 `vue-tsc` 通过 + 浏览器复验通过 |
| 技术债：`StepStatus` 三处定义收敛为单一来源 + `bubble.css` 重启坑固化 | `vue-tsc` 通过 |

**待整改**（见第三、四节，P0/P1 多为"会出事/会静默给错数"）：护栏的**资源安全**（P0-1/2/3/5）、**判据正确性**（P0-4、P1-1/2/11/10）、**测试覆盖**（前端零测试、executed 13 分支零测试）、**专名护栏边角误伤**（P1-3/4、纯小写单词漏拦）。

---

## 二、业界最佳实践（检索依据，2026-10-17 补充）

### 2.1 权威风险框架
- **OWASP LLM Top 10（2025 v1.1）**：Excessive Agency（过度代理）、Unbounded Consumption（无界消耗）、Misinformation（幻觉）、敏感信息泄露、提示注入。
- **AWS Well-Architected「Generative AI Lens」**：代理风险在于"未确认时执行**不可逆**操作" → fail-closed 施加于**写/副作用**，只读动作不应一刀切硬拦。
- **Anthropic 工具许可**："默认对任何**可能修改系统**的操作请求授权……刻意保守设计" → 保守作用于写操作，只读 fail-open。

### 2.2 护栏工程通识（本次检索新增）
- **Traccia（arXiv 2607.14309）**："**fail-closed enforcement at the boundary**：不安全请求在 LLM 被调用前就被拒绝"。即硬拦应放在**确定性边界**（能力/授权/语法/资源阈值），而非语义猜测。
- **openclaw #72741**：外部护栏契约应定义 **allow / warn / block / fail-open / fail-closed** 五档决策——本项目只有 block（硬拦）与放行，缺 **warn（软提示，不阻断）** 这一档。
- **text-to-SQL 落地教训（CSDN「验算、安全、性能三件事」）**："上线第一天，Agent 生成一条人模人样的 SQL，在线上库跑了近三分钟，把核心业务表打挂" → **只读查询也要有性能护栏**（成本估算、超时、熔断）。
- **Agent 循环防御三层架构（CSDN「别让 AI Agent 无限循环烧 Token」）**：执行前预算控制 → 执行中指纹去重/振荡检测/超时取消 → 执行后成本归因；**终止权由运行时控制器而非模型承担**（与本项目 `LoopGuard`、SETTINGS 一致）。
- **db-agent（生产级 text-to-SQL）**：safety guardrails + schema-aware + **cost cap**（成本封顶）。
- **护栏自身亦为攻击面**：LLM-based guardrails 已成标准层，但存在"推理扩展 DoS"脆弱性（构造输入把护栏困入无界推理）→ 护栏需**可观测 + 可降级**。

### 2.3 提炼的设计原则（用于评估本项目）
| # | 原则 | 含义 |
|---|---|---|
| **P1** | **风险匹配** | 写/不可逆 → fail-closed + 人工确认；只读/可逆 → fail-open + 提示（warn 档） |
| **P2** | **确定性优先** | 判据用能力清单/语法/阈值（static），避免"用户说了什么词"的语义启发式 |
| **P3** | **反幻觉靠证据链** | 数字必须可溯源（工具返回 + SQL + 口径 + 自检），不靠"拦住问题"防错 |
| **P4** | **资源靠预算** | 无界消耗用估算/超时/熔断/成本封顶，不靠语义猜测 |
| **P5** | **可观测 + 可降级** | 触发原因记录回显；误拦能自愈重试（不把护栏故障说成"库里没数"） |
| **P6** | **护栏分档** | 引入 **warn（软提示不阻断）** 档，与 block 互补（openclaw 契约） |

---

## 三、多方向评估：专名护栏（专项）

### 3.1 三方案对比（实测结论）
| 方案 | 做法 | 对齐 | 代价 |
|---|---|---|---|
| A SQL 形态检测 | 含 `SELECT…FROM` 视为内部取数，不触发 | 部分（只解"贴 SQL"） | 仍误伤"纯中文+技能名" |
| B 扩充契约词豁免 | SQL 关键字 + 技能名成分入通用词表 | 部分（缓解） | 词表永漏、维护负担 |
| **C 降级软提示** | 不再硬拦，附"若 X 是外部主体请先 web_search"提示 | **完全对齐 P1/P2/P6** | 失去硬兜底 → 由 GROUNDING 反编造补偿 |

### 3.2 已实施的"方向 C（技能闸）"与方案 C 的区别
- 实际落地的"方向 C"= **技能闸**：读过 `business-data-query` → 信任模型选源，不再词形硬拦；未读技能仍兜底硬拦。
- 端到端实测：读过技能后含 `Netflix`/表名的消息**放行取数**（解决主流误伤）。
- **剩余边角（P1-3/4、实测）**：形态过滤只处理 snake/驼峰/点号，**纯小写单词**仍漏——用户**直接贴 SQL**（`SELECT`/`COUNT`/`JOIN` 等关键字）或**提技能名**（`business-data-query` 的 `business`/`query`）仍被当"外部专名"硬拦，且提技能名与"必须先读技能"形成死锁（已在 BI 库实测核验时复现）。

### 3.3 最终推荐
**保留已实施的技能闸（主流场景已解）+ 补"warn 档"兜底**：
- 把 `UNSCOPED_NAME_BI_REFUSAL` 的**纯小写单词类**触发从硬拦降为 **warn（附提示、不阻断）**，彻底消除贴 SQL/提技能名的边角死锁（对齐 P1/P6）；
- 仍保留"未读技能 + 真外部专名"的硬拦兜底（确定性边界，对齐 P2）；
- 外部专名若真拿 BI 搜、返回空 → GROUNDING 反编造护栏保证"如实说没数据，不编造"（本项目已验证）。

---

## 四、综合问题清单（按严重度，详见证清单文档）

### P0 / 严重（与线上事故同源，优先修）
| # | 问题 | 影响 |
|---|---|---|
| **P0-1** | SETTINGS 未判数据库引擎就全局追加；3 个 SQL 入口 `database_id` 归一化不一致 | 与事故①同源（一处全局注入打挂全部查询） |
| **P0-2** | `classifyUpstreamError` 不识别 `Code 115 / UNKNOWN_SETTING` | 事故①只是被"改名+默认关闭"遮住，**无自愈**；换库/开开关即全失败且归因方向相反 |
| **P0-3** | `result_overflow_mode='break'` 静默截断 | 高基数查询**系统性偏小且零提示**（静默给错数） |
| **P0-4** | `hasDateWindow` 只认 `'YYYY-MM-DD'`，DateTime 不识别 | DateTime 写法有界短窗误判无窗 → 误报 HEAVY |
| **P0-5** | `HEAVY_EXACT_AGG_NOWINDOW` 漏 `uniqExactIf/Array/State/OrNull` | **恰好是线上事故形态**，护栏对其失效 |
| **严重-1** | 前端**零测试** | 状态映射改动无回归保护 |
| **严重-2** | `tool_result.executed` 13 个 yield 分支**零测试** | 核心语义（未执行 vs 真失败）无自动化保护 |
| **严重-3** | COMPARISON 文档 DAU 数字**自相矛盾**（3 处过时） | 削弱结论可信度 |
| **严重-4** | GUARDRAIL 文档 §6.6 与 §五/§6.7 **矛盾** | 读者被引向已修复/改名做法 |

### P1 / 高
| # | 问题 |
|---|---|
| P1-1 | `!=` 被当单日等值窗（修复③引入的假阴性，漏报 HEAVY） |
| P1-2 | `GROUP BY 1` 误报 `GROUP_BY_SELECT_MISMATCH` |
| P1-3 | 形态过滤把真外部专名也删了（判据选错实证，P0-3 节已述） |
| P1-4 | `GENERIC_LATIN_TOKENS` 覆盖不足（SQL 关键字/技能名成分未豁免） |
| P1-5 | 自有业务护栏硬编码 `mcp__bi__` server id |
| P1-6 | `usedOwnBusiness` 只看点名不看执行 |
| P1-7 | 专名闸被拦不计入 `ownBusinessRefused`（拿不到重试兜底） |
| P1-8 | `repeatBudgetStop` 只在并发分支（串行无上限保护） |
| P1-9 | 工具循环内部无 try/catch（异常逃逸 `runLoop`） |
| P1-10 | `app.ts` 重建 steps 丢 `executed`、无结果记成功 |
| P1-11 | `execute_query(question_id)` 绕过 lint/SETTINGS/只读校验（后门） |
| 前端高-1 | `.mcp-dot.error` 不存在（子代理失败灰点） |
| 前端高-2 | `cancelled` 映射成绿点（自相矛盾） |
| 前端高-3 | `Bubble` 第二份未收敛（我的收敛只完成一半） |
| 前端高-4 | `--warn` 主题变量不存在（4 处硬编码，深色对比度不足） |
| 前端高-5 | `.step.warn .step-status` 缺失（"未执行"药丸灰色） |

### P2 / 中低
- 后端：`P2-1` 求源类护栏无日志/审计；`P2-2` `alreadyHasSettings` 静默跳过资源护栏
- 前端：状态函数无编译期穷尽性、同一"未执行"语义三套冲突写法、aria 缺口、bubble.css 死规则、reduced-motion 缺口
- 测试：`[D4c]` 边角输入无覆盖、`checkCaliber` 硬拦无单测
- 文档：三份文档零交叉引用、GUARDRAIL §五计数过时、MULTI_JOIN_UNBOUNDED 描述窄于代码、COMPARISON 个别数字未标时点

---

## 五、整改批次路线图

### 批次 1：资源安全（会打挂/静默给错数，最高优先）
- [ ] **P0-1**：`runSql` 内先取 engine，仅 ClickHouse 系才 append SETTINGS；wid 归一化上提到 `runSql` 共用
- [ ] **P0-2**：`classifyUpstreamError` 增 `115/UNKNOWN_SETTING` 分支 → 自动不带 SETTINGS 重试一次 + 记日志回显被跳过 setting + 再失败才回落通用
- [x] **P0-3**：`result_overflow_mode` 默认改 `'throw'`（已在 `bi-query-settings.mjs` 落地；`BI_CH_RESULT_OVERFLOW_MODE=break` 可还原静默截断）
- [ ] **P0-5**：`HEAVY` 正则扩到 `uniq\w*(?:If|Array|State|OrNull)?` 家族
- [ ] **P1-11**：`execute_query` 纳入同一 lint/SETTINGS/只读校验链

### 批次 2：判据正确性
- [ ] **P0-4**：`hasDateWindow` 放宽日期正则支持 `toDateTime('… 08:00:00')` 写法
- [ ] **P1-1**：排除 `!=`/`<>`（只认 `=` 为等值）
- [ ] **P1-2**：`GROUP BY` 只含序号时返回 null（放弃判定）
- [ ] **P1-10**：`app.ts` 重建 steps 保留 `executed`，无结果记 `interrupted`

### 批次 3：专名护栏收口（消除边角死锁）
- [ ] 按 3.3：纯小写单词类触发降为 **warn 档**（不阻断），保留"未读技能+真外部专名"硬拦
- [ ] **P1-5**：`mcp__bi__` 改为常量/配置
- [ ] **P1-6/7**：`usedOwnBusiness` 改用 `ownBusinessExecuted`；专名闸命中也置 `ownBusinessRefused`
- [ ] **P1-8/9**：串行补 `repeatBudgetStop`；主循环补 try/catch

### 批次 4：测试与前端收尾
- [ ] **严重-1**：`apps/web` 装 vitest + 至少 3 条状态映射用例（executed===false&&ok===false→refused 等）
- [ ] **严重-2**：新建 `tool-result-executed.test.ts`，逐 yield 断言 `executed`
- [ ] 前端高-1~5：error 类名 / cancelled 绿点 / Bubble 收敛 / `--warn` 变量 / `.step.warn .step-status`

### 批次 5：文档校准
- [ ] 严重-3/4 + 中低文档项：统一实测值、消矛盾、三份文档交叉引用、方案 C 标注状态

### 批次 6：输出质量（SQL 质量 / 结果正确率 / 总结 / 排版）
> 详述与最佳实践对照见 `REVIEW_FINDINGS_OUTPUT_QUALITY_2026-10-17.md`（3 子 agent 审查）。
- [ ] **输出正确率（会直接给错数，最高优先）**：维度二 #2 服务端合计/汇总复核（普通查询也校验，仿 `schedule-alert.ts:204`）；#3 中文表头/枚举翻译层（至少告警，避免裸英文上屏）；#1/#4 结论先行+口径+来源运行时结构判定；#5 通用角色 `enforceGrounding` 默认开
- [ ] **SQL 质量**：维度一 P∅ gold SQL 静态校验（GROUP BY/聚合/别名/窗口/SELECT *，编译期强提示）；P2 `get_field_values` 归口 `runSql`、`hasDateWindow` 限 WHERE 作用域、`MULTI_JOIN_UNBOUNDED` 描述校准
- [ ] **排版（视觉断裂）**：维度三 H1+H2+H3 图表深色 + support-label 不可见（牵连 `--warn/--text/--surface/--border` 变量补齐）；M3 原始 `<a>` Tabnabbing 加固
- [ ] **打磨**：维度三 M1 代码高亮 / M2 warn 药丸 / M5 结论视觉强调 / M6 M7 表格包裹与流式性能；维度二 #6 预警 total 口径 / #7 wrapUpWith 复核 / #9 #10 核验保守化

---

## 六、回滚与验证
- 各批次改动独立、可单独 revert；护栏类改动集中在 `chat.ts` / `sql-lint-common.mjs` / `bi-query-settings.mjs`，范围可控。
- 验证：每批次跑 `tsc --noEmit` + 相关 vitest；护栏行为用浏览器端到端复验（含"贴 SQL""提技能名"两类历史误伤消息）。
- 不擅自提交：所有改动先落工作区，commit/push 由你确认后再做。

---

*生成：基于 2026-10-17 联网检索（OWASP 2026 / AWS / Anthropic / Traccia / openclaw / text-to-SQL 落地 / Agent 循环防御）+ 本项目 3 子 agent 审查 + 多方向实测。支撑文档：`BI_GUARDRAIL_BEST_PRACTICE_PLAN.md`、`REVIEW_FINDINGS_2026-10-17.md`。*
