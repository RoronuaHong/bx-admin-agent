# 会话列表交互补齐方案：右键菜单 / 拖拽排序 / 重命名

> 版本：v4（2026-09-17，§3.4 排序语义定为**方案 A**；阶段 1-6 已实施并端到端验证，见 §8。
> v4 变更：按用户要求**移除会话项 `⋯` 按钮，只保留右键入口**，键盘/触屏的等价路径见 §3.1「入口决策」）
> 定位：**最佳实践调研 + 交互设计稿 + 实施追踪**。目标是把侧栏对话列表从「只有一个删除按钮」补齐到主流产品水准（对齐 ChatGPT / Claude / Cursor / Slack 的会话管理约定）。
> 相关：`docs/conversation-state-plan.md`（对话一等公民与后端持久化）、`apps/web/src/pages/ChatPage.vue`、`apps/agent-server/src/conversations.ts`、`apps/agent-server/src/app.ts`。

**当前状态**

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 右键菜单补全 + 边界翻转 + Esc/滚动关闭 + role/焦点（**只保留右键入口**） | ✅ 已完成 |
| 2 | 重命名内联编辑 + 后端整理动作不刷新 `updatedAt` | ✅ 已完成 |
| 3 | 删除撤销 Toast + 触屏入口 | ✅ 已完成 |
| 4 | 置顶（`pinnedAt` + 排序 + 菜单项 + 置顶区分隔） | ✅ 已完成 |
| 5 | 拖拽排序（方案 A：拖拽即固化）+ `reorder` 接口 + `convSortMode` | ✅ 已完成 |
| 6 | 会话项键盘可达（`role=button` + ↑/↓ 焦点 + `Alt+↑/↓` 调序 + F2） | ✅ 已完成 |
| 7 | P2 留档项（归档 / 复制对话 / 导出 / 分享） | 🟡 部分（2026-09-17：归档 ✓ / 复制 ✓ / 导出 MD+JSON ✓ / 免打扰 ✓；分享链接待登录体系） |


---

## 1. 现状审计（代码级）

侧栏对话列表当前实现（`ChatPage.vue`）：

| 能力 | 现状 | 位置 |
|---|---|---|
| 右键菜单 | **只有 1 项**「关闭其它对话」 | `ctxMenu` 状态 + `openCtxMenu/closeCtxMenu`（L257-263 / L518-527），Teleport 模板 L1307-1318 |
| 删除 | hover 显示 `×`，**直接删除**，无确认无撤销 | `.conv-del` L1249-1256 → `removeConversation` |
| 重命名 | **无 UI**（后端 PATCH 已支持 `title`） | — |
| 置顶 | **无** | — |
| 拖拽排序 | **无** | — |
| 菜单关闭时机 | 仅靠 `.chat @click="closeCtxMenu"` | 模板 L1199 |
| 菜单键盘 | 无 role、无 Esc、无方向键、无焦点管理 | — |
| 菜单边界 | 直接 `clientX/clientY` 定位，**靠近右/下边缘会被裁切** | L1311 |
| 会话项键盘可达 | `div` + `@click`，**Tab 不可达、无 Enter/Space** | L1226-1233 |
| 触屏 | `×` 默认 `opacity: .45`（**常显**，触屏可用），但除 `×` 外没有任何入口 | `.conv-del` 样式 |

**结论**：右键菜单只是个占位实现；重命名、置顶、拖拽全部缺失；a11y 与触屏可用性为 0。

---

## 2. 网上最佳实践调研

### 2.1 主流产品的会话菜单长什么样

| 产品 | 入口 | 菜单项 |
|---|---|---|
| ChatGPT | 项内 `⋯` / 右键 | Rename、Delete、Pin、Archive、Share |
| Claude | 项内 `⋯` | Rename、Delete、（Star / Projects） |
| Cursor（Chat History） | 右键 / `⋯` | Rename、Delete；2.6 版本曾因这两项缺失造成大量用户投诉 → **重命名与删除是用户预期底线** |
| 腾讯云 Chat UI Kit（`ConversationActions`） | 项内操作区 | 默认「删除 / 置顶·取消置顶 / 免打扰·取消免打扰」，且支持自定义扩展 |
| Slack / Teams | `⋯` | 置顶、静音、标记已读、（不提供拖拽） |
| Notion / VS Code 文件树 | 右键 + 拖拽 | 重命名(F2)、删除、复制链接、**拖拽排序**（分层结构特有） |

**关键结论**：

1. **重命名 + 删除是会话管理的必备项**（Cursor 的教训说明缺了会被视为缺陷）。
2. **置顶（Pin）是次必备**，且是「整理型」需求的主流解法。
3. **自由拖拽排序在聊天类产品里其实很少见**（ChatGPT/Claude/Cursor/Slack 都不支持），它是 Notion / 文件树模式。既然本项目明确要拖拽，就要处理好它与「按最近活动自动排序」的语义冲突（见 §3.4）。
4. **Chat UI Kit 的做法值得抄**：菜单项是「动作集合 + 可扩展」，而不是硬编码几项。

