# BI 护栏：业界最佳实践对齐与整改方案

> **实施状态（2026-10-17）：方案 C 已落地**——`ownBusinessNameRefusal` 由「硬拦（要求先 web_search）」降级为 **advisory 软提示（不阻断只读 BI 查询）**，三处调用点据此不再阻断，技能闸 `ownBusinessToolRefusal` 保留硬拦。本次落地缘起于同日的端到端复现（见 `docs/agent/BI_GUARDRAIL_AUDIT_2026-10-17.md`）：用户问 `INGoogle8/INGoogle10` 渠道新增用户来源结构+同比，模型被专名护栏硬拦、web_search 无果后放弃，空手返回。
>
> 目的：解决「专名护栏误伤」——用户直接贴 SQL、或消息里提到技能名 `business-data-query` 时，BI 只读查询被硬拦（旧版 `UNSCOPED_NAME_BI_REFUSAL` 要求先 `web_search`），甚至与「必须先读技能才能用 BI」形成死锁。
>
> 方法：先对齐业界最佳实践（OWASP LLM Top 10 2025 v1.1、AWS Generative AI Lens、Anthropic 工具许可设计），再结合本项目多方向实测证据给出方案。

---

## 一、业界最佳实践（检索依据）

### 1.1 OWASP LLM Top 10（2025 v1.1）

| 编号 | 风险 | 与本项目的对应护栏 |
|---|---|---|
| LLM01 | Prompt Injection | 不可信数据定界（`wrapUntrusted`）+ 注入防护 |
| LLM02 | Sensitive Information Disclosure | `SENSITIVE_COLUMN` lint（手机号/邮箱/证件号/薪资提示） |
| **LLM03** | **Excessive Agency（过度代理，2026 由第 6 升至第 3）** | 能力边界：工具允许清单、写操作确认、`deniedBuiltins` |
| LLM05 | Data and Model Poisoning | 外部内容定界、证据来源记账 |
| **LLM06** | **Unbounded Consumption（无界消耗）** | 成本护栏：SETTINGS（`max_execution_time` 等）、超时、熔断、`LoopGuard` |
| **LLM07** | **Misinformation（错误信息/幻觉）** | 反编造：数字必须来自工具返回、回显 SQL、口径声明、合计自检 |
| LLM10 | Improper Output Handling | 输出渲染转义、artifact 校验 |

### 1.2 AWS Well-Architected「Generative AI Lens」对 Excessive agency 的界定
代理被赋予行动能力，**风险在于代理可能在未确认时执行不可逆操作**。→ 护栏的**保守（fail-closed）应施加于"有副作用/不可逆"的动作**，而非一切动作。

### 1.3 Anthropic（Claude Code 官方最佳实践）的工具许可原则
> "默认情况下，Claude Code 会对任何**可能修改你系统的操作**请求授权……我们**刻意采取这种保守的设计**。"
→ 保守设计的作用域 = **写/副作用**；对只读动作不应一刀切硬拦。

### 1.4 护栏工程通识（多来源一致）
- 护栏分 **Input Validation + Output Validation** 双层，是「第一道防线」，应以**确定性规则**（regex / 静态结构判据）为主。
- 护栏的职责是：*what the system can access、which actions it may perform、what formats it must follow、and when it must stop for review*（把业务要求翻译成软件控制点）。
- **终止权/预算应属于运行时控制器，不属于模型**（与本项目 `LoopGuard`、成本护栏一致）。
- **护栏自身也会成为攻击面**（如"推理扩展 DoS"：构造输入把护栏困进无界推理），因此护栏需要**可观测**（记录并回显触发原因）与**可降级/可重试**。

### 1.5 提炼出的 5 条判据（用于评估本项目）
| # | 原则 | 含义 |
|---|---|---|
| **P1** | **风险匹配原则** | 护栏强度 ∝ 操作风险：**写/不可逆 → 硬拦（fail-closed）+ 人工确认**；**只读/可逆 → 放行 + 提示（fail-open）** |
| **P2** | **确定性优先** | 判据用静态结构/清单（能力、语法、成本阈值），避免"用户说了什么词"这类语义启发式 |
| **P3** | **反幻觉靠证据链** | 数字必须可溯源（工具返回 + SQL + 口径 + 自检），不靠"拦住问题"来防错 |
| **P4** | **资源护栏靠预算** | 无界消耗用估算/超时/熔断/预算，不靠语义猜测 |
| **P5** | **可观测 + 可降级** | 护栏触发要记录并回显原因；误拦时能自愈/重试（不把护栏故障说成"库里没数"） |

---

## 二、本项目护栏现状对齐度评估

