# Prompt 分层架构与精简规范

> 对齐 **Function Calling 设计哲学**（工具定义 JSON Schema 承担引导，system prompt 回归人设与边界本职）与 **Cursor agent 方案**（Rules = 常驻底线、Skills = 按需加载、Context = 让 agent 自己找、不为罕见边缘情况加指令）。
>
> 落地日期：2026-08-24。适用范围：`apps/agent-server/src/chat.ts`（LangGraph 图内 system step 注入）与 `apps/agent-server/src/tools.ts`（工具描述）。

## 一、目标架构（一句话）

**「输入 → 调用工具返回数据」阶段不注入任何业务工作流 prompt**（引导职责全部下沉到工具 description + 常驻底线）；
**「调用工具返回数据 → 输出最后结果」阶段保留薄 prompt**（每条 ≤1-2 行，只约束数据→答案质量与防死循环）。

| 阶段 | 职责 | 承载者 |
|---|---|---|
| 输入 → 调用工具返回数据 | 语义理解、模块定位、接口调用 | 模型自主决策 + 23 个工具 description（自带行为规范）+ resident rules（7 条底线） |
| 调用工具返回数据 → 输出最后结果 | 中文化、收束、防死循环 | 薄 system step（stop / output-align / list / detail / validate） |

## 二、阶段1（输入 → 调用工具返回数据）：零业务 prompt

### 2.1 删除项（2026-08-24 已删）

| 原 prompt | 原位置 | 行数 | 删除依据（职责去向） |
|---|---|---|---|
| `[workflow/llm-first]`（全局工作流指南） | chat.ts preprocess | 22 行 | 内容逐条下沉：见 §4 可行性检查对照表 |
| `[workflow/superpower]`（业务强化指南） | chat.ts preprocess | 7 行 | 与 llm-first 高度重复；独有「列表一次取全」已在 call_api description |

### 2.2 保留项（精简后）

| Prompt | 现状 | 说明 |
|---|---|---|
| `[workflow/agent]`（极简角色） | 1 条 / ~3 行 | 唯一新增的角色定位：业务请求第一步 submit_understood_intent → 按需检索 → call_api，可多轮，中文回复，不复述内部步骤 |
| `[workflow/rules]` | 常驻 | 5 条底线（写确认/禁编造含先检索/目标/词义不明先反问/已明确请求直接执行/写后回读）合并为 1 个 step 注入（2026-08-24 由 7 条精简：删日志对齐/展示前规范化两条已下沉服务端，先检索并入禁编造；2026-08-25 对齐 Cursor：去掉「查询不反问可选条件」写死压制，改为「目标/词义不明先反问」+「已明确请求直接执行、可选筛选条件缺失用默认参数」），优先级最高 |
| `[workflow/skills]` | 按需 | Cursor 语义：name+description 清单交模型自判加载正文；含 16000 字符预算护栏 |
| `[workflow/intent-context]` | 1 行 | 多项目切换必需 |
| `[workflow/chit-chat]` | 3 行 | 仅 actionableQuery=false 注入：纯文本回答、禁调业务工具、禁 JSON；知识库文档类问题可调 search_knowledge_base（提示非路由） |

> 注（2026-08-24）：`[knowledge-base]` KB 关键词预检短路已删除——模型已有 `search_knowledge_base` 工具（description 明确触发场景，实测「上班迟到了会扣钱吗」即模型自主调工具命中考勤制度），15 词表召回率低且业务句含「流程/标准/资料」存在误短路风险，forcedReply 无模型整合也偏离 RAG「注入+整合」主流。知识库问答改由模型自主调工具，chit-chat 分支补 KB 意图提示补位。

## 三、阶段2（调用工具返回数据 → 输出最后结果）：薄 prompt

| Prompt | 触发 | 内容要点（≤1-2 行） |
|---|---|---|
| `[workflow/stop]` ×4 | 数据已就绪/工具完成/失败 | 禁止再调工具，直接自然语言收束 |
| `[workflow/output-align]` ×5 | 自动渲染失败/英文表头/数字枚举 | 统一 `outputAlignStep` 模板：按 pc-column-mapping 技能读源码补中文映射后用 render_table 输出，禁止透传原始英文/枚举 |
| `[workflow/list]` / `[workflow/detail]` | 受控渲染成功 | 已按 PC 列定义/formSchema 渲染，直接展示，禁止再调渲染工具 |
| `[workflow/output]` | normalize_output 完成 | 接着 render_table，勿再盲目检索 |
| `[workflow/validate]` | 返回结构异常 | 向用户说明数据异常，禁止透传原始内容 |
| `[workflow/pc-parity]` | 报表图表对齐成功 | 已按 PC 口径对齐表头与 ECharts |
| `MODULE_RETRY` / `CLARIFICATION_REQUIRED` | 工具失败/槽位缺失 | 机制必需，模型重试依据 |

