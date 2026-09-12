# Analytics TurnIntent-LLM：续问意图由模型声明、代码枚举校验

> **状态**：已落地（pack `2026-09-12.01`）  
> **日期**：2026-09-11 / 补漏 2026-09-12  
> **关联**：[`2026-09-11-analytics-askstate-design.md`](./2026-09-11-analytics-askstate-design.md) §2.2 / §3（原稿已写 TurnIntent=LLM；实现误落成 heuristic）  
> **动机**：停止用正则堆「呢？/换成/按天」；准确度走 LLM 理解，严谨度走代码门  
>
> **补漏（2026-09-12）**：共用 `pickAnalyticsModel`；clarify 可恢复路径 seal AskState；web 传 `lastClarifySlot`；删 deprecated `inferTurnIntent` 与重复单测；`turnIntentSource` 进 web 类型。  
> P1 原「全部 clarify 写 AskState」：已覆盖 structure / contentLang / capability / channel·grounding；输入护栏与纯 time_range 仍可不写。

---

## 0. 一句话

把 `inferTurnIntent` 从 **启发式主路径** 换成 **LLM 结构化声明 + 代码校验**；merge / grounding / delivery **不变**。正则只保留 meta 与 slotAnswers 的极薄兜底。

---

## 1. 问题

| 现状 | 后果 |
|------|------|
| `ask-state.ts` 里短句正则猜 revise | 每修一个 case 加一条规则，改不完 |
| 原稿已规定 TurnIntent=LLM | 实现与设计漂移 |
| Structure LLM 仍可能重跑整段历史 | 续问本可 skip Structure，却被历史幽灵维误伤 |

---

## 2. 目标 / 非目标

**目标**

1. 有 `prevAskState` 时：LLM 输出合法 `TurnIntent` JSON → `validateTurnIntent` → `mergeAskState`。  
2. `revise` 可声明 `set` / `clear` / `requestedPatch` / `outputDims`（多渠对比时模型应带上 `channel` dim；代码可做 **软补全**：`requested.channels.length>1` 且缺 `channel` dim → 自动补，记 note，**不**靠「呢？」正则）。  
3. 非法 JSON / 非法 kind / 非法 path → **降级 `new_ask`**（或 `clarify` 意图，本阶段默认降级 new_ask + note），禁止硬猜改槽。  
4. 删除（或 `#region deprecated` 冻结）短句 channel/grain heuristic；单测改为 LLM mock + validate。

**非目标**

- 不重做 Structure / Capability / Grounding / Delivery  
- 不做多 Ask 分支树  
- 不把 live smoke 塞进默认 CI  

---

## 3. 流水线（仅改意图层）

```text
lastUserText + prevAskState? + slotAnswers? + lastClarifySlot?
  → [薄兜底] slotAnswers → clarify_answer
  → [薄兜底] meta 正则（清除默认 / 本轮不用默认 / 设默认）
  → 否则 LLM TurnIntent（json_object）
  → validateTurnIntent(prev)
  → 现有 merge → gates → compile …
```

有 `prevAskState` 且 `kind=revise|clarify_answer` 且 merge 完整 → **继续 skip Structure LLM**（保持快路径）。

---

## 4. LLM 契约

### 4.1 输入（短）

- `prevAskState` 摘要 JSON（metric/time/filters/outputDims/requested/ops）  
- `lastUserText`  
- 可选：`lastClarifySlot` + options ids（若上一助手是 clarify）  
- 一句话规则：续问改的是当前 Ask；「呢」类默认 channel **union**；「换成/改成」默认 **replace**；多渠对比须在 outputDims 含 `channel`。

### 4.2 输出 schema（与现有 `TurnIntent` 对齐）

```json
{
  "kind": "revise",
  "set": { "outputDims": ["watch_date", "channel"], "metricId": "uniq_users" },
  "clear": [],
  "requestedPatch": { "channels": { "mode": "union", "values": ["FoxA"] } },
  "notes": ["llm_turn_intent"]
}
```

或 `new_ask` / `clarify_answer` / `meta`。

### 4.3 `validateTurnIntent`

- `kind` ∈ 白名单  
- 无 prev → 禁止 revise（改 new_ask）  
- `set`/`clear` path ∈ 允许列表：`metricId|layout|pivotDim|outputDims|ops|time|filters.*|requested.*`  
- `requestedPatch.channels.mode` ∈ `union|replace`；values 非空字符串  
- `clarify_answer` 须有 slot + values  
- `meta.action` ∈ 已知集合  
- 失败：返回 `{ kind:"new_ask", notes:["turn_intent_invalid:"+reason] }`

### 4.4 代码软补全（允许的「非正则业务」）

仅在 **merge 之后**：

- `requested.channels.length > 1` 且 `outputDims` 无 `channel` → 追加 `channel` + note `auto_output_dim_channel_for_compare`  
  （这是交付契约，不是 NL 词表。）

---

## 5. 薄兜底（保留）

| 条件 | 行为 |
|------|------|
| `slotAnswers`（优先取首槽；多槽记 note） | `clarify_answer`（前端澄清点选） |
| 明确 meta 句（清除默认 / 本轮不用默认 / 设为默认） | `meta`（避免多一次 LLM） |
| LLM 超时/抛错 | `new_ask` + note；不阻断主问 |

**删除主路径**：`呢？` / `换成` / `按天看看` / CamelCase 短句等 heuristic。

---

## 6. 实现落点

| 模块 | 动作 |
|------|------|
| `turn-intent-llm.ts`（新） | prompt + parse + validate + `resolveTurnIntent` |
| `ask-state.ts` | `inferTurnIntentFallback` + `validateTurnIntent` + `stripDisableDefaultsPrefix` |
| `pipeline.ts` | `await resolveTurnIntent({..., lastClarifySlot, modelId, signal})`；可恢复 clarify seal AskState |
| 单测 | validate/merge 在 `analytics-ask-state.test.ts`；删重复 validate 脚本 |
| pack | bump；`turnIntentSource` 在 **响应字段**（非 pack notes） |
| 选模 | `pick-analytics-model.ts` 共用（Structure / TurnIntent / llmText） |

---

## 7. 验收

1. 「IndiaA…按天」→「FoxA呢？」：LLM revise + union + outputDims 含 channel；SQL `IN (IndiaA,FoxA)` 且 GROUP BY channel。  
2. 「换成 FoxA」：replace，非 union。  
3. 「按天看看」：revise `outputDims` 含 watch_date，非 contentLang clarify。  
4. Ghost clarify →「换成 IndiaA」：ok，SQL 无 Ghost；维校验只用本轮用户句。  
5. 非法 TurnIntent JSON → 降级 new_ask，不静默乱改槽。  
6. **不再**为新短句加正则（评审门禁：ask-state heuristic 行数只减不增）。

---

## 8. 分期

- **P0（本设计）**：LLM TurnIntent + validate + 删短句 heuristic + 软补全 channel dim + 单测  
- **P1（部分完成）**：可恢复 clarify 写 AskState + `lastClarifySlot` 接线；输入护栏/纯时间反问仍可不写  
- **P2**：TurnIntent 与 Structure 合并为一次 LLM（省延迟；非必须）

---

## 9. 已定决策（请确认）

1. 主路径 = LLM TurnIntent，不是 heuristic。  
2. 非法意图 → 降级 `new_ask`（本阶段不用 clarify 意图）。  
3. 多渠缺 dim 的 **代码软补全** 保留。  
4. meta / slotAnswers 薄兜底保留。
