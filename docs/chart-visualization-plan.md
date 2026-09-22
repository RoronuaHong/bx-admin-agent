# 图表可视化接入方案（AntV）

> 版本：v3（2026-09-21，路线 3 已落地并端到端验证，见 §11）
> **状态：当前唯一出图路径是路线 3（内置工具 `render_chart` + 前端 AntV 本地渲染，零外链、数据不出本机）。**
> 路线 1（AntV 官方出图服务）**已下线**：`chart` 服务器已从 `MCP_BUILTIN_SERVERS` 移除，§5 的配置片段仅作历史记录，**不要再启用**。
> 自托管（路线 2）仍挂账，且已无必要（路线 3 不出网）。
> 相关：`docs/mcp-guide.md`（MCP 接入权威实现）、`docs/deep-agents-plan.md` §5 D5（代码执行沙箱）、`apps/agent-server/scripts/metabase-mcp.mjs`（现有 BI MCP）。

---

## 0. 一句话结论

**可行，已实测通过。** AntV 的 `@antv/mcp-server-chart` 提供 27 个出图工具（饼图/柱状图/雷达图/组织结构图/思维导图/网络图/桑基图…），能直接挂到我们现有的 MCP 通道上，**前端零改动**（`img` 白名单已允许）。默认走蚂蚁官方出图服务（数据出内网 + 图片落在公有 CDN），生产应切自托管 GPT-Vis-SSR。

**唯一的阻塞点是数据合规口径**，口径未定前不动手。

---

## 1. 现状核查（代码级，纠正已有说法）

| 能力 | 落点 | 判定 |
|---|---|---|
| 查数据 | `.env` 的 `MCP_BUILTIN_SERVERS` → `scripts/metabase-mcp.mjs`（`list_databases` / `get_database_schema` / **`get_field_values`** / `run_native_query` / `list_cards` / `list_dashboards` / `get_dashboard` / `get_card` / `search`） | ✅ 9 个工具 = **8 个只读** + `run_native_query`（执行任意 SQL），**没有**建卡工具。2026-09-19 新增取值域工具 `get_field_values`（写过滤/分组条件前先取证），`toolRisks` 已同步标 `read` |
| 存数据 | `src/fs-store.ts` + `fs_write/read/edit/ls`，对话级工作区 `.data/fs/<convId>/` | ✅ |
| **对话内显示图片** | `apps/web/src/chat-richtext.ts`：DOMPurify 白名单**已含 `img`**（`src/width/height`），URI 放行 `https` 与相对路径 | ✅ **不需要改前端** |
| 出图工具 | —— | ❌ 无 |
| 工作区静态路由 | `src/app.ts` 只有 `/chat/upload/:id` | ❌ 无（本地生成的图无法交给浏览器） |
| 图表事件契约 | `packages/shared/src/index.ts` 的 `ChatEvent` 无 chart 相关类型 | ❌ 无 |
| 前端图表库 | `apps/web/package.json` 只有 vue / markdown-it / dompurify | ❌ 无 |

> 上一轮曾考虑「服务端自研 SVG + 新增静态路由」——**该方案作废**：AntV 的方案白拿 27 种图 + 主题 + 自动布局，自己抽 SVG 属重复造轮子。

## 2. Metabase 能不能帮我们出图（连实例实测，结论：不能）

对 `https://bi.vmovs.com`（`.env` 里的 key，只读探测）：

| 探测 | 结果 |
|---|---|
| `/api/health` | 200 |
| `/api/user/current` | 服务账号 `Mac-Agent-MCP`，`can_create_queries / can_create_native_queries = true` |
| `/api/card?f=all` | 99 张卡片，**`public_uuid` 全为 null**（0 张已开公开链接） |
| `/api/setting/enable-public-sharing` | **403**（API Key 非管理员，读不到也开不了） |
| `GET /api/pulse/preview_card_png/96` | **404**（该版本无此端点） |
| `POST /api/card/96/query/png｜svg｜html` | **全部 404** |
| `POST /api/card/96/query/xlsx｜json` | 200（导出格式只有 csv/json/xlsx） |

**结论**：该实例通过 REST **出不了图**；公开链接是 SPA 页面而非图片，且需管理员权限开 `public sharing`。→「接 Metabase 渲染」这条路在当前实例上不成立。

## 3. AntV 方案实测证据（2026-09-17，本机）