## 四、可行性检查：llm-first 逐条下沉对照（删除前必须确认无信息丢失）

| llm-first / superpower 原文要点 | 承接者（证明删除可行） |
|---|---|
| 推荐顺序：submit_understood_intent → 检索补全 → call_api | `[workflow/agent]` 极简角色明确第一步 |
| 模块定位：search_api_module 命中后 read_api_module 读源码，禁止反复 grep/list_dir 绕路 | `search_api_module` description（已补「直接读源码、勿绕路」）+ `read_api_module` description |
| call_api 成功后服务端自动受控渲染，禁止手动 normalize/render | `normalize_output` / `render_table` description（均注明「服务端自动渲染，仅 output-align 时手动」） |
| 仅 output-align 提示时才手动处理（pc-column-mapping） | `normalize_output` / `render_table` description + `[workflow/output-align]` 薄提示 |
| 用户已说清的模块名必须沿用 | `request_clarification` description「已明确、可直接执行的请求无需反问」 |
| 知识库：先 search_knowledge_base，禁止编造公司制度 | `search_knowledge_base` description + resident rule #2（禁止编造） |
| 目标/词义不明先反问（禁止硬猜），已明确请求直接执行、可选筛选条件缺失用默认参数 | resident rule + `request_clarification` description + `[workflow/tool-calling]`#4（对齐 Cursor AskQuestion） |
| 数据展示完成后立即自然语言回复 | `summarize_chart_data` description「必须立刻回复」+ `[workflow/stop]` |
| Agent 自主续探：多轮直到拿到数据 | `[workflow/agent]` 极简角色「可多轮调用工具直至拿到数据」+ 条件边机制 |
| 输出纪律：不复述内部执行步骤 | `[workflow/agent]` 极简角色 + final `validateFinalText` 兜底 |
| 列表一次取全（size/pageSize 设大） | `call_api` description（列表查询规范） |
| 先检索再调用（operation 优先） | resident rule #4 + `call_api` description（operation/path/base 用法） |
| 写操作需确认 | resident rule #1 + tool 节点强制确认机制（不依赖 prompt） |

**结论：llm-first 与 superpower 的全部行为约束均有确定性承接者（工具 description / resident rules / 极简角色 / 服务端机制），删除不丢失语义。** 唯一新增的是极简角色（角色定位 + 第一步 + 多轮信号），约 170 字符，替代原约 960 字符的两条指南。

## 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| 弱模型（zen 免费链）不主动调工具 | ① 业务请求**首轮 tool_choice=required**（understand 节点，机制级兜底）；② `[workflow/agent]` 明示「需要业务数据就调工具，第一步 submit_understood_intent」 |
| 删除后模型行为回归（误反问/编造） | resident rules 常驻注入优先级最高，不随阶段1 删除受影响 |
| 死循环 | stop / 条件边 / MAX_TOOL_ROUNDS 全保留，与 prompt 无关 |
| 英文字段/枚举未中文化 | output-align 薄提示（pc-column-mapping 指引）保留为阶段2 核心护栏 |

## 六、验证清单

1. `pm2 restart agent-server` 生效
2. 业务查询：用户列表 / 优惠活动配置 → 中文表头 + 表格渲染，无回归
3. 闲聊：你有哪些能力？/ 你好 → 自然语言回答，不落兜底文案
4. 查日志：`[chat:understand] raw output` 行确认模型正常输出
5. 特殊：英文字段（clientType）→ output-align 触发，模型按 skill 补中文映射

## 七、改动记录

| 日期 | 改动 |
|---|---|
| 2026-08-24 | 阶段1：删 `[workflow/llm-first]` + `[workflow/superpower]` → 新增极简角色 `[workflow/agent]`；intent-context 缩 1 行、chit-chat 缩 3 行。阶段2：output-align 5 处提取统一 `outputAlignStep` 模板。tools.ts：`search_api_module` 补模块定位引导（承接 llm-first 禁令）。token 节省：阶段1 约 960 字符 → 约 170 字符 |
| 2026-08-25 | 对齐 Cursor 反问语义（修复「二级分类的链接」硬猜输出错误结果）：去掉 `request_clarification` description + resident rule 中「查询一律不反问可选条件」的写死负面压制（Cursor AskQuestion 无此句），改为 Cursor AskQuestion 式纯正向描述「目标/词义不明用结构化问题反问用户收敛」；resident rule + `[workflow/tool-calling]`#4 补「目标/词义不明先反问、已明确直接执行、可选筛选条件缺失用默认参数」绿灯条款 |
