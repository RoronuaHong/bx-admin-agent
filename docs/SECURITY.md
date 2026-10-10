# 安全白皮书（Security）

> 本文件是 bx-admin-agent 安全态势的**权威文档**：列出已落地的控制项、默认部署假设、部署加固清单，以及**诚实标注的已知局限**。
> 相关设计背景另见 `docs/agent-infrastructure.md` §5（权限、安全与合规）、`docs/agent/PRODUCTION_READINESS.md` §2.6（安全维度评估）。
> 安全控制代码位置的索引在文末。

---

## 1. 范围与定位

bx-admin-agent 是一个 AI 对话 Agent 运行时：后端（Hono + TS）暴露 HTTP 端点供前端调用，可执行内置工具、调用模型、连接外部 MCP；`run_tool_code` / `run_command` / `run_script` 还会**在服务器上起子进程执行代码/命令**。

安全目标按优先级：

1. **不把服务器变成别人的执行跳板**（远程代码执行、凭据外带是头号风险）。
2. **只做被允许做的事**（最小权限 + 写操作确认 + 审计）。
3. **不泄漏私有数据**（会话/审计/trace 按归属隔离，响应不进缓存）。
4. **出错也不泄漏内部细节**（全局错误兜底统一 JSON，不回吐堆栈）。

---

## 2. 威胁模型（默认部署假设）

| 假设 | 说明 |
| --- | --- |
| 监听地址默认 `127.0.0.1` | 仅本机，前端经同机 vite 代理访问；**开放局域网/公网需要显式配置且承担对应风险** |
| 配置端点默认无令牌恒等放行 | 单机开发机信任本机；开放部署**必须**配 `AGENT_ADMIN_TOKEN` |
| 聊天端点无令牌 | 信任能连上端口的调用方（本机/内网）；若需对外，应在反代层加认证 |
| 模型输出不可信 | 模型可能输出 prompt 注入（来自知识库/工具返回/子代理回传），所有外部内容走定界处理 |
| 子进程代码来自模型 | `run_tool_code` 的代码是模型生成的，**可被 prompt 注入操控**，故其子进程受多重约束；`TOOL_CODE_FS_ALLOW` 放行凭据文件会削弱 §8.3 守卫，慎用 |

**已明确不做**（超出当前范围）：OS 级容器沙箱、登录/多租户、多实例分布式限流。凭据形态打码始终开启；通用 PII 打码默认关闭（`REDACT_PII=on` 才启用）。见 §15。

---

## 3. 网络暴露与监听

- **默认只听本机**：`serve` 绑定 `HOST`（默认 `127.0.0.1`）。历史版本曾因未指定 hostname 实际监听 `0.0.0.0:8787`，已修正。
- **公开监听 fail-closed**：若 `HOST=0.0.0.0`（或 `::`）且未配 `AGENT_ADMIN_TOKEN`，进程启动即 `process.exit(1)` 拒绝启动——否则「改 MCP 配置 → `reload` 即 `spawn` 任意命令」等于向局域网开放未鉴权远程代码执行。默认 `127.0.0.1` + 无令牌的行为不受影响。
- **全局配置端点令牌准入**：`/mcp/servers`、`/notify/channels` 等全局注册表端点，配置令牌后要求 `x-admin-token` 头；比较用 `crypto.timingSafeEqual` 防时序侧信道；按来源 IP 限流（`RATE_LIMIT_ADMIN_PER_MIN`，默认 30/分钟）压住反复 `reload` 不断 `spawn`。判定走 **request path**（非 `/health` 且非 `/chat/*`），刻意不用路由分组，避免端点散落时漏注册。

---

## 4. 认证与授权

- **会话标识**：匿名 cookie `bx_agent_sid`（会话 TTL）+ 设备 owner cookie `bx_agent_oid`（1 年，跨会话稳定归属）。
- **配置端点**：`AGENT_ADMIN_TOKEN` 未配时恒等放行；配置后所有非 chat/health 端点须带 `x-admin-token`。
- **最小权限（HTTP 面）**：`GET /cost/summary`、`GET /audit/list`、`GET /chat/trace/*` 强制 `ownerKey` 过滤——用户只能看自己的；全局视角只走 CLI / 管理端。他人或不存在的资源统一返回 `404`，不泄漏存在性。
- **审计留痕**：越权拒绝、写确认请求与结论（confirmed/denied/timeout/grant_read/ownership_mismatch/subagent_refused/clarify_deferred/memory_write/quota_exceeded/allowed）、工具调用决策均写入 append-only JSONL，与 trace 经 `runId` 关联（实际决策类型见 `src/audit.ts`）。

---

## 5. CORS