### 2.2 右键菜单最佳实践（通用）

- **通常要有一个等价的非右键入口**（项内 `⋯`）：照顾触屏与"不知道能右键"的用户。
  - ⚠️ **本项目最终决定不做**（用户明确要求"右键就行"）。代价与兜底见 §3.1「入口决策」——键盘用 `Shift+F10` / 菜单键，触屏用长按（浏览器长按即触发 `contextmenu`）。
- **分组 + 危险项置底**：常用整理动作（重命名/置顶）→ 复制导出 → 分隔线 → 危险动作（删除/关闭其它）最后且用 danger 色。危险项不与常用项紧邻，降低误点。
- **控制在 8 项以内**，超出用子菜单。
- **边界翻转**：菜单超出视口右/下边缘时向左/上偏移（flip），不裁切。
- **关闭时机全覆盖**：Esc、点击空白、列表滚动、窗口 resize、再次右键别处、触发任一动作后。
- **键盘规范（WAI-ARIA menu pattern）**：`role="menu"` + `role="menuitem"`；打开时焦点进入第一项；↑/↓ 循环、Home/End、Enter 执行、Esc 关闭并把焦点**归还触发元素**。
- **焦点归还**：关闭后焦点回到被右键的那一项，键盘用户不迷路。

### 2.3 拖拽排序最佳实践

- **拖动阈值**：位移 > 4px 才进入拖拽，否则视为点击 → 避免误拖导致选错对话。
- **视觉反馈**：拖动项半透明 + 抬起阴影；落点显示插入指示线（或留出占位空槽）；`cursor: grabbing`。
- **自动滚动**：拖到列表上/下边缘时列表自动滚动（长列表必备）。
- **提交时机**：`drop` 时一次性提交，不是每次 `dragover` 都写库；失败回滚到原顺序 + 提示。
- **键盘替代路径（a11y 硬要求）**：拖拽对键盘/读屏用户不可用，必须提供等价操作 —— `Alt+↑/↓` 移动次序，或至少「置顶」菜单项。
- **互斥**：拖拽中禁用 `contextmenu`；重命名编辑中禁止拖拽；拖拽中禁用点击选中。
- **实现选型**：生态主流是 SortableJS / `vuedraggable`(Vue3) / Motion for Vue 的 `Reorder`。但本项目前端依赖极简（仅 vue / vue-router / dompurify / markdown-it），**首选原生 HTML5 DnD（零依赖）**；后续若要更细的触屏与动画支持再评估引入 SortableJS（单一职责、体积小）。触屏需注意：HTML5 DnD 在移动端支持差，触屏走 `pointerdown/pointermove` 自实现或直接以「置顶」替代（见 §3.5）。

### 2.4 内联重命名最佳实践

- **触发方式**：右键菜单「重命名」+ 快捷键 `F2`（VS Code / Notion 约定）；慢双击（第二次点击间隔 < 500ms 且未移动）作为可选增强。
- **就地编辑**：把标题 `<span>` 换成 `<input>`，**自动聚焦并全选**（便于直接覆盖，这是 ChatGPT/Notion 的行为）。
- **提交/取消**：`Enter` 提交、`Esc` 取消恢复原值、`blur` 提交（用户点了别处通常意味「改完了」；比 blur 取消更少丢失编辑）。
- **输入法（重要）**：中文输入法组合态下按 `Enter` 是「选词」而非「提交」，必须检查 `event.isComposing` / `keyCode === 229`，否则中文用户重命名会被截断。
- **校验**：`trim()`；空值 → 回退原值（不提交）；长度上限（建议 100 字符）超出截断并提示。
- **乐观更新**：本地先改（列表不闪烁）→ PATCH → 失败回滚 + 复用 `showSettingsError()` 提示。
- **a11y**：input 带 `aria-label`；编辑态用 `role="textbox"`；Esc 后焦点回到会话项。

### 2.5 删除最佳实践

- 现状（hover `×` 直接删）**误删风险高**。两个主流解法二选一：
  - **确认**：菜单项二次确认（对话框或菜单项内「确认删除？」二次点击）。
  - **撤销**：删除后 5s 内弹「已删除 · 撤销」Toast（Gmail / Notion 风格，体验更流畅，推荐）。
- 删除进行中的对话先 `abort` 该对话的流（现状 `removeConversation` 已做，保留）。

---

## 3. 交互设计（本项目落地口径）

### 3.1 右键菜单项清单

**P0 — 必备**

| 项 | 说明 | 依赖 |
|---|---|---|
| 重命名 | 内联编辑，实现见 §3.3 | 后端已有（PATCH `title`） |
| 置顶 / 取消置顶 | 置顶区固定在最上 | 后端需加 `pinnedAt`（§4） |
| 关闭其它对话 | 已有，保留 | — |
| 删除对话 | 移入菜单，danger 色 + 撤销 Toast | — |

**P1 — 推荐**

| 项 | 说明 |
|---|---|
| 清空当前对话 | 复用底部现有按钮能力，进菜单更顺手 |
| 复制对话标题 / ID | `navigator.clipboard`，便于反馈问题 |

