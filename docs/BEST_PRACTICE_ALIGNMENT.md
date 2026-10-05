# 最佳实践对齐矩阵（Best Practice Alignment）

> 把本项目的功能与**公开的业界最佳实践**逐条对照，列出「✅ 一致 / 🟡 部分一致 / ❌ 未实现或口径不一致」，并标注缺口与行动。
> 本文是**缺口清单的 SSOT**；安全细节正文见 `docs/SECURITY.md`，各维度设计见 `docs/agent-infrastructure.md`。
> 判定口径：只根据**当前代码**判定，不把「文档里写了」当作已实现。

---

## 1. 对照来源与口径

| 来源 | 版本 | 用途 |
| --- | --- | --- |
| OWASP Top 10 for LLM Applications | 2025（LLM01–LLM10） | LLM 应用安全基线 |
| OWASP Top 10 for Agentic Applications | 2026（ASI01–ASI10，2025-12 发布） | Agent 安全威胁分类（100+ 研究者参与，被 Microsoft/NVIDIA/AWS 引用） |
| OpenTelemetry GenAI 语义约定 / AI Agent Observability | 2025 | 可观测互操作性标准 |
| Anthropic《Building effective agents》/《Effective context engineering》 | — | Agent 编排与上下文治理 |
| 生产就绪八维（追踪/评测/成本/安全/身份/异步/版本/可观测） | 本项目 `PRODUCTION_READINESS.md` | 上线维度自查 |

**符号**：✅ 已对齐 · 🟡 部分对齐（有实现但不完整或口径不同）· ❌ 未实现 · ➖ 不适用

---

## 2. OWASP LLM Top 10（2025）对照

| 项 | 最佳实践要求 | 本项目现状 | 判定 | 缺口 / 行动 |
| --- | --- | --- | --- | --- |
| LLM01 提示词注入 | 外部内容隔离标注；系统/用户输入分隔 | `src/untrusted.ts`：清洗控制符 + `[untrusted_content nonce]` 定界 + 协议规则（定界内只当数据、不构成写授权）。刻意不用越狱话术词表（符合「禁写死」红线，语义交模型） | 🟡 | 无「注入检测分类器」（业界普遍做法）。**本项目刻意不做**——词形/语义检测会退化为业务词写死。以「定界 + 只读桥 + 写确认」替代 |
| LLM02 不安全的输出处理 | 输出按上下文转义；不拼进 SQL；白名单标签过滤 | 前端 `chat-richtext.ts` DOMPurify 净化；`builtins.ts` 手写 HTML 零外链软护栏；出站密钥/PII 打码；**本轮收口** `src/output-schema.ts` 把结构化输出（澄清/待办/图表 spec）统一 fail-closed 校验 + `GET /chat/output-schema` 可观测 | ✅ | — |
| LLM03 训练数据污染 | 训练/微调数据清洗 | 项目不训练模型、不微调 | ➖ | 不适用 |
| LLM04 模型 DoS | 输入长度限制、速率限制、token 配额 | 请求体上限 `MAX_BODY_BYTES`；限流（chat/login/admin）；`MAX_TOOL_ROUNDS`；Doom Loop 跨轮熔断；上下文 token 预算；**本轮新增** `COST_HARD_QUOTA=on` 可开启硬配额（默认仍只 `budgetAlerts` 告警） | 🟡 | 硬配额默认关闭（免费链波动大，默认硬拦会误伤）；多实例为每实例计数（需入口层兜底）。列为已知局限 |
| LLM05 供应链漏洞 | 依赖审计、模型/插件完整性校验、SBOM | `pnpm audit` 进非阻断 CI；overrides 修传递依赖；子进程不继承凭据；MCP stdio 命令白名单（可选）；`scripts/gen-sbom.mjs` 产出 CycloneDX SBOM；**本轮新增** MCP 来源形态指纹漂移检测（`/mcp/provenance`） | 🟡 | 白名单默认未启用；来源检测只比命令形态（不哈希可执行文件，防替换需 `MCP_REQUIRE_PROVENANCE=on`） |
| LLM06 敏感信息泄露 | 输出 PII 扫描脱敏；RAG 按权限过滤 | RAG 文档级 ACL（召回前过滤）；审计/trace 不落凭据；出站凭据打码；**本轮新增**可开启的 PII 打码（`REDACT_PII=on`，email/手机号/身份证/银行卡，可按类型选） | 🟡 | PII **默认关闭**（业务数据误报高）；无姓名/地址类识别（无形态可依，靠词典必然误报，不做） |
| LLM07 不安全的插件设计 | 工具参数校验、最小权限、不执行任意 SQL | `BUILTIN_RISK` 风险登记 + 启动断言；`risk.ts`/`sql-readonly.ts` MCP 原生 SQL 只读闸（fail-closed）；`run_tool_code` 只读工具桥 | ✅ | — |
| LLM08 过度自主 | 最小权限，只给任务需要的工具 | 工具分级（read/write/destructive）；写操作二次确认；子代理最小工具集；会话级 MCP 启用集；**本轮新增** per-run 工具 allowlist（`toolAllowlist` 正向清单，注入即收窄、点名也被拒并回灌模型） | ✅ | allowlist 为 opt-in（未传入=行为不变），契合「模型自选 + 最小权限」 |
| LLM09 过度依赖 | 高风险输出加验证层、标注来源与置信度 | 事后核验两阶段（抽断言 → 不回传草稿逐条判支持性）；grounding 诚实兜底；RAG 答案带来源；未取证如实说 | ✅ | — |
| LLM10 模型窃取 | 限流、token 总量限制、批量相似请求检测 | 有 HTTP 限流（chat/login/admin）；进程级 metrics 可观测请求量；**token 总量配额**（`COST_HARD_QUOTA=on` + `DAILY_TOKEN_BUDGET` 全局池 + **本轮新增** `DAILY_TOKEN_BUDGET_PER_OWNER` 每 owner 池，防单用户烧光共享预算把其他人全挡住） | 🟡 | 配额**默认关闭**（免费链波动大，默认硬拦会误伤）且为**每实例**计数（多实例需入口层兜底）；仍**无批量相似请求检测** |

