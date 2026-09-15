# Analytics 答案卡片布局：v1 现状快照 · v2 分区重构 · 回滚手册

> **状态**：v2 已落地（2026-09-15；单测 + 实跑验收见 §6）  
> **日期**：2026-09-15  
> **git 基线**：`4e68080`（fix(analytics): keep answered slots across multi-slot clarifies, dedupe delivery tail, fix error misclassification）  
> **宿主**：`apps/web`（Analytics 对话 UI，`AnalyticsAgentPage.vue`）+ `apps/agent-server`（Analytics 语义层与执行/解读链路）  
> **关联**：
> - [`2026-09-09-metabase-analytics-agent-design.md`](./2026-09-09-metabase-analytics-agent-design.md)
> - [`2026-09-11-analytics-askstate-design.md`](./2026-09-11-analytics-askstate-design.md)
> - 总章程 `docs/agent/AGENT_CHARTER.md`（禁止业务词写死）
> **决策**：布局分两段收敛——「答案与证据在前、解读与出处收尾」；新增 `headline`（头号答案）与 `caution`（口径提示）两个契约字段，**不新增 LLM 调用**。

---

## 0. 一句话

把 Analytics 答案卡片从「时间回显 + 表格 + 一段解读乱序堆叠」重排为 **元信息 → 头号答案 → 证据（图/表）→ 解读 → 口径与出处 → 反馈**；本文件先把改造前的 v1 布局、文案拼装方式、代码锚点原样存档，并给出无需 git 也能恢复的粘贴级还原手册。

---

## 1. 版本时间线

| 版本 | 变更 | 位置 |
|------|------|------|
| **v0** | 原始布局：正文 → `insight`（总结 + 趋势）→ SQL → 图表 → 表格 | `AnalyticsAgentPage.vue`（HEAD `4e68080`） |
| **v1** | 仅把 `insight` 整块从「正文之后」移到「表格之后」，成为内容收尾；`.ask-insight` margin 改为 `12px 0 0` 并加 `max-width` | 本文件 §2.1 / §3 |
| **v2** | 本次改造：新增 `headline`/`caution` 字段；headline 上提到顶部；SQL 下移到收尾区；正文不再重复渲染时间回显 | 本文件 §5 |

> v1 与 v2 均为**未提交的工作区改动**（基线仍是 `4e68080`）。回滚时先看 §3。

---

## 2. v1 现状快照（改造前）

### 2.1 卡片分区顺序与字段来源

| # | 区块 | class | 数据来源 | v1 表现 |
|---|------|-------|----------|---------|
| 1 | 状态行 | `.status-line` | `status` / `timeEcho` / `packVersion` / `modelId` / `verify` | `ok` 徽标 · 时间回显 · pack 版本 · 模型 · 校对 chip |
| 2 | 条件回显 | `.ask-summary` | `askSummary` / `defaultsNote` | 「2026-09-14～2026-09-14 · uniq_users」+ 默认渠道 chip（可关） |
| 3 | 图片 / 附件 | `.msg-images` / `.msg-files-inline` | `images` / `files` | 用户侧上传回显 |
| 4 | 正文 | `.body` | `message`（+ 尾部可能拼 `verifyCaution`） | ok 答案里常常**只有一句时间回显**（如「按 2026-09-14～2026-09-14」） |
| 5 | SQL（可折叠） | `details.sql` | `sqls` / `trust` / `sqlSource` | 折叠块 + 口径 chip（`sqlTrustLabel`） |
| 6 | 图表 | `.msg-charts` | `charts` | 本地 ECharts 双轨图 |
| 7 | 表格 | `.msg-tables` | `tables` | 列标题/数值/条数（如「4 条」） |
| 8 | 解读 | `.ask-insight` | `insight` = `summary` + `trend`（`composeInsightMarkdown`，`\n\n` 拼接） | v1 已移到此处收尾：**总结段在前、趋势段在后** |
| 9 | 探针 | `.probe` | `probeSummary` | 仅 `status !== "ok"` 时出现 |
| 10 | 反馈 / 操作 | `.feedback-row` / `.body-actions` | `askId` / `feedback` | 有用·有误；编辑·复制 |

### 2.2「回复」是怎么拼出来的（服务端）