| 验证项 | 结果 |
|---|---|
| 以 stdio MCP 拉起 `npx -y @antv/mcp-server-chart` | ✅ 成功，`tools/list` 返回 **27 个工具** |
| 官方出图服务可达性 | ✅ `POST https://antv-studio.alipay.com/api/gpt-vis` → `{"success":true,"resultObj":"https://mdn.alipayobjects.com/one_clip/afts/img/.../original"}`；再拉该图 `200 image/jpeg 36546`，**无鉴权、无需 API Key** |
| MCP 配置能否传 env | ✅ `src/mcp/config.ts` 的 `McpServerConfig.env`；`src/mcp/hub.ts` spawn 时 `process.env + cfg.env` 合并 |
| Windows 下能否起 | ✅ SDK 依赖 `cross-spawn ^7.0.5`，`command: "npx"` 会自动解析 `npx.cmd` |
| 私有化自托管 | ✅ npm `@antv/gpt-vis-ssr@0.3.8`（deps：`canvas` + `@antv/g2-ssr`/`g6-ssr`/`s2-ssr`）；MCP 侧用 `VIS_REQUEST_SERVER` 指向自建服务；官方仓库另有 docker 编排。**限制：3 个地理图不支持私有化** |
| 27 个工具名 | `generate_area_chart, generate_bar_chart, generate_boxplot_chart, generate_column_chart, generate_district_map, generate_dual_axes_chart, generate_fishbone_diagram, generate_flow_diagram, generate_funnel_chart, generate_histogram_chart, generate_line_chart, generate_liquid_chart, generate_mind_map, generate_network_graph, generate_organization_chart, generate_path_map, generate_pie_chart, generate_pin_map, generate_radar_chart, generate_sankey_chart, generate_scatter_chart, generate_treemap_chart, generate_venn_chart, generate_violin_chart, generate_waterfall_chart, generate_word_cloud_chart, generate_spreadsheet` |

## 4. 图种覆盖度对照

| 需求图种 | 对应工具 | 备注 |
|---|---|---|
| 饼图 | `generate_pie_chart` | |
| 柱状图 | `generate_bar_chart`（横向）/ `generate_column_chart`（纵向） | |
| 雷达图 | `generate_radar_chart` | |
| 结构图 | `generate_organization_chart`（组织架构）/ `generate_mind_map`（思维导图）/ `generate_flow_diagram`（流程）/ `generate_fishbone_diagram`（鱼骨）/ `generate_treemap_chart`（矩形树图） | 层级数据用 `children` 嵌套 |
| 关系图 | `generate_network_graph` / `generate_sankey_chart` / `generate_venn_chart` | |
| 其余统计图 | 折线/面积/散点/漏斗/直方图/箱线图/小提琴/瀑布/双轴/词云/水波 | |
| 表格 | `generate_spreadsheet` | 与现有 Markdown 表格二选一 |
| 地理图 | `generate_district_map` / `generate_path_map` / `generate_pin_map` | ⚠️ 走**高德地图且仅支持中国境内**；本项目是海外线 → **直接禁用** |

## 5. 三条落地路线

### 路线 1 · MCP + 官方服务（已下线 · 仅作历史记录）
> ⚠️ 2026-09-21 起不再使用：`chart` 服务器已从 `MCP_BUILTIN_SERVERS` 移除，出图统一走路线 3（本地渲染、零外链）。
> 下面这段配置**不要再启用**——两条路并存时模型可能改调官方出图服务，既产生数据外发、又会弹确认卡。

`.env` 的 `MCP_BUILTIN_SERVERS` 追加一条（现有两条 `bi` / `yapi` 之间用逗号连接）：

```json
{"id":"chart","label":"图表","transport":"stdio","command":"npx","args":["-y","@antv/mcp-server-chart"],"env":{"DISABLED_TOOLS":"generate_district_map,generate_path_map,generate_pin_map"},"timeoutMs":120000}
```

链路：模型取数 → 调 `generate_*_chart` → 返回图片 URL → 模型用 `![](url)` 贴进回复 → 前端 `img` 直接渲染。

- ✅ 零代码、当天可见效果
- ⚠️ **数据发往蚂蚁公开服务**，图片落在**公有 CDN**（实测无需鉴权即可访问）
- 建议：先给该服务器加 `"requireConfirm": true`（每次出图用户确认一次），把数据外发的动作显式化

### 路线 2 · MCP + 自托管 GPT-Vis-SSR（生产推荐，约 0.5～1 天）
同上配置，只加一个 env：