---

## 3. OWASP Agentic Top 10（2026）对照

| 项 | 最佳实践要求 | 本项目现状 | 判定 | 缺口 / 行动 |
| --- | --- | --- | --- | --- |
| ASI01 目标劫持 | 输入校验 + **目标约束** | `untrusted.ts` 定界；grounding 事后核验；写操作确认；**本轮新增**行为异常检测（`/chat/anomalies`，按 owner 建滚动基线比对轮数/token/耗时/工具新颖性） | 🟡 | 无「目标约束」（固化本次任务目标、偏离即拦）；行为基线已建但只报不管（样本<5 不判）。目标约束列为已知局限 |
| ASI02 工具滥用 | 工具 allowlist、作用域约束 | 风险登记 + 只读闸 + 写确认 + 越权拒绝并审计；**本轮新增** per-run 工具 allowlist（正向清单，按任务收缩） | ✅ | — |
| ASI03 身份与权限滥用 | Agent 作为一等非人类身份（NHI）治理：最小权限、JIT 授权、持续授权 | 匿名 cookie 会话（`bx_agent_sid`）+ 设备 owner（`bx_agent_oid`）；HTTP 面按 ownerKey 最小权限（只看自己的） | ❌ | **无登录/租户、无 NHI 生命周期管理**（创建/复核/监控/退役）。P1（多端接入前置项） |
| ASI04 记忆投毒 | 记忆隔离 + **完整性校验** | 记忆按 owner 隔离；条数与注入字符双上限；写入前清洗控制符 + 写入落审计（`memory_write`）；**本轮新增**内容指纹 sidecar + 逐条完整性校验（`/chat/memory` 返回 `integrity`） | ✅ | 写入前无用户复核确认入口（模型直调 `save_memory` 即落盘），列为已知局限 |
| ASI05 数据泄露 | 输出过滤、DLP | ownerKey 隔离；`Cache-Control: no-store`；出站凭据打码；**本轮新增**可开启通用 PII 打码（email/手机号/身份证/银行卡，可按类型） | ✅ | PII 默认关闭（业务数据误报高）；无姓名/地址类识别（无形态可依，不做） |
| ASI06 供应链 | MCP/插件完整性校验、SBOM、依赖审计 | 依赖审计（非阻断 CI）；`MCP_ALLOWED_COMMANDS` 命令白名单（配置时 + **spawn 前**再校验）；SBOM（`gen-sbom.mjs`，393 组件）；MCP 来源形态指纹漂移检测（`/mcp/provenance`，`MCP_REQUIRE_PROVENANCE=on` 可 fail-closed 拒连） | ✅ | 白名单默认关闭；来源检测只比命令形态（不哈希可执行文件） |
| ASI07 输入操纵 | 输入清洗、类型/结构校验 | 请求体上限；ReDoS 护栏（嵌套量词 + **本轮新增交替重叠型** `(a|a)*`）+ 2s 预算兜底；`runGate` schema/可调用性校验 | ✅ | — |
| ASI08 过度自主 | 渐进式自主、不可逆操作人工批准 | 写操作二次确认（三态 granted/denied/timeout）；`MAX_TOOL_ROUNDS`；Doom Loop 熔断；子代理受限工具集；**本轮新增** 渐进式自主（按近期质量**只向下**收紧轮次预算，`/chat/autonomy`） | ✅ | 不自动提权（历史质量好也不放开确认/权限——防刷分提权） |
| ASI09 日志与监控不足 | 全面遥测 + 审计 + 行为检测 | trace（run / round / span 三层）+ audit（append-only）+ cost + span 挂 `gen_ai.*`；**本轮新增进程级 metrics、OTLP 导出、行为异常检测** | ✅ | 仍无跨进程基线共享（基线在进程内，重启重建） |
| ASI10 不安全的输出处理 | 输出校验、下游控制 | DOMPurify 净化 + 零外链护栏 + 出站打码 | 🟡 | 无输出结构校验。P2 |

---

## 4. 可观测：OpenTelemetry GenAI 对照