```
pipeline.ts
  ├─ message  ← 编译路径：`${range.echo}${emptyNote}`；LLM 写 SQL 路径：`${trustCaption("unverified")}${echo}${空结果提示}`
  ├─ attachPostExec()
  │    ├─ runPostExecLlm()  → verify（校对结论）+ insight（总结+趋势）
  │    └─ message = `${input.message}${verifyCaution(verify)}`   ← ★「校对未通过：…」被拼进正文
  └─ seal({ message, timeEcho, sqls, tables, charts, verify, insight, ... })
```

| 产物 | 生成方 | 备注 |
|------|--------|------|
| `message` | `pipeline.ts`（模板拼装，非模型） | ok 答案里基本等于 `timeEcho`，与状态行/条件回显**三处重复** |
| `insight` | `llm-verify.ts`：LLM（`headline` 尚无）或 `buildLocalInsight` 确定性兜底 | LLM 路径 = 1 次调用；编译/金样路径跳过校对，仅产出解读 |
| `caution` | 无（不存在该字段） | 校对失败文案混在 `message` 尾部 |
| `headline` | 无（不存在该字段） | 卡片顶部没有「头号答案」 |

关键代码锚点（v1）：

- `apps/agent-server/src/analytics/pipeline.ts:711-743`（`attachPostExec`，caution 拼进 message）
- `apps/agent-server/src/analytics/pipeline.ts:1031-1046`（LLM 写 SQL 路径 seal）
- `apps/agent-server/src/analytics/pipeline.ts:1866-1880`（编译路径 seal / `deliverAndSeal`）
- `apps/agent-server/src/analytics/llm-verify.ts:267-303`（insight prompt：`{summary, trend}`）
- `apps/agent-server/src/analytics/llm-verify.ts:305-328`（`parseInsightResponse` / `composeInsightMarkdown`）
- `apps/agent-server/src/analytics/llm-verify.ts:336-363`（`buildLocalInsight` 确定性兜底）
- `apps/agent-server/src/analytics/llm-verify.ts:478-481`（`verifyCaution`，带前导 `\n\n`）
- `apps/web/src/pages/AnalyticsAgentPage.vue:1682-1731`（v1 卡片模板顺序）

### 2.3 v1 已暴露缺口（v2 要解决的）

| ID | 缺口 | 影响 |
|----|------|------|
| G1 | 顶部没有头号答案 | 真正回答（如「2466349 为无语言标注行人数」）藏在表格里，需要自己扫表 |
| G2 | 校对/口径提示混在正文尾 | 「校对未通过：…」被读成答案的一部分 |
| G3 | SQL 折叠块夹在正文与图表之间 | 切断「答案 → 证据」动线；方法与出处应属最后一层 |
| G4 | 末尾没有追问建议 | 业界普遍在答尾给 2–3 个下一步 chip（本项目 `ANALYTICS_ASK_EXAMPLES` 目前只用于空态/帮助弹窗） |
| G5 | 时间回显重复 3 次 | 状态行 + 条件回显 + 正文（正文里那句基本无信息量） |

---

## 3. v1 恢复手册（回滚）

### 3.1 一步 git 回滚（仅当 v1/v2 的改动尚未提交时）

```powershell
cd d:\Code\bx-admin-agent
git --no-pager diff --stat                      # 先看都有哪些工作区改动
git checkout -- apps/web/src/pages/AnalyticsAgentPage.vue   # 丢弃前端卡片改动（回到 v0）
```

> ⚠️ 注意：工作区里还有大量与本卡片无关的既有改动（analytics 语义层等），**不要**用 `git checkout .` 或 `git stash` 全量操作，避免连带回滚他人/在途改动。本次卡片改造只涉及：
> - `apps/web/src/pages/AnalyticsAgentPage.vue`
> - `apps/web/src/api.ts`
> - `apps/agent-server/src/analytics/types.ts`
> - `apps/agent-server/src/analytics/llm-verify.ts`
> - `apps/agent-server/src/analytics/pipeline.ts`
> - `apps/agent-server/scripts/analytics-llm-verify.test.ts`

### 3.2 手工还原（保留其它改动时用）

**(a) 模板顺序** — 在 `AnalyticsAgentPage.vue` 的 `.body-wrap` 内，把顺序改回 v1：

```
1 status-line
2 ask-summary
3 msg-images / msg-files-inline
4 .body            （v1 无「隐藏纯时间回显」判断）
5 details.sql      ← SQL 在正文之后
6 msg-charts
7 msg-tables
8 .ask-insight     ← 解读在表格之后（v1 的位置）
9 .probe
10 .feedback-row / .body-actions
```