**P2 — 可选（本期不做，留档）**

归档 / 取消归档 ✅、复制对话（Duplicate）✅、导出对话（MD/JSON）✅、免打扰 ✅（2026-09-17：静默该对话的「后台任务完成」提醒；多会话并行场景——切走的对话跑完原本会弹一次提示）、生成分享链接（⏸ 需权限模型 / 登录体系，未做）。

**菜单布局**（分隔线分组，危险项置底）：

```
┌──────────────────┐
│ 重命名        F2 │
│ 置顶             │
├──────────────────┤
│ 复制标题         │
│ 清空对话         │
│ 关闭其它对话     │
├──────────────────┤
│ 删除对话      🗑 │  ← danger 色
└──────────────────┘
```

**入口决策（已定）**：**只保留右键**，不加 `⋯` 按钮（用户明确要求"不需要这个，右键就行"）。代价由其他路径兜住：

| 用户类型 | 如何打开菜单 |
|---|---|
| 鼠标 | 右键会话项 |
| 键盘 | 会话项 `tabindex="0"` 可聚焦 → `Shift+F10` / 菜单键（浏览器会派发 `contextmenu`）；Chrome 会把菜单锚到该项中心 |
| 触屏 | 长按会话项（移动端浏览器长按即派发 `contextmenu`） |

实现注意：键盘触发的 `contextmenu` 在部分环境里 `clientX/clientY` 为 0，直接用会把菜单甩到屏幕左上角 —— `openCtxMenu` 里对此做了兜底（回落到该项的坐标）。

> 结论：右键"是唯一**鼠标**入口"，但不是唯一**操作**入口。删掉 `⋯` 后仍满足 §3.6 的无障碍要求。

### 3.2 菜单行为规范

- 定位：`openCtxMenu` 时做**边界翻转** —— 若 `x + menuWidth > innerWidth` 则 `x = e.clientX - menuWidth`；`y` 同理。菜单尺寸在打开后测量（`nextTick` + `getBoundingClientRect`）。
- 关闭：Esc（且焦点归还触发项）、点击空白、列表 `scroll`、`resize`、动作执行后。
- a11y：`role="menu"` / `role="menuitem"`；打开时焦点入首项；↑/↓/Home/End 导航；`aria-haspopup="menu"` 挂在会话项上。
- 菜单项支持 `disabled` 状态（如「取消置顶」在未置顶时不出现，而非置灰）。

### 3.3 重命名交互规范

```
用户操作                    系统行为
─────────────────────────────────────────────────────────
右键 → 重命名 / F2     →   标题变 input，自动聚焦 + 全选
Enter（非组合态）      →   trim 后 PATCH；成功保留，失败回滚 + 提示
Esc                    →   取消，恢复原值，焦点回会话项
blur                   →   等同 Enter 提交
空串 / 全空白          →   取消，恢复原值
超长                   →   截断到上限并提示
```

**踩过的坑（已修）**：`patchConversation()` 原先无条件写 `updatedAt = Date.now()`。在「按最近活动排序」下，**重命名会把该对话弹到列表最前**（取消置顶同理）—— 与用户预期不符。修法见 §4.2.1。

### 3.4 拖拽排序与排序语义（方案 A，已落地）

矛盾点：现在列表按 `updatedAt desc` 自动排序（新消息上浮），而手动拖拽要求顺序稳定 —— 两者天然冲突（拖完一发消息就弹回去了，等于白拖）。

**方案 A ✅（已确认 2026-09-17）· 置顶区 + 普通区，拖拽即固化**

- 列表分两段：置顶区（Pin）在上，普通区在下，中间一条「置顶」分隔线（本期已实现）。
- 置顶区：手动顺序，支持拖拽调整。
- 普通区：**默认按最近活动（现状不变）**；用户**首次拖拽普通区**时，把「当前看到的顺序」固化为手动顺序，并记录设备偏好 `convSortMode = "manual"`（所见即所得，不会突然乱序）。
- `manual` 模式下：新对话插到普通区顶部；新消息不再上浮；菜单/设置里提供「恢复按最近活动排序」。
- 跨区拖拽：普通项拖入置顶区 = 置顶（反向 = 取消置顶）。

**方案 B · 全手动（Notion / VS Code 风格）**（未采用）

- 整列表永远手动顺序，新对话插顶部，新消息永不上浮。
- 简单、可预测，但失去「最近的对话自动在最上面」的便利。

**方案 C · 全自动（ChatGPT / Slack 风格）**（未采用）

- 普通区永不支持拖拽，只有「置顶」+ 置顶区内部拖拽。
- 与主流聊天产品一致，改动最小，但不满足「拖拽也要实现」的诉求。

