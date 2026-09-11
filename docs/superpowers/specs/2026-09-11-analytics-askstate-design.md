# Analytics AskState：会话工作记忆 · 续问修订 · 接地硬门 · 交付契约

> **状态**：P0/P1 已落地（含 delivery explain）；会话 askState 前端持久化；联调见 `analytics-askstate-smoke.ts`  
> **日期**：2026-09-11  
> **宿主**：`apps/agent-server` Analytics 语义层 + `apps/web` Analytics 对话 UI  
> **关联**：  
> - [`2026-09-09-metabase-analytics-agent-design.md`](./2026-09-09-metabase-analytics-agent-design.md)  
> - [`2026-09-10-analytics-ambiguity-gate-design.md`](./2026-09-10-analytics-ambiguity-gate-design.md)  
> - [`2026-09-11-analytics-reliability-roadmap.md`](./2026-09-11-analytics-reliability-roadmap.md)  
> **决策**：采用方案 B（AskState）；channel 未接地默认 **`clarify`**（非 refuse）

---

## 0. 一句话

把 Analytics 从「槽位填空机」升级为「带着工作记忆的 Agent」：自由对话改的是 **当前 AskState**；能力、维值接地与交付验收由代码硬门约束，禁止静默答非所问。

---

## 1. 问题与动机

### 1.1 已暴露缺陷

| ID | 现象 | 根因 |
|----|------|------|
| #1 | 「IndiaB呢？」又问语言 | 无续问意图；闸门作用域是整段历史，不是「当前 Ask」 |
| #4A | 别名/澄清文案不稳 | 未统一以 Metabase lexicon / probe 为源 |
| #4B | 幽灵 channel/码进 SQL | 接地软失败后 passthrough；channel 靠手写 allow-list |
| #2 | 两渠道对比缺行 | 只保证 SQL 提到，不保证结果覆盖 `requested` |
| #3 | 默认口径黑箱 | prefs 静默写入；UI 不可见、不可关 |

### 1.2 原则红线（继承总定稿）

1. **LLM 声明、代码校对** — 不把业务词黑名单当主路径。  
2. **失败可见** — 未接地 / 超纲 → `clarify` 或 `refuse`，禁止静默降级。  
3. **灵活在状态修订，严谨在接地与交付** — 对话自由 ≠ 自由写 SQL。

### 1.3 非目标

- 全面 text-to-SQL  
- 手写全量渠道/影片别名表当主路径（仅允许 pack override 兜底）  
- P0 做多 Ask 分支树 / 跨设备同步  

---

## 2. 核心对象

### 2.1 `AskState`（可序列化）

```ts
type AskState = {
  askId: string;
  packId: string;
  packVersion: string;
  metricId: string;
  time: { start: string; end: string };
  filters: Record<string, string[]>;   // 已接地或待接地
  outputDims: string[];
  layout?: "wide" | "long";
  pivotDim?: string;
  ops: string[];
  /** 交付验收：用户期望在结果中看到的成员集合 */
  requested: {
    channels?: string[];
    contentLangs?: string[];
    movieTypes?: string[];
  };
  defaultsApplied?: {
    channels?: boolean;
    layout?: boolean;
  };
  /** 给人看的一句话复述 */
  summary: string;
  updatedAt: number;
};
```

约定：

- `requested.channels` 在对比场景必须包含用户点名的全部渠道（如 IndiaA + IndiaB），即使 WHERE 形态是 `IN (...)`。  
- `filters` 可与 `requested` 同集；若只筛选一侧但仍要对比两侧，以 `requested` 为准做 Delivery。  
- 上一轮成功或可恢复的 Ask 作为 `prevAskState` 传入本轮。

### 2.2 `TurnIntent`（LLM 声明，代码枚举校验）

```ts
type TurnIntent =
  | { kind: "new_ask" }
  | { kind: "revise"; set?: Record<string, unknown>; clear?: string[] }
  | { kind: "clarify_answer"; slot: string; values: string[] }
  | { kind: "meta"; action: "set_defaults" | "clear_defaults" | "disable_defaults_this_turn"; payload?: Record<string, unknown> };
```

| kind | 含义 | 示例 |
|------|------|------|
| `new_ask` | 新开问数 | 「IndiaA 按天观看人数」 |
| `revise` | 修订当前 Ask | 「IndiaB呢？」「换成人均」「不要语言筛选」 |
| `clarify_answer` | 回答澄清 | 「1,3」「全都要」 |
| `meta` | 偏好/说明 | 「以后默认 IndiaA」「本轮别用默认渠道」 |