v1 原始片段（可直接粘贴替换 v2 的对应区块）：

```vue
          <div
            v-if="item.text && !item.pending"
            class="body"
            :class="{ error: item.status === 'error' || item.status === 'refuse' }"
            v-html="renderMarkdown(item.text)"
          />

          <details v-if="item.sqls?.length" class="sql">
            <summary class="sql-summary">
              <span>{{ tx("SQL", "SQL", "SQL", "SQL") }} ({{ item.sqls.length }})</span>
              <span v-if="sqlTrustLabel(item)" class="sql-trust" :class="`sql-trust-${item.trust || item.sqlSource || ''}`">{{ sqlTrustLabel(item) }}</span>
              <button
                type="button"
                class="sql-copy"
                :title="copiedSqlKey === `${item.id}:sql` ? tx('已复制', 'Copied') : tx('复制 SQL', 'Copy SQL')"
                @click.stop.prevent="copySqls(item)"
              >
                {{ copiedSqlKey === `${item.id}:sql` ? tx("已复制", "Copied") : tx("复制", "Copy") }}
              </button>
            </summary>
            <pre v-for="(sql, idx) in item.sqls" :key="idx">{{ sql }}</pre>
          </details>

          <div v-if="item.charts?.length" class="msg-charts">
            <ResultChart
              v-for="(ch, ci) in item.charts"
              :key="`${item.id}-c${ci}-${ch.title}-${ch.categories?.length || 0}`"
              :chart="ch"
            />
          </div>

          <div v-if="item.tables?.length" class="msg-tables">
            <ResultTable
              v-for="(table, idx) in item.tables"
              :key="`${item.id}-t${idx}`"
              :table="toTableView(table)"
              :empty-hint="item.timeEcho || undefined"
            />
          </div>

          <div
            v-if="item.insight && !item.pending"
            class="ask-insight"
            v-html="renderMarkdown(item.insight)"
          />

          <p v-if="item.probeSummary && item.status !== 'ok'" class="probe">
```

**(b) 样式原文**

v1（当前）：

```css
/* 结论性阅读（总结 + 趋势）固定收在数据之后 */
.ask-insight {
  margin: 12px 0 0;
  max-width: min(860px, 100%);
  font-size: 13px;
  color: var(--ink);
  line-height: 1.55;
}
```

v0（更早，解读在正文之后）：

```css
.ask-insight {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--ink);
  line-height: 1.55;
}
```

**(c) 服务端**：删除 `AnalyticsAskResult` 的 `headline` / `caution` 字段，并在 `attachPostExec` 里把

```ts
      const caution = verifyCaution(verify);
      return { verify, insight: post.insight, headline: post.headline, caution: caution || undefined, message: input.message };
```

改回

```ts
      return {
        verify,
        insight: post.insight,
        message: `${input.message}${verifyCaution(verify)}`,
      };
```

同时把 `verifyCaution` 恢复为 `return \`\n\n校对未通过：${verify.reason}\`;`（需要前导空行）。

---

## 4. 业界参考（别人怎么做）

| 类别 | 结论 | 来源 |
|------|------|------|
| BI / 仪表盘 | 渐进式披露：Headline Metrics（数据卡，置顶）→ Trends（图表）→ Details（表格）；数字右对齐、粘性表头、空态不留白 | PenguinMails《Analytics UI Patterns》（2025-11 更新） |
| AI 洞察卡片 | 四层金字塔：L1 核心结论 Headline（1 秒）→ L2 关键 KPI（3 秒）→ L3 微图表（5 秒）→ L4 归因/明细与下钻（深交互）。**结论在最上、明细在最下** | 中文 BI 实践文《智能数据洞察卡片的视觉层级架构》 |
| 对话式分析（Agent） | 回答是「消息流」：文本内依次是**推理步骤 → 进度 → 最终答案**；数据/图表作为独立消息流出；**SQL 不作为答案正文展示**（只存在于工具语境）；引用挂在文本上 | Google Cloud《Conversational Analytics API – Architecture and key concepts》（2026-09-03 更新） |
| 本项目对齐基线（Cursor） | 工具结果先上屏、模型基于真实数据在最后收束总结；主聊天页顺序即 `图表 → 推理 → 工具结果 → 表格 → 正文` | `apps/web/src/pages/ChatPage.vue:1209-1212`、`docs/agent/AGENT_CHARTER.md` |