- 以配置 `webOrigin` 为主，叠加 `CHAT_CORS_ORIGINS`（逗号分隔）与本地开发端口（`localhost/127.0.0.1` 的 5173/5174）。
- `credentials: true` 下给**具体来源列表**，绝不使用 `"*"`（否则浏览器直接拒绝带凭据请求，且会放大暴露面）。
- 来源数组先 `filter(Boolean)`，去掉未配置（如 `webOrigin` 为空）产生的空项，避免把 `"undefined"` 当成一个来源。

---

## 6. 传输与响应头

全局中间件为每个响应附加（无额外依赖、内联实现）：

| Header | 值 | 作用 |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | 禁止 MIME 嗅探 |
| `X-Frame-Options` | `DENY` | 禁止被嵌入 iframe（点击劫持） |
| `Referrer-Policy` | `no-referrer` | 不泄漏来源 URL |
| `X-Permitted-Cross-Domain-Policies` | `none` | 禁止跨域策略文件 |
| `Cache-Control` | `no-store` | 所有 API 响应不进浏览器/代理缓存（聊天、配置、审计、trace 均含私有数据） |

- **TLS / HSTS**：由前置反代（如 nginx）负责；服务自身监听 HTTP，生产应只暴露 HTTPS 入口。HSTS 不应在明文端口下发。
- **CSP**：因前端为带哈希资源的内联 SPA，严格 CSP 会破坏渲染，未强制；静态资源走带哈希文件名 + `no-store`（见 §6）已足够。

---

## 7. 输入处理

- **请求体上限**：`MAX_BODY_BYTES`（默认 1MB，`0` 关闭）。有 `Content-Length` 时直接比较；分块且不带长度时按实际读到的字节累计，超过即 `413`（`hono/body-limit`）。对话快照走 `MAX_MESSAGES_BODY_BYTES`（默认 8MB），上传走 `MAX_UPLOAD_BODY_BYTES`（默认 22MB）。
- **全局错误兜底**：`app.onError` 把任何 handler 抛出的未捕获异常收敛成统一 JSON（`INTERNAL_ERROR`），不把内部堆栈/路径回吐给客户端，服务端留痕。
- **ReDoS 护栏**（`fs-store.ts` `isCatastrophicPattern`，用于 `fsGrep` 等把正则交模型的入口）：
  - 拦「嵌套/量词套量词」：`(a+)+`、`(.*)*`、`(a*)*b`、`(a+b)+`、`((a+)b)+`、`(a+){2,}`。
  - 拦「交替重叠 + 整体量化」：`(a|a)*`、`(.*|a)*`、`(a|ab)*`、`(a?|b)*`——分支可重叠匹配且组被 `*`/`+`/`{m,}` 量化即指数回溯。
  - **不误伤**顺序量词：`a+b+`、`\d+\.\d+`、`(foo|bar)+baz`、`\d{1,3}(\.\d{1,3}){3}` 等放行。
  - **兜底预算**：单次 `fsGrep` 最长 `FS_GREP_BUDGET_MS = 2000ms`，即便启发式漏判也保证单次调用最多占用这么久后截断返回（双重保险）。

---

## 8. 工具执行安全（重点）

### 8.1 风险登记与启动断言

每个内置工具在 `BUILTIN_RISK` 注册风险级别（`read` / `write` / `destructive` / `external`）。`assertBuiltinRiskCoverage()` 在启动时断言**全部**工具都登记过，漏登记直接抛错——避免「未登记的隐式放行」。

### 8.2 写操作二次确认

识别写意图 → 发 `confirmation_required` 事件 → 等用户应答（区分「拒绝」与「超时」）→ 才执行。确认请求本身零副作用。单一接线点：`chat.ts:2070` 的 `requestConfirmation`（`confirm.ts:58` 定义），所有写意图经此一处发出。

**「完全访问」与「硬拒」是两件事（2026-10-06 修订）**：

- `conversation.fullAccess` 缺省为 `true`（开箱即完全授权，对齐 CodeBuddy「完全访问模式」）。它**只跳过确认卡**，
  因为闸门过密会制造确认疲劳、用户退化成橡皮图章（论证见 `risk.ts` `verdictNeedsConfirm` 注释）。逐项弹卡可用
  前端「关闭完全访问」按对话关闭，`support` 角色即默认关闭。
- **`deny`（硬拒）不受 `fullAccess` 影响**（`risk.ts` 的 `isHardDenied`，签名里没有 `fullAccess`）。两个来源：
  `MCP_UNKNOWN_TOOLS=deny`（运维显式策略）与 `source=sql-readonly`（原生 SQL 非只读查询）。
  此前 `chat.ts` 写的是 `verdict.deny && !ctx.fullAccess`，等于**运维显式写下的安全策略被默认开启的开关静默覆盖**，
  且 SQL 只读闸在默认配置下只剩 MCP 适配器一层。现已修正，回归锚点 `tests/risk-hard-deny.test.ts`。