| 最佳实践 | 现状 | 判定 | 行动 |
| --- | --- | --- | --- |
| 采用 GenAI 语义约定（标准属性名） | 自研 JSONL 结构；**本轮新增** span 上挂 `gen_ai.operation.name` / `gen_ai.provider.name` / `gen_ai.request.model` / `gen_ai.tool.name` / `gen_ai.tool.type` / `gen_ai.conversation.id` | 🟡 | 属性名已标准化（导出时可直接映射），但**仍无 OTLP 导出器**。P2 |
| 遥测作为评测的反馈回路 | trace 落盘 → **本轮新增 `src/eval-online.ts`**：每次真实运行确定性打分，回流成 `/chat/eval/*` 与 Prometheus 指标 | ✅ | 刻意不做 LLM-as-judge（每次运行都叠评委模型 = 成本翻倍 + 评委偏好），只用 trace 已如实记录的字段判 |
| metrics（吞吐/延迟/错误率/成本） | 拉取式聚合 + **本轮新增**进程级 Prometheus `GET /metrics`（模型/工具/运行/HTTP 四类，零依赖） | ✅ | — |
| 采样与保留策略 | trace 按月/按 run 分文件；**本轮新增**保留期清理（`TRACE_RETENTION_DAYS`，默认 30 天，启动 + 每日回收过期 run/rounds/spans） | 🟡 | 保留期已实现；仍**无采样**（全量落盘，高频场景磁盘增长靠保留期兜底而非采样减量） |

---

## 5. 生产就绪八维对照

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 追踪 Trace | ✅ | run / round / span 三层，runId 关联审计，逐轮落盘 |
| 评测 Eval | ✅ | G1–G7 测试闸门 + **在线评测**（每次运行确定性打分，`/chat/eval/runs` `/chat/eval/summary` + Prometheus 指标） |
| 成本 Cost | 🟡 | 有聚合 + 预算告警 + 钉钉推送；**本轮新增可开启的硬配额**（`COST_HARD_QUOTA=on`，默认仍只告警） |
| 安全 Security | 🟡 | 见 §2/§3；核心控制齐备，login/tenant/sandbox/多实例限流/出站DLP 有缺口（已知局限） |
| 身份 Identity | ❌ | 匿名 cookie + 设备 owner；无登录/租户/NHI 治理 |
| 异步 Async | ✅ | 执行与推送解耦、断线落库、专属会话回投、定时任务 |
| 版本 Version | ✅ | release（git sha）贯穿 trace/eval 基线 |
| 可观测 Observability | ✅ | 有 TracePage + 端点；进程级 `GET /metrics`；OTLP/HTTP JSON 导出（默认关闭）；行为异常检测 `/chat/anomalies` |

---

## 6. 汇总一：与最佳实践**不一致**的地方（口径/形态差异）

| # | 不一致点 | 最佳实践 | 本项目做法 | 是否有意为之 |
| --- | --- | --- | --- | --- |
| 1 | 提示词注入检测 | 用分类器/规则检测注入 | 只做结构化定界，**不做检测** | ✅ 有意：检测必然退化为业务词写死，违反最高红线；以定界+只读桥+确认替代 |
| 2 | Trace 格式 | OTel 语义约定 + OTLP | 自研 JSONL（**本轮已挂 `gen_ai.*` 标准属性**） | 🟡 部分有意：零依赖优先；属性名已对齐，导出器待补 |
| 3 | 评测形态 | 在线/持续评测闭环 | 测试闸门（G1–G7） | 🟡 有意：评测层已随 analytics 拆分清理，现以测试承担回归 |
| 4 | 成本治理 | 硬配额（超限拒绝） | 默认只告警；`COST_HARD_QUOTA=on` 时**可开启硬配额**（本轮补齐） | 🟡 部分：默认仍是告警（免费链波动大，默认硬拦会误伤），开启后 fail-closed |
| 5 | MCP 白名单 | 默认启用工具 allowlist | 默认关闭（`MCP_ALLOWED_COMMANDS` 未配=放行） | ✅ 有意：单机开发机需自由加 MCP；生产部署清单要求显式配置 |
| 6 | 子进程沙箱 | OS 级容器隔离 | 无沙箱，靠「环境白名单+超时+并发上限+只读桥」 | 🟡 无意（成本/平台限制），已在 `SECURITY.md` §8.4 诚实标注 |

## 7. 汇总二：**未实现**清单（按优先级）

