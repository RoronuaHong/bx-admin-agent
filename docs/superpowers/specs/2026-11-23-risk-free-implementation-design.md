# 风险可控的剩余待办实施设计（2026-11-23 v2）

- 状态：A/B/C/D 低风险项已实施并推送；高风险项保持降级，收口记录见 §8（2026-11-24）
- 决策来源：用户要求「第 1 类不做，其余能做的都做」，并追加硬约束「先评估风险，不要改动原有功能和交互；没问题的先做，有问题的先列出来」
- 实施顺序：A 前端测试补强 → B 定时任务测试补强 → C 安全与审计测试/接线 → D 产品功能 additive 项
- 原则：每个子项目单独验证、独立回滚；任何无法用自动化测试证明「原行为不变」的项降级为方案文档，不落生产代码

## 1. 硬约束

1. 不改变任何现有功能、交互、视觉结果、API 默认行为或配置默认值。唯一允许的可见变化是 §6 中 pptx 作为新增导出格式带来的枚举文案扩展，且既有格式行为必须逐字不变。
2. 新能力必须 additive 或 opt-in；默认关闭或只在显式调用时生效。
3. 不删除现有代码路径，不收紧现有限流/校验口径，不修改持久化数据迁移逻辑。
4. 不覆盖工作区已有未提交改动；功能代码默认不提交，用户明确要求时才逐子项目独立提交、独立回滚。
5. 每个改动先写红测/契约测试，再改实现。
6. 每子项目结束必须全绿：服务端 `pnpm test` / `type-check` / `build`；前端 `pnpm --filter @bx/web test` / `type-check` / `build`；`git diff --check`；ChatPage 单 chunk 检查。前端测试基线不低于 64 例。
7. 浏览器实测、真实模型调用、外部服务凭据、人工签字均不作为本轮验收前置条件。

## 2. 明确不做（有问题项清单）

### 2.1 用户已明确跳过

- BI A/B 全量重跑、FK/owner/隐藏表外部签批。

### 2.2 需人工、真实浏览器或外部服务

- Chrome 全清单冒烟、中文 IME 真实输入法实例验证、前端视觉最终判定、7.5s 万条对话性能实测。
- 会话分享链接（依赖登录与权限模型）、消息落库即推（需持久事件与多实例分发）。
- 生产 Webhook / 真·单聊推送、RAG 网页链接抓取、Rerank、Jev/SalesIQ 中文校准闭环。
- 真异步子代理、mid-flight steer、Checkpoints 工作区快照、BI 专用子代理有效性验证。

### 2.3 需外部基础设施或架构决策

- 子进程 OS 级沙箱、多实例 Redis 限流、DB 层只读角色与行级权限、登录与多租户。
- 目标约束层、批量相似请求检测、trace 采样。
- 阶段 2 P1-2 `vue-tsc` CI 阻断：与 T7 解耦，本轮不做；触发条件为单独确认 `vue-tsc` 连续 3 次稳定后再评估。

### 2.4 风险高于收益，降级为方案或不改生产行为

- C16/C17/C18/C19/C23/C24/C26 的**生产 CSS 下沉**：视觉结果无法用自动化证明不变，本轮只做前置方案与 selector 归属契约测试，不动组件源码与 `chat-page.css`。
- sendBeacon：新增投递监听、幂等端点与现有卸载路径存在行为/竞态风险，且真实 unload 不可本轮验证，整体降级为方案。
- 定时任务未读清零失败回滚、老任务迁移补 `runs[0]`：改变失败路径可见角标与持久化数据，降级为方案；现有行为只用测试固化。
- T-8 凭据拒读：收紧 `run_tool_code` 默认校验口径且出网未根治，降级为方案。
- 审计输出/计数类项：IO-6、IO-7、IO-8、IO-9、T-9，以及 C-1/C-2/C-3/C-5、S-3/S-4/S-5/S-6、A-4 等改变输出语义、配额计数、调度或通知行为的项，不做。
- png 导出：新增 UI 按钮有视觉回归风险，降级为方案。

## 3. 子项目 A：前端测试补强（不碰生产 UI/CSS）

### 3.1 实施范围