### 8.3 子进程执行：`run_tool_code` / `run_command` / `run_script`

这三类会**在服务器上起子进程**（`run_tool_code` 用 `spawn` 跑 Node/Python 解释器；`run_command`/`run_script` 用 `exec` 跑 shell / 解释器）。多重约束：

| 控制 | 默认 | 说明 |
| --- | --- | --- |
| 环境白名单（不继承服务端凭据） | `ENV_ALLOW` | 子进程只拿到跑起来必需的环境变量（`PATH`/`TEMP`/locale 等）。**不继承** `process.env` 全量——否则把 `MONGO_URI`、各家 API key 交给「模型写的、可被注入操控」的代码，配上不受限出网即凭据外带 |
| 输出边收边截断 | `STREAM_CAPTURE_MAX = 4MB` | 收集中超过上限即停止累加并标注，避免「疯狂 `print`」在收齐前先把内存打爆 |
| 展示截断 | `OUTPUT_MAX = 12KB` | 回给模型的输出保头尾截断 |
| 超时 + 强杀兜底 | 三条路径都是超时先 `SIGTERM`，1.5s 未退出升级 `SIGKILL` | 不留忽略软终止的孤儿进程 |
| **并发上限** | `TOOL_SUBPROCESS_MAX_CONCURRENT = 4` | 进程内信号量，把「同时在跑的子进程数」收敛到上限，多出排队。防 fork-bomb / 资源耗尽（恶意或 bug 代码瞬间拉起大量解释器） |
| 工具调用上限 | `TOOL_CODE_MAX_CALLS = 400` | `run_tool_code` 经只读桥调工具的调用次数上限 |
| 只读工具桥 | `run_tool_code` 只能调 `read` 级工具 | 桥接服务端工具时强制 `verdict.level === "read"` 且免确认；MCP 写工具进不来 |
| **凭据文件读取守卫** | `src/tool-code-fs-guard.ts`，默认开启 | 拦 `.env` / 私钥（`*.pem` `*.key` `*.p12` …）/ 云凭据目录（`.ssh` `.aws` `.docker` …）等**形态明确**的凭据文件读取。Node 侧前置补丁 `fs`（含 `promises` 与 `createReadStream`），Python 侧包装 `builtins.open`。逃逸口 `TOOL_CODE_FS_ALLOW`。**这不是沙箱**，见 §8.4 |
| **命令执行守卫**（child_process） | `src/tool-code-fs-guard.ts`，默认开启 | Node 侧在 `--require` 预加载里把 `node:child_process` 的 exec/spawn 家族（exec / execSync / execFile / spawn / spawnSync / fork）**在模块层打补丁抛错**——无论 ESM 命名导入 / `require` / `createRequire` / 动态 `import()` 拿到的都是补丁后函数（与上方 fs 守卫同一「模块求值期快照」机制）；Python 侧包装 `subprocess`（Popen/run/call/check_output…）/ `os.system` / `os.popen`。封死「模型代码 `import { execSync } from "node:child_process"` 直接执行任意命令、绕过只读工具桥」这条路径（审计第 2 项：Node ESM 命名导入绕过 permission model）。**不是沙箱**：原生插件 / `process.binding` / Python `from subprocess import Popen` 这类把名字绑到局部变量的写法仍可绕过 |

### 8.4 已知局限（诚实标注，非已修复）

> ⚠️ 当前子进程**没有 OS 级沙箱**。上述约束是「数量 / 环境 / 输出 / 读取」维度的护栏，**不提供隔离**：
>
> - **绝对路径可读任意文件（已收窄但未根治）**：子进程仍能用绝对路径读服务器上的任意**非凭据**文件（含其它项目源码、业务数据）。凭据文件（`.env` / 私钥 / 云凭据）已由 §8.3 的读取守卫拦下，但那是**拒绝清单**，不是隔离。
> - **守卫可被绕过（部分已收窄）**：`node:child_process` 的 exec/spawn 家族已在 §8.3 被模块级打补丁封死（ESM 命名导入 / `require` / `createRequire` / 动态 `import()` 均拿不到可用函数），命令执行这道被堵上；但仍可被原生插件 / `process.binding` / Python `from subprocess import Popen` 这类把名字绑到局部变量的写法绕过。守卫挡住的是 prompt 注入场景下**最直接**的那几步（让模型去读 `.env`、去 `execSync` 跑命令），挡不住决心明确的绕过。
> - **无出网限制**：子进程可连外部网络（凭据外带的真正出口）。
> - **无文件系统隔离**：`cwd` 默认在工作区，但代码可 `../` 越界写。
> - **无进程数硬上限（OS 层）**：`TOOL_SUBPROCESS_MAX_CONCURRENT` 是进程内信号量，多实例/多 worker 不共享。
>
> 真正的隔离需要 OS 级容器（microVM / Docker / Windows AppContainer）。在 Windows 开发机上做 microVM 容器化成本高，列为后续工作（§15）。**当前缓解**：默认只听本机 + 子进程不继承凭据 + 凭据文件读取守卫 + 超时 + 并发上限 + 只读桥；开放部署到不受信任网络前**必须先解决沙箱**。