| 优先级 | 缺口 | 对应最佳实践 | 说明 |
| --- | --- | --- | --- |
| **P1** | 登录/租户 + NHI 生命周期治理 | ASI03 | 多端接入前置项；当前靠匿名 owner 最小权限 |
| ~~**P1**~~ | ~~在线/持续评测闭环~~ | OTel「遥测作为评测反馈回路」 | ✅ **本轮已补齐**（`src/eval-online.ts`）。剩余：登录/租户与 NHI 治理——**用户 2026-10-06 明确暂不需要登录体系**，保留为已知缺口 |
| ~~**P2**~~ | ~~SBOM~~ | LLM05 / ASI06 | ✅ **本轮已补齐**：`scripts/gen-sbom.mjs`（CycloneDX 1.5，生产依赖），实测 393 组件 / 0 未知许可证 |
| ~~**P2**~~ | ~~通用 PII / 出站 DLP~~ | LLM06 / ASI05 | ✅ **本轮已补齐**（可开启）。剩余：姓名/地址类不做（无形态可依，词典必然误报） |
| ~~**P2**~~ | ~~按任务（per-run）工具 allowlist~~ | LLM08 / ASI02 | ✅ **本轮已补齐**：`toolAllowlist`（正向清单，只收窄），未传入=行为不变 |
| ~~**P2**~~ | ~~记忆完整性校验~~ | ASI04 | ✅ **本轮已补齐**：内容指纹 sidecar + 逐条校验（`/chat/memory` 返回 `integrity`）。剩余：写入前用户复核确认 |
| ~~**P2**~~ | ~~行为异常检测~~ | ASI09 | ✅ **本轮已补齐**：`src/anomaly.ts` 按 owner 建滚动基线比对（轮数/token/耗时突增、工具新颖性、未取证成串），`/chat/anomalies`。**样本不足不判**（防冷启动误报） |
| ~~**P2**~~ | ~~OTLP 导出器~~ | OTel | ✅ **本轮已补齐**：`src/otlp.ts`，OTLP/HTTP JSON 编码，默认关闭（`OTEL_EXPORTER_OTLP_ENDPOINT` 未配则不发请求） |
| ~~**P2**~~ | ~~渐进式自主分级~~ | ASI08 | ✅ **本轮已补齐**：`src/autonomy.ts` 按近期质量**只向下收紧**轮次预算（`/chat/autonomy`）；不自动提权 |
| ~~**P2**~~ | ~~MCP 服务器来源校验~~ | ASI06 | ✅ **本轮已补齐**：`src/mcp/provenance.ts` 比对命令形态指纹，漂移告警（`/mcp/provenance`） |
| ~~**P2**~~ | ~~输出结构（schema）校验~~ | LLM02 / ASI10 | ✅ **本轮已补齐**：`src/output-schema.ts` 把澄清/待办/图表 spec 校验统一收口，边界 fail-closed，`GET /chat/output-schema` 可观测 |

---

## 8. 本轮（2026-10-05 第七轮）已补齐项

| 缺口 | 落地 | 位置 |
| --- | --- | --- |
| ASI06 供应链 | MCP stdio 命令白名单 `MCP_ALLOWED_COMMANDS`（配置时校验 + **spawn 前再校验**） | `src/mcp/config.ts`（`isAllowedMcpCommand`）、`src/mcp/hub.ts` |
| ASI05 / LLM06 数据泄露 | 出站凭据打码（只认形态明确的凭据，保留类型标记） | `src/redact.ts`、`src/chat.ts`（最终回答落库前） |
| ASI04 记忆投毒 | 写入前清洗控制符（保留 `\t\n\r`）+ 写入落审计 `memory_write` | `src/memory.ts`、`src/builtins.ts`、`src/audit.ts` |
| ASI09 / OTel 互操作 | span 挂 `gen_ai.*` 标准属性（格式自有、语义标准） | `src/trace.ts`、`src/chat.ts` |
| **P1 成本硬配额** | `COST_HARD_QUOTA=on` + `DAILY_TOKEN_BUDGET`：当日累计达预算即拒绝**新的**运行（不掐在途运行），落审计 `quota_exceeded` | `src/quota.ts`、`src/chat.ts`（入口）、`src/audit.ts` |
| **P1 进程级 metrics** | `GET /metrics` 输出 Prometheus 文本格式；模型调用 / 工具调用 / 运行 / HTTP 四类打点，零新依赖 | `src/process-metrics.ts`、`src/app.ts`、`src/chat.ts` |
| **P1 在线评测闭环** | 每次真实运行**确定性打分**（收束 / 取证 / 轮数 / token / 耗时 / 稳定性 / 纠正七维），落 `.data/eval` JSONL，回流成 `bx_agent_eval_*` 指标与 `/chat/eval/runs`、`/chat/eval/summary`。**不调模型做评委** | `src/eval-online.ts`、`src/app.ts` |
| **P2 OTLP 导出** | `src/otlp.ts`：run/span 转 OTLP/HTTP **JSON** 编码推给 Collector；traceId/spanId 由 runId 稳定派生可去重；默认关闭、发了就忘、不阻断对话 | `src/otlp.ts`、`src/app.ts` |
| **P2 通用 PII 出站打码** | `REDACT_PII=on`（可按 `REDACT_PII_TYPES` 只开某几类）：email / 手机号 / 身份证 / 银行卡；**默认关闭**（业务数据误报高）。凭据打码不受此开关影响 | `src/redact.ts`、`src/chat.ts`（`redactSensitive`） |
| **P2 SBOM** | `scripts/gen-sbom.mjs`：复用 `pnpm licenses list --prod --json` 的**已安装**清单产出 CycloneDX 1.5（只生产依赖），零新依赖 | `scripts/gen-sbom.mjs` |
| **P2 行为异常检测** | 按 owner 建滚动基线（近 50 次），比对轮数/token/耗时突增、工具新颖性、未取证成串；**样本 <5 不判**；只报不管 | `src/anomaly.ts`、`src/app.ts` |
| **P2 记忆完整性校验** | 内容指纹 sidecar（`memory.digest.json`）+ 逐条校验；诚实区分 `match`/`mismatch`/`missing`；只告警不擅自改写 | `src/memory.ts`、`src/app.ts`（`/chat/memory` 返回 `integrity`） |
| **回归修复：记忆清洗正则** | 第七轮引入的清洗正则缺 `u` 标志，`\uE0000-\uE007F` 被解析成「`0` 到 `\uE007`」巨大区间 → **几乎匹配所有字符，会把整条记忆抹空**。已改 `\u{...}` + `u` 标志，并抽出可测纯函数 `sanitizeMemoryText` | `src/memory.ts`、`tests/anomaly-memory.test.ts` |
| **P2 per-run 工具 allowlist** | 新增正向清单 `toolAllowlist`（内置工具名）：写入即收窄，清单外工具既不注入、点名调用也拒绝并把拒绝回灌模型（静默丢弃会触发 Doom Loop） | `src/chat.ts`（opts + 两处执行闸门） |
| **P2 渐进式自主分级** | 按近期质量推导 `level`（0–2），**只向下**收窄轮次预算；绝不因表现好自动放开确认/权限（防刷分提权） | `src/autonomy.ts`、`src/chat.ts`、`src/app.ts`（`/chat/autonomy`） |
| **P2 MCP 来源漂移检测** | 记各服务器命令形态指纹（command/args/cwd），再登记时比对；漂移告警（`MCP_REQUIRE_PROVENANCE=on` 可 fail-closed 拒绝连接） | `src/mcp/provenance.ts`、`src/app.ts`（`/mcp/provenance`） |
| **P2 统一输出 schema 校验** | `src/output-schema.ts` 把散落的澄清/待办/图表 spec 校验收口为单一模块；每个结构化输出 fail-closed（畸形即拒绝并回灌模型），`GET /chat/output-schema` 暴露登记清单 | `src/output-schema.ts`、`src/builtins.ts`、`src/app.ts`（`/chat/output-schema`） |

