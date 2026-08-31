---
name: preprocess-optimize-rules-kb
overview: 优化 chat.ts preprocess 输入预处理：① resident rules 精简去重并合并注入，② skills 清单 description 规范化与预算护栏，③ 删除 KB 关键词预检 forcedReply 短路（改由模型自主调 search_knowledge_base 工具），并在 chit-chat 分支补 KB 意图提示补位。
todos:
  - id: rules-slim
    content: 精简 agent-routing-baseline.mdc 7→4 条，chat.ts 注入合并为单个 workflow/rules step
    status: pending
  - id: skill-desc
    content: 用 [skill:skill-creator] 优化 5 个 SKILL.md 的 description 为触发场景句+触发词格式
    status: pending
  - id: skills-budget
    content: skills.ts 增加技能清单字符预算护栏并清理 import 引用
    status: pending
  - id: kb-preflight-removal
    content: 删除 chat.ts KB 预检短路，chit-chat 补 search_knowledge_base 提示，清理相关 import
    status: pending
  - id: regression-verify
    content: 重启 agent-server 回归 KB/业务/闲聊三类请求并更新流程改进日志
    status: pending
    dependencies:
      - rules-slim
      - skill-desc
      - skills-budget
      - kb-preflight-removal
---

## 用户需求
对「请求入口与预处理」中两项进行优化：
1. **② resident rules 注入 + skills 清单注入：需要优化**
2. **③ 知识库预检（KB_KEYWORDS 正则 + searchKnowledgeBase + forcedReply 短路）：检查是否必要，没必要就删除，或给出更好方案**

## 检查结论

### ② 检查结果（已有 2 处重复、5 处 description 不达标）
- `.cursor/rules/agent-routing-baseline.mdc` 7 条中：#5 PC 日志对齐（服务端 call_api 已按元数据 logEnabled 自动判定）、#7 展示前规范化（normalize_output 工具 description + 服务端受控渲染已强制）为**纯重复项**；#4 先检索再调用与 #2 禁止编造**语义重叠**。chat.ts 目前逐条注入 7 个 system step，浪费上下文槽位。
- 9 个 SKILL.md 中 5 个（output-report-chart、write-confirm、pc-output-formats、export-preview、media-bi-richtext）description 为**纯关键词堆叠**，缺触发场景句，不符合 Claude/Cursor「description 写触发条件」规范；business-intent 已 enabled:false 不加载。
- skills.ts loadSkills() 无清单预算护栏（当前 ~1100 字符，远低于官方 2%/16000 回退上限，属预防性）。

### ③ 检查结果（结论：删除预检短路）
- KB_KEYWORDS 15 词正则召回率低：自然口语「上班迟到扣钱」「请假多久」不含关键词 → 预检不触发。
- 与 `search_knowledge_base` 工具**功能重复**：该工具已注册且模型可自主调用（实测「上班迟到了会扣钱吗」→考勤制度即走工具路径，该句不含任何 KB_KEYWORDS）。
- **假阳性短路风险**：业务句含「流程/标准/资料」（如「结算流程数据」）时若 KB 恰好命中会被误短路。
- 短路体验差：forcedReply 直接返回 formatSearchResults 原始分段（200 字截断+出处），无模型整合，与 RAG 主流「注入+整合」相悖。
- 与红线一致：删除符合「服务端不抢路由、完全抛弃词表预判」方向。
- **更好方案**：KB 意图判断完全交还模型（工具 description 已明确触发场景），同时在 chit-chat 薄提示中补一句「询问公司内部规范/制度/文档可调 search_knowledge_base」作轻量引导（提示非路由，符合红线），避免非业务分支模型不知道 KB 工具的存在。

## 核心功能
- 规则 7 条精简为 4 条（删 #5、#7 纯重复；#4 并入 #2），chat.ts 注入从 7 个 system step 合并为 1 个 `[workflow/rules]` step
- 5 个 SKILL.md description 统一为「触发场景句 + 触发词」格式（对齐 Claude Skill 官方规范）
- skills.ts 增加技能清单预算护栏（防技能数量膨胀后上下文超限）
- 删除 KB 预检短路（chat.ts），保留 search_knowledge_base 工具与 knowledge-base.ts 检索实现；chit-chat 分支补 KB 工具提示