---

### 8.5 MCP 服务器供应链（OWASP ASI06）

stdio 传输会 `spawn` 任意命令——**加了管理员令牌也挡不住**「有权限的人/被注入的流程新增一个恶意 MCP 服务器」，那正是供应链攻击的形态。

- `MCP_ALLOWED_COMMANDS`（逗号分隔，可选）：配置后，stdio 命令必须命中名单（同时认完整路径与可执行名，如 `npx` 与 `/usr/bin/npx`）。
- **两处校验**：配置时（`validateServerInput`）+ 建连时（`hub.ts` `transportRefusal`，在 `buildTransport` 里、真正 spawn 之前）。第二处挡的是「白名单启用前就已落盘」的旧服务器。拒绝记在连接的 `error` 上，避免半成品一直停在连接中。
- 未配置时：开发环境放行。`NODE_ENV=production` 未配则拒绝全部 stdio（配置校验与 spawn 前都生效）。生产清单见 §14。
- **子进程环境**（`mcpChildEnv`）：只给跑起来所需的 `PATH` 等、`BI_` / `YAPI_` 前缀、`MCP_ENV_PASSTHROUGH` 点名的变量，以及该服务器自己的 `env`。不继承 `MONGO_URI` 和模型密钥。自定义 MCP 要额外变量时，写进服务器 `env` 或 `MCP_ENV_PASSTHROUGH`。

### 8.6 出站凭据打码（OWASP ASI05 / LLM06）

Agent 会读文件、读环境、调外部系统——回答里若带了读到的密钥，就是一次凭据外带。`src/redact.ts` 在**最终回答落库与下发前**做最后一道过滤：

- 只认**形态明确**的凭据（`sk-`、`AKIA`、`glpat-`、`ghp_`、`xox*-`、`Bearer`、PEM 私钥块、JWT），打码为 `[REDACTED:<TYPE>]`（保留类型标记，不静默消失）。
- 不做宽泛的「像密码」启发式——业务数据上误报率极高，会把正常回答改坏。
- 打码时打一条 `console.warn`，留痕但不落原文。
- 这是**最后一道**防线：真正的防线是「子进程不继承服务端凭据」（§8.3）与「凭据不入日志/trace」（§12）。
- **PII（可选）**：`REDACT_PII=on` 后追加打码 email / 手机号 / 身份证 / 银行卡，可按 `REDACT_PII_TYPES` 只开某几类。
  默认**关闭**——订单号像卡号、编号像身份证，默认开启会把正常回答改坏；
  姓名/地址这类**无形态可依**的不做（只能靠词典，误报不可控，也不符合「禁写死」红线）。
  凭据打码不受此开关影响（形态明确、误报极低，总是打码）。

### 8.7 长期记忆防投毒（OWASP ASI04）

记忆会被无条件拼进后续每一轮的**系统提示**——污染一次能影响之后很久的每一轮决策。

- **写入前清洗**：`addMemory` 剥离控制符（NUL、零宽、双向覆盖、变体选择符、Tag 块；保留 `\t\n\r`），防止伪造提示结构。
- **写入留痕**：`save_memory` 落审计事件 `memory_write`（谁 / 哪次会话 / 内容摘要前 60 字），污染后可回溯。
- **隔离与上限**：按 `ownerKey` 隔离；条数上限 + 注入字符总上限双约束。
- **完整性校验**（本轮新增）：`memory.digest.json` 存内容指纹（与顺序无关），
  每次由服务写入后刷新；`/chat/memory` 返回 `integrity.baseline`，诚实区分三种状态：
  `match`（一致）/ `mismatch`（**对不上，疑似带外篡改**）/ `missing`（没有基线，不算篡改）。
  另有逐条校验：空内容、含控制符/不可见字符、超长度。
- **只报不管**：发现异常只告警并暴露，不擅自改写用户数据（改数据留给用户决定）。
- 已知边界：写入**没有用户复核确认**（模型可直接调 `save_memory`），但已有查看/删除端点与前端面板；见 §15。

### 8.8 最小权限工具集（OWASP LLM08 过度自主 / ASI02 工具滥用）

默认所有内置工具都注入本轮（§8.8 提供收窄方式）。两种收窄方式：

