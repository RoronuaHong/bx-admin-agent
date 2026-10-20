# bx-admin-agent 多场景多实例全链路验证方案

> v1 · 2026-10-19 · 依据 2026 最新最佳实践 + 本系统实际架构（deep agent harness / 三角色 / ~24 内置工具 / skills / MCP / 记忆 / 上下文压缩 / grounding / 在线评测）编制。
> 目的：把「回答时间、质量、意图分析、记忆、上下文、超长文本、全工具、skill、MCP、图文」十个维度拆成可执行、可判定、可回归的验证矩阵，并给出优先级与执行手段。

---

## 一、最佳实践基线（为什么这样验，附来源）

1. **评测单元是「轨迹」不是「最终答案」**：agent 评测要评工具调用/检索/中间态/副作用的完整轨迹；答案可能「对但理由错」，也可能因工具喂了过期数据而错。只看终答会漏掉链断在哪。（sphereinc.com/blogs/how-to-evaluate-ai-agents-in-2026）
2. **可靠性看 pass^k**：同一任务连续成功 k 次才算可靠；公开基准（tau-bench / GAIA / SWE-bench）只作定向，不作为对本系统的判定——前沿 agent 的 pass^8 常 <25%。（nomadx.ae/blog/how-to-evaluate-ai-agents-2026）
3. **压测多步失败与指标博弈**：错误会在多步链中级联；对着固定指标优化会「学会指标而非目标」。（clawvard.school/blog/ai-agent-evaluation-stress-testing）
4. **时延是三层指标**：TTFT（首 token，交互体验生死线，>1.5s 显卡）、TPOT（每 token 稳定度）、端到端；按 P50/P95 设 SLO；快配非推理模型 TTFT 0.75–1.6s、44–172 tok/s。（techscoria.com · particula.tech · devopsie.com）
5. **上下文工程 > 提示词**：广告上下文窗口是营销数，**能真正解出任务的有效窗口常小 4–16 倍**；按「节点」决定 include/exclude；相关性胜过体量；超长运行要 summarize-and-prune 而非裸累积。（genalphai.com/context-engineering-for-ai-agents · wpnews.pro）
6. **分层记忆**：短期（近几轮）/ 中期（会话摘要）/ 长期（用户画像/偏好/历史决策）；记忆四类（工作/情景/语义/过程）；TTL 自动淘汰；**双时间戳（事实时间+摄入时间）**防陈旧与「记忆中毒」；检索结果**不要再用 LLM 过滤**（增延迟增故障点）；团队记忆默认 private。（linjiejim.com · blog.csdn.net/zhilige/163020795 · guwentian/164264675）
7. **多模态的坑在空间推理**：受控空间任务（左右/比例/遮挡）当前 VLM 准确率仅 50–55%（人类 85%+）；缓解=视觉对比解码、多智能体纠偏、结构化输出校验；评估要**端到端任务**而非单能力、**badcase 分类追踪**、**同一输入问 10 次看一致性**、用**自己的业务图**而非公开 benchmark。（tianpan.co/zh/blog/2026/04/19/multimodal-agents-production-agentic-loop · epwk.com/meijie/322321）
8. **长上下文用 NIAH/RULER 自测「有效上下文交叉点」**：按位置×长度×任务族分别记准确率，同时记每长度下的成本与时延；警惕 lost-in-the-middle。（iotdigitaltwinplm.com · khimananda.com）
9. **MCP/工具用「真实 agent 任务」评，而非直接调工具**：评工具选择、参数准确、任务完成、终态、输出质量、效率、重复跑一致性；覆盖重叠工具、无工具请求、错误路径、权限边界；an MCP 调用跨 客户端/传输/服务端/后端 四段，用 OpenTelemetry 串同一 traceId；**能按会话 ID 回放任意一次线上对话**；**模型升级要按工具类型分类统计准确率**（整体分持平但某类工具格式系统性退化的隐蔽回归）。（nhimg.org/?p=157903 · github mcp-server-evaluation · sheratonhq.com/news/166113 · masturbyte.com/mcp-2026）

---

## 二、本系统可测特性（架构映射）