校验：

- `kind` 必须 ∈ 上表；非法 → 降级为 `new_ask` 或向用户 `clarify` 意图，**禁止硬猜改槽**。  
- `revise.set` / `clear` 路径必须落在已知 Ask 槽位（`filters.*` / `metricId` / `time` / `outputDims` / `layout` / `ops`）。  
- 无 `prevAskState` 时禁止 `revise`（改为 `new_ask`）。

---

## 3. 流水线

```text
messages + prevAskState + prefs
  → TurnIntent（LLM）
  → merge → candidate AskState
  → Ambiguity Gate（缺槽）
  → Demand–Capability Gate（ops ⊆ pack）
  → Grounding Gate（维值 ∈ lexicon/probe）     ★ 新增硬门
  → compile → exec
  → Delivery reconcile（对 requested 补零或说明） ★ 新增契约
  → 返回 result + AskState + UI 摘要元数据
```

与现有闸门：

| 闸门 | 管什么 | 本设计 |
|------|--------|--------|
| Ambiguity | 槽位缺失 / 宽长表 | 保留；作用域改为 **合并后 Ask** |
| Capability | ops/metric 超纲 | 保留 |
| Grounding | 维值是否真实存在 | **新增**；未接地默认 **clarify** |
| Delivery | 结果是否覆盖 requested | **新增** |

**作用域铁律**：`userDemandsLangFilter` / 语言 clarify 等政策只看 **本轮合并后的 Ask + 本轮用户显式语言诉求**，不得因历史某次语言题拦截 `revise` 续问。

---

## 4. 合并规则（AskState merge）

1. `new_ask`：由 Structure 填满新 Ask；可 soft-fill prefs（见 §7），并标记 `defaultsApplied`。  
2. `revise`：以 `prevAskState` 为底，应用 `set`/`clear`；`requested` 随 diff 更新（例如只改 channel 为 IndiaB → `requested.channels` 按产品规则扩展为对比集或替换——**默认：set 覆盖该维 requested；若 diff 语义是「加上对比」则 union**）。  
   - 续问「IndiaB呢？」在上一 Ask 已有其他渠道时：**union** 进 `requested.channels` 并更新 `filters.channel` 为对比集（或保留多渠对比语义）。  
   - 实现时用 TurnIntent 可选字段 `requestedPatch: { channels: { mode: "replace"|"union", values: string[] } }`；缺省对单实体续问用 **union**。  
3. `clarify_answer`：只填对应 slot，其余继承。  
4. `meta`：改 prefs / `defaultsApplied`，必要时用新 prefs 重算 filters（不改用户本轮明文）。

合并后若 metric/time 仍缺 → Ambiguity clarify；**不得**用历史无关槽位冒充。

---

## 5. Grounding Gate（维值硬门）

### 5.1 适用范围

Pack `enumDimensions` + `probeDimensions` 中需接地的维，至少：

- `movieType`：`metabase_lexicon`（已有）  
- `contentLang`：probe / literal 成员  
- `channel`：**纳入同一门**（probe Top-N + 可选 lexicon）；废除「手写 allow-list 即合法」为主路径  

### 5.2 算法

```
for each filter/requested token on grounded dims:
  resolve via lexicon then probe membership
  if unresolved:
    → status=clarify（默认，已确认）
       clarifySlot=<dim>
       options=lexicon/probe labels（禁止长期裸码）
    不得把未解析 token 写入 compile filters
```

策略细节：

- **单值像笔误 / 未命中** → `clarify`（用户决策：默认 clarify）。  
- 多值中部分命中：已命中可暂存；未命中列出并 clarify「以下无法识别：…」；**禁止**只拿命中部分静默跑完。  
- lexicon/probe 加载失败：记 note + `clarify` 或安全 `refuse`（不可 passthrough 幽灵码）。  
- pack 可提供 `aliasOverride` 作兜底，**不得**替代 Metabase 主源。

### 5.3 与 #4A / #4B

- 澄清文案：一律优先 lexicon/probe **label**。  
- 幽灵码：不能进 SQL（硬门）。

---

## 6. Delivery reconcile（交付契约）

在 exec 成功后、对用户交付前：

