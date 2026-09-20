# 前端搜索与拼音匹配规范

> 版本：v1（2026-09-20）
> 定位：**行为约定 + 实现约束 + 待办清单**。统一「工具飞出面板（技能 / 连接器 / 专家）」与「模型下拉」的搜索行为，避免各处各写一套匹配逻辑。
> 相关：`apps/web/src/pinyin.ts`、`apps/web/src/components/ToolsSearch.vue`、`apps/web/src/components/ModelSelect.vue`、`apps/web/src/pages/ChatPage.vue`。

**当前状态**

| 项 | 内容 | 状态 |
|---|---|---|
| 1 | 拼音匹配统一到 `pinyin-pro`（`match()`） | ✅ 已完成 |
| 2 | 三个飞出面板搜索框抽为 `ToolsSearch` 组件（+ 清空按钮） | ✅ 已完成 |
| 3 | 打开面板重置关键词 + 聚焦策略（点击聚焦 / 悬停不聚焦） | ✅ 已完成 |
| 4 | 短/长字段分档（修「输入任意字母都命中全部」） | ✅ 已完成 |
| 5 | 空态 / 底部说明的 class 语义归一（`empty-hint` / `flyout-hint`） | ✅ 已完成 |
| 6 | `pinyin-pro` 按需加载（从主 chunk 拆出） | ✅ 已完成（见 §5.1） |
| 7 | `ExpertSelect.vue` 死代码处置 | 🟡 待定，见 §5.2 |

---

## 1. 搜索点清单

| 位置 | 关键词状态 | 短字段（单字符也匹配） | 长字段（≥2 字符才匹配） |
|---|---|---|---|
| 技能飞出 | `skillQuery` | `name` | `dir`、`description` |
| 连接器飞出 | `mcpQuery` | `label` | `id` |
| 专家飞出 | `expertQuery` | 当前界面语言的 `label` | `id`、四语 `label` / `description` |
| 模型下拉 `ModelSelect` | `query` | `label`、`id`（无长字段，直接用 `matchesFuzzy`） | — |

「短 / 长字段」的划分是**用户体验约束**，不是性能优化，理由见 §2.3。

---

## 2. 匹配规则

### 2.1 用什么

`pinyin-pro@3.29.2`（仓库已装，声明在 `apps/web/package.json`）的 `match(text, pinyin, options)`。

- 自带多音字与词组词典，首字母 / 全拼 / 缩写都支持：`jn`、`jineng` 都能命中「技能」；
- 非中文（id、英文标签）走原文子串匹配，与拼音结果**取或**；
- 不自建汉字→拼音表。曾用 `Intl.Collator('zh-Hans-CN')` 的排序位置反推声母，准确率与覆盖率都不如现成词典，已废弃。

### 2.2 精度选项：`precision: "start"`（默认），不要用 `"any"`

实测 `precision: "any"` 会把「添加文件」判为命中 `jn`（取「文**j**ian」里的 j…n），噪声不可接受。默认的 `start` 已支持从中间字起匹配（`lb` → 用户列表），够用。

### 2.3 单字符只看短字段（分档匹配）

一个字母几乎必然出现在长描述或它的拼音串里（「标准解答话术」→ `biaozhun jied**a**`），若长文本参与匹配，**输入任意字母都会命中全部条目**，搜索等于失效。故：

```ts
matchesFuzzyScoped(short, long, q)  // q.length < 2 时只用 short
```

反例（修复前的真实 bug）：专家面板输入 `a` 命中「客服助手」，因为英文 label `Support assistant` 与描述拼音都含 `a`。修复后 `a` 不命中，`kf` / `kfzs` / `kefu` / `客服` / `support` 仍命中。

注：中文界面下单字符只匹配**当前界面语言**的名称，非当前语言文案不参与——否则英文文案的字母会制造同样的噪声。

---

## 3. 面板交互约定

四个搜索点必须一致：