- **角色实例**：通用 `/chat`、客服 `/support`（enforceGrounding + KB）、观影 `/movie`（forceToolCall + 全量电影工具）；会话互相独立、按 ownerKey 隔离。
- **循环**：deep agent harness，`MAX_TOOL_ROUNDS=14`，同轮去重 + 跨轮 Doom Loop 熔断；模型候选链 + 瞬时重试。
- **上下文/记忆**：历史分层压缩（prune→LLM 摘要，保留近 3 轮）、大工具结果卸载工作区（offloadToolResult）、工具结果治理（governToolResults，`MCP_TOOL_RESULT_CHARS=12000`）、跨会话长期记忆（memory.ts，owner 隔离 + 条目/字符双上限）、静态引导前缀化（prompt cache）。
- **内置工具（~29，deep-agent 全集；`submit`/`call_api`/`search_api_module` 是已移除的旧架构，当前 src 0 命中）**：文件 `fs_write/fs_read/fs_edit/fs_glob/fs_grep/fs_delete/fs_ls`；定时 `list_schedules/manage_schedule`；知识库 `search_knowledge/knowledge_sources`；数据聚合 `count_list_by_time/salesiq_chat_brief`；输出 `export_data/render_chart/normalize_output`；规划 `write_todos`；委派 `task`（子代理，并行 3）；记忆 `save_memory`；澄清 `request_clarification`；技能 `read_skill`；检索 `search_tools`（deferred 加载）；执行 `run_tool_code/run_command/run_script`；联网 `web_search`；图像 `image_gen`；钉钉 `search_dingtalk_doc`。**业务数据一律走 MCP 连接器**（Zoho SalesIQ / BI(Metabase) / gitlab / movie(TMDb) / YApi），按对话启用；无对应连接器时模型应如实说明并给路径（这也是已验证的正确行为）。
- **skills**：`pc-column-mapping / api-interface-routing / business-data-query / ...`，索引注入 + `read_skill` 按需加载；`default:true` 仅在面板隐藏（不删能力）。
- **MCP**：gitlab、Zoho SalesIQ、BI(Metabase)、movie 等；命名空间 `mcp__<id>__<tool>`；**BI 只读硬闸（双层 fail-closed）**；写操作走确认通道；按对话启用集做作用域闸。
- **图文**：视觉模型 `hyvision`(direct) / `ds4vexp`；聊天图片输入（OptionImage）；`image_gen`；图表 `render_chart` + 导出内联 SVG。
- **可观测/评测基建（复用而非重造）**：`/trace` 运行追踪 + span（llm/tool 两级 + gen_ai.*）、在线评测 `eval-online.ts`（七维确定性打分）、grounding 事后核验（两阶段）、输出 schema 校验（fail-closed）、审计、`/metrics`。

---

## 三、维度验证矩阵（维度 × 场景 × 预期 × 手段）

### A. 回答时间（时延）
| 场景 | 手段 | 判定/指标 |
|---|---|---|
| 闲聊「你好」 | Chrome/脚本计时 | TTFT ≤1.5s；E2E ≤5s |
| KB 检索问答 | 脚本 SSE 计时 | TTFT + E2E；记录模型 |
| 业务数据查询（MCP 连接器，如 Zoho/BI） | 脚本 | 每轮 E2E、连接器耗时、多轮累计 |
| 多轮工具循环（ rounds≥3 ） | 脚本 | 每轮增量、prompt cache 命中（同前缀） |
| 定时任务一期 | `/trace` | 单期 E2E（近期约 16–80s 属正常区间） |
- **口径**：P50/P95（≥20 次/场景），分模型记录；冷启 vs 热缓存分开。**模型 402 期间的数据不计入时延结论**（供应商侧，非代码回归）。

### B. 质量（grounding + 数值 + 结构）
- 场景：已知答案问（KB/业务）；诱导编造型（问不存在的数据）；数值型（计数/汇总）；表格型（列表/多页聚合）。
- 判定：**接地**（结论有证据支撑、不编造，走 grounding 核验）、**数值一致**（服务端总数 vs 分项求和 vs 模型声明，O3 确定性校验）、**表格正确**（中文表头/枚举翻译/多页合并）、**诚实兜底**（取不到就说取不到，不估算）。
- 手段：`eval-online.ts` 七维 + grounding 两阶段核验 + 输出 schema；对同一 query 跑 **pass^k**（建议 k=3）看稳定性。

### C. 意图分析 / 路由
- 场景：①纯闲聊（不应调工具）②明确业务（选对模块+工具+读法）③**目标/词义模糊 → `request_clarification`**（不硬猜）④序指代（「第2页」「上一个」）⑤**无工具请求**⑥**重叠工具**选对 ⑦缺可选筛选条件 → 用默认参数直接查（不过度反问）。
- 判定：路由正确（对齐红线：语义判定全交模型，服务端无业务词正则）；澄清不缺失不过度；**数据源/连接器选择**正确（该用哪个 MCP、无可用连接器时如实说明）。
- 手段：脚本批量 prompt → 断言 tool_calls 名/参数；badcase 分类。