- C16：按既有 `plan §10.8` 的三个 CSS 区间，扩展 `apps/web/tests/chat-task-panel-contract.test.ts` 中已有用例，逐项锁定 selector 归属与共享留根；不新增 case，保持 web 测试数 64/64。
- C17/C18/C19/C23/C24/C26：只写前置方案与 selector 归属表，不改组件源码或根 CSS；C19/C23 虽风险较低，仍因视觉不可自动化证明而降级。
- `visibleThinking`：新增表驱动纯函数测试，覆盖 `en/zh/pt-BR/hi`、空串/空白/短句、`lat=79/80`、比率 `0.15` 两侧、`pt-BR` 英文词计数边界；不改实现。
- IME：对 4 个现有 handler 做源码/行为契约测试，覆盖 `isComposing=true` 与 `keyCode=229` 不调用 submit、不 `preventDefault`；不改实现。

### 3.2 风险消除

- 不新增可见 UI 元素，不改点击、键盘、滚动、折叠、卸载行为。
- 所有测试必须在不改生产代码的前提下通过；若必须改生产代码才能测试，则该项降级为方案。

## 4. 子项目 B：定时任务测试补强（不改行为与数据）

### 4.1 实施范围

- 在 `schedule-runs.test.ts` 补：`same` 两期复用同一会话、`runs` 去重、`unreadRuns` 累加；`purpose=alert → same/on_alert`、报告默认 `new`；复用现有归档不删、删除保留会话用例。
- 在 `schedule-retry` 相关测试补：并发占用时 `skipped`，与每期新会话判定组合。
- 新增 web `task-groups` 契约测试：`taskConvIds`、`taskGroups` 过滤与分组，点击子项打开对应 `conversationId`；不改 UI。
- 未读清零：只固化现有两处入口 `clearTaskUnread` 与 `ctxMarkTaskRead` 的乐观清零行为，不做失败回滚。
- 老任务迁移：按 `docs/scheduled-task-sessions-plan.md §3.6/§3.8` 固化现有两类口径，不新增第二口径，不改数据。
- 若测试需要 seam，只允许新增纯函数包装或测试导出，不改默认参数、调用路径与持久化逻辑。

### 4.2 风险消除

- 不改 UI 布局、交互、角标可见性与手测清单。
- 不新增推送通道，5 秒轮询保留。
- 不做 bug 修复、数据回填或行为变更；只写测试固化现状。

## 5. 子项目 C：安全与审计（接线 + 测试，不改默认值）

### 5.1 实施范围

- 交互式 allowlist：把已实现的 `chatStream` opts `toolAllowlist` 暴露到 `POST /chat/stream` HTTP 层，显式传入才生效；不传等价于现状。
- T-7、A-3：已修，只补回归测试，覆盖原工具名含 `__`、非法字符折叠、`_2` 冲突后缀仍正确命中 `toolRisks.destructive`。
- `AGENT_DATA_DIR`：补集成断言，模块清单至少含 trace、audit、fs-store、uploads、memory、MCP config/tool-cache/provenance、RAG store、skills、eval-online、model-health、owner-alias；不改路径解析。
- 配置令牌：只补现有测试未覆盖端点的无令牌/错令牌/正确令牌用例；默认行为与前端请求头不变。

### 5.2 风险消除清单

| 项 | 处置 |
|---|---|
| T-7 / A-3 | 已修，仅补测试 |
| allowlist | HTTP 透传，默认不传 |
| DATA_DIR / 令牌 | 只补测试，不改默认值 |
| T-8 / IO-6 / IO-7 / IO-8 / IO-9 / T-9 / C/S/A 其余项 | 不做，已在 §2.4 列明 |

## 6. 子项目 D：产品功能 additive 项

### 6.1 实施范围

- pptx 导出：`EXPORT_FORMATS`/`MULTI_SHEET_FORMATS` 加 pptx，补 `BINARY_EXTS` 与 `MIME_BY_EXT`（`mimeOf()` 自动读取），动态导入 `pptxgenjs`；标题页 + 每表一页。使用变量 specifier 动态导入，与 `rag/parsers.ts` 同模式。若依赖或锁文件安装失败，降级为方案。
- RAG：离线评测集；现有分块默认值 `CHUNK_CHARS=900` / `CHUNK_OVERLAP=120` 由测试锁定。如需新分块策略，必须以 env 默认关闭且写入独立 namespace/索引，并用同一评测集做 A/B 基线，否则只留方案。
- `http_request`：默认关闭；开启时需注册 `BUILTIN_RISK`，具备主机白名单、私网/重定向/DNS 防护、响应体上限、确认门、审计，结果走 `wrapUntrusted`。缺任一项则不注册。
- R3：按 `docs/deep-agents-plan.md:409` 的原意「export 降为模块私有」，基于 tsc/LSP 引用清单，只处理零外部引用符号。R4：先生成 `scripts/_*.mjs` 清单与保留理由表，只归档无文档、无测试、无回归价值的脚本。
- 命令输出治理：默认值严格等于现状（`RUN_MAX_BUFFER`、`RUN_OUTPUT_MAX_CHARS` 与头尾截断行为不变），仅新增 opt-in 调整项；补 `maxBuffer` 超限返回 `ok: true`、成功截断、失败分支截断的集成测试。

