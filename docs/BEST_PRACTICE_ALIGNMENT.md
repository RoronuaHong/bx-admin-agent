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
| LLM02 不安全的输出处理 | 输出按上下文转义；不拼进 SQL；白名单标签过滤 | 前端 `chat-richtext.ts` DOMPurify 净化；`builtins.ts` 手写 HTML 零外链软护栏；**本轮新增**出站密钥打码 | 🟡 | 无「输出 schema 校验」（要求模型按结构输出再校验）。P2 |
| LLM03 训练数据污染 | 训练/微调数据清洗 | 项目不训练模型、不微调 | ➖ | 不适用 |
| LLM04 模型 DoS | 输入长度限制、速率限制、token 配额 | 请求体上限 `MAX_BODY_BYTES`；限流（chat/login/admin）；`MAX_TOOL_ROUNDS`；Doom Loop 跨轮熔断；上下文 token 预算 | 🟡 | **无用户级 token 配额**（成本只有 `budgetAlerts` 告警，不强制）。P1 |
| LLM05 供应链漏洞 | 依赖审计、模型/插件完整性校验、SBOM | `pnpm audit`（显式 registry）进非阻断 CI；`pnpm-workspace.yaml` overrides 修传递依赖；子进程不继承服务端凭据；**本轮新增** MCP stdio 命令白名单（可选） | 🟡 | **无 SBOM**；MCP 白名单默认未启用（单机开发机体验优先）。P2 |
| LLM06 敏感信息泄露 | 输出 PII 扫描脱敏；RAG 按权限过滤 | RAG 文档级 ACL（`rag/store.ts` `visibleTo`，召回前过滤）；审计/trace 不落凭据；**本轮新增**出站凭据打码 | 🟡 | **无通用 PII 检测/出站 DLP**（只做凭据形态，业务数据上误报高）。P2 |
| LLM07 不安全的插件设计 | 工具参数校验、最小权限、不执行任意 SQL | `BUILTIN_RISK` 风险登记 + 启动断言；`risk.ts`/`sql-readonly.ts` MCP 原生 SQL 只读闸（fail-closed）；`run_tool_code` 只读工具桥 | ✅ | — |
| LLM08 过度自主 | 最小权限，只给任务需要的工具 | 工具分级（read/write/destructive）；写操作二次确认；子代理最小工具集；会话级 MCP 启用集 | 🟡 | **无按任务（per-run）的工具 allowlist**——当前是「全局工具集 + 模型自选」。P2 |
| LLM09 过度依赖 | 高风险输出加验证层、标注来源与置信度 | 事后核验两阶段（抽断言 → 不回传草稿逐条判支持性）；grounding 诚实兜底；RAG 答案带来源；未取证如实说 | ✅ | — |
| LLM10 模型窃取 | 限流、token 总量限制、批量相似请求检测 | 有 HTTP 限流（chat/login/admin） | ❌ | **无 token 总量配额、无相似请求检测**。P2（内网部署优先级低） |

---

## 3. OWASP Agentic Top 10（2026）对照

| 项 | 最佳实践要求 | 本项目现状 | 判定 | 缺口 / 行动 |
| --- | --- | --- | --- | --- |
| ASI01 目标劫持 | 输入校验 + **目标约束** | `untrusted.ts` 定界；grounding 事后核验；写操作确认 | 🟡 | 无「目标约束」（把本次任务目标固化并偏离即拦）；无行为基线比对。P2 |
| ASI02 工具滥用 | 工具 allowlist、作用域约束 | 风险登记 + 只读闸 + 写确认 + 越权拒绝并审计 | 🟡 | allowlist 是**全局**的，非按会话/任务收缩。P2 |
| ASI03 身份与权限滥用 | Agent 作为一等非人类身份（NHI）治理：最小权限、JIT 授权、持续授权 | 匿名 cookie 会话（`bx_agent_sid`）+ 设备 owner（`bx_agent_oid`）；HTTP 面按 ownerKey 最小权限（只看自己的） | ❌ | **无登录/租户、无 NHI 生命周期管理**（创建/复核/监控/退役）。P1（多端接入前置项） |
| ASI04 记忆投毒 | 记忆隔离 + **完整性校验** | 记忆按 owner 隔离；条数与注入字符双上限；**本轮新增**写入前清洗控制符 + 写入落审计（`memory_write`） | 🟡 | 无完整性校验、无用户复核入口（记忆写入由模型直接调 `save_memory`）。P2 |
| ASI05 数据泄露 | 输出过滤、DLP | ownerKey 隔离；`Cache-Control: no-store`；**本轮新增**出站凭据打码 | 🟡 | 无通用 PII/DLP。P2 |
| ASI06 供应链 | MCP/插件完整性校验、SBOM、依赖审计 | 依赖审计（非阻断 CI）；**本轮新增** `MCP_ALLOWED_COMMANDS` stdio 命令白名单（配置时校验 + **spawn 前再校验**，fail-closed 落在执行点） | 🟡 | 白名单默认关闭；无 SBOM、无 MCP 服务器来源校验。P2 |
| ASI07 输入操纵 | 输入清洗、类型/结构校验 | 请求体上限；ReDoS 护栏（嵌套量词 + **本轮新增交替重叠型** `(a|a)*`）+ 2s 预算兜底；`runGate` schema/可调用性校验 | ✅ | — |
| ASI08 过度自主 | 渐进式自主、不可逆操作人工批准 | 写操作二次确认（三态 granted/denied/timeout）；`MAX_TOOL_ROUNDS`；Doom Loop 熔断；子代理受限工具集 | 🟡 | **无渐进式自主分级**（不以历史成功率提升权限）；不可逆操作未强制人工（靠风险等级触发确认，已接近）。P2 |
| ASI09 日志与监控不足 | 全面遥测 + 审计 + 行为检测 | trace（run / round / span 三层）+ audit（append-only）+ cost；**本轮新增** span 挂 OTel GenAI 标准属性 `gen_ai.*` | 🟡 | **格式自研、无 OTLP 导出**；无进程级 metrics（Prometheus）；**无行为异常检测**。P1（metrics）/P2（行为检测） |
| ASI10 不安全的输出处理 | 输出校验、下游控制 | DOMPurify 净化 + 零外链护栏 + 出站打码 | 🟡 | 无输出结构校验。P2 |