| 护栏 | 判据类型 | 风险等级 | 当前行为 | 对齐 |
|---|---|---|---|---|
| 写操作确认 / 工具允许清单 / `deniedBuiltins` | 确定性（能力清单） | 写/副作用 | **硬拦 + 人工确认** | ✅ P1/P2（保守设计用在该用的地方） |
| 只读校验（Metabase 只读、禁写语句） | 确定性（SQL 语法） | 只读 | 硬拦写语句 | ✅ |
| `sql-lint` 体检 | 确定性（SQL 静态结构） | 只读 | **advisory，放行 + 提示** | ✅ P1/P2/P5（回显原因） |
| 成本/超时/熔断 `SETTINGS`+`LoopGuard` | 确定性（阈值） | 只读 | 预算控制、超时取消 | ✅ P4 |
| `SENSITIVE_COLUMN` | 确定性（列名形态） | 输出 | advisory 提示 | ✅ LLM02 |
| GROUNDING / 反编造 | 证据来源记账 | 输出 | 无证据不给数 | ✅ LLM07/P3 |
| **技能闸 `ownBusinessToolRefusal`** | 确定性（是否读过技能） | 只读 | 硬拦一轮 + 文案自愈（"读过技能下一轮直接调用"） | ⚠️ 可接受（流程边界 + 可降级 P5），但会阻塞一轮 |
| **专名护栏 `ownBusinessNameRefusal`** | **启发式（用户消息里的拉丁词形态）** | **只读** | **硬拦（要求先 web_search）** | ❌ **违反 P1（只读不应硬拦）、P2（语义启发式）、P5（误拦无自愈）** |

**结论**：除专名护栏外，其余护栏均与最佳实践一致。**唯一系统性偏差 = 专名护栏对只读查询做了基于语义猜测的硬拦**。

---

## 三、偏差的具体证据（本项目实测）

1. **用户直接贴 SQL 被拦**：`SELECT / COUNT / DISTINCT / JOIN / WHERE / GROUP / ORDER / FROM` 等 SQL 关键字都是 ≥4 字母拉丁词，既不匹配 snake/驼峰形态过滤，也不在通用词表 → 被判为"外部专名"。
2. **提到技能名被拦（死锁）**：`business-data-query` 中的 `business`、`query` 为纯小写单词 → 被判"外部专名"；而"必须先读该技能"才能用 BI，形成 **"不提技能名读不了、提了就被拦"** 的死锁。
3. **方向 C 之前的同类误伤**：含 `elt_user_vip_info` / `countryCode` / `vipType` 等内部标识符的取数消息曾被拦（已通过形态过滤 + 技能闸放行缓解，但未根治纯小写单词这一类）。

**根因**：`unscopedNameTokens` 的形态过滤只处理 `snake_case` / 多段驼峰 / `schema.table`，**不处理"纯小写单词"**（SQL 关键字、技能名成分、通用英文词），而"外部专名"恰恰也是普通词形 → **词形无法区分内部语境与外部专名**，这是该护栏的固有缺陷（不是参数没调好，是判据选错了）。

---

## 四、推荐方案（按最佳实践）

### 4.1 方案对比（多方向考虑）

| 方案 | 做法 | 对齐度 | 代价 |
|---|---|---|---|
| A. SQL 形态检测 | 消息含 `SELECT…FROM` 视为内部取数，不触发 | 部分（只解"贴 SQL"） | 仍误伤"纯中文 + 技能名"；保留硬拦与启发式 |
| B. 扩充契约词豁免 | 把 SQL 关键字 + 技能名成分加入通用词表 | 部分（缓解） | 词表永远可能漏（新关键字、新技能名）；维护负担；仍硬拦 |
| **C. 护栏降级为软提示（推荐）** | `ownBusinessNameRefusal` 由"拒绝执行"改为**附加提示**（像 lint 那样），不再阻断 | **完全对齐 P1/P2/P5** | 失去"防弱模型用 BI 搜外部专名"的硬兜底 → 由 GROUNDING 兜底（见 4.3） |

### 4.2 推荐：C（软提示）+ 保留确定性硬拦

**改动 1：专名护栏 → advisory 提示（不阻断）**
- `ownBusinessNameRefusal` 不再返回拒绝文本、不再阻断工具执行；改为在**工具返回里附加一条提示**（与 `sql-lint` 一致的 advisory 形态）：
  > 「提示：这句话里出现了未在已连接数据中落到实处的名称（如 X）。若 X 是外部主体，请先用 `web_search` 核对；若是内部业务指标，可继续用本连接器取数。」
- 模型自行判断（P1：只读 fail-open；P2：不再用语义猜测决定"能不能执行"；方向 C 的"信任模型选源"精神一致）。

**改动 2：保留的硬拦（确定性判据，不动）**
- 工具允许清单、`deniedBuiltins`、写操作未确认、定时运行拒绝、直接列表闸、安全闸门 —— 这些都是**能力/授权边界**（P2 确定性），继续硬拦。
- 技能闸（未读技能）保留硬拦 —— 它是**流程边界**且已具备自愈文案（P5）。

**改动 3：可观测**
- 专名提示被触发时记为一次 advisory 事件（与 lint 一样进入返回文本），便于事后统计误报率，判断是否还有噪声。