**推论**：v1 的「解读收尾」符合 Agent 消息流与自家聊天页；但要补齐 BI 那半边——**顶部一句头号答案**。v2 同时满足两侧。

---

## 5. v2 目标设计（本次改造）

### 5.1 分区

```
① 状态行（ok · 时间 · pack/模型 · 校对）
② 条件回显（时间 · 指标 · 默认渠道）
③ 头号答案 headline        ← 新增：一句直接回答，含关键数字
④ 正文 message            ← 仅承载非回显内容（拒答/澄清/空结果/未核验口径提示）；纯时间回显不再渲染
⑤ 图表 → 表格（证据）
⑥ 解读 insight（总结 + 趋势）
⑦ 口径提示 caution        ← 新增：校对未通过等，从正文尾拆出
⑧ SQL（折叠）+ 口径 chip   ← 由正文之后下移到收尾区
⑨ 探针 probe
⑩ 反馈（有用/有误）· 编辑/复制
```

### 5.2 改动清单

**服务端**

| 文件 | 改动 |
|------|------|
| `src/analytics/types.ts` | `AnalyticsAskResult` 新增 `headline?: string`、`caution?: string` |
| `src/analytics/llm-verify.ts` | insight prompt 增字段 `headline`（同一次调用产出，**不增加调用次数**）；`parseInsightResponse` 返回 headline；新增 `composeHeadline`（接地校验 + 只取首句）；`PostExecLlm`/`generateLlmInsight` 带出 headline；`verifyCaution` 去掉前导 `\n\n`（改为独立字段用） |
| `src/analytics/pipeline.ts` | `attachPostExec` 不再把 caution 拼进 `message`，改为返回 `caution`；两条 seal 路径带出 `headline` / `caution` |
| `scripts/analytics-llm-verify.test.ts` | 补 headline 解析/接地/首句裁剪断言 |

**前端**

| 文件 | 改动 |
|------|------|
| `src/api.ts` | `AnalyticsAskResult`、`StoredMessage` 增 `headline` / `caution` |
| `pages/AnalyticsAgentPage.vue` | 类型与三处映射（`bubbleToStored` / `storedToBubble` / 成功回填）增字段；模板新增 headline 块与 caution 块、SQL 下移；`.ask-headline` / `.ask-caution` 样式；`copyBody` 复制内容含 headline + 解读 |

### 5.3 规则说明（合规）

- **纯时间回显不重复渲染**：判定条件是「`text.trim()` 与结果自带的 `timeEcho` 字段全等」，属于**协议级字段比对**，不涉及任何业务词/正则（符合 `AGENT_CHARTER` 禁止写死红线）。空结果提示、未核验口径前缀等只要与 echo 不完全相同就照常展示。
- **headline 来源**：与 `insight` 同一次 LLM 调用；模型未给或数字未接地时为空，**不回退编造**（确定性 `buildLocalInsight` 仍按原样放在解读区）。
- **趋势≠预测**：`trend` 的 prompt 明确「No future numeric forecast」，文案上不承诺数值预测。

---

## 6. 验收清单

- [x] 单指标单值问法：顶部出现 headline 且数字与表格一致
- [x] 分组问法（如按语言分组）：headline 给出头号组 + 数值；解读仍在收尾
- [x] 空结果/拒答/澄清：正文照常展示，无 headline 时不出现空块
- [x] 校对 fail 场景：正文干净，收尾区出现「口径提示」（字段已外置；fail 路径由实跑触发时可见）
- [x] 编译路径不产生额外 LLM 调用：单测断言 compiled 路径仍为 1 次「只读解读」调用，`ANALYTICS_LLM_INSIGHT=0` 时 0 次调用
- [x] 刷新页面 / 切换会话：headline、caution 已进 `StoredMessage` 契约，随服务端会话恢复
- [x] `tsx scripts/analytics-llm-verify.test.ts` → `analytics-llm-verify.test.ts OK`

**实跑（2026-09-15，直连 `analyticsAsk`，模型 dsflash，clock=2026-09-09T12:00+08:00）**