```json
"env":{"VIS_REQUEST_SERVER":"http://<内网渲染服务地址>","DISABLED_TOOLS":"generate_district_map,generate_path_map,generate_pin_map"}
```

- 需部署 `@antv/gpt-vis-ssr`（HTTP 渲染服务）：Docker（抄 `antvis/mcp-server-chart` 仓库的 docker 编排）或 Node + `canvas`（原生模块，Windows 需预编译，建议 Linux 容器）
- ✅ 数据不出内网；图片 URL 指向自己的服务
- ⚠️ 多一个内部服务要运维；3 个地理图不支持

### 路线 3 · 前端本地渲染（体验最好，约 1.5～2 天）
web 引入 `@antv/g2`（统计图）＋ `@antv/g6`（结构/关系/树图，G2 不覆盖）± `@antv/s2`（透视表）；配套新增：

1. `packages/shared` 增加 `{ type: "chart", spec, title }` 事件；
2. 内置 `render_chart` 工具（**spec 由模型给、数值由服务端从真实工具结果注入**，防编造）；
3. 前端图表卡片组件（深浅主题、tooltip、导出 PNG）。

- ✅ 可交互、零外链、无合规风险、历史消息里长期有效、图片不会因 CDN 失效
- ⚠️ 包体积约 +2MB；事件/组件/工具三处新代码；spec→图表的字段映射要自己定

## 6. 落地必补的小件（与选哪条路线无关）

1. **收窄工具位**：27 个工具会吃 schema 预算（`MCP_MAX_TOOLS=80`，超阈值会自动切 `search_tools` 按需加载）。建议 `DISABLED_TOOLS` 掉地图 3 个 + 少用的 `generate_word_cloud_chart`/`generate_liquid_chart`/`generate_violin_chart`，保留 20 个左右。
2. **新增 chart skill**（用现有 `skills/<name>/SKILL.md` 机制，不改代码）：约束三件事——
   - 先取数再出图，`data` 必须来自工具真实返回，**禁止编造数据点**；
   - 只画聚合后的序列（建议 ≤50 个数据点），别把明细塞进图；
   - 出图后**必须用 `![标题](url)` Markdown 图片语法贴进回复**，不要只给一个链接。
3. **数据回喂**：工具返回的是图片 URL，模型看不到图本身；若要求"图与数一致"的核对，需在 skill 里要求它复述出图用的数据摘要。

## 7. 风险与坑

| 风险 | 说明 / 缓解 |
|---|---|
| 数据合规 | 路线 1 数据出内网且图在公有 CDN；缓解 = 路线 2 自托管，或路线 1 加 `requireConfirm` 显式确认 |
| 图片可达性 | 官方 CDN 在用户网络环境可能被墙/被代理拦；自托管则只需内网可达 |
| 工具位超载 | 27 个工具 + 现有 bi/yapi 工具，可能触发按需加载模式；用 `DISABLED_TOOLS` 收窄 |
| Token 成本 | 模型要把数据数组塞进工具参数，明细大时很贵；skill 里限制只传聚合序列 |
| 地理图 | 高德、仅中国境内 → 与本项目海外业务无关，直接禁用 |
| 原生依赖 | 自托管 SSR 需 `canvas`（node-canvas）；Windows 本机编译风险高，建议容器化 |
| 与「禁止写死」红线 | 出图选型、图表类型判断全部交模型（skill 只给通用约定，不写业务词） |

## 8. 验收口径（实施时用）

1. 提问「按渠道看用户分布」→ 模型先跑 `run_native_query` 取数 → 调出图工具 → **气泡内直接显示图片**，刷新后仍在；
2. 图片 URL 来源符合选定路线（官方 CDN / 内网服务），且不暴露 API Key；
3. 工具清单按 `DISABLED_TOOLS` 生效，工具数与服务器状态回报正确；
4. **未勾选 chart 服务器时零回归**：纯直连路径行为与改动前一致；
5. 抽查图表数值与 `run_native_query` 返回一致（模型未编造数据点）。

## 9. 待办（下次开工从这里继续）