| 行为 | 约定 | 原因 |
|---|---|---|
| 打开时 | 清空关键词 | 残留关键词会让列表看着「少了几项」 |
| 聚焦 | 点击打开 = 聚焦；**悬停打开 = 不聚焦** | 悬停展开是浏览行为，聚焦会把焦点从消息输入框抢走 |
| 清空 | 有内容时显示 `×` | 与模型下拉一致 |
| 空态 | 显示「没有匹配的 XX」 | 空列表必须有解释 |
| Esc / 外部点击 | 收起面板 | 键盘可达 |

实现要点：`toggleSkillPanel(focusSearch = true)` / `toggleMcpPanel(...)` / `toggleExpertPanel(...)`，`hoverFlyout` 一律传 `false`；`@click` 必须写成 `toggleXPanel()`，否则 MouseEvent 会被当成 `focusSearch` 实参。

---

## 4. 组件与样式归属

- 搜索框只有一个实现：`components/ToolsSearch.vue`（图标 + input + 清空按钮 + 可选聚焦）。
- **样式随组件走**。`ChatPage.vue` 是 `<style scoped>`，`.tools-flyout__search input` 这类后代选择器**打不到子组件内部元素**（scoped 只给子组件根元素加父 scope id），所以搜索框样式写在 `ToolsSearch.vue` 内，ChatPage 里不留副本。
- 命名用中性语义，避免「一个类被别的面板复用」造成语义错位：
  - 空态 `.empty-hint`（原名 `.mcp-empty` 被技能 / 专家 / 记忆 / 工作区混用）；
  - 底部说明 `.flyout-hint`（原名 `.skill-hint` 被专家面板复用）。

---

## 5. 已知取舍与待办

### 5.1 `pinyin-pro` 体积（已实施）

字典较大，不在首屏加载，而是首次打开任何带搜索的面板时按需 `import('pinyin-pro')`（Vite 自动拆成独立 chunk）。

实现（`apps/web/src/pinyin.ts`）：

- 模块内 `let lib` 缓存字典，`loadPinyin()` 幂等触发动态 import，就绪后翻转 `export const pinyinReady`；
- `fieldMatches` 在 `lib` 为 null 时**降级为纯原文子串匹配**（不会误命中，只是暂时没有拼音能力）；
- 四个搜索点的 computed（`skillFiltered` / `mcpFiltered` / `expertFiltered` / `ModelSelect.groups`）都读取 `pinyinReady.value` 建立依赖，字典就绪后自动重算，启用拼音；
- 触发点：打开工具菜单（`toggleToolsMenu`，后台预拉）、三个飞出面板打开分支、模型下拉 `openPanel`。

效果：构建后主包从 ~431 kB 降到 ~312 kB，拼音字典（~246 kB，gzip ~70 kB）成为独立 chunk，仅在首次搜索时加载。

注意：`loadPinyin()` 的判定含 `typeof window === "undefined"` 守卫，SSR / 测试环境不会发起动态 import。

### 5.2 其它挂账（已全部处理）

- ✅ **死代码清理**：`components/ExpertSelect.vue` 经核实全仓无任何组件 import（仅 `useSelectPanel.ts` 注释提及），已删除；`useSelectPanel.ts` 注释同步修正为「仅 ModelSelect 使用」。
- ✅ **`PortalPage` 专家网格**：已加搜索框（首屏 Landing）。`expertsFiltered` 跨四语名称 + id + 描述匹配，单字母只命中名称；首次输入触发 `loadPinyin()`，空态四语提示。
- ✅ **侧栏会话列表**：已加搜索框。按会话标题过滤（`matchesFuzzy`），搜索态下隐藏「置顶/归档」分隔线、禁用拖拽，并给出四语空态；首次输入触发 `loadPinyin()`。
- ⚠️ **任务表单 MCP 多选面板**：经全仓核对（搜 `mcp|MCP` 仅命中 `ChatPage.vue`、`api.ts`），前端**不存在**该 UI，挂账移除，无需处理。
- 全拼支持由 `pinyin-pro` 天然提供，无需额外词表。

至此「四类选项搜索 + 门户专家 + 侧栏会话」已全部接入统一搜索（原文子串 + 拼音首字母/全拼/缩写，单字母只匹配短字段防误命中），且拼音字典按需懒加载。