> **已确认并落地**：走方案 A，阶段 5 已完成。实现口径：
> - 拖拽 / `Alt+↑/↓` 都以「**新可视顺序的全量 id 列表**」一次性提交（`POST /chat/conversations/reorder`），服务端按 `index × 1000` 写 `sortOrder`。全量提交让「固化」天然成立，也不存在「部分项没排过」的中间态。
> - 首次移动即把 `convSortMode` 切到 `manual`（并持久化到设备偏好）；菜单出现「恢复自动排序」出口，点它只切模式、**不清 `sortOrder`**（下次再拖会重新固化）。
> - 未拖动过的组保持默认序：置顶组按 `pinnedAt`（新的在上）、普通组按 `updatedAt`。所以「拖了普通组」不会冻结置顶组的排序。
> - `manual` 模式下新建对话显式排到普通区最前（否则它没有 `sortOrder` 会沉到底部）。

**拖拽交互细则**（实际实现）

- 拖拽阈值交给浏览器原生 HTML5 DnD（Chrome 约 5px 起拖），因此不会与「点击选中对话」冲突。
- 拖动中的项 `opacity: .5`；落点用 2px 插入指示线（**伪元素**，不用 `box-shadow` —— `.conv-item.active` 已占用它画左侧选中条）。
- 拖到列表上下边缘（距边 24px）→ 每次 `dragover` 滚动 12px。
- `drop` 时一次性提交；失败回滚 + 提示（并重新拉一次列表，防「置顶已生效但顺序没写成功」的分叉）。
- 跨区拖拽：拖进置顶区 = 置顶，拖出 = 取消置顶（与移动在同一次操作里完成）。
- 互斥：重命名编辑中 `draggable=false`（否则输入框没法选中文字）。
- 键盘等价路径：`Alt+↑/↓` 在组内上移/下移，移动后焦点跟着走。

### 3.5 触屏与响应式

- 会话项右侧只保留 `×`（`opacity: .45` 常显，触屏无 hover 也能用）；`⋯` 已按用户要求移除。
- 触屏打开菜单靠**长按**（浏览器长按即 `contextmenu`）；触屏不启用 HTML5 DnD（支持差）→ 用置顶 / `Alt+↑↓` 替代。
- 菜单最小点击区 ≥ 40px。

### 3.6 无障碍清单

- 会话项：`role="button" tabindex="0"` + `aria-current`，Enter/Space 选中，↑/↓ 移动焦点，`Alt+↑/↓` 调序，F2 重命名。
  - **不能真的换成 `<button>`**：重命名时会内嵌 `<input>`，而 `button` 不允许包含交互式内容。
- 菜单：`role="menu"` + `menuitem` + 焦点管理 + Esc 归还焦点。
- 重命名 input：`aria-label="重命名对话"`。
- 内层 `×` 的 Enter/Space 不冒泡到会话项（否则会「既删除又切对话」）。
- 焦点可见：统一用 `:focus-visible` 焦点环（`.conv-item:focus-visible` 与 `.conv-del:focus-visible`）。

---

## 4. 数据与接口改动

### 4.1 数据模型

`ConversationDoc`（`apps/agent-server/src/conversations.ts`）新增：

| 字段 | 类型 | 语义 |
|---|---|---|
| `pinnedAt` | `number \| null` | 置顶时间戳；`null`/缺省 = 未置顶。用于置顶区排序（最新的置顶在上） |
| `sortOrder` | `number` | 手动顺序（`manual` 模式下生效）。按可视顺序下标 × `ORDER_STEP` 分配 |

### 4.2 接口

| 改动 | 说明 | 状态 |
|---|---|---|
| `PATCH /chat/conversations/:id` | body 扩展 `pinnedAt`（`null` = 取消置顶） | ✅ |
| 整理动作不刷新 `updatedAt` | 见下方「活动中性字段」 | ✅ |
| `POST /chat/conversations/reorder` | body `{ ids: string[] }`，服务端按下标写 `sortOrder = index × ORDER_STEP`（1000）。**一次请求原子提交**，避免 N 次 PATCH 的竞态与中间态；同样不碰 `updatedAt` | ✅ |
| `listConversations()` | 排序改为「置顶优先 → `sortOrder` → 默认序」 | ✅ |
| `dedupeDocs()` | 排序函数同步（原先硬编码 `updatedAt desc`） | ✅ |
| 设备偏好 `ChatPreferences` | 新增 `convSortMode: "recent" \| "manual"`（服务端 `SessionPreferences` 同名） | ✅ |

> 排序的**最终裁决在前端**（`convRank`）：服务端不知道本设备的排序模式，它只提供一份稳定默认序；前端按 `convSortMode` 复算（`recent` 模式忽略 `sortOrder`）。

### 4.2.1 活动中性字段（重要语义）

`title`（重命名）与 `pinnedAt`（置顶）都只改变「列表怎么组织」，**不代表对话有新活动**。若它们刷新 `updatedAt`，在「按最近活动排序」下会把该对话弹到列表最前 —— 用户改个名字、取消个置顶就发现它跳走了，与预期不符。

实现：`conversations.ts` 的 `ACTIVITY_NEUTRAL_KEYS = new Set(["title", "pinnedAt"])`，只有当本次 patch 触碰了集合外的字段时才写 `updatedAt`。**排序只应由真实活动（新消息 `upsertMessages` / `appendContext`）驱动。**