---

## 4. 可观测：OpenTelemetry GenAI 对照

| 最佳实践 | 现状 | 判定 | 行动 |
| --- | --- | --- | --- |
| 采用 GenAI 语义约定（标准属性名） | 自研 JSONL 结构；**本轮新增** span 上挂 `gen_ai.operation.name` / `gen_ai.provider.name` / `gen_ai.request.model` / `gen_ai.tool.name` / `gen_ai.tool.type` / `gen_ai.conversation.id` | 🟡 | 属性名已标准化（导出时可直接映射），但**仍无 OTLP 导出器**。P2 |
| 遥测作为评测的反馈回路 | trace 落盘；评测闸门现为 `tests/grounding-guard.test.ts`（G1–G7，随 `pnpm test` 跑） | 🟡 | **无在线/持续评测**（离线评测脚本 `eval-*` 已于 2026-09 清理）。P1 |
| metrics（吞吐/延迟/错误率/成本） | 仅有 `/cost/summary`、`/chat/trace/runs` 等**拉取式**聚合 | ❌ | **无进程级 Prometheus metrics**。P1 |
| 采样与保留策略 | trace 按月/按 run 分文件，无采样与保留期配置 | 🟡 | 缺保留期与轮转策略。P2 |

---

## 5. 生产就绪八维对照

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 追踪 Trace | ✅ | run / round / span 三层，runId 关联审计，逐轮落盘 |
| 评测 Eval | 🟡 | 有 G1–G7 测试闸门；**无在线评测 / 无人值守评测** |
| 成本 Cost | 🟡 | 有聚合 + 预算告警 + 钉钉推送；**本轮新增可开启的硬配额**（`COST_HARD_QUOTA=on`，默认仍只告警） |
| 安全 Security | 🟡 | 见 §2/§3；核心控制齐备，identity/sandbox/DLP 有缺口 |
| 身份 Identity | ❌ | 匿名 cookie + 设备 owner；无登录/租户/NHI 治理 |
| 异步 Async | ✅ | 执行与推送解耦、断线落库、专属会话回投、定时任务 |
| 版本 Version | ✅ | release（git sha）贯穿 trace/eval 基线 |
| 可观测 Observability | 🟡 | 有 TracePage + 端点；**本轮新增进程级 `GET /metrics`**；仍缺 OTLP 导出与行为检测 |

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
| **P1** | 在线/持续评测闭环 | OTel「遥测作为评测反馈回路」 | 现为测试闸门（G1–G7） |
| **P2** | SBOM + MCP 服务器来源校验 | LLM05 / ASI06 | 依赖审计已有，SBOM 未做 |
| **P2** | 通用 PII / 出站 DLP | LLM06 / ASI05 | 现只做凭据形态打码 |
| **P2** | 按任务（per-run）工具 allowlist | LLM08 / ASI02 | 现全局工具集 |
| **P2** | 记忆完整性校验 + 用户复核 | ASI04 | 现有隔离+清洗+审计，缺复核入口 |
| **P2** | 行为异常检测 | ASI09 | 现有留痕，无基线比对 |
| **P2** | OTLP 导出器 | OTel | 属性名已对齐，待接导出 |
| **P2** | 渐进式自主分级 | ASI08 | 现靠固定风险等级触发确认 |
| **P2** | 输出结构（schema）校验 | LLM02 / ASI10 | 现只有净化与外链护栏 |

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

> ⚠️ 事故与修复：本轮 `write_to_file` 直接覆盖了**已被 git 跟踪**的 `src/metrics.ts`（`8eff5e4` 提交的 `buildMetrics`，供 `/chat/metrics` 使用），
> 被 `tsc` 报 `has no exported member 'buildMetrics'` 发现，已 `git checkout HEAD --` 还原，新模块改名 `src/process-metrics.ts`。
> **教训：新建文件前必须先确认目标路径未被跟踪**（`git ls-files --error-unmatch <path>`）。