| 问法 | status | message | headline | insight | 行数 | 耗时 |
|------|--------|---------|----------|---------|------|------|
| 八月二十到二十一印度A按天观看人数 | ok | `按 2026-08-20～2026-08-21` | 「2026年8月20日至21日印度A每日观看人数分别为695,508人和698,475人。」 | 保持（按天稳定描述） | 2 | 15.1s |
| 八月二十印度A按语言观看人数 | ok | `按 2026-08-20～2026-08-20` | 「2026-08-20 印度A按语言观看人数中，语言为空值的用户最多，达 688,406 人…」 | 保持（四行 + 集中度） | 4 | 14.2s |

要点：headline 与 insight 同一次调用产出（耗时与改造前同级），数字均来自样例行（接地校验通过）；`message` 保持为时间回显（未再被 caution 污染）。

**实跑（v2.1/v2.2，模型 = glm52）**

| 问法 | status | headline | followups | 行数 |
|------|--------|----------|-----------|------|
| 八月二十印度A按语言观看人数 | ok | 「八月二十印度A按语言观看人数中，未标注语言用户最多，达688,406人。」 | 3 条（未标注语言用户看什么内容 / 已标注语言时长分布 / 其他日期是否同模式） | 4 |

**降级实跑（模型不可用时的兜底，2026-09-15 实测 dsflash 402 期间）**

- 模型层完全不可用时：`insight` 区不再重复时间回显，`headline` 由 `buildLocalReading` 补出（如「共 4 行，首位 users 688406。」），`followups` 为空 → 卡片不会出现「顶部空白」。
- 单测覆盖两条降级分支（空响应 / 抛错），见 `analytics-llm-verify.test.ts`。

**浏览器端到端实测（2026-09-15，playwright @ localhost:5173/analytics，模型 glm52）**

- 卡片 DOM 顺序实测与 §5.1 完全一致：`status-line → ask-summary → ask-headline → (正文隐藏) → msg-charts → msg-tables → ask-insight → details.sql → ask-followups → feedback-row`；正文纯时间回显确实不再渲染。
- headline 实测：「八月二十日印度A频道未标注语言观看人数达688,406人，为最高分组。」；模型徽标显示 `pack 2026-09-14.01 · glm52`（实际使用模型，非请求首选）。
- 追问 chip 实测 3 条、点击后自动发问（chip 文案成为新的用户消息）✓。
- **发现并修复**：`ASK_TIMEOUT_MS` 原为 45s，而真实链路（structure 工具循环 + 意图 + 执行 + 解读）实测 62.8s → 45s 必然掐断；已放宽为 **120s**（复杂追问仍可能超时，见 §8）。
- 截图：仓库根 `analytics-card-v2.png`（可删）。

---

## 7. 回滚开关

1. **一键回前端布局**：`git checkout -- apps/web/src/pages/AnalyticsAgentPage.vue`（回到 v0；v2 新增字段不影响 v0 渲染）。
2. **关闭模型产出 headline**：`.env` 设 `ANALYTICS_LLM_INSIGHT=0` → 只走 `buildLocalInsight` 确定性解读，headline 为空，卡片等价于 v1。
3. **只关校对提示外置**：把 §3.2(c) 改回即可（caution 重新拼进 message）。

---

## 8. 未做（挂账）

- 复杂追问（需要探库/多轮工具循环的问法）实测可能超过 120s 前端超时——延迟来自结构阶段的多轮尝试（候选链重试 + 探库），如需彻底解决要做流式/分阶段上屏，而非继续放大超时。
- 多表/多模块结果下的 headline 选取规则（当前取样例行首行 + 模型判断）。
- structure 阶段的「口径/语义质量」白名单（候选链已覆盖可达性与可解析性，见 §10 末段）。
- 追问 chip 的「点了之后是否隐藏历史 chip」「最多保留几组」等交互细节（当前每轮卡片各自保留）。

---

## 9. v2.1 收尾（查缺补漏 · 去冗余）