`reorderConversations()` 同理**完全不写 `updatedAt`**（它只写 `sortOrder`）。

### 4.3 前端类型

`apps/web/src/api.ts`：`ConversationDto` 加 `pinnedAt?` / `sortOrder?`；`patchConversation` 的 patch 类型加 `pinnedAt`；新增 `reorderConversations(ids)`；`ChatPreferences` 加 `convSortMode` 并导出 `ConvSortMode` 类型。

---

## 5. 实施计划

| 阶段 | 内容 | 前后端 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | 右键菜单补全（重命名 / 置顶 / 清空 / 关闭其它 / 删除）+ 边界翻转 + Esc/滚动关闭 + `role`/焦点 | 前端为主 | P0 | ✅ |
| 2 | 重命名内联编辑（自动聚焦全选 / Enter / Esc / blur / `isComposing` / 校验 / 乐观更新）+ 后端整理动作不 touch `updatedAt` | 前后端 | P0 | ✅ |
| 3 | 删除撤销 Toast + 触屏入口 | 前端 | P0 | ✅ |
| 4 | 置顶（`pinnedAt` 字段 + 排序 + 菜单项 + 置顶区视觉分隔） | 前后端 | P0 | ✅ |
| 5 | 拖拽排序（原生 HTML5 DnD + `reorder` 接口 + `convSortMode` 偏好 + 键盘 `Alt+↑/↓`） | 前后端 | P1 | ✅ |
| 6 | 会话项键盘可达（`role=button` + ↑/↓ 焦点移动 + F2） | 前端 | P1 | ✅ |
| 7 | P2 留档项（归档 / 复制对话 / 导出 / 分享） | — | P2 | 🟡 部分（免打扰已落地：字段 `muted` + 菜单开关 + 列表标识 + 后台完成提醒静默；分享链接仍需权限模型/登录体系） |

---

## 6. 验收清单

P0 项均已浏览器实测（见 §9）：

- [x] 右键任一对话：菜单弹出，含重命名/置顶/清空/关闭其它/删除，危险项置底且 danger 色
- [x] 菜单边界翻转（靠近右/下边缘时向左/上偏移，不被裁切）
- [x] Esc / 点击空白 / 滚动列表 / 窗口 resize 均能关闭菜单
- [x] 菜单 `role="menu"` + `menuitem`；打开即焦点入首项；↑/↓ 循环、Home/End、Tab 关闭
- [x] Esc 关闭后焦点**归还触发元素**（会话项 `tabindex="0"` 可聚焦，右键与键盘路径均生效）
- [x] 重命名：自动聚焦全选（实测 `selStart 0 / selEnd 8`）；Enter 提交、Esc 取消、blur 提交；`isComposing` 防中文输入法选词误提交；空值回退
- [x] 重命名后**列表顺序不变**（不弹到最前）
- [x] 删除后 5s 内可撤销，且撤销**放回原位置**
- [x] 撤销窗口到期后服务端真正删除（前端计数 5 → 删除 → 仍为 5，即净删除 1 条）
- [x] 置顶项固定在最上 + 「置顶」分隔线；取消置顶回到普通区且位置不乱跳
- [x] 刷新后标题与置顶状态保持（后端 `pinnedAt` / `title` 为真相）
- [x] 触屏：`×` 常显（`opacity: .45`），无 hover 依赖；菜单靠长按触发
- [x] 中英文界面文案齐全（`tx(zh, en)`），`pnpm build` 通过、lint 干净
- [x] 置顶 / 取消置顶不刷新 `updatedAt`（对话不会因整理动作跳到最近区顶部）
- [x] F2 触发重命名（会话项聚焦时、菜单打开时都生效）
- [x] 键盘：Tab 可达会话项、Enter/Space 选中、↑/↓ 移动焦点、焦点环可见
- [x] 拖拽：拖动项半透明、落点 2px 插入指示线、边缘自动滚动、drop 一次性提交、失败回滚
- [x] 拖拽与点击/重命名互斥（重命名编辑中 `draggable=false`；原生 DnD 天然抑制"拖后误点击"）
- [x] 跨区拖拽 = 置顶 / 取消置顶
- [x] `Alt+↑/↓` 在组内移动次序，且移动后焦点跟随被移动项
- [x] 首次拖拽自动切「手动排序」并持久化；菜单出现「恢复自动排序」出口（自动模式下该项消失）
- [x] 手动模式下新建对话排到普通区最前

---

## 7. 风险与回滚