### D. 记忆存储
- 场景：①跨会话写入→召回（「我叫X」→ 新会话问）②**owner 隔离**（A 的记忆不进 B）③控制符/注入写入被剥/拒 ④条目/字符上限 ⑤**陈旧/中毒**（写入错误事实后是否被当真、能否被更正）⑥记忆注入 system prompt 的可见性。
- 判定：召回准确、隔离严格、注入被中和、上限生效、过时事实可追溯更正。
- 手段：脚本写 `save_memory` → 换 owner/新会话读；直接构造记忆条目测 `visibleTo`/注入渲染。

### E. 上下文管理
- 场景：①长对话触发压缩（prune→摘要），**关键事实（模块/数据规模/未决问题）在压缩后仍存活** ②大工具结果卸载工作区 + 后续 `fs_read` 召回 ③分角色 system prompt（support vs generic vs movie）④静态前缀 cache 命中 ⑤**lost-in-the-middle**（长上下文早期事实仍被用到）。
- 判定：压缩日志 `[chat:history]` mode 正确；卸载后能召回；上下文字符不失控；早期事实可用。
- 手段：脚本构造超长历史/超大工具结果，观测压缩与召回。

### F. 超长文本输入输出
- 输入：粘贴 50KB+ 文档让总结；**needle 事实放在长输入的不同位置**（头/中/尾）问细节；超长单条消息（贴近 1MB body 上限的行为）。
- 输出：长回答；`export_data` 大数据集（xlsx/csv/pdf/docx/html）；`fs_write` 大文件；`result_overflow_mode=throw` 下的超限报错（非静默截断）。
- 判定：needle 命中率按位置×长度记录（有效上下文交叉点）；导出完整不截断；超限 fail-loud；时延/成本随长度记录。

### G. 所有内置工具（逐个）
- 对每个工具：**happy path + 参数准确 + 错误路径 + 权限级别**（read 免确认 / write 需确认 / deny）+ 输出 schema（`render_chart/export_data/write_todos/request_clarification` fail-closed）。
- 专项：`search_tools` deferred 加载（未加载工具先检索再调）；`task` 子代理（最小工具集、拒绝 `save_memory`、并行批、失败结构化交接）；`run_tool_code`（只读桥 + 环境白名单 + 输出截断 + SIGKILL 超时）；`count_list_by_time`（只读 MCP + 服务端翻页 + complete:false 诚实）。
- 手段：单测（handler 级，已有部分）+ agentic 任务测（模型自主选该工具走完）。

### H. Skill
- 场景：技能索引注入 → 模型按任务 `read_skill` 正确技能（BI 取数→`business-data-query`；英文表头→`pc-column-mapping`；接口选路→`api-interface-routing`）；启用/停用某技能；`default:true` 隐藏技能不在面板列出但可加载。
- 判定：选对技能、内容加载、停用生效、隐藏不影响加载。

### I. MCP（每个连接器）
- 场景：工具列举；只读查询走通；**作用域闸**（对话未启用的连接器 → 拒绝）；**写操作 → 确认卡**；**BI 只读硬闸**（`SELECT` 放行、写 SQL 双层拒）；错误路径（连接器断开 → 优雅降级不崩）；同一任务重复跑一致性。
- 判定：命名空间正确、只读/写确认/越权三条闸生效、OTel span 串起四段、断连 graceful。
- 手段：脚本端到端（建对话→勾选启用集→发消息看 tool_call/result）+ 直连适配器层验只读。

### J. 图文（多模态）
- 场景：上传图片描述/提取；**读图表/表格截图**（空间推理弱项，重点）；`render_chart` 数据→图；`image_gen` 文生图；导出内联 SVG 报告。
- 判定：**同一张图问 10 次看一致性**；端到端复合任务（「找出图中所有红色物品及位置」类）；badcase 按错误类型分类存档；文字不被图像带偏（图文一致性）；用**自己的业务图**。
- 手段：Chrome 上传 + 脚本；视觉模型不可用时该项记 SKIP 不记 FAIL。

---

## 四、多实例串联场景（端到端 chain）