### 6.2 风险消除

- 新增导出格式只扩展格式白名单，不改既有格式生成、下载、错误路径；用契约测试固定新旧格式行为。
- png 新按钮不做。
- http_request 默认不出现在 `builtinToolSpecs()` 与模型工具清单。
- R3/R4 必须先有引用/保留理由证据表，无证据不删。
- 命令输出不允许把超限失败改成静默截断。

## 7. 验证与交付

1. 每子项目先写测试，测试失败后再改生产代码。
2. A/B/C 以测试与契约为主；D 的 pptx/http_request 允许 additive 生产代码，但必须满足各自风险闸门。
3. 每子项目结束运行：服务端 `pnpm test` / `type-check` / `build`；前端 `pnpm --filter @bx/web test` / `type-check` / `build`；`git diff --check`；ChatPage 单 chunk 检查。前端测试数不低于 64。
4. 功能代码默认不提交；用户明确要求时逐子项目独立提交、独立回滚。
5. 最终结论只报告：已完成、已降级为方案、验证结果、残留风险。

## 8. 实施收口与后续计划（2026-11-24）

### 8.1 本轮实施记录

| 子项目 | 落地内容 | 提交 |
|---|---|---|
| A | `visible-thinking.test.ts`（15 例）、`ime-composing-contract.test.ts`（7 例）、`task-groups-contract.test.ts`（4 例）；C16 在 `chat-task-panel-contract.test.ts` 既有 case 内加 selector 归属断言，case 数不变 | `b843b18` |
| B | `schedule-runs.test.ts` +2 例（purpose 默认、`same` 两期复用）；`schedule-retry.test.ts` +1 例（`same` 与 skipped 组合） | `f92714e` |
| C | `app.ts` 透传 `/chat/stream` 的 `toolAllowlist`（不传等价现状）；新增 allowlist/T-7·A-3/DATA_DIR/令牌端点四组测试 | `f92714e` |
| D | 新增 RAG 分块默认值测试、命令输出三分支测试；修复 Node 22 缓冲超限错误码（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`）使 `ok: true` 回到注释既有意图 | `f92714e` |

门禁：`pnpm test` 147 files / 1017 tests、`pnpm --filter @bx/web test` 12 files / 90 tests、`pnpm type-check`、`pnpm build`、`git diff --check`、单 ChatPage chunk 全绿。前端测试数高于 64 基线。

### 8.2 C16 冲突裁决

§3.1 要求 C16 锁定 selector 归属，§10.8 的红测样本写的是「CSS 已搬进 `ChatTaskPanel.css`」，与 §2.4「生产 CSS 下沉不做」冲突。按硬约束取前者：**本轮只锁定当前归属**——`.notify-switch*` / `.notify-manage` / `.notify-form*` / `.notify-list` / `.notify-item*` / `.notify-note` / `.cron-raw` 仍在 `chat-page.css`，`.notify-btn*` / `.primary-btn` / `.field__input` / `.modal-*` 留根，`ChatTaskPanel.vue` 无 `ChatTaskPanel.css` 引用。§10.8 的搬迁断言待视觉可自动化证明后再启用。

### 8.3 C17–C26 前置方案与 selector 归属表

> 当前锚点以代码为准（旧计划 §10.2 行号已漂移）：`chat-page.css` 中通知 `:69–303`、任务表单 `:374–1194`、日期 `:1195–1407`、快捷导航 `:1408–1458`、骨架/状态点 `:1460–1562`、确认弹窗 `:783–826`、Toast `:1678–1713`、右键 `:1804–1864`、输入区 `:3393–3520`、产物预览 `:2928–2975`、对话区 `:3043–3070`。

| 块 | 主 DOM | 必须留根 | `:deep` / 特殊处理 | Teleport | 风险 |
|---|---|---|---|---|---|
| C17 任务表单主体 | `ChatTaskPanel.vue` | `.modal-*`、`.field__input`、`.primary-btn`、`.tools-*`、`.mcp-*`、`.prompt-box` | `UiSelect`/`ToolsSearch`/`SkillAddForm`/`McpAddForm`/`PromptBox` 逐项 `:deep` | `#task-panel-host` + 2× `to="body"` | 高→高 |
| C18 一次性日期选择器 | `ChatTaskPanel.vue` | `.field__input`；`dtPos`/ref 桥留根 | 状态变体随块搬；定位由根层算 | `to="body"` | 高→中高 |
| C19 快捷导航 | `ChatSidebarList.vue` | 无（`.side-nav*` 独占） | 无需 `:deep`；目标 `ChatSidebarList.css` | 无 | 低→低 |
| C20 骨架/拖拽/状态点 | `ChatSidebarList.vue` / `ChatThread.vue` | `.conv-dot*`、`.dragging*`、`.boot-skeleton*` | 只搬侧栏专属骨架 | 无 | 中高→中 |
| C21 删除确认弹窗 | `ConfirmDialog.vue` | `.modal-*`、`.ghost-btn`；`.confirm-text` 在 bubble 侧有副本 | 只搬 confirm 专属 | `to="body"` | 中→中 |
| C22 Toast | `DoneToast.vue` | `@keyframes done-toast-in` 在 `styles.css`（全局唯一来源） | 只搬 `done-toast*` 前缀 | `to="body"` | 中→中低 |
| C23 产物预览 | `ArtifactPreviewModal.vue` | `.modal-*`、`.ghost-btn` | 只搬 `preview-*`（类独占） | `to="body"` | 中低→低 |
| C24 对话区/气泡/大纲 | `ChatThread.vue` / `ChatBubble.vue` / `ConversationOutline.vue` | `bubble.css` 已有共享副本；`.group-head*` 等留根 | 逐 selector 建映射，建议拆 2–3 子提交 | 无 | 高→高 |
| C25 右键菜单 | `ContextMenuHost.vue` | 定位计算留根层 | 原规则写为 `:global(.ctx-*)`；下沉后需实测 scope 命中 | `to="body"` | 中→中 |
| C26 输入区 | `MessageComposer.vue` | `.tools-flyout*`、`.prompt-box` 基础、`.primary-btn` | `PromptBox`/`ToolsSearch`/`UiSelect` 需 `:deep` 清单 | 工具飞出 `to="body"` | 高→中高 |