```
expected = AskState.requested.<dim>（若有）
actual   = 结果表中该维出现的成员
missing  = expected \ actual
```

策略（P1，可配置）：

| 模式 | 行为 |
|------|------|
| `zero_fill`（默认，对比场景） | 为 missing 补行，度量填 0，`notes` 含 `delivery_zero_fill:<dim>:<id>` |
| `explain` | 不补行，但 message 明确：「未出现：IndiaB（区间内无数据）」 |

验收：两渠道对比必须 **两行或点名说明**，禁止静默少行。

`reconcileNamedDimensions` 现有「SQL 里提到即 OK」改为：**对 requested 成员，结果单元格或 zero_fill/explain 必须覆盖**。

---

## 7. Prefs 可见可关（#3）

- 写入：仅 `meta` 明确「以后默认…」或产品确认的连续确认策略（可关）。  
- 读取：Structure facts + merge soft-fill；**不覆盖**本轮明文。  
- 「各渠道」等全量对比语义：不得强制默认单渠道（已有规则保留）。  
- UI：Ask 摘要条展示 `defaultsApplied` 芯片；操作：  
  - 本轮不用默认 → `meta.disable_defaults_this_turn`  
  - 清除默认 → `meta.clear_defaults`  
- API 响应增加 `askState` + `defaultsApplied` 供前端渲染。

---

## 8. 前端

- 续问：短句不再只靠 `looksLikeSlotOnlyReply`；服务端 `TurnIntent` 为主，前端可继续把澄清短答标成 `clarify_answer` 提示。  
- 结果区上方 **Ask 摘要条**：时间、渠道、指标、ops、默认芯片。  
- 「IndiaB呢？」类：不强制用户点澄清选项；走 `revise`。

---

## 9. 验收用例

| # | 步骤 | 期望 |
|---|------|------|
| A | 多语言对比成功后再问「IndiaB呢？」 | 非 `contentLang` clarify；IndiaB 进入对比或 Delivery 说明 0/无数据 |
| B | filters/requested 含幽灵 channel | `clarify` channel；SQL 无该码 |
| C | movieType 中文「电影」 | lexicon→1；clarify 选项含「电影」文案 |
| D | `requested.channels=[A,B]`，B 无行 | 补 0 或 message 点名 B |
| E | 存在默认渠道 | 摘要可见；关掉后重跑不再静默带上 |

回归：既有 C6 YoY/MoM、C2 宽表、C4 电影、baseline UV、TopN refuse 不得回退。

---

## 10. 分期

### P0（先做）

1. `AskState` 类型 + 响应回传 + 前端暂存 `prevAskState`  
2. `TurnIntent` 解析/校验 + merge（含 `revise` union 渠道）  
3. Grounding Gate：channel + movieType（contentLang 对齐）  
4. 政策作用域：续问不再被历史语言闸误伤  
5. 用例 A/B/C

### P1

1. Delivery `zero_fill` / `explain` — **已落地**（pack `delivery.missingChannel`；默认 zero_fill）  
2. Prefs 摘要条 + 可关 — **已落地**  
3. 用例 A/B/C/D/E — `npm run test:analytics-askstate-smoke`（`ASKSTATE_CASE=A|B|C|D|E`）

### P2（非本阶段）

- AskState 服务端持久化、多 Ask 分支、undo → 见 [`2026-09-11-analytics-askstate-p2-design.md`](./2026-09-11-analytics-askstate-p2-design.md)（线性栈 A，已实现）

---

## 11. 代码落点（实现指引，非本阶段编码）

| 模块 | 路径（预期） |
|------|----------------|
| AskState / merge / TurnIntent | `src/analytics/ask-state.ts`（新） |
| Grounding gate | 扩展 `dim-resolve.ts` / 新 `grounding-gate.ts` |
| Delivery | 扩展 `dim-reconcile.ts` |
| Pipeline 串联 | `pipeline.ts` |
| Prefs UI 元数据 | `analytics-prefs.ts` + web Analytics 页 |
| 续问前端 | `analytics-clarify.ts`（降级为辅助，主逻辑在服务端） |

---

## 12. 已确认决策

1. 总体采用方案 B（AskState）。  
2. channel（及同类维）未接地默认 **`clarify`**。  
3. 别名主源：Metabase lexicon / probe；非手维主表。  
4. 对比缺行：P1 默认 zero_fill，可 explain。