- **反向剔除** `omitBuiltinTools`：划掉几个（如预警跑摘掉 `render_chart`/`export_data`）。
- **正向 allowlist** `toolAllowlist`（本轮新增）：只给明确清单。**未传 = 不收窄**（与改动前一致）。
  清单外工具既不注入，模型点名调用也**拒绝并把拒绝回灌模型**——静默丢弃会让模型以为工具坏了反复重试（Doom Loop）。
- 定时任务已有 `mcpServers`/`mcpAllowlist`/`denyBuiltinTools`：任务级工具集以任务自身配置为准，不与对话勾选取并集（避免越权放大）。

### 8.9 渐进式自主分级（OWASP ASI08）

`src/autonomy.ts` 按 owner 的近期评测质量推导 `level`（0–2），**只向下收紧**轮次预算：劣质占比高 → 减到 4 轮、中等 → 8 轮，正常 → 不收紧。

**刻意不实现「 earned trust escalation 」**：不因为历史表现好就自动放开确认或权限。理由——本项目的在线评测是确定性规则分，攻击者只要让运行「看起来干净」（少调工具、少纠正）就能刷高；用它**提权**等于给了攻击者一条路径。收窄则只会更保守。放开权限必须由人决策（改配置 / 改角色）。`GET /chat/autonomy` 可查看当前自主度与原因。

### 8.10 MCP 服务器来源校验（OWASP ASI06）

stdio 传输会 `spawn` 任意命令。命令白名单（`MCP_ALLOWED_COMMANDS`，§8.5）能挡「不在名单里的命令」，但挡不住「名单里的命令本身被换掉」。`src/mcp/provenance.ts` 补**来源漂移检测**：

- 指纹含命令形态（command / args / cwd）、HTTP 的 `url`、请求头哈希（不落鉴权原文），以及参数里本地脚本（`.js` / `.mjs` / `.cjs` / `.ts`，最多读 1MB）的内容哈希。
- **未开严格模式时，建连不检查、不拦。** `GET /mcp/provenance` 会比对并告警：命令、`url`、请求头变了保留旧基线；仅脚本内容变了则告警后接受新内容。
- `MCP_REQUIRE_PROVENANCE=on` 时，stdio 与 HTTP 都在 `buildTransport` 里检查。不一致就拒绝这次连接，失败记在连接错误上，不留下「一直连接中」的半成品。
- 旧基线还没有脚本哈希或 `url` / 请求头时，命令形态没变就补记，不算漂移。
- 不哈希 `node` / `npx` 可执行文件本身：运行时升级会误报。那一层靠命令白名单。

### 8.11 统一输出 schema 校验（OWASP LLM02 / ASI10）

模型不只是产出自由文本，还会产出**结构化子输出**：澄清卡片（`request_clarification`）、任务计划（`write_todos`）、图表 spec（`render_chart`）、导出报告里内嵌的图表（`export_data.charts`）。这些会被渲染成卡片 / 清单 / 图表或喂给下游（报告合成）——一旦结构非法，要么前端渲染崩、要么脏数据静默混入导出文件。

`src/output-schema.ts` 把这些散落的校验**收口为统一模块**：

- 每个结构化输出一个校验函数，统一 `ValidationResult` 形态（成功带 value，失败带 error 文本）。
- **边界 fail-closed**：畸形即返回错误文本、回灌给模型让它重试，**绝不把坏结构交付前端 / 下游**。非法澄清（缺 question、选项不足 2 个）、非法待办（非数组、超上限、未知 status）、非法图表（类型不支持、统计图 data 非行对象数组、图形类 data 非 `{nodes,edges}`）全部被拦。
- **只校验结构、不校验语义**（选项是否真能区分、图表数据是否真相关交给模型）；**可选字段宽松**（澄清的契约字段缺失不报错，弱模型漏填不该整次判失败）。
- 统一 `OUTPUT_SCHEMAS` 登记清单，`GET /chat/output-schema` 可观测（哪些输出被收口、是否 fail-closed、校验规则）。新增结构化输出时一处登记即同时获得校验 + 可观测。

> 这是把原本散落在 `builtins.ts` 的 `normalizeClarification` / `normalizeTodos` / `isChartSpecLike` / render_chart 内联判断**重构**到单一模块，行为完全不变，只是可审计、可观测。自由文本回答另有 `chat-richtext.ts` 的 DOMPurify 净化 + 零外链护栏覆盖（§8.3）。

## 9. Prompt 注入防护

外部内容（工具返回 / 检索片段 / 子代理回传）回灌模型前，由 `src/untrusted.ts` **结构化定界**（非越狱话术词表，语义仍 100% 交模型，符合「禁写死」红线）：