| 类型 | 项 | 处理 |
|------|----|------|
| 补漏 | `pipeline.ts` `collectIssues` 的 `pack` 参数可选，导致 `verifyGrainDay(nl, sql, pack)` 的类型报错、且缺 pack 时会**静默跳过 grain 硬门** | 参数改为必填（两处调用点本来就都传了 `pack`），报错消除、硬门不可被静默绕过 |
| 去冗余 | 时间回显在状态行 / 条件回显 / 正文出现 3 次 | 状态行的时间回显改为「无 `askSummary` 时才渲染」（协议级存在性判断）；正文的纯回显已隐藏 → 收敛为 2 处（条件回显 + 表格空态 hint） |
| 去冗余 | 「未核验口径 / 金样口径」曾与正文混排，且与 SQL 折叠里的口径 chip 重复占位 | 统一进 `caution`（与「校对未通过」同一层），正文只留答案与自身提示（空结果等） |
| 去冗余 | `llm-verify.ts` 两个分支各写一遍「parse → grounded → insight/headline」 | 抽出 `composeReading()`，headline 与 insight 共用同一套接地过滤 |
| 补漏 | `caution` 可能两行（口径 + 校对），HTML 里换行会被折叠 | `.ask-caution` 加 `white-space: pre-line` |
| 补漏 | 模型不可用（402/限流/空响应）时 headline 直接消失，卡片顶部没有直答 | 新增 `buildLocalReading`（确定性读数、不含时间回显）；`runPostExecLlm` 两条路径统一 `finishReading()`：模型没给出可用读数时把确定性读数补到 **headline** 位，解读区不重复 |
| 去冗余 | `buildLocalInsight`（含时间回显）与兜底逻辑重复、且模型降级时会把时间回显再写一遍 | 合并为 `buildLocalReading`（去掉 echo 前缀与 `local` 参数透传），`composeReading` 只回模型产出的部分，本地兜底归调用方 |
| 任务 | G4 追问建议 chip | 模型在同一次解读调用里产出 `followups`（1-3 条），`composeFollowups` 做接地过滤 + 去重 + 单条截断 + 不复述当前问句；答尾渲染为可点击 chip（点击即问） |
| 补漏 | 候选链换模型后，结果/审计上报的 `modelId` 仍是**请求时**的首选（UI 徽标与审计账本会显示错模型） | `LlmOpts.onModelUsed` 上报实际使用模型，`seal` 优先级改为 `result.modelId ?? usedModelId ?? resolvedModelId` |

回归：`analytics-llm-verify / analytics-pipeline-unit / analytics-delivery / analytics-sql-guard / analytics-verified-query` 全绿；前端 `chat-helpers / analytics-clarify / table-columns` 全绿；实跑（dsflash）`message="按 2026-08-20～2026-08-21"`（干净、与 `timeEcho` 全等 → UI 隐藏）、`headline` 有值、`caution` 为空。

---

## 10. 模型可用性与降级策略（2026-09-15 排查记录）

**背景**：本次改造收尾时发现「headline / followups 有时不出现」，逐层排查后确认**不是代码回归，而是模型侧不可用**。

| 现象 | 根因 | 证据 |
|------|------|------|
| 卡片顶部无 headline，解读退化成「共 N 行，首位 …」 | 分析解读模型调用失败被吞掉（`llmText` 包装里 `catch → ""`） | 直接以同一份 insight prompt 打模型：`dsflash` → **402** `401008 免费额度已耗尽` |
| structure 阶段偶发 clarify | 同上（structure 也走同一个模型） | 同上 |

**逐个模型探测（`chat/completions` 极简 ping）**

| 模型 | 结果 |
|------|------|
| `glm52`（glm-5.2） | ✅ 200 |
| `nvnemotronultra` / `nvnanoomni` / `hyvision` | ✅ 200 |
| `dsflash` / `dspro` / `glm5turbo` / `glm5` / `hy4` | ❌ 402（TokenHub 免费额度耗尽，未开后付费） |
| `nemotronultra` / `nemotronfree`（zen 免费链） | ❌ 400 `OpenCode's free tier can only be used in OpenCode` |
| `zenhy3` / `xpreviewfree` / `lagunas`（zen） | ❌ 401 `Model ... is not supported` |
| `nvstepflash` | ❌ 410 已下线；`nvlagunaxs` ❌ 503 worker 配额满 |

**处置（可一行回退）**：`.env` 里 `ANALYTICS_DEFAULT_MODEL` 由 `dsflash` 改为 `glm52`（`pickAnalyticsModel` 支持该开关，无需改代码）。切换后的实跑见 §6——headline / insight / followups 全部恢复，并首次端到端验证了追问 chip 的数据来源。回退方式：把该行改回 `dsflash`。

**候选模型链（已落地，替代上面的单点弱点）**