| 风险 | 应对 |
|---|---|
| 排序语义冲突（拖拽 vs 最近活动）导致用户困惑 | ✅ 已落地方案 A「拖拽即固化」；「恢复自动排序」出口已验证 |
| ~~重命名触发 `updatedAt` 导致顺序跳动~~ | ✅ 已解决：`ACTIVITY_NEUTRAL_KEYS`（`title` / `pinnedAt` 不刷新 `updatedAt`，见 §4.2.1） |
| 延迟删除 + 硬刷新会「复活」对话（5s 撤销窗口内直接刷新/关页，删除尚未发出） | 已知取舍：SPA 内卸载会 flush；硬刷新窗口内会复活。后续可用 `navigator.sendBeacon` 补 |
| ~~右键非可聚焦元素时 Esc 无法把焦点还回去~~ | ✅ 已解决：会话项 `role="button" + tabindex="0"`（阶段 6） |
| 原生 HTML5 DnD 触屏支持差 | 触屏不启用拖拽，以置顶 / `Alt+↑↓` 替代；后续评估 SortableJS |
| `reorder` 批量接口竞态 | ✅ 单请求原子提交 + drop 时才发；服务端按下标覆盖 |
| 「置顶已生效但 reorder 失败」造成前后端顺序分叉 | ✅ 失败路径重新 `fetchConversations()` 以服务端为准，而非盲目回滚本地 |
| 多客户端共用同一份会话列表 | 排序模式是**设备级**偏好而列表是全局的：A 设备拖拽固化后，B 设备（recent 模式）依然按最近活动显示。属预期行为，已在 §4.2 说明 |

---

## 8. 实施与验证记录（阶段 1-6，2026-09-17）

### 8.1 改动文件

| 文件 | 改动 |
|---|---|
| `apps/agent-server/src/conversations.ts` | `ConversationDoc.pinnedAt` / `sortOrder`；`conversationRank`（置顶优先 → `sortOrder` → 默认序）替换 `dedupeDocs` 里硬编码的 `updatedAt desc`；`ConversationPatch.pinnedAt`；`ACTIVITY_NEUTRAL_KEYS` 语义；新增 `reorderConversations()` + `ORDER_STEP` |
| `apps/agent-server/src/app.ts` | `PATCH /chat/conversations/:id` body 支持 `pinnedAt`；新增 `POST /chat/conversations/reorder`；`/chat/preferences` 读写 `convSortMode` |
| `apps/agent-server/src/session.ts` | `SessionPreferences.convSortMode` + 导出 `ConvSortMode` |
| `apps/web/src/api.ts` | `ConversationDto.pinnedAt` / `sortOrder`、`patchConversation` patch 类型、`reorderConversations()`、`ChatPreferences.convSortMode` |
| `apps/web/src/pages/ChatPage.vue` | 菜单/重命名/置顶/删除撤销/拖拽/键盘可达/排序模式的全部逻辑与样式 |

### 8.2 关键实现点

- **菜单定位**：`openCtxMenu` 渲染后（`nextTick` + `getBoundingClientRect`）按菜单实际尺寸做边界翻转，再把焦点移入首个 `menuitem`。
- **关闭时机**：`.chat @click` + window `keydown`(Esc) + window `scroll`（**捕获阶段**，因为 `scroll` 不冒泡）+ window `resize`，`onBeforeUnmount` 全部摘除。
  - ⚠️ 模板里必须写 `@click="closeCtxMenu()"` 而不是 `@click="closeCtxMenu"` —— 后者会把 `MouseEvent` 当作 `restoreFocus` 传进去，导致每次外部点击都强行夺回焦点。
- **删除撤销**：本地立即消失 + 服务端**延迟落库**；窗口到期 / 新删除到来 / 组件卸载时 `flushPendingDelete()` 落实。撤销放回**原索引**。
- **重命名**：`renaming` 状态 + v-if 换成 input；`setRenameInput` 用**函数式 ref**（在 `v-for` 内部用字符串 ref 会被 Vue 收集成数组，拿不到单个元素）。
- **置顶排序**：前端 `convRank` 与服务端 `conversationRank` 必须保持一致；乐观更新后本地 `resortConversations()` 立即重排。

### 8.3 实测记录（Chrome DevTools MCP，localhost:5173 真实登录态）

| 用例 | 结果 |
|---|---|
| 右键会话项 | 菜单弹出，5 项齐全；定位 = 点击坐标（120, 260） |
| `Shift+F10`（键盘右键） | 会话项聚焦后按 `Shift+F10` → 菜单打开、焦点自动落到首个 `menuitem`；Chrome 把菜单锚在**该会话项中心**（实测 `item(14,152~190)` → `menu(127,171)`），不是屏幕角落 |
| ↑/↓ 导航 | 焦点依次走到「取消置顶」→「清空对话」 |
| Esc 关闭 | 菜单消失 + 焦点回到**被右键的会话项**（该项 `tabindex="0"` 可聚焦） |
| 移除 `⋯` 后 | `document.querySelectorAll('.conv-op').length === 0`，每项只剩 `×`；右键菜单 5 项不变 |
| 置顶 | 目标项跳到列表最上并加粗，出现「置顶」分隔线（DOM：`PIN 日活表` → `[DIVIDER] 置顶` → 其余） |
| 置顶项菜单文案 | 变为「取消置顶」 |
| 取消置顶 | 分隔线消失、回到普通区，且**位置不乱跳**（`updatedAt` 未变） |
| 重命名 | 输入框出现、聚焦、`selectionStart 0 / selectionEnd 8`（全选）；Enter 提交后标题更新且**顺序不变** |
| 删除 → 撤销 | `before [日活表,新对话,smoke,重命名测试标题]` → 删除后 `[日活表,新对话,smoke]` → 撤销后**回到原末位** |
| 撤销窗口到期 | Toast 自动消失，服务端计数 5 →（新建 1 + 删除 1）→ 5，净删除 1 条 ✅ |
| 持久化 | 刷新后 `serverOrder` 与 `renderedRows` 完全一致，`pinnedAt` 落库（`1789628831376`） |
| `updatedAt` 语义 | PATCH `pinnedAt` 后再取消，`updatedAt` 三次读值完全一致 |