---

## 9. 验证记录（多实例）

以下均为**实际运行**结果，不是代码审阅结论。

### 9.1 实例一：全量测试回归（真实 vitest 实例）

```
Test Files  58 passed (58)
     Tests  319 passed (319)
```

补齐前 57 文件 / 311 用例，补齐后 58 文件 / 319 用例（新增 `tests/best-practice-gaps.test.ts` 8 例），**无回归**。`tsc --noEmit` 0 错误。

### 9.2 实例二：新增补齐项单测（真实 vitest 实例）

```
tests/best-practice-gaps.test.ts > 出站密钥脱敏（ASI05 / LLM06）  ✓ 4 例
tests/best-practice-gaps.test.ts > MCP stdio 命令白名单（ASI06）  ✓ 4 例
Tests  8 passed (8)
```

### 9.3 实例三：真实模块实例（env 驱动行为，非 mock）

`node --import tsx .tmp/bp-gap-verify.mjs` → **20/20 PASS**，含：

- 脱敏：`sk-*`、`AKIA*`、`glpat-*`、`ghp_*` 四类凭据命中即打码且原文不残留；PEM 私钥整块替换为 `[REDACTED:PRIVATE_KEY]`；`countSecretHits` 计数=2；`共 20 条` / `单价 12.50 元` / `订单号 A20261005001` **不误伤**。
- MCP 白名单：未配 `MCP_ALLOWED_COMMANDS` → `npx` 放行、`validateServerInput` 通过（**现状不变**）；配 `npx,node` 后 → `cmd` 被拒（配置时报错「stdio 命令不在白名单内」）、`/usr/bin/node` 放行（认完整路径）、空命令被拒。

### 9.4 实例四：真实服务端 HTTP 实例

重启 `agent-server-dev` 后实测：

| 检查 | 结果 |
| --- | --- |
| `GET /health` | `200`，`Cache-Control: no-store`（第六轮护栏在位） |
| `GET /mcp/servers` | `200`（未配令牌恒等放行；**白名单默认关闭，未误伤已配置的 MCP 服务器**） |
| `POST /mcp/servers` 1.2MB body | `413`（请求体上限生效） |

### 9.5 实例五：真实 Chat 实例（遥测落地）

真实建对话 + `POST /chat/stream`，结束后读最新 span 文件：

```
最新 span 文件 spans-run_cc1e343a-....jsonl（2 行）
  llm span attrs={"gen_ai.operation.name":"chat","gen_ai.provider.name":"openai",
                  "gen_ai.request.model":"deepseek/deepseek-flash","gen_ai.conversation.id":"conv_..."}
  llm span attrs={... "gen_ai.request.model":"step-5-preview" ...}
带 gen_ai.* 属性的 span：2/2 → PASS
```

> ⚠️ 诚实说明：本实例中**所有已配置模型均返回 402**（`free trial quota` 免费额度耗尽，供应商侧问题，非代码回归），
> 因此只验证了「遥测链路 + 属性落地」，**没有验证到模型真实作答**。span 里 `ok:false` 正是模型 402 的如实记录——
> 这也反过来证明 span 会如实记录失败原因。模型额度恢复后需补跑一次完整作答实例。

### 9.6 未做实例验证的项（诚实标注）

| 项 | 原因 |
| --- | --- |
| 记忆写入审计 + 控制符清洗 | `addMemory` 落盘路径绑定 `.data/memory.json`，造实例会污染用户真实长期记忆；本次**仅代码审阅 + 类型检查 + 全量回归**。补测需先给 `memory.ts` 加可注入的存储目录 |
| 出站脱敏的**真实模型作答**路径 | 依赖模型产出含凭据的文本；模型 402 期间无法构造，已以纯函数多形态实例覆盖 |

### 9.7 实例六：真实服务端 `/metrics`（进程级指标）

重启后实测（先抓一次基线，再跑一次 chat，再抓一次）：