独占性已核实：`.side-nav*`、类级 `preview-*`、类级 `.ctx-*`、类级 `done-toast*` 均只出现在对应组件与 `chat-page.css`，可作为后续下沉的第一梯队。

### 8.4 风险项 go / no-go 与触发条件

| 项 | 结论 | 触发条件或替代方案 |
|---|---|---|
| C16–C26 生产 CSS 下沉 | 不做（本轮） | 前置验证发现硬阻断：无视觉回归自动化，且 `.ctx-*` 当前为浏览器不识别的 `:global(...)` 死规则；下沉会改变命中结果 |
| pptx 导出 | 已实施（2026-11-24） | 双 Agent 前置评审 GO；`pptxgenjs 4.0.1` + `pnpm-workspace.yaml` override `image-size ^2.0.4`（解析 2.1.0，审计无漏洞）；计划/落盘/失败/文案尾部追加均有测试，真实 nodebuffer 冒烟 ZIP 魔数通过 |
| `http_request` 内置工具 | 不做（本轮） | 白名单/私网/重定向/DNS/上限/确认门/审计/`wrapUntrusted` 任一缺失即不注册；当前未实现完整闸门 |
| R3/R4 引用清单与脚本归档 | 不做（本轮） | 先产出 tsc/LSP 引用证据与保留理由表，无证据不删 |
| sendBeacon | 不做 | 投递监听/幂等端点/卸载竞态无法本轮验证 |
| 未读清零失败回滚、老任务补 `runs[0]` | 不做 | 会改变失败路径角标与持久化数据；现有行为已由测试固化 |
| `onKeydown` / `onRenameKeydown` 的 `keyCode=229` 回退 | 未改 | 契约测试已锁现状；修复需改实现，留待明确授权 |
| T-8、IO-6~9、T-9、C-1/2/3/5、S-3~6、A-4、png | 不做 | 按 §2.4 改变输出语义/配额/调度/视觉，风险高于收益 |

### 8.5 残留风险

- 视觉一致性无自动化证明，C16–C26 下沉仍需浏览器实测或人工签字。
- IME 两个 handler 在旧浏览器缺少 `keyCode=229` 回退；中文真实输入法实例验证按 §2.2 非本轮前置条件。
- Node 22 缓冲错误码兼容已修，但仍只在集成测试环境验证，未做真机长日志场景。
- pptx：默认 builder 未被仓库内单测直测（仅临时冒烟验证 ZIP 魔数/字节数）；真实 PowerPoint/WPS 打开、中文与表格分页需人工签字。