### 8.4 阶段 5-6 实测记录（拖拽 / 键盘 / 排序模式）

| 用例 | 结果 |
|---|---|
| 拖拽落点指示线 | 拖动中源项加 `.dragging`（`opacity .5`）；悬停在目标下半区时 `.drop-after` 出现（计数 1） |
| 拖拽落位 | `[A,B]` 拖 A 到 B 下 → `[B,A]`；`dragend` 后拖拽态清干净（无 `.dragging` / 无指示线） |
| 排序模式自动切换 | 拖拽后 `GET /chat/preferences` 返回 `convSortMode: "manual"` |
| 顺序落库 | `POST /chat/conversations/reorder` 后服务端 `sortOrder` = `0 / 1000 / 2000`（按可视顺序） |
| 跨区拖拽 | 把普通项拖到置顶项上 → 两项都变 `pin=y`，置顶区展开、分隔线出现 |
| `Alt+↑` | `[A,B]` 光标在 B 上按 `Alt+↑` → `[B,A]`，**焦点仍停留在 B**（元素被移动而非重建） |
| `Alt+↓` 在末位 | 正确 no-op（组内已无可换位对象） |
| ↑/↓ 移动焦点 | 首项聚焦后按 `ArrowDown` → 焦点到第二项 |
| 菜单出口 | `manual` 模式菜单 6 项（含「恢复自动排序」）；点击后偏好回到 `recent`，该菜单项消失（回到 5 项） |
| 手动模式新建对话 | 新对话服务端下标 = `0`（排到普通区最前），而不是因为没有 `sortOrder` 沉到底部 |
| 构建 / lint | `pnpm build` 通过、lint 干净 |

> 测试期间发现**另一个客户端在并发操作同一个服务端**（日志里出现非本页签的 `POST /chat/stream` + `POST /chat/conversations`，会话名形如 `smoke-p1b`），会创建/删除会话。上面的顺序类断言都在同一次脚本内完成，不受其影响；测试结束后已把排序模式还原为 `recent`、取消测试期间产生的置顶。**若发现会话"自己少了"，先查是否有并行会话/脚本在收尾清理，不要先怀疑本功能。**

### 8.5 过程中的坑

1. **`var(--surface)` 是不存在的变量 → 菜单全透明（既有 bug）**：设计 token 在 `styles.css` 的 `:root` 里叫 `--panel`，**没有 `--surface`**。`background: var(--surface)` 在计算值阶段失效 → 背景回落成透明，菜单像"悬浮文字"一样透出背后的侧栏内容。原先「只有一个菜单项」所以一直没人注意。已把 3 处（菜单 / 撤销条 / 重命名输入框）全部改成 `--panel`。
   - 教训：Teleport 到 `body` 的元素一旦用了不存在的变量，**构建与 lint 都不会报错**，只有肉眼看渲染或读 `getComputedStyle` 才能发现。
2. **Vue HMR 崩溃**：模板结构大改（`v-for` 里加 `<template>` 包裹 + 条件分支）后热更新报 `Cannot read properties of null (reading 'flags')` + `[HMR] Something went wrong during Vue component hot-reload`，页面白屏。**必须整页刷新**，不要误判成代码 bug（`pnpm build` 与 lint 都是干净的）。
3. **重复函数定义**：`openCtxMenu`/`closeCtxMenu` 改写时新旧两份同时存在（后者覆盖前者），靠 grep 函数名才发现。改完务必核对同文件是否出现同名函数。
4. **撤销窗口对自动化太短**：5s 窗口下，人工点「撤销」够用，但自动化工具往返 >5s 会拿不到 Toast，需在**同一个脚本里**连续执行「删除 → 点撤销」。
5. **置顶/取消置顶最初会刷新 `updatedAt`**：导致取消置顶后对话跳到最近区最前（与重命名同一类问题）。已用 `ACTIVITY_NEUTRAL_KEYS` 统一收敛。
6. **`@click="closeCtxMenu"` 的隐式传参**：`closeCtxMenu(restoreFocus = false)` 加上参数后，模板里不写括号就会把 `MouseEvent` 传进去（truthy）→ 每次点击外部都强行抢焦。必须写 `@click="closeCtxMenu()"`。
7. **内层按钮的 Enter 会冒泡到会话项**：会话项加了 `@keydown` 后，焦点在 `⋯`/`×` 上按 Enter 会**既开菜单又切换对话**（button 的 Enter 触发 click，keydown 继续冒泡）。需在会话项处理器里判断 `e.target.closest("button, input, textarea")` 后跳过 Enter/Space（↑/↓ 与 F2 仍放行）。
8. **落点指示线不能用 `box-shadow`**：`.conv-item.active` 用 `box-shadow: inset 2px 0 0 var(--ink)` 画左侧选中条，指示线若也用 `box-shadow` 会把选中条盖掉。改用 `::before`/`::after` 伪元素（配合 `position: relative`）。
9. **会话项不能真的换成 `<button>`**：重命名时项内会渲染 `<input>`，而 HTML 规定 `button` 不能包含交互式内容（浏览器会把 input 撕出去）。因此用 `role="button" + tabindex="0"` 而不是原生 button。
10. **`Alt+↑/↓` 调序后要保住焦点**：Vue 是 keyed diff，元素会被**移动**而非重建，焦点通常能保留；但为了稳妥仍在 `nextTick` 后按 `data-conv-id` 重新 `focus()`。