1. **清洗**：不可见/危险控制符（NUL、零宽、双向覆盖、变体选择符、Tag 块）。
2. **定界**：统一包成 `[untrusted_content kind=… nonce=… source=…] … [/untrusted_content]`，nonce 每请求随机，正文中同形标签被中和（防伪造闭合逃逸），`source` 标注来源。
3. **协议**：定界内一律当数据、只经函数调用通道发起工具、定界内容**不构成写操作授权**（写操作仍走确认卡）。

---

## 10. 外部 MCP 原生 SQL 只读闸

`src/risk.ts`（`isNativeSqlRejected` + 只读工具表）+ `src/sql-readonly.ts` 对 `mcp__bi__*` 等原生 SQL 工具做 fail-closed 只读校验，配合审计 gate——服务端判定只读 SQL 才放行，写 SQL / 改库一律拒绝。

---

## 11. 审计与可观测

- `src/audit.ts`：append-only JSONL（按月分文件），事件类型 `allowed` / `confirmed` / `denied` / `timeout` / `grant_read` / `subagent_refused` / `clarify_deferred` / `memory_write` / `quota_exceeded` / `ownership_mismatch`，与 trace 经 `runId` 关联。查看入口：`GET /audit/list`（ownerKey 隔离）+ `scripts/inspect-audit.mjs`（全局）。
- 审计告警节流（避免正常点「不同意」刷屏）：同「归属 + 工具」在窗口内累计到阈值才推第一条，带累计条数；`AUDIT_ALERT_THROTTLE=off` 退回逐条。
- trace：`GET /chat/trace/runs`、`/chat/trace/spans`（均 ownerKey 隔离，查不到/不属于自己统一 404）。

---

### 11.1 成本硬配额（OWASP LLM04 模型 DoS / LLM10）

`cost.ts` 的预算**只告警不拦截**——真超预算时钱已经花出去了才在报告里看到一行红字。这里补拦截层：

- 默认关闭（`COST_HARD_QUOTA` 未配 = 只告警），与改动前行为完全一致。
- 开启后按**当日累计 token** 拒绝新的对话运行；**不掐在途运行**（半途掐断比超预算更糟：钱照花还丢结果）。
- 拒绝落审计 `quota_exceeded`。
- 局限：进程内计数，多实例部署是**每实例**的额度，需入口层或共享存储兜底（§15）。

### 11.2 进程级指标（可观测）

`GET /metrics` 输出 Prometheus 文本格式，零新依赖。与已有的 `/chat/metrics`（**按 owner 的历史聚合**，每次现扫 JSONL，看趋势）分工：这里看**当下**的速率与错误率，进程重启即清零。

指标：`bx_agent_runs_total`、`bx_agent_llm_calls_total`、`bx_agent_llm_duration_ms`、`bx_agent_tool_calls_total`、`bx_agent_tool_duration_ms`、`bx_agent_tokens_total`、`bx_agent_rounds`、`bx_agent_http_requests_total`。

注意：本路径不在 admin-gate 的豁免里——配了 `AGENT_ADMIN_TOKEN` 后抓取需带 `x-admin-token`；默认只听 `127.0.0.1`，本机抓取不受影响。

## 12. 凭据与密钥

- 服务端密钥在 `.env`（已 gitignore，不进仓库）；`.data/mcp-servers.json` 中的 MCP 凭据**落盘时脱敏**（只返回键名）。
- 子进程**不继承**服务端 `process.env`（见 §8.3 环境白名单）。
- 日志 / trace 中不出现凭据明文。

---

## 13. 依赖安全

- `pnpm audit` 在本机默认 registry（npmmirror）不可用（无安全公告端点），必须用：`pnpm audit --registry=https://registry.npmjs.org`（已写入根 `package.json` 的 `audit` 脚本）。
- 传递依赖覆盖写在 `pnpm-workspace.yaml` 的 `overrides:`（pnpm 11 起不再读取 `package.json` 的 `pnpm.overrides`）。
- 关键修复历史：hono（parseBody 无界嵌套 / 查询串解析 / jsx 未转义 XSS）、dompurify（afterSanitize 游离子树事件处理器 DOM XSS）、markdown-it 15.0.0 的 linkify 二次复杂度（回退 14.x）。
- **SBOM（OWASP LLM05 / ASI06）**：`node scripts/gen-sbom.mjs` 产出 CycloneDX 1.5（默认 `.data/sbom.cdx.json`）。
  复用 `pnpm licenses list --prod --json` 的**已安装**清单（真实版本 + 许可证，比读声明范围更接近事实），
  只收生产依赖，零新依赖。出事时能立刻回答「我们受不受影响」，而不是临时翻 `node_modules`。
  实测 393 组件 / 0 未知许可证。许可证表达式（如 `MIT OR Apache-2.0`）原样保留为 `name`，不拆分（拆分需要 SPDX 解析器）。