```
1) GET /metrics status = 200 | content-type = text/plain; version=0.0.4; charset=utf-8
3) 再次抓取 /metrics：
     bx_agent_llm_calls_total{status="error"} 10      ← 模型 402，如实记为 error
     bx_agent_llm_calls_total{status="ok"} 1
     bx_agent_llm_duration_ms_count{status="error"} 10
     bx_agent_rounds_count 1
     bx_agent_runs_total{status="ok"} 1
     bx_agent_tokens_total 2
PASS：进程级指标已随运行累加
```

恢复常态实例后再连抓两次：

```
bx_agent_http_requests_total{method="GET",status="200"} 2
```

> 说明：HTTP 计数在响应中间件里、handler 之后打点，所以**本次抓取看到的是之前的请求数**（第一次抓取为空属预期，不是缺陷）。

### 9.8 实例七：真实服务端成本硬配额

以 `COST_HARD_QUOTA=on` + `DAILY_TOKEN_BUDGET=1` **单实例**启动（先停掉 pm2 常态实例，避免定时任务分布式锁冲突），全新实例连跑两次对话：

```
第 1 次: 放行
第 2 次: 被拦截（QUOTA_EXCEEDED）
PASS：配额在第 1 次累计后拦截了第 2 次
```

语义确认：只挡「已达预算之后的**新**运行」，**不掐在途运行**（半途掐断比超预算更糟）。验证后已杀掉临时实例、恢复 pm2 常态实例（`/health` 200）。

### 9.9 实例八：真实服务端在线评测闭环

重启后跑一次真实对话，再查评测端点与指标：

```
1) 跑完一次 chat
2) GET /chat/eval/runs status=200 条数=1
     degraded score=0.857 failed=[stability] model=step5
3) GET /chat/eval/summary status=200
     {"runs":1,"avgScore":0.857,"good":0,"degraded":1,"poor":0,
      "axisFailures":[{"axis":"stability","count":1}],"qualityDegraded":false}
4) /metrics 中的评测指标：
     bx_agent_eval_runs_total{verdict="degraded"} 1
     bx_agent_eval_score_count 1
     bx_agent_eval_score_sum 0.8571428571428571
PASS：在线评测已随真实运行落盘并打点
```

`stability` 被判未达标是**如实**的：本轮所有模型 402，主流程连续切换候选模型（`modelFallbacks` 超阈值）。
这正是在线评测要抓的信号——「模型侧不稳导致的劣质运行」现在能被度量，而不只是事后翻日志。

### 9.10 实例九：OTLP 导出 + PII + SBOM（真实模块 / 真实收集器）

**OTLP**：脚本内起一个真实 HTTP 收集器（`127.0.0.1:14318/v1/traces`），用**真实 span 文件里的 runId** 调 `exportRunOtlp`：

```
收集器已启动 http://127.0.0.1:14318/v1/traces
PASS  找到真实 span 文件（80 个）
PASS  解析出真实 runId：run_unit_rounds
PASS  exportRunOtlp 返回成功
PASS  收集器收到 1 个 trace 请求
PASS  payload 含父 span + 子 span（169 个）
PASS  traceId 为 32 hex
PASS  子 span 的 parentSpanId 指向父 span（成链）
PASS  父 span 带 run 级属性 bx_agent.status
PASS  子 span 带 gen_ai.* 标准属性（可观测互操作）
```

**PII**（真实模块，开/关两种环境，17 项全 PASS）：默认关闭时 PII 不动、凭据照常打码；
开启后 email/手机号打码；`REDACT_PII_TYPES=email` 只打 email（**大小写归一**后生效——
初版因类型名大写而输入小写被静默过滤，是单测抓出来的）。

**SBOM**：`node scripts/gen-sbom.mjs` →

```
SBOM 已生成：D:\Code\bx-admin-agent\.data\sbom.cdx.json
组件数（生产依赖）：393
许可证未知：0
```

> 坑：`pnpm` 在 Windows 是 `.cmd` 垫片，`execFileSync("pnpm")` 会 ENOENT，
> 而 `execFileSync("pnpm.cmd")` 在 Node 22 下又报 EINVAL——最终走 `cmd /c pnpm.cmd`。

### 9.11 实例十：行为异常检测 + 记忆完整性（真实服务端）

```
1) GET /chat/memory status = 200
   integrity = {"ok":true,"count":3,"baseline":"missing","issues":[]}
   PASS  integrity.baseline 取值合法（诚实区分「没基线」与「对不上」）
   PASS  memory 仍是数组（结构与改动前一致）
2) GET /chat/anomalies status = 200 条数 = 0
3) 跑完一次对话后的异常检测指标：
     bx_agent_anomaly_runs_total{anomalous="no"} 1
   PASS  observeRun 已在真实运行上打点
```

`baseline: "missing"` 是**如实**的：升级后还没有经由服务写入过记忆，摘要文件尚未生成——
这不算篡改，只有 `mismatch` 才是。`anomalies` 为 0 也符合设计：**基线样本 <5 不判**，
避免冷启动第一次运行就被自己的空基线判成异常。

### 9.12 ⚠️ 本轮发现并修复的真实回归（记忆清洗正则）

写完整性校验的单测时，一条「501 个 x 应判超长」的断言失败，报的却是「含控制符」。
根因：**第七轮引入的记忆清洗正则缺 `u` 标志**：