1. **通用 MCP 数据链**（需先在对话启用连接器）：如启用 Zoho SalesIQ → 「最近一小时会话量」→ `count_list_by_time` 服务端翻页计数 → 阈值判定 → 表格/结论（定时预警已是该链的稳定实例）。
2. **客服 KB 链**：「上班迟到会扣钱吗」→ `search_knowledge` → 接地结论 + 表格（已在 Chrome 实测通过）。
3. **客服定时链**：预警任务 → Zoho SalesIQ 计数（翻页到末页 complete:true）→ 阈值判定 → 结论协议标记 → 通知投递（钉钉关键词 `bx-agent`）。
4. **跨会话记忆链**：会话1「记住我叫X」→ 新建会话2 → 「我叫什么」→ 召回。
5. **长上下文链**：粘贴长文档 → 多轮追问早期细节（验压缩+lost-in-middle）。
6. **图文链**：上传数据图 → 解读 → `render_chart`/导出。
7. **多实例隔离**：两个并发会话（不同角色/不同 owner）互不串台；定时任务结果只回专属对话。

---

## 五、需要测试的地方（按优先级）

- **P0（核心正确性/安全，必须先过）**
  - C 意图/路由（含澄清、序指代、无工具、重叠工具选对）
  - B 接地/数值/诚实兜底（不编造是底线）
  - G 工具权限三闸（read/write-confirm/deny）+ I MCP 只读硬闸（BI 禁写，红线）
  - A 闲聊/KB 的 TTFT（交互生死线）
- **P1（体验/稳健）**
  - E 上下文压缩与卸载召回
  - F 超长输入（needle 按位置）/ 超长输出导出
  - D 记忆写入/召回/隔离/防注入
  - G 全工具逐个覆盖 + `task` 子代理 + deferred 加载
  - H skill 选对与停用
  - I MCP 作用域闸 + 断连降级
- **P2（深度/回归）**
  - B pass^k 一致性（k=3）
  - F 有效上下文交叉点（位置×长度×成本）
  - J 多模态一致性（同图 10 次）+ badcase 库
  - 跨模型回归：**按工具类型分类统计准确率**（升级换模不只看总分）
  - 可观测：按会话 ID 回放、OTel span 四段串联

---

## 六、执行手段

- **手动/浏览器**：chrome-devtools（已完成门户/三角色/交互 KB/`/trace`/控制台零错误）。
- **脚本**：`apps/agent-server/scripts/_*.mjs`（SSE 流式解析 + 自动应答确认卡），批量 prompt → 断言 tool_calls/参数/上屏。
- **评测基建（复用）**：`eval-online.ts`（七维确定性打分 + `/chat/eval/*`）、grounding 两阶段核验、输出 schema、`/trace` + span + `/metrics`。
- **回放**：凭 runId/会话 ID 重放（span 已按 runId 分文件）。

---

## 七、缺口 / 风险 / 依赖

- **模型可用性**：TokenHub 多 402、OpenRouter 免费限额——所有结论必须**记录当次模型**；402 期间的失败不计代码回归；建议固定一个可用模型做基线。
- **视觉模型**：`hyvision`/`ds4vexp` 额度/可用性影响 J 项，不可用则 SKIP。
- **MCP 凭据**：gitlab token、Zoho、BI、movie 连接器需就绪；BI 严格只读（红线：不写库、不改 MCP）。业务数据无内置上游通道，全靠 MCP——连接器未启用时模型必须如实说明（已验证）。
- **数据卫生**：测试用测试库/测试数据，避免污染真实会话/记忆/BI。
- **红线合规**：测试夹具可用真实业务词（是测试数据，非服务端代码）；服务端仍零业务词写死。
- **未覆盖待补**：音频/语音交互（当前无）、视频、多 Agent 协同（仅 `task` 单层子代理）。

---

## 八、与既有工作的关系

- 本方案**不重造**评测：`eval-online.ts`/grounding/输出 schema/`/trace` 是执行底座；本方案是「维度×场景×判定」的用例层。
- 与 `docs/audit/dialog-reply-audit-20261019.md`（SQL/回复审计）、`BEST_PRACTICE_ALIGNMENT.md`（OWASP/Agentic/OTel 对照）互补：前者查缺陷，本方案管全链路验收。

---

## 九、基线实测记录（2026-10-19 · Chrome 前台多实例 · DeepSeek-Flash）

**基线模型 = TokenHub DeepSeek-Flash（ds4flash0731）**，在通用 `/chat` 角色真实跑通 8 类场景（另：TokenHub `step5` 可用但慢 ~120s/轮；OR 免费 Nemotron 输出乱码/提示泄漏不可用；`auto` 免费链不可靠——曾把系统提示当闲聊回复）。