---

## 14. 部署加固清单（checklist）

- [ ] 生产只暴露 HTTPS（反代终止 TLS），服务监听 `127.0.0.1`，由反代转发。
- [ ] 若必须开放局域网：**配 `AGENT_ADMIN_TOKEN`**（启动会 fail-closed 校验），并通过反代给 chat 端点加认证。
- [ ] `MODEL_PROVIDERS` 首位用稳定模型；免费链限流窗口期会退化，前端「切模型」兜底。
- [ ] 定时任务共享 MongoDB 分布式锁——**不要为验证而同时起第二个实例**（会把某个 schedule 真跑起来）。
- [ ] 改 `.env` / 代码后重启：`pm2 delete agent-server-dev` → 确认 8787 释放 → `pm2 start ecosystem.dev.config.cjs --only agent-server-dev`。
- [ ] 不信任网络下部署 `run_tool_code`/`run_command`/`run_script` 前，先解决 §8.4 的沙箱缺口。
- [ ] 生产设置 `NODE_ENV=production`，并配置 `MCP_ALLOWED_COMMANDS`（未配则 stdio MCP 起不来）。需要内容级拒绝时再开 `MCP_REQUIRE_PROVENANCE=on`。
- [ ] 生产 BI 配置 `BI_READONLY_API_KEY`。未配置时适配器拒绝连接，不会回落 `BI_API_KEY`。
- [ ] 依赖审计进非阻断 CI；前端类型检查进非阻断 CI（巨型 SFC 结果不稳定）。

---

## 15. 已知局限与后续工作

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 子进程 OS 级沙箱 | ❌ 未做 | 绝对路径可读任意**非凭据**文件 / 无出网限制 / 无文件系统隔离。凭据文件读取（§8.3）与 `child_process` 命令执行（§8.3）已分别由模块级守卫收窄（均为拒绝清单，原生插件 / 重绑定仍可绕过）。需 microVM / Docker / AppContainer |
| 登录与多租户 | ❌ 未做 | 当前为匿名 cookie 会话 + 设备 owner；多端接入前置项 |
| 多实例限流 | ❌ 需 Redis | 当前限流进程内，多副本不共享 |
| 出站凭据打码 | ✅ 始终开启 | `redact.ts` 认凭据形态；最终回答落库前打码。与下面的通用 PII 开关无关 |
| 配置端点强制令牌 | 🟡 默认不强制 | 需显式配 `AGENT_ADMIN_TOKEN` 才启用；默认单机信任 |
| 交替重叠 ReDoS 的更精确检测 | 🟡 启发式 | 当前靠「重叠分支 + 量化」启发式 + 2s 预算兜底，极罕见模式可能漏判但被预算兜住 |
| 通用 PII / 出站 DLP | 🟡 可开启 | `REDACT_PII=on` 后打码 email/手机号/身份证/银行卡；**默认关闭**（业务数据误报高）。姓名/地址类不做（无形态可依） |
| SBOM | ✅ 已做 | `scripts/gen-sbom.mjs` 产出 CycloneDX 1.5（生产依赖，393 组件） |
| MCP 服务器来源校验 | ✅ 形态 + 端点 + 本地脚本 | `src/mcp/provenance.ts` 比对 command/args/cwd、HTTP url、请求头哈希，并哈希本地脚本。stdio 与 HTTP 建连前检查；`MCP_REQUIRE_PROVENANCE=on` 时拒绝新连接。不哈希 `node`/`npx` 本体。生产未配 `MCP_ALLOWED_COMMANDS` 时 stdio 直接拒绝 |
| 统一输出 schema 校验 | ✅ 已做 | `src/output-schema.ts` 收口澄清/待办/图表 spec 校验，边界 fail-closed，`GET /chat/output-schema` 可观测；自由文本另有 DOMPurify 净化 |
| 进程级 metrics | ✅ 已做 | `GET /metrics` 输出 Prometheus 文本格式（模型/工具/运行/HTTP 四类打点，零新依赖）；进程重启即清零，趋势看 `/chat/metrics` 的持久聚合 |
| OTLP 导出 | ✅ 已做（默认关） | `src/otlp.ts`，OTLP/HTTP JSON 编码；未配 `OTEL_EXPORTER_OTLP_ENDPOINT` 则不发请求 |
| 在线/持续评测闭环 | ✅ 已做 | `src/eval-online.ts` 每次真实运行确定性打分（七维），落 JSONL + 指标 + `/chat/eval/runs`、`/chat/eval/summary`；**不做 LLM-as-judge** |
| 成本硬配额 | 🟡 默认只告警 | 默认 `DAILY_TOKEN_BUDGET` 只产生 `budgetAlerts`；置 `COST_HARD_QUOTA=on` 后当日累计达预算即拒绝**新的**运行（不掐在途运行），落审计 `quota_exceeded`。**双层**：全局池（守钱包）+ `DAILY_TOKEN_BUDGET_PER_OWNER` 每 owner 池（守公平，避免单用户烧光共享预算把其他人全挡住），两层都未配即不拦截。多实例时为**每实例**计数，需入口层兜底；owner 跟踪表按 `QUOTA_MAX_TRACKED_OWNERS`（默认 1000）有界淘汰 |
| 行为异常检测 | ✅ 已做 | `src/anomaly.ts` 按 owner 建滚动基线比对（轮数/token/耗时突增、工具新颖性、未取证成串）；**样本 <5 不判**、只报不管。局限：基线在进程内，重启重建，多实例不共享 |
| trace 保留期 / 遗留回收 | ✅ 已做 | `TRACE_RETENTION_DAYS`（默认 30 天，启动 + 每 24h）回收过期 run/rounds/spans 明细、孤儿子文件、以及旧格式遗留（`<uuid>.jsonl`，当前无读取方）。损坏行**保留不删**（宁可留痕不误删证据）；不匹配任何已知形态的文件（如 analytics 的 `analytics-standalone.jsonl`）**一律不动** |