### 8.6 归档开关修复（2026-09-18）

**问题**：勾选「显示归档」后归档对话被直接混进普通列表 —— 没有分区标题、没有视觉区分（和普通项长得一模一样，看不出开关到底有没有生效），还会插进「置顶」分隔线的索引判断里（`i === pinnedCount` 只按置顶数量算，归档项一旦置顶就错位）；`convRank` 也完全没考虑 `archived`，归档项按 `updatedAt` 混在中间。开关本身还不持久化，刷新即失效。

**修复**：

| 点 | 改动 |
|---|---|
| 分区 | 归档区固定在列表最末（`convRank` 先比 `archived`），区前插入「归档」分隔线（复用 `.conv-divider`）；归档项加 `.conv-archived`（`opacity .72` + 标题斜体），选中时恢复不透明 |
| 计数组 | `pinnedCount` 排除归档项（归档自成一组，不进置顶组），新增 `archivedCount` / `firstArchivedIndex` 供分隔线使用 |
| 不参与排序 | 归档项 `draggable=false`，`onConvDragStart/Over/Drop` 与 `Alt+↑/↓` 均跳过归档项（归档与否由菜单决定，不靠拖拽误触） |
| 持久化 | 开关写进设备偏好（`SessionPreferences.showArchived` + `PUT /chat/preferences` + `ChatPreferences.showArchived`），刷新 / 换设备都保持；启动先读偏好再拉列表 |
| 归档当前对话 | 它已从列表收起时自动切到仍可见的那条，避免侧栏没有任何选中项 |
| 批量关闭 | 「关闭其它对话」跳过归档项 —— 归档本是「收起来」，批量关闭不该连带删掉看不见的对话 |
| 顺带修 | `reloadConversations` 拉取失败不再把列表清空（原来 `.catch(() => [])` 会清空，看起来像对话全丢了）；切开关时保住撤销窗口里那笔待删对话（服务端要等窗口结束才真删，直接覆盖会让它闪回来）；`api.ts` 的 `patchConversation` 补上缺失的 `archived` / `muted` 类型（此前归档、免打扰两处一直是类型错误） |

**实测**（Chrome DevTools MCP，真实登录态）：

| 用例 | 结果 |
|---|---|
| 勾选显示归档 | 请求带 `includeArchived=1`；归档项落在末尾，其前有「归档」分隔线，类名含 `conv-archived`、`draggable="false"` |
| 持久化 | 刷新后复选框仍勾选、归档项直接可见；`GET /chat/preferences` 返回 `showArchived: true` |
| 取消归档 | 菜单项变「取消归档」→ 点击后回到普通区，分隔线消失 |
| 排序 | 造 3 条临时对话（中间那条归档）：可视顺序 = 普通①、普通②、原对话、原对话、「归档」分隔线、**归档项（始终最末）** |
| 清理 | 临时对话已删除，偏好恢复 `showArchived: false` |

> 又一次踩到 §8.5-2 的 HMR 崩溃（改模板 + 改样式后白屏，控制台 `Theme is not provided` + `Full reload required`）：硬刷新（忽略缓存）即恢复，不是代码问题。

---

## 9. 参考来源

- 腾讯云 Chat UI Kit · 自定义会话操作（`ConversationActions` 默认支持删除 / 置顶 / 免打扰）：<https://trtc.io/zh/document/64707>
- Cursor 2.6 Chat History 右键重命名/删除缺失引发的用户投诉（佐证这两项是底线需求）：dredyson.com 系列文章
- Claude Cookbook · Building a session browser（会话列表的 list/rename/tag/fork 实践）：<https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser>
- ChatGPT 会话管理（Rename / Delete / Share / Archive）：<https://mrnoob.net/manage-your-conversations-inside-chatgpt/>
- Vue 拖拽排序生态（SortableJS / vuedraggable / Motion for Vue Reorder）：<https://motion.dev/docs/vue-reorder>、CSDN 相关教程
- 内联编辑最佳实践（优缺点与替代方案）：<https://www.uisdc.com/best-practices-inline-editing>
- WAI-ARIA Authoring Practices · Menu pattern（`role="menu"` 键盘规范）
