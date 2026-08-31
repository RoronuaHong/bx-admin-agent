# 企业级能力路线图（企业内项目 + 企业知识库 + 智能问法系统）

> **评估日期**：2026-08-22  
> **需求**：让 bx-admin-agent 成为企业级智能助手，支持「企业内项目（多后台管理系统）+ 企业知识库 + 智能问法系统」  
> **定位**：本文档是需求→现状→差距→待办的唯一入口；落地进度随时更新

---

## 1. 需求拆解

| 子需求 | 说明 | 验收目标 |
|---|---|---|
| **企业内项目** | 接入企业内部后台管理系统（PC 端），支持多项目并存 | 新增一个后台项目，无需改代码即可对话 CRUD |
| **企业知识库** | 查询公司内部文档（钉钉文档/本地文档），并给出引用出处 | 自然语言问 → 返回文档内容 + 来源链接 |
| **智能问法系统** | 用户用自然语言完成 查/增/改/删/统计/导出/续聊 等操作 | 问法识别准确、写操作有确认、多轮上下文连贯 |

---

## 2. 架构现状（2026-08-22 实测）

### 2.1 企业内项目 ✅ 已实现（数据驱动，可扩展）

| 能力 | 状态 | 支撑点 |
|---|---|---|
| 多项目切换 | ✅ | `clarification-policy.json` 的 `project` 槽位（bx-film-admin + global）；`set_project` 工具 |
| 新项目接入 | ✅ 无需改代码 | 项目配 `codebaseRoot` + `moduleAliases`；模块定位以实时 grep PC 端源码为主（方案 A），索引自动生成作兜底 |
| 模块/接口/字段识别 | ✅ | 实时源码定位（grep + read_file）+ `api-operation-index.json`（call_api 安全底座）/ `field-mapping.json` 数据驱动 |
| 项目代码检索隔离 | ✅ | `codebaseRoot` 限定 grep/list_dir/read_file 目录 |
| **多项目权限隔离** | ⚠️ 未做 | 谁能访问哪个项目/模块，无 ACL |

### 2.2 企业知识库 ⚠️ 骨架已搭，未打通

| 能力 | 状态 | 说明 |
|---|---|---|
| 钉钉文档搜索 | ⚠️ 骨架 | `search_dingtalk_doc` 已注册（tools.ts + mcp.ts），token 逻辑完整；**卡在凭证** |
| 本地文档检索 | ❌ 未做 | 无向量化/语义检索；仅 `resolveLocalDoc`（读本地 md）+ `fetch_url`（白名单） |
| 文档正文读取 | ❌ | 钉钉 `getDocContent` 标了 TODO |
| 知识库 RAG 问答 | ❌ | 无「文档切分→向量化→语义检索→引用回复」链路 |

### 2.3 智能问法系统 ✅ 核心已实现

| 能力 | 状态 | 说明 |
|---|---|---|
| 意图理解（大模型先行） | ✅ | `submit_understood_intent` + `parse_intent` 双层 |
| 能力询问 | ✅ | 「可以做哪些操作？」→ 操作清单（2026-08-22 修复稳定） |
| 上下文继承 | ✅ | 「查看详情」自动继承上一轮模块+ID（2026-08-21 实现） |
| 澄清机制 | ✅ | `request_clarification` + 澄清策略（缺槽反问/选项补全/限 2 轮） |
| 写操作安全确认 | ✅ | tool 节点 + 服务端兜底双重强制确认（2026-08-21 修复） |
| 详情/列表渲染 | ✅ | 两列表格、位掩码全展开、空字段占位、字段补全 |
| 导出 | ✅ | `export_dataset`（xlsx/pdf，树表/footer） |

---

## 3. 差距清单（按优先级）

### P0：钉钉凭证（阻塞知识库第一步）
- [ ] 获取公司钉钉「企业内部应用」的 **Client ID / Client Secret**
  - 前置：公司钉钉管理员开通应用、授权文档读权限
  - 阻塞：`search_dingtalk_doc` 目前只能返回"未配置凭证"指引
- [ ] 凭证到位后联调 `search_dingtalk_doc`：
  - [ ] 确认文档搜索真实端点/参数（TODU 标注）
  - [ ] 处理分页、权限过滤（仅返回应用可见文档）
  - [ ] 补充 `getDocContent` 正文读取