## 技术栈
- 现有：Node.js + TypeScript + LangGraph（apps/agent-server），无新依赖
- 规则载体：.cursor/rules/*.mdc（Cursor Rules 对齐层）
- 技能载体：apps/agent-server/skills/<name>/SKILL.md（YAML frontmatter + Markdown）

## 实现方案
### 1. 规则精简（.cursor/rules/agent-routing-baseline.mdc + chat.ts 注入合并）
- 规则从 7 条精简为 4 条：
  - #1 写操作必须确认（保留，服务端 confirmation_required 机制兜底）
  - #2 禁止编造（并入原 #4「先检索再调用」：不得编造模块/操作/参数，不确定时用 search_api_module / read_api_module 检索索引确认）
  - #3 查询不反问可选条件（保留）
  - #4 写后回读（保留）
  - 删除 #5 PC 日志对齐（服务端按元数据 logEnabled 自动判定）、#7 展示前规范化（normalize_output description + 服务端受控渲染强制）
- chat.ts preprocess（1043-1049 行）：将 `for` 循环逐条 push 改为**单个** `[workflow/rules]` system step（4 条合并为一段文本），减少 system 槽位与 token 开销，并同步更新 PROMPT_ARCHITECTURE.md §2.2 描述与 §七 改动记录。

### 2. SKILL.md description 优化（5 个文件）
- 保留现有触发词，补「触发场景句」（Claude 官方规范：description 写触发时机而非功能摘要），格式示例：
  - `description: 当渲染结果出现英文表头/字段或枚举值未翻译时使用，需按本技能到源码找中文映射。触发词：表头英文、字段映射、枚举翻译…`
- 涉及：output-report-chart、write-confirm、pc-output-formats、export-preview、media-bi-richtext（pc-column-mapping / codebase-explorer / local-service-probe 已达标不动；business-intent 已停用不动）

### 3. skills.ts 预算护栏（预防性）
- loadSkills() 增加清单字符预算常量（如 `SKILL_CATALOG_BUDGET = 2000` 字符），超过时按优先级（description 长度/启用状态）截断并 console.warn 提示；当前 ~1100 字符不受影响，仅防未来技能膨胀。

### 4. 删除 KB 预检短路（chat.ts）
- 删除 1002-1021 行 KB_KEYWORDS 正则 + searchKnowledgeBase + formatSearchResults 预检块
- 1088-1089 行 forcedReply 不再由 kbPreflight 赋值（forcedReply 机制本身保留，供受控渲染路径使用）
- 清理 import：移除 `formatSearchResults, searchKnowledgeBase`（确认 chat.ts 无其他使用处）
- chit-chat 分支（1077-1083 行）文案补充：「若询问公司内部规范/制度/文档等知识库内容，可调用 search_knowledge_base 工具检索；call_api 等业务工具不要调用」——仅提示非路由
- 保留：tools.ts search_knowledge_base 工具注册、knowledge-base.ts 全部实现、understand 节点 forcedReply 短路分支（机制复用）

### 5. 回归验证
- pm2 restart agent-server 生效
- KB 类：「上班迟到了会扣钱吗」「报销流程是什么」→ 模型自主调 search_knowledge_base 返回带出处答案
- 业务类：「查询优惠活动配置列表」「账号合并 5585230699772928」「用户列表」→ 中文表头 + 表格渲染无回归
- 闲聊：「你好」「你有哪些能力」→ 纯文本回答不落兜底
- 更新 docs/agent/README.md 流程改进日志（日期+模块+要点+改动文件）

## 性能与风险
- token 收益：每业务请求减少约 6 个规则 system step（7→1）+ 移除预检注入与 KB 检索开销（KB 检索毫秒级，删除后请求路径更短）
- 风险与缓解：删除预检后 KB 类问题依赖模型自主调工具——以 chit-chat 提示 + search_knowledge_base description（已含触发场景）双保险；弱模型不调工具时用户仍可手动追问，不产生错误数据


## Agent Extensions
### Skill
- **skill-creator**
  - Purpose: 用于优化 5 个 SKILL.md 的 description，将其从纯关键词堆叠改写为「触发场景句 + 触发词」格式，对齐 Claude Skill 官方触发规范
  - Expected outcome: 5 个 SKILL.md 的 frontmatter description 均符合「写触发条件而非功能摘要」标准，模型能准确判断何时加载对应技能正文