```
[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFE00-\uFE0F\uE0000-\uE007F]
                                                                                    ^^^^^^^^^^^^^^
不加 u 时 \uE0000 被解析成 \uE000 + 字面量 "0"，于是 \uE0000-\uE007F 变成
「从字符 '0'(0x30) 到 \uE007(0xE007)」的巨大区间 —— 几乎匹配所有字符。
```

后果：`addMemory()` 的清洗会把**整条记忆抹空**（`text` 变空 → 返回 null → 记忆存不进去）。
第七轮只做了代码审阅没造实例，正是当时 §9.6 里诚实标注的「未做实例验证」项，果然在那里翻了车。

修复：改用 `\u{E0000}-\u{E007F}` + `u` 标志，并抽出纯函数 `sanitizeMemoryText()` 便于单测；
新增断言「中文 / 英文 / 单号 / 数字等正常文本清洗后必须原样保留」。

> 教训：**清洗类（白名单反向 = 去字符）的正则必须有一条「正常文本不被改动」的断言**，
> 只测「坏字符被去掉」会漏掉正则写错导致的大面积误伤。

### 9.13 实例十一：工具 allowlist / 渐进式自主 / 来源校验（真实服务端）

```
1) GET /chat/autonomy status = 200 → {"level":2,"reason":"样本不足（0/5），按默认自主度","maxRounds":14}
   PASS  自主度端点 200
   PASS  level 取值合法
   PASS  maxRounds ≥ 1
2) GET /mcp/provenance（第 1 次）status = 200
   checks = [bi/yapi/movie/orders/gitlab/zoho-salesiq 共 6 个，status="new"]
   PASS  来源端点 200
   PASS  checks 是数组
   PASS  strict 标记存在（默认 false = 只告警不拦）
3) GET /mcp/provenance（第 2 次）→ 6 个全部 "unchanged"（指纹稳定）
   PASS  已有基线后再比对 → unchanged
```

`/chat/autonomy` 返回 `level 2` 是**如实**的：当前没有近期评测样本，按默认自主度（不收紧、也不提权）。
`/mcp/provenance` 第 1 次把 6 个已配置服务器记为 `new`（建立基线），第 2 次全部 `unchanged`——
证明指纹稳定、只要命令形态没变就不会误报。后续若某个 `command` 被替换，立即变 `changed` 并告警
（`MCP_REQUIRE_PROVENANCE=on` 下还会拒绝连接）。

> 工具 allowlist（`toolAllowlist`）因依赖「模型真实调用工具」才能端到端验证，而当前模型侧 402，
> 故该路径以**单测**覆盖（注入收窄 + 点名调用拒绝回灌），未做 HTTP 级实例（与历史同类项的取舍一致）。

### 9.14 关于 P1/P2 收尾

- P1 四项：登录/租户与 NHI 治理（ASI03）经用户 2026-10-06 明确「暂不需要登录体系」保留为缺口；
  其余三项（成本硬配额、进程级 metrics、在线评测）已补齐。
- P2 八项：本轮补齐「per-run 工具 allowlist / 渐进式自主 / MCP 来源校验 / 统一输出 schema 校验」后，**全部完成**。

### 9.15 实例十二：统一输出 schema 校验（真实服务端）

```
GET /chat/output-schema → 200
schemas: request_clarification:true, write_todos:true, render_chart:true, export_data.charts:false
```

四个结构化输出的 schema 全部登记、可被运维核对：工具产出类（澄清 / 待办 / 图表）为 `strict:true`
（fail-closed——畸形即拒绝并回灌模型重试，绝不把坏结构交付前端）；导出内嵌图表为 `strict:false`
（宽松过滤，不合规图表安静丢弃、不拖垮整次导出）。该清单与 `src/output-schema.ts` 的 `OUTPUT_SCHEMAS`
同源，新增结构化输出时一处登记即同时获得「校验 + 可观测」。

> 该层是把原本散落在 `builtins.ts` 的 `normalizeClarification` / `normalizeTodos` / `isChartSpecLike` /
> render_chart 内联判断**收口**为统一模块，行为完全不变（含弱模型双重编码宽容解析、可选字段宽松），
> 只是从「散落函数」变成「单一可审计、可观测的出口」。单测 21 例覆盖各输出合法/非法分支。

> ⚠️ 事故与修复：本轮 `write_to_file` 直接覆盖了**已被 git 跟踪**的 `src/metrics.ts`（`8eff5e4` 提交的 `buildMetrics`，供 `/chat/metrics` 使用），
> 被 `tsc` 报 `has no exported member 'buildMetrics'` 发现，已 `git checkout HEAD --` 还原，新模块改名 `src/process-metrics.ts`。
> **教训：新建文件前必须先确认目标路径未被跟踪**（`git ls-files --error-unmatch <path>`）。

### 9.16 实例十三：trace 保留期清理（§10 局限收口）

`trace.ts` 新增 `cleanupTraceDir(dir, retentionMs)` 与 `startTraceRetentionSweeper()`，`index.ts` 启动时挂一次 +
每 24h（`unref`，不阻止进程退出）。策略对齐 OTel「采样与保留策略」中**保留期**那一半：