---

## 附：控制项代码索引

| 控制 | 位置 |
| --- | --- |
| 监听地址 / fail-closed | `src/index.ts`、`src/config.ts`（`host`） |
| 配置端点令牌准入 + 限流 | `src/admin-gate.ts`、`src/app.ts` |
| CORS | `src/app.ts` |
| 安全响应头 / `no-store` / 全局错误兜底 / 请求体上限 | `src/app.ts` |
| ReDoS 护栏 | `src/fs-store.ts`（`isCatastrophicPattern`、`FS_GREP_BUDGET_MS`） |
| 内置工具风险登记 | `src/builtins.ts`（`BUILTIN_RISK`、`assertBuiltinRiskCoverage`） |
| 子进程约束（环境/输出/超时/并发上限） | `src/tool-code.ts`、`src/subprocess-limit.ts`、`src/builtins.ts`（`runShell`） |
| MCP stdio 命令白名单（ASI06） | `src/mcp/config.ts`（`isAllowedMcpCommand`）、`src/mcp/hub.ts`（`buildTransport`） |
| 出站凭据打码（ASI05 / LLM06） | `src/redact.ts`、`src/chat.ts`（最终回答） |
| 长期记忆防投毒（ASI04） | `src/memory.ts`（清洗）、`src/builtins.ts` + `src/audit.ts`（`memory_write`） |
| OTel GenAI 语义属性（可观测互操作） | `src/trace.ts`（`SpanTrace.attrs`）、`src/chat.ts`（llm / tool span） |
| 成本硬配额 | `src/quota.ts`、`src/chat.ts`（入口）、`src/audit.ts`（`quota_exceeded`） |
| 进程级指标 | `src/process-metrics.ts`、`src/app.ts`（`GET /metrics`）、`src/chat.ts`（打点） |
| per-run 工具 allowlist | `src/chat.ts`（opts `toolAllowlist` + 两处执行闸门） |
| 渐进式自主分级 | `src/autonomy.ts`、`src/chat.ts`（轮次预算）、`src/app.ts`（`GET /chat/autonomy`） |
| MCP 来源漂移检测 | `src/mcp/provenance.ts`；建连闸门 `src/mcp/hub.ts`（`transportRefusal`）；查询 `src/app.ts`（`GET /mcp/provenance`） |
| 统一输出 schema 校验 | `src/output-schema.ts`、`src/builtins.ts`、`src/app.ts`（`GET /chat/output-schema`） |
| OTLP 导出（可选） | `src/otlp.ts`、`src/app.ts`（run 收束时触发） |
| 出站 PII 打码（可选） | `src/redact.ts`（`redactPii` / `redactSensitive`）、`src/chat.ts` |
| SBOM | `scripts/gen-sbom.mjs` |
| 行为异常检测 | `src/anomaly.ts`、`src/app.ts`（`GET /chat/anomalies`） |
| 记忆完整性校验 | `src/memory.ts`（`canonicalDigest` / `validateMemoryItems` / `verifyMemoryIntegrity`）、`src/app.ts` |
| 只读工具桥 | `src/tool-code.ts`（`toolCodeDenied`、`DENIED`） |
| Prompt 注入定界 | `src/untrusted.ts` |
| MCP 原生 SQL 只读闸 | `src/risk.ts`、`src/sql-readonly.ts` |
| 审计 | `src/audit.ts` |
| 依赖覆盖 | `pnpm-workspace.yaml`（`overrides:`） |