- `pick-analytics-model.ts`：`orderAnalyticsModels`（纯函数排序：显式指定 → 最近成功 → 配置偏好 → 冷却殿后）+ `markAnalyticsModelUnavailable` / `markAnalyticsModelSuccess`（冷却 TTL=5min，成功即解除冷却）+ `listAnalyticsModelCandidates`。
- `model-fallback.ts`：`withModelFallback`（非致命错误自动换下一个候选；**取消/超时不换**，避免等待翻倍）+ `isModelUnavailableError`（按 HTTP 状态或网关提示判定「可用性类失败」才冷却）+ `reportModelFailure`（供各传输点登记）。
- `pipeline.ts llmText`：改为候选链调用；`schema-agent` / `sql-agent` / `turn-intent-llm` 的非 200 响应也登记冷却（下一个候选自动顶上）。
- 开关：`ANALYTICS_MODEL_FALLBACKS`（默认 6，上限 10）、`ANALYTICS_MODEL_COOLDOWN_MS`（默认 300000）。
- **实测自愈证据**：把首选钉死为已 402 的 `dsflash`，日志可见逐个换模型（`glm5turbo → nemotronultra → zenhy3 → …`），第 2 次 LLM 调用自愈到 NVIDIA 候选并拿到响应——不再是「一个模型 402 整链路静默降级」。

**质量失败也已接入（本轮补齐）**：模型 HTTP 200 但给不出可用 schema（`parseStructureResponse` 抛错）≠ 合法 clarify。schema-agent 三处解析点与 pipeline 兜底解析点统一走 `parseStructureOrReport` / 质量登记：解析失败 → `reportModelQualityFailure`（**短冷却 ≤60s**）→ 同请求内的下一次尝试（tool loop → pipeline 兜底）经 `pickAnalyticsModel` 自动换到未冷却候选；解析成功则 `markAnalyticsModelSuccess`（成功记忆 + 解除冷却）。

**实测**：把首选钉死为「HTTP 200 但结构解析必失败」的 `nvnemotronultra`——修复前该请求必 `clarify`；修复后 `status=ok`、rows=4、headline 正常产出（自愈到后续候选）。

**仍存在的缺口（挂账）**：候选链解决「可达性 + 输出可解析」，不解决「口径/语义质量」——弱模型可能给出可解析但语义欠佳的 schema，这仍靠 verify 闸门与 clarify 兜底；如需进一步收敛，可对 structure 阶段单独维护高质量白名单。

**2026-09-15 追记（schema-agent 探库兜底）**：`schema-agent.ts` 的 probe 兜底已从写死 overlay 表名改为「调用侧已解析表（`resolvedTable`）→ pack `overlayTableName`」，均缺失时诚实返回 `table_unresolved`；system JSON 示例 / 工具描述里的业务表名字面量同步清除（详见 09-13 设计 §8）。此修复不改变本节模型可用性结论。

---

## 附录 A. 顺带修正的两个小问题

| 位置 | 原状 | 现状态 |
|------|------|--------|
| `AnalyticsAgentPage.vue` `editInComposer` | 助手气泡「编辑」回填 `item.text`（= 时间回显），点了等于把「按 2026-09-14～2026-09-14」塞进输入框 | 改为 `item.userNl \|\| item.text`，回填原始问句 |
| `AnalyticsAgentPage.vue` `copyBody` | 只复制 `item.text`；正文隐藏纯回显后复制会得到一句时间范围 | 复制「可见答案」：headline + 正文（去掉纯回显）+ 解读 + 口径提示 |

## 附录 B. 既有问题（非本次改造引入）及其处置

- `apps/agent-server/src/analytics/pipeline.ts` `collectIssues` 的 `pack` 原为可选参数，而内部 `verifyGrainDay(nl, sql, pack)` 要求必填 → 工作区在途改动里一直有 TS 报错 `Argument of type 'AnalyticsPack | undefined'...`，且缺 `pack` 时会静默跳过 day-grain 硬门。
  - 该签名变更属在途改动（对 HEAD `4e68080` 的 diff 中已存在），**两处调用点（`pipeline.ts:2141`、`pipeline.ts:2393`）本来就都传了 `pack`**，因此只需把参数改为必填即修好。
  - **已于 v2.1 修复**（见 §9）：签名改为 `collectIssues(nl, sqls, allowedTables, dimColumns, timeField, skipNamedChannel, pack)`，不再有静默跳过分支。