- [x] **决策**：先走路线 1（官方服务），用 `requireConfirm: true` 把数据外发显式化为每次确认卡；内网敏感数据规模化使用前再评估自托管
- [x] 路线 1 最小验证：`MCP_BUILTIN_SERVERS` 加 `chart` 条目 → 重启 → 端到端出图（见 §10）
- [x] 写 `skills/chart-visualization/SKILL.md`（§6.2 三条约束：先取数再出图不编造 / 聚合序列 ≤50 点 / `![](url)` 贴图 + 数据摘要）
- [x] **路线 3 落地**：`chart` 事件 + `render_chart` 工具 + 前端 g2/g6 组件（2026-09-21，见 §11）
- [x] **路线 1 下线**：`chart` 服务器从 `.env` 移除 + 清理各对话启用集里的悬空 id（2026-09-21，见 §11）
- [ ] （生产加固）自托管 `@antv/gpt-vis-ssr`——**已无必要**：路线 3 不出网、数据不出本机，此条可视为作废
- [x] 内置工具（含 `render_chart`）不再依赖「勾选至少一个 MCP」：已落地（2026-09-21 的 `toolMode` 拆分，见 `docs/deep-agents-plan.md` §8 末条修正）

---

## 10. 实施记录（路线 1，2026-09-17）

**改动**：
1. `.env` `MCP_BUILTIN_SERVERS` 追加 `chart` 服务器：`npx -y @antv/mcp-server-chart`，`requireConfirm: true`（数据外发显式确认），`DISABLED_TOOLS` 禁用 3 个地理图 + 词云/水波/小提琴（27 → 21 个工具位），`timeoutMs: 120000`；
2. 新增 `skills/chart-visualization/SKILL.md`（模型按需加载的出图守则）；
3. 验证脚本 `scripts/_chart-e2e.mjs`（真实服务端到端：自动应答确认票据 → 断言图表调用成功 + 回复含 Markdown 图片 + 图片 URL 可达）。

**端到端实测（默认模型 kimi28 + BI + chart）**：
```
[tool_call] read_skill          → 命中「图表可视化」skill，加载出图守则
[tool_call] mcp__bi__list_databases
[tool_result] ok=true
[tool_call] mcp__bi__get_database_schema
[tool_result] ok=true（totalTables: 47）
[tool_call] mcp__chart__generate_column_chart
[confirm] 票据批准 -> 200        ← 数据外发确认卡（write-op-safety P0-4 票据机制）
[tool_result] ok=true → 图片 URL
回复含 Markdown 图片：true；图片可达：200 image/jpeg
E2E PASS
```

**与安全闸门的联动**：chart 未声明风险级别 + 服务器级 `requireConfirm` → 每次出图弹确认卡（含脱敏参数摘要 = 将送去渲染的数据），既是写操作确认也是数据外发确认——方案 §5.9 的"歪打正着"在有 requireConfirm 配置下成为确定性保障。

**遗留**：生产规模化前评估自托管（§9 第 4 条）；确认卡目前不区分「数据外发」徽标（`RiskLevel` 的 egress 轴，方案 §5.9 下一轮）。

> 注：以上路线 1 的记录保留作历史对照。`mcp__chart__*`、图片 URL、确认卡这些产物在路线 3 下都不再出现。

---

## 11. 实施记录（路线 3 · 本地渲染，2026-09-21）

**为什么换**：路线 1 每次出图都要把数据发往蚂蚁官方服务、图片落公有 CDN、并弹一张数据外发确认卡。路线 3 把出图搬到浏览器：数据不出本机、零外链、历史消息长期有效（图不再依赖 CDN 存活）。

**改动**：

1. **服务端**
   - `src/builtins.ts` 新增内置工具 `render_chart`（`BUILTIN_RISK` 登记为 `read`：只透传 spec、不发起任何外部请求，故**不需要确认卡**）；
   - `src/chat.ts` 主循环与子代理路径均下发 `chart` 事件（`{ chartType, data, title?, encode?, options? }`）；
   - `packages/shared` 的 `ChatEvent` 增加 `chart` 变体；
   - 图型清单见 `skills/chart-visualization/SKILL.md`（pie/bar/column/line/area/scatter/radar/treemap/funnel/boxplot/histogram/waterfall/dual_axes/sankey/mind_map/org_chart/network），与 `src/builtins.ts` 的 `CHART_TYPES` 白名单一致。