### 4.3 硬兜底移除后的风险补偿（关键）
原硬拦的价值是"防模型拿 BI 库搜外部专名"。降级后由**既有护栏**补偿，且更符合最佳实践：
- **GROUNDING / 反编造（LLM07）**：若模型真拿 BI 搜外部专名，返回必为空 → 护栏要求"没数据就如实说没数据"，**不会编造外部信息**（本项目已多次验证：Netflix 一例中模型如实说"无法确认"）。
- **技能纪律**：`business-data-query` 技能已写明"主体落在外部世界时不要用这个连接器，改用 web_search"——**约束放在系统提示/技能里（软约束，可解释），而不是靠词形硬拦**。

### 4.4 为什么不选 A/B
二者都是"给错误判据打补丁"：判据本身（用用户消息的词形推断内外）**不可修复**——词形永远区分不了"内部 SQL 关键字 / 技能名"与"外部专名"。继续打补丁只会让词表越来越长、维护成本越来越高，且仍会漏。

---

## 五、实施步骤

1. `chat.ts`：把 `ownBusinessNameRefusal` 的返回值从"阻断拒绝"改为"提示文本"，并调整 3 个调用点（不再 `return {ok:false, executed:false}`，改为附带 hint 后正常执行）。
2. 保留 `unscopedNameTokens`（仍用于生成提示里的名称列表），但不再用它做准入判定。
3. 测试：新增用例固化——
   - 贴 SQL 的消息：**工具正常执行**，返回里附专名提示（不再被拦）；
   - 含技能名的中文消息：同上；
   - 真外部专名场景：仍产出提示（advisory），且模型可继续取数（不像旧行为那样阻断）。
4. 重启 `agent-server` + 浏览器复验：贴一条完整 SQL 让执行，确认**不再出现"未执行"**且数字正常返回。
5. 复跑第五章的 4 条核验 SQL（回归确认护栏改动未影响取数）。

---

## 六、风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 弱模型真的拿 BI 搜外部专名 | 低（返回空 → 反编造护栏保证如实说"没数据"，不产生假数字） | GROUNDING + 技能里的软约束 |
| 提示噪声（每次取数都带提示） | 中（需观察） | 可观测统计触发率；若噪声高，可把提示收窄为"仅当消息含明显非库内实体时" |
| 只读查询失控消耗 | 与本改动无关 | 已有 SETTINGS/超时/熔断（LLM06）不变 |

**回滚**：改动集中在 `ownBusinessNameRefusal` 一个函数 + 3 个调用点，可整体 revert 回到硬拦版本。

---

## 附：检索来源
- OWASP LLM Top 10（2025 v1.1）：Excessive Agency、Unbounded Consumption、Misinformation
- AWS Well-Architected「Generative AI Lens」— Excessive agency
- Anthropic《Claude Code: Best practices for agentic coding》— 工具许可清单的保守设计原则
- 护栏工程通识（Input/Output Validation 双层、确定性规则优先、终止权属运行时控制器、护栏自身亦为攻击面）
- 本项目实测记录（2026-10-16~17 端到端）：SETTINGS 回归 `c168883`、方向 C 技能闸、`hasDateWindow` 判据、未执行黄色警告、BI 库实测核验（印度有效会员 741,999 等）

---

## 七、实施记录（2026-10-17，方案 C 落地）

### 7.1 复现证据（触发本次落地）
用户消息含内部渠道编码 `INGoogle8`/`INGoogle10`，触发 `unscopedNameTokens` → 被判为「外部专名」→ 旧版 `ownBusinessNameRefusal` 硬拦（强制先 web_search）。模型 `web_search` 无命中后放弃取数，空手返回「没取到数据」。`docs/agent/BI_GUARDRAIL_AUDIT_2026-10-17.md` 记录了完整对照（含人工手写 SQL 揭示的真实数据模型与 SQL 自身问题）。

### 7.2 代码改动（chat.ts）
- `ownBusinessNameRefusal` 返回文案由「未执行…先调用 web_search」改为 **advisory 提示**：列出未在已连接数据落到实处的名称，提示「若是外部主体先 web_search 核对；若是内部业务指标可继续取数」，并 `console.log` 记录触发（可观测 P5）。
- 三处调用点（`chat.ts:2122 / 2841 / 3482`）**不再据此阻断**只读 BI 查询；成功执行时把提示作为 advisory 附加到工具返回文本（与 `sql-lint` 同源 fail-open）。
- 保留：技能闸 `ownBusinessToolRefusal`（未读 `business-data-query` 技能仍硬拦，确定性流程边界，已有自愈文案）。

### 7.3 文档改动
- 本文件顶部标记方案 C 已实施。
- `skills/business-data-query/SKILL.md` 补「被专名护栏挡住时的恢复步骤」：web_search 无命中后必须读技能并回退 BI 取数，不要据此放弃。

### 7.4 回归
- `tests/deep-agent-control.test.ts` 对 `ownBusinessNameRefusal` 的 `toContain("web_search")` / `toBeNull()` 断言仍成立。
- 端到端复验：含 `INGoogle8/INGoogle10` 的取数消息不再被「未执行」卡死，能进入 BI 取数流程。
