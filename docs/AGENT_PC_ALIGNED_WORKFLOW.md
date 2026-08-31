# PC后台对齐：输入到接口调用工作流

本文定义 `bx-admin-agent` 在企业后台场景下，从自然语言输入到工具调用、参数组装、日志落盘的确定性流程。目标是最大化正确率，并与 PC 后台行为保持一致。

## 1. 目标与边界

- 目标：让 Agent 对“模块、接口、参数、日志”四件事与 PC 后台一致。
- 边界：LLM 不是确定性程序，无法数学意义上保证 100% 正确；工程上通过强约束达到“可验证的一致性”。

## 2. 四层架构（Workflow + Skill + MCP + Tools）

### A. Workflow（运行时流程）

1. 意图解析：把用户输入归一化为 `operation + params`。
2. 操作映射：只允许 `operation`（如 `country.getById`），禁止自由拼 URL。
3. 参数归一：应用 `paramAliases`（如 `id -> movieId`）。
4. 执行前校验：
   - operation 必须在索引中存在；
   - 参数必填/类型通过；
   - 写操作必须确认（HITL）。
5. 调用执行：走 `call_api`，由服务端按 session 国家线拼 base URL。
6. 日志策略：仅当该 operation 在前端源码中配置了 `getLogOptions(...)` 才写 `operationlog/add`。
7. 回读验证：关键写操作执行后，再读一次详情确认变更生效。

### B. Skill（流程固定化）

使用项目技能强制 Agent 按上述流程执行，避免“看起来会做、实际乱调”：

- 技能位置：`.cursor/skills/pc-agent-crud-router/SKILL.md`
- 技能职责：模块解析、operation 选择、参数规范化、写操作确认、回读验收、日志一致性检查。

### C. MCP（代码源与知识源）

- 首选：企业 GitLab MCP（可用时）读取远端仓库 API 文件与路由模块。
- 兜底：本地仓库索引（`src/api` + `router/modules`）生成 JSON 清单。
- 原则：MCP 只做“来源更新与核对”，不绕过工具执行层。

### D. Tools（执行层）

- `search_api_module`：按模块名定位候选 API 模块。
- `read_api_module`：读取 API 文件源码和函数定义。
- `call_api`：按 `operation` 映射执行；国家线、鉴权、白名单、防错均在服务端。
- `fetch_url`/`read_file`/`list_dir`：辅助定位与核验。

## 3. 正确率保障机制（Deterministic Guards）

1. 强制 `operation`：禁止裸 `url/path` 自由调用（建议生产开启）。
2. 双索引：
   - `api-operation-index.json`：函数级映射；
   - `module-api-catalog.json`：路由模块级映射。
3. 参数别名与模板：减少字段名漂移。
4. 写操作确认：未确认不执行。
5. PC日志对齐：从前端源码抽取 `getLogOptions` 元数据决定是否写日志。
6. 执行后回读：关键写操作必须二次读取核验。

## 4. Superpower 实现建议

`superpower` 建议实现为“可配置策略层”，而不是新工具协议：

- 策略文件：`apps/agent-server/data/superpower-router-policy.json`
- 核心开关：
  - `requireOperation`: 必须传 operation；
  - `strictIndexPath`: path 必须在索引中；
  - `pcLogAlignmentOnly`: 仅按 PC 日志元数据落盘；
  - `postWriteReadback`: 写后回读验收。

通过策略文件可在不同环境做灰度，而不改主代码逻辑。

## 5. create-skill / find-skills 如何使用

- `create-skill`：用于把当前流程固化为项目技能，保证团队协作时执行一致。
- `find-skills`：用于查找外部可复用技能（如审计、测试、文档），但核心业务路由建议用项目内技能自控。

## 6. 验收标准（必须同时满足）

1. 同一输入在同一会话与数据状态下，解析出的 operation 一致。
2. 接口路径与 base URL 与前端同源代码一致。
3. 参数字段与后台期望一致（含别名转换）。
4. 写操作有确认事件，且执行后回读值正确。
5. operationlog 记录策略与 PC 前端 `getLogOptions` 一致。