### P1：知识库 RAG 链路（不依赖钉钉凭证）✅ 骨架已落地（2026-08-22）
- [x] 文档源接入：本地目录（`docs/knowledge/**`）+ 后续钉钉文档拉取（TODO）
- [x] 文档切分（按标题/段落，带元数据：来源、路径、更新时间）
- [x] 存储：本地 JSON 索引（`docs/knowledge/.index.json`），`build-knowledge-index.mjs` 构建
- [x] 检索：中文 bigram + TF-IDF 加权 + 标题加权（纯 JS，零新依赖）
- [x] 新工具 `search_knowledge_base`（tools.ts + mcp.ts 已注册）
- [x] 引用出处渲染（回答中带 `来源：docs/knowledge/xxx`）
- [x] 模型自主检索：`search_knowledge_base` 工具 description 明确触发场景，模型自主判断调用（2026-08-24 删除服务端 KB 预检短路——词表低召回/业务句误短路/forcedReply 无模型整合；chit-chat 分支补 KB 意图提示）
- [ ] 语义检索升级（embedding 向量化，TODO 标注）——当前词法检索够用，接 embedding API 后可升级
- [ ] 权限过滤（按项目/角色过滤文档可见性）——当前全量可见
- [ ] 钉钉文档拉取入库——凭证到位后接入
- [ ] 增量索引——当前全量重建

### P2：多项目权限隔离
- [ ] session 增加 `roles` / `allowedProjects`
- [ ] `clarification-policy.json` 的 project 槽位增加 ACL（`accessRoles`）
- [ ] `set_project` / `parse_intent` 校验项目访问权
- [ ] `call_api` / `search_api_module` 按项目过滤模块

### P3：体验增强（低优先）
- [ ] 闲聊稳定性：单字/短输入（如 "hello"）易被误读，加兜底
- [ ] 写操作参数补全：多语言 `names` 的 languageId 动态获取（当前后端错误如实回显）
- [ ] 能力清单：更多模块的中文操作说明（`logOperator` 补全）

---

## 4. 建议落地路径

```
当前（已可用）：多项目后台 CRUD 问法 + 写确认 + 续聊 ✅
    │
    ├─ 阶段 1（等钉钉凭证）：钉钉文档搜索（方案 A）→ 知识库"搜得到"
    │
    ├─ 阶段 2（可并行）：本地知识库 RAG 向量化（方案 B）→ 知识库"答得出"
    │      └─ 不依赖钉钉凭证，先支持 docs/knowledge/** 本地目录
    │
    ├─ 阶段 3：项目级权限隔离 + 知识库权限过滤
    │
    └─ 阶段 4：体验打磨（闲聊兜底 / 写参数动态语言 / 操作说明补全）
```

---

## 5. 进度记录

| 日期 | 模块 | 进展 | 关联文件 |
|---|---|---|---|
| 2026-08-22 | 知识库 P1 | ✅ 本地知识库 RAG 骨架落地：文档扫描+分段+TF-IDF 检索+引用出处；`search_knowledge_base` 工具注册（tools.ts+mcp.ts） | tools/knowledge-base.ts / build-knowledge-index.mjs / chat.ts / tools.ts / mcp.ts |
| 2026-08-24 | 知识库 P1 | 🔵 删除服务端 KB 预检短路（KB_KEYWORDS 正则+forcedReply）：改由模型自主调 `search_knowledge_base`（工具 description 触发场景，实测已可自主命中）；chit-chat 补 KB 意图提示；检索实现（TF-IDF+embedding RRF）不变 | chat.ts / skills.ts / agent-routing-baseline.mdc / 5×SKILL.md |
| 2026-08-22 | 评估 | 建立本文档，明确差距与优先级 | `ENTERPRISE_ROADMAP.md` |
| 2026-08-21 | 智能问法 | 写操作强制确认、续聊上下文继承、能力清单 | chat.ts / workflow-orchestrate.ts / tool-gate.ts |
| 2026-08-21 | 多项目 | 别名数据驱动化（project-aliases.json） | generate-api-index.mjs / api-index.ts / tools.ts |

---

## 6. 待办看板（总览）

### 阻塞中（等外部）
- [ ] P0 钉钉企业应用凭证（Client ID/Secret）

### 可立即开工
- [x] P1 本地知识库 RAG（方案 B）✅ 骨架已落地（2026-08-22）
- [ ] P1 语义检索升级（embedding 向量化，当前词法）

### 待排期
- [ ] P2 多项目权限隔离（ACL）
- [ ] P1 知识库权限过滤 / 钉钉拉取 / 增量索引
- [ ] P3 闲聊兜底 / 写参数动态语言 / 操作说明补全