| 维度 | 场景 | 结果 | 时延 |
|---|---|---|---|
| 质量/接地 | 「上班迟到会扣钱吗」 | ✅ `knowledge_sources`+`search_knowledge` 命中《考勤制度》→ 中文表格 + 「制度无迟到扣款条款」「**超10:00属制度空白点，≠不扣钱的明文承诺**」「请假扣款与迟到是两套规则」 | 2步12s |
| 多轮/上下文 | 「补卡每月几次」 | ✅ 先回忆上文、**再检索原文核实**（不轻信记忆），上下文 4 条历史正确累积 | 1步8s |
| 意图/澄清 | 「统计一下人数」 | ✅ 识别多读法→先检索确认→终答「**无数据≠算出0人**」+列出需补的数据源+请给口径 | 2步18s |
| 超长文本 | 500字运营记录三问 | ✅ 三问全对、数字精确（47分钟/38份中31份/21+16单）、**发现原文内部矛盾**（7人在岗 vs 恢复三人在线） | 17s |
| 上下文管理 | 长会话 | ✅ 压缩实证：token 1375→…→**71**（8轮）；本轮 B 会话 6 条历史正常累积（225 tokens） | — |
| MCP 数据流 | 「最近一小时新会话」（通用/chat 启用 Zoho） | ✅ `getConversationsList` 真实数据 + `count_list_by_time`（complete:true）→「21条」+分桶 3+18=21 **交叉自洽** + 口径说明 | 2步22s |
| MCP·角色 | /support「最近60分钟印度会话」 | ✅ **客服角色默认预连接 Zoho**（与 /chat 不同）；auto 模型真实取数 + 终答高质量（含口径/来源/提醒：「26条是本次取回范围内结果」）；容错实测：`run_tool_code` 首次 node/Python 语言错配失败→重试成功（拿到 `data/more_data_available`） | 2步44s |
| 记忆 | 跨会话「我工位在哪」 | ✅ 新会话召回「3楼B区」（长期记忆注入，0历史）；**但推理出现「Memory says 3楼B区」——记忆拟人化渗入推理** | 1步8s |
| 工具/图表 | 「画个柱状图」 | ✅ `render_chart` 真实 image 渲染（14点3/15点18）+ 数据洞察；**本轮直接场景无元推理泄漏、无过度探索**（1步直出） | 1步8s |
| 推理语言 | 全部场景 | ⚠️ **DeepSeek-Flash 推理过程默认英文**，与中文 UI 冲突 → 系统触发「**内部推理与当前语言不一致，已收起**」保护，折叠可见推理（终答中文正常，不影响结果但降低可解释性） | — |
| 模型质量 | 推理过程检查 | ⚠️ **元推理泄漏（已定位根因）**：干净会话(0历史)同问法仍出现「用户说不要反问/上一轮我列了选项」等——**根因=长期记忆注入的用户偏好被模型误当成本轮/上轮指令**，并导致过度放弃结构化澄清；歧义/澄清场景易触发，直接场景(图表)不触发 | — |
| skill | 「用户列表中文列名→英文字段」 | ⚠️ **未触发 `read_skill`**：模型不知道 skill 索引存在（pc-column-mapping 未加载），退化为检索+联网，终答诚实但无 skill 支撑 | 5步27s |

**结论**：DeepSeek-Flash 是当前**最佳可用基线**——接地/诚实/严谨度/工具链/时延（4–22s）全部达标，质量明显优于 auto 与 OR 免费 Nemotron；`/support` 角色预连接 Zoho 的数据流稳定且带口径/来源声明。遗留观察点（均非阻断，P2 级）：
1. **推理默认英文被「已收起」**——建议：①服务端强制 reasoning 语言跟随界面语言；②或前端对收起推理提供「展开原文」入口（当前中文用户看不到推理）。
2. **元推理泄漏根因=记忆拟人化**——长期记忆里「不要抛回确认」等偏好被模型在折叠推理区当成本轮指令，偶发导致过度放弃澄清；建议审视记忆注入措辞（以第三人称事实陈述而非指令式）。
3. **`request_clarification` 结构化卡未触发**（倾向散文式澄清）；**skill 未触发 `read_skill`**（索引未主动注入）——两者均属「模型未充分利用系统能力」，建议增强 system prompt 对「何时调 read_skill / request_clarification」的指引。
4. BI/YApi/gitlab/movie 连接器显示 0 工具（未就绪），其**只读闸**（红线）待连接器恢复后实测。