2. **前端**
   - 新增 `src/components/ChartCard.vue`：`@antv/g2`（统计图）/ `@antv/g6`（结构·关系·树图）**按需动态 import**（不出图不背这 2MB），跟随深/浅主题，渲染失败降级成原始数据表格；
   - 聊天页在气泡内渲染卡片；`chart` spec **随消息快照落库**（`StoredMessage.chart` + `toStored`/恢复映射），刷新后由 ChartCard 按 spec 重绘；
   - 带图表的气泡撑满对话列（`.bubble-wrap.has-chart`）：气泡默认按文字收缩，会让卡片的百分比宽度反向塌成窄条（实测 159px）。
3. **配置下线**
   - `.env` 的 `MCP_BUILTIN_SERVERS` 移除 `chart` 条目；`.env.example` 注明「不要再加 chart」；
   - 悬空 id 三处防线：`GET /chat/mcp/servers` 只过滤回报（**不写库**，GET 是安全方法）、`PUT` 落盘前拦掉不存在的 id、**启动维护** `pruneUnknownMcpServers()` 扫掉存量（`.env` 改动只在启动时读，那条路径没有别的清理点）；
   - 存量清理一次性摘掉了 73 个对话里的 `chart`（当初该服务器配置了 defaultEnabled，新建对话都会带上它）。

**验证**（2026-09-21，默认模型 + BI）：

```
node scripts/_chart-e2e.mjs          ← 脚本已从路线 1 断言改写为路线 3
[启用] ["bi"]
[tool_call] mcp__bi__list_databases        → ok（主库）
[tool_call] mcp__bi__get_database_schema   → ok（47 张表）
[tool_call] render_chart
[chart] 事件下发：type=column title=各数据库的表数量 data=1 行
E2E PASS
```

浏览器侧另验：图表卡片渲染为 `canvas 690×300`、柱状图/图例/坐标轴正常；**整页刷新后卡片仍在**（走落库快照恢复）。

**内置工具恒注入**：内置工具（含 `render_chart`）与本对话勾了哪些连接器无关，**始终注入**——2026-09-21 已把旧的 `toolMode` 耦合拆开（旧实现让「没勾任何连接器的新对话零工具」，连本地出图与工作区文件都用不了；修正记录见 `docs/deep-agents-plan.md` §8 末条）。因此**零连接器也能出图**。

此时没有取数来源，图里的数据必须来自用户提供的内容或已有工具结果，**不得编造**——「先取数、不编造数据点」这条约束由 `skills/chart-visualization` 与 `skills/business-data-query` 两个技能承担。

**2026-09-21 补齐（查缺补漏，详见 `docs/deep-agents-plan.md` §11.9）**：

1. **spec 与图型清单收敛到 `@bx/shared`**：`ChartSpec` + `CHART_TYPES` / `GRAPH_CHART_TYPES` 一处定义，服务端工具校验（`builtins.ts` 的 `render_chart`）与前端 G2 / G6 分流（`ChartCard.vue`）共用——此前服务端落库那份内联类型只认 13 种旧图型且把图形类 `data` 写成数组，与工具白名单漂移。
2. **子代理出的图不再丢**：`runSubagent` 此前只转发文本与 `tool_call`，`chart` 事件被吞（`render_chart` 在子代理工具集内）→ 现已转发。
3. **前端渲染失败必降级**：G2 的 `render()` 是 Promise，原先未 `await` → 渲染期报错绕过降级表格且留下未处理拒绝；现已 `await` 并统一回收半成品实例（`discardMine()`）。

**2026-09-22 补齐（伪出图护栏，详见 `docs/deep-agents-plan.md` §11.10）**：

4. **「假装出图」不再直通用户**：模型没调 `render_chart`、只在正文里写 `![标题](chart)` 占位符时（图根本不存在），浏览器把 `chart` 当相对路径请求 → 404，用户看到的是**破图**而不是「没有图」。两道护栏同口径：
   - 服务端 `chat.ts` 的 `unresolvableImageTargets`——正文里的图片语法只要目标不是可解析的图片地址（无 `http(s):` / `data:` / `//`）即判为占位符，作废该轮正文并回灌提示要求改走 `render_chart`（与伪工具调用共用一次纠正预算；代码块里的图片语法属示例，不误判）；
   - 前端 `chat-richtext.ts` 渲染后处理摘掉这类 `<img>`——护栏上线前落库的历史消息也不会再显示破图。
5. **`SCHEDULE_TASK_GUIDE` 补一句「图仍要用 `render_chart` 出」**：原文「图表只作补充（推送里不一定看得到图）」是讲「正文必须能独立阅读」，被模型读成了「这期不用出图」。