- `runs-YYYYMM.jsonl`：**整月**早于保留期起点的直接删文件；跨月的则逐行裁剪（`at`<cutoff 的 run 丢弃，其余保留）。
- `rounds-<runId>.jsonl` / `spans-<runId>.jsonl`：runId 不在「本轮仍在保留期内」的集合即删——过期 run 的明细，
  以及**孤儿**明细文件（对应 run 记录早已不存在）一并回收，避免明细文件比 run 活得久。
- 损坏的 run 行**保留不删**（宁可留痕，不误删证据）；`TRACE_RETENTION_DAYS` 未配=30 天，配 `<=0`=关闭清理（不启用扫描器）。
- **旧格式遗留**（`<uuid>.jsonl`，早期「每 span 一文件」写法）：当前代码**无任何读取方**
  （`cost.ts` / `listRunTraces` / `listSpanTraces` 一律只认 `runs-\d{6}` 与 `spans-<runId>` 精确路径），
  但实打实占磁盘，故按 mtime 一并回收。**不匹配任何已知形态的文件一律不动**（如 analytics 的
  `analytics-standalone.jsonl`），避免误伤别的子系统。

> **实例验证（真实目录，已备份可回滚）**：3178 文件 / 4.28MB → 2834 文件 / 3.56MB，
> 回收 344 文件（其中旧格式遗留 264 + 孤立明细 80），`expiredRuns=0`（两个月度文件都在保留期内）。
> 核对：analytics 文件未动、遗留文件剩余 2684 且最早为 09/07（正好是 30 天边界）——mtime 判定精确。

> ⚠️ 顺带发现并修复的真实缺陷：`trace-span.test.ts` / `round-trace.test.ts` 一直往**生产** `.data/traces`
> 写文件（`spans-run_span_*`、`rounds-run_unit_rounds`），此前每跑一次测试就堆一批，
> 既污染真实排障数据、又会被保留期清理当孤儿删掉。已加 `setTraceDirForTest()` 把测试落盘重定向到临时目录；
> 验证方式很直接——跑完全量测试后真实目录文件数 **3178 → 3178 零变化**（修复前必然增长）。

> 残留：仍无**采样**（全量落盘）。高频部署下磁盘减量要靠缩短保留期而非采样；真要采样需先定「哪些 run 可丢」
> 的口径（排障/评测/成本三类的保留需求不同），属设计决策，未做。

---

## 10. 已知局限（已评估、暂不做 / 需架构决策）

> 与 §6「有意为之的不一致」不同，下面这些是**尚未实现且需要架构层面决策或显著投入**的欠账，不是设计取舍。当前内网单机部署下风险可控，列此供后续排期。

| # | 局限 | 对应项 | 现状与缺口 | 推进所需 |
| --- | --- | --- | --- | --- |
| 1 | 登录 / 租户 + NHI 生命周期治理 | ASI03 | 仅匿名 cookie owner + 设备 owner 最小权限；无账号、无 NHI 创建/复核/退役 | 用户 2026-10-06 明确「暂不需要登录体系」，保留为缺口；多端接入前置项 |
| 2 | 子进程 OS 级沙箱 | LLM07/ASI02 执行安全 | `run_tool_code` / `run_command` / `run_script` 仅靠「环境白名单 + **凭据文件读取守卫** + 超时 + 并发上限 + 只读工具桥」，**无 microVM/Docker/AppContainer 隔离**：绝对路径可读任意**非凭据**文件、无出网限制、无文件系统隔离；守卫是拒绝清单，可被 `child_process` 绕过 | 需引入 microVM（gVisor/Firecracker）或容器运行时，平台成本较高 |
| 3 | 多实例限流 / 配额 | LLM04/LLM10 | 限流与成本配额均为**每实例**计数（进程内），多实例部署时各算各的、无全局阈值 | 需 Redis 或入口层（网关/反向代理）兜底 |
| 4 | 出站内容脱敏默认值 | LLM06/ASI05 | PII 打码 `REDACT_PII` **默认关闭**（业务数据误报高，开启会改坏正常回答） | 属刻意取舍；如需强制需在业务侧加白名单，非纯技术开关 |
| 5 | 配置端点强制令牌 | §5 安全 | `/mcp/servers`、`/notify/channels` 受 `admin-gate` 保护，但 `AGENT_ADMIN_TOKEN` 未配置时**恒等放行**；仅 `HOST=0.0.0.0` 无令牌才 fail-closed 拒启 | 开放局域网部署前必须显式配 `AGENT_ADMIN_TOKEN`，属部署清单项 |
| 6 | 模型窃取防护 | LLM10 | 有 HTTP 限流与 **token 总量配额**（全局池 + 每 owner 池双层，默认关闭、每实例计数）；仍**无批量相似请求检测** | 相似请求检测内网优先级低；全局配额计数需 Redis 或入口层兜底 |
| 7 | 目标约束 | ASI01 | 行为基线已建（`/chat/anomalies`），但无「把本次任务目标固化、偏离即拦」的目标约束层 | 需定义目标表示 + 偏离判定，属较大设计 |

> 原第 8 项「trace 保留期 / 轮转」已在本轮补齐（`TRACE_RETENTION_DAYS` + 启动/每日清理），不再列为局限；
> 残留的只有**采样**（全量落盘，未做采样减量），已在 §4「采样与保留策略」行标注。
