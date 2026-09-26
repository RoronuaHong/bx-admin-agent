# PC 后台结构与输出类型清单（bx-film-admin-in2）

> **用途**：对齐 Agent 对 PC 端后台的理解——项目结构、菜单域、页面输出形态，以及对应需要的 skill / tool。  
> **仓库**：[web/bx-film-admin-in2](https://git.work.xxbbc.com/web/bx-film-admin-in2)  
> **本地根**：`D:\Code\bx-film-admin-in2`  
> **复核日期**：2026-08-20  
> **归属层**：skill（输出规范）+ superpower（形态枚举）+ tools（落地能力差距）

关联文档：

- [field-mapping.json](./field-mapping.json) — 字段名/枚举对齐  
- [clarification-policy.json](./clarification-policy.json) — 四元组与澄清策略  
- Agent 侧章程：`bx-admin-agent/docs/agent/AGENT_CHARTER.md`

---

## 1. 技术栈与规模（复核）

| 项 | 值 |
|---|---|
| 框架 | Vue 3 + Vite + Ant Design Vue 2 + Vben Admin |
| 国家线构建 | `hi` / `br` / `mx`（`dev:hi` 等） |
| `src/views` 一级目录 | **73** |
| 路由业务模块 `src/router/routes/modules/*.ts` | **24** |
| `src/api/**/*.ts` | **212** |
| `List.vue` | **186** |
| `Edit.vue` | **20** |
| `DeptModal.vue` | **148** |
| `*Modal*.vue` | **232** |
| `*Drawer*.vue` | **2** |
| `Analysis.vue` | **12** |
| 含 BasicTable / useTable 的 List 页（约） | **229** |
| 使用 ECharts / useECharts 相关文件（约） | **16+** |
| Tinymce 相关页（约） | **5** |
| Excel 导出相关页（约） | **14** |
| BI / iframe 页（约） | **2** |
| 地图组件（AMap/leaflet 等） | **0** |

图表：`package.json` 未直接依赖 echarts，运行时通过 `useECharts` / `window.echarts` 使用。

---

## 2. 目录结构

```
bx-film-admin-in2/
├── src/
│   ├── views/          # 业务页面（按菜单域）
│   ├── api/            # 接口封装（与 views 大致对应）
│   ├── router/
│   │   ├── routes/modules/   # 24 个业务路由模块
│   │   └── country/          # 国家差异菜单注入
│   ├── components/     # Vben 基础：Table/Form/Modal/Upload/Excel/Tree/Tinymce…
│   ├── components2/    # 业务组件：User*Info、Player、relateFilm、advancedSearch…
│   ├── hooks/          # useTable、useECharts、useStandardTable…
│   ├── layouts/        # 布局 / 多页签壳
│   ├── store/ locales/ utils/
│   └── …
├── docs/agent/         # Agent 对齐文档（本文件所在）
├── build/ mock/ public/ types/
└── …
```

---

## 3. 菜单 / 路由业务域（24）

| 模块文件 | 路径前缀（典型） | 业务范围 |
|---|---|---|
| `dashboard` | `/dashboard` | 分析看板、登录日志、QC 等 |
| `film` | `/film` | 影片/剧集/分类/演员/系列/时间标签/推荐片段/片源等 |
| `content` | `/content` | 专题、反馈、资讯等 |
| `match` | `/match` | 多源匹配、虚拟 IMDB、自动上传；国家菜单注入外站源 |
| `sport` | `/sport` | 赛程、联赛、球队、体育 Banner 等 |
| `live` | `/live` | 直播类型、频道 |
| `vip` | `/vip` | 售卖、权益、订单、审核、多活等 |
| `redeemCode` | `/redeemcode` 等 | 兑换码、礼品码、代理、UPI 代付（印度） |
| `account` | `/account` | 用户、黑白名单、投诉、消息等 |
| `userlayer` | `/userlayer` | 用户分层、分组、特价与相关统计 |
| `share` | `/share` | 分享裂变、提现、活动、发帖审核等 |
| `publicity` | `/publicity` | 归因、新增统计、短链、运营广告 |
| `dataReport` | `/dataReport` | BI、观看/登录/收入/留存/LTV 等报表 |
| `statistics` | `/statistics` | 客服侧：反馈、片源纠错、举报等 |
| `coo` | `/coo` | 运营：消息、Banner、广告位、活动帖等 |
| `platform` | `/platform` | 渠道/版本/域名/支付/CDN/登录方式等 |
| `dictionary` | `/dictionary` | 字典、敏感词、语言、国家配置等 |
| `seo` | `/seo` | TDK / Type / Project |
| `im` | `/im` | IM 配置、消息、禁言、黑名单 |
| `agreement` | `/agreement` | 协议（富文本） |
| `chatgpt` | `/chatgpt` | SEO 相关（多 `hideMenu`） |
| `activity` / `game` | `/activity` `/game` | 竞猜、游戏订单等 |
| `sys` | `/sys` | 部门、成员、菜单、操作日志 |

---

## 4. 输出类型全清单（Agent 对齐枚举）

> 下列类型均在仓库中有真实落地；Agent 答复时应识别「当前页属于哪一类」，再选对应输出形态，**禁止**把图表页只当纯文本、或把列表页画成假图。

### 4.1 表格 / 列表

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| T01 | 标准数据表格 | BasicTable + 搜索表单 | 绝大多数 `**/List.vue` |
| T02 | 树形表 / 可展开行 | `children`、expand | `menu/List`、Banner 位等 |
| T03 | 嵌套子表 | 详情内多张 BasicTable | `UserVipInfo` / `UserServerInfo` 等 |
| T04 | 可编辑单元格 / 动态行 | EditableCell、EditList | 剧集/倒计时等 form |
| T05 | 表尾汇总 | table footer | 部分报表 configs |
| T06 | 高级检索结果表 | advancedSearch | `components2/advancedSearch/*` |

### 4.2 图表 / 可视化

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| C01 | 折线 / 面积图 | ECharts line/area | `dataReport/*/Analysis.vue` |
| C02 | 柱状图 | ECharts bar | `platformIncomeTotal/BarChart.vue` |
| C03 | 饼图 | ECharts pie | `dashboard/.../SalesProductPie` 等 |
| C04 | 雷达图 | ECharts radar | VisitRadar / SaleRadar |
| C05 | 列表 + 图表组合 | 表 + 扩展区图 | 观看时长、平台收入等 |
| C06 | 看板内嵌分析图 | analysis 组件 | `dashboard/analysis` |

**Agent 侧约定**：不在对话里真画 ECharts；输出「趋势摘要 + 关键点数据表」。

### 4.3 统计 / KPI / 看板

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| K01 | KPI 增长卡片 | GrowCard / Statistic | `dashboard/analysis` |
| K02 | 数字卡片 / CountTo | Card + 数字 | 看板、工作台 |
| K03 | 待办 / 任务卡片 | Todo | `dashboard/analysis/components/Todo` |
| K04 | 用户画像块 | 性别/地区/语言组件 | dashboard User* |
| K05 | 工作台快捷区 | workbench | `dashboard/workbench` |

### 4.4 矩阵 / 宽表报表

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| M01 | 留存矩阵 | 多日列动态表 | `dataReport/retentionTotal` |
| M02 | LTV 宽表 | 多日/多维列 | `dataReport/ltvTotal` |
| M03 | 归因 / 新增细分宽表 | 宽表 + 导出 | `publicity/newSourceTotal` 等 |

### 4.5 表单 / 详情 / 编辑

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| F01 | 整页表单编辑 | Edit + BasicForm | `film/Edit`、`episode/Edit`、`actor/Edit` |
| F02 | 弹窗表单 | DeptModal / BasicModal | ~148 DeptModal 范式 |
| F03 | 抽屉 | Drawer（极少） | `vip/auditOrder/*Drawer*` |
| F04 | 多 Tab 详情 | PageWrapper + a-tabs | `account/user/Edit` |
| F05 | 只读描述块 | Description / Info | `UserBaseInfo` 等 |
| F06 | 穿梭 / 关联选择 | Transfer、relateFilm | 影片关联、标签 |
| F07 | 颜色 / 图标等控件 | ColorPicker、IconPicker | 配置类表单 |

### 4.6 分区与导航

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| N01 | 页面 Tabs | a-tabs | 用户详情、分类、域名配置 |
| N02 | 维度 Radio/切换 | RadioButton 工具栏 | 看板、留存报表 |
| N03 | 框架多页签壳 | layout tabs | 非业务输出 |

### 4.7 树

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| R01 | TreeSelect | 表单树选 | 分类/权限相关 |
| R02 | 树编辑弹窗 | EditTreeModal | `bannerlocation` |
| R03 | 菜单树 + 权限 | 树表 + PermissionModal | `menu/*` |
| R04 | 逻辑分组条件树 | LogicalModal | `userlayer/accountGroup` |

### 4.8 媒体

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| V01 | 单图/多图上传 | UploadImage(s) | Banner、演员、活动 |
| V02 | 图片裁剪 / 预览 | Cropper、ImgPreview | 头像、审核凭证 |
| V03 | 视频/字幕上传 | UploadVideo* | 剧集、体育视频 |
| V04 | HLS / 自定义播放器 | Player + hls vendor | `components2/Player`、VideoModal |

**Agent 侧约定**：只返回 URL / 封面 / 状态 meta，不内嵌播放。

### 4.9 富文本 / 代码

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| E01 | 富文本 | Tinymce | 协议、资讯、部分配置 |
| E02 | JSON / 代码编辑 | CodeMirror | 域名/渠道扩展配置 |
| E03 | JSON 调试展示 | vue-json-pretty | 错误日志详情 |

**Agent 侧约定**：富文本给摘要，不全量倾倒 HTML。

### 4.10 导入导出 / 外嵌

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| X01 | Excel 导出 | ExportExcel / useExportExcel | 留存、邀请、热搜、Top |
| X02 | Excel 导入 | ImportExcel | Excel 组件场景 |
| X03 | BI iframe | 选报告嵌 URL | `dataReport/biTotal/BIPage` |
| X04 | 通用 iframe | sys iframe | `views/sys/iframe` |

**Agent 侧约定**：BI 给报告名 + 链接说明，不伪造 BI 数。

### 4.11 交互态输出

| ID | 输出类型 | PC 形态 | 代表路径 |
|---|---|---|---|
| I01 | 行内状态开关 | Switch / PopconfirmSwitch | 影片、Banner、渠道 |
| I02 | 确认删除/操作 | Popconfirm + TableAction | 几乎所有 List |
| I03 | 审核流 | Audit Modal/Drawer | 影片、VIP、UPI、发帖 |
| I04 | 批量操作结果 | Result Modal | 归因批量、批量删 |
| I05 | 评论/回复线程 | ReplyList | 短视频/影片评论 |
| I06 | 排序拖拽 | Sortable / SortItems | 菜单、轮播 |
| I07 | 二维码 | QrCode | 登录等 |
| I08 | 纯文本说明 | 文案/提示 | Agent 对话侧主形态之一 |

### 4.12 明确不存在或几乎不用

| 类型 | 结论 |
|---|---|
| 地图（AMap / leaflet / mapbox） | 未发现 |
| 业务 Timeline | 未发现业务用法 |
| FlowChart 业务页 | 组件库有，业务页几乎未用 |

---

## 5. 页面交互模式（操作轴）

| 模式 | 特征 | 代表 |
|---|---|---|
| List → Modal CRUD | 主路径（DeptModal） | 平台/VIP/匹配/字典… |
| List → 整页 Create/Edit | 复杂表单 | 影片、剧集、演员、版本 |
| List → 多 Tab 详情 | 只读块 + 可编辑 Tab | 用户详情 |
| 仅查询统计 | 无写或弱写 | dataReport、多数统计 |
| List + 图 / 导出 | 分析 | 收入、留存、支付渠道 |
| 行内 Switch | 启停/上下架 | Banner、活动、渠道 |
| 审核通过/驳回 | 专用 Modal/Drawer | 影片、VIP、UPI |
| 批量工具栏 | toolbar + Result | 归因、分享用户、CDN |
| 外链/iframe 只读 | BI | BIPage |

---

## 6. Agent Skills / Tools 对照

### 6.1 已有能力（2026-08-20 已补齐输出类）

| 层 | 名称 | 位置 | 覆盖输出 |
|---|---|---|---|
| skill | `business-intent` | `apps/agent-server/skills/business-intent` | 意图→检索→call_api |
| skill | `pc-output-formats` | `skills/pc-output-formats` | 列表/详情/表头/Markdown 表 |
| skill | `output-report-chart` | `skills/output-report-chart` | 报表/图表摘要/BI 说明 |
| skill | `write-confirm` | `skills/write-confirm` | 写操作确认与回读 |
| skill | `media-bi-richtext` | `skills/media-bi-richtext` | 媒体 meta / 富文本摘要 / BI |
| skill | `codebase-explorer` | `skills/codebase-explorer` | 找模块/接口 |
| skill | `local-service-probe` | `skills/local-service-probe` | 本地服务探测 |
| tool | `submit_understood_intent` / `parse_intent` / `set_project` | `tools.ts` | 四元组 |
| tool | `grep_codebase` / `search_api_module` / `read_api_module` / `read_file` | + MCP | 定位模块（方案 A：实时 grep PC 端源码为主，索引兜底） |
| tool | `call_api` / `request_clarification` | | 执行/澄清 |
| tool | `normalize_output` / `read_field_mapping` | | 字段对齐 |
| tool | `get_list_columns` / `get_page_schema` | | 列定义 / 页面形态 |
| tool | `render_table` / `summarize_chart_data` | | Markdown 表 / 图表摘要 |
| tool | `list_dir` / `read_file` / `fetch_url` | | 通用读写 |

### 6.2 仍可选增强（非阻断）

| 项 | 说明 |
|---|---|
| `export_dataset` | 真触发 Excel 导出接口（现可以文字说明筛选与导出入口） |
| `preview_media_meta` / `open_bi_report` | 更专用的媒体/BI 工具（现有约定已够用） |
| field-mapping 覆盖率 | 按模块继续补 `field-mapping.json` |

#### Skills（历史建议，多数已落地）

| 优先级 | Skill | 状态 |
|---|---|---|
| P0 | `pc-output-formats`（原 output-table/detail/field-align） | ✅ |
| P1 | `output-report-chart` | ✅ |
| P1 | `write-confirm` | ✅ |
| P2 | `media-bi-richtext` | ✅ |

#### Tools（历史建议）

| 优先级 | Tool | 状态 |
|---|---|---|
| P0 | `get_list_columns` / `render_table` / 增强 normalize | ✅ |
| P1 | `get_page_schema` / `summarize_chart_data` | ✅ |
| P2 | `read_field_mapping` | ✅ |
| P2 | `export_dataset` 等 | ⏳ 可选 |

---

## 7. 输出形态 → Agent 默认答复策略（速查）

| 用户意图像… | PC 输出 ID | Agent 默认怎么答 |
|---|---|---|
| 「看某某列表」 | T01 | `call_api` → `normalize_output` → Markdown 表 |
| 「看用户详情」 | F04 + T03 | 分块：基础信息 + 子表摘要 |
| 「看收入/观看趋势」 | C05 / C01 | 摘要结论 + 关键点表（可选说明 PC 有图） |
| 「看留存」 | M01 | 矩阵表（控制列宽）+ 说明 |
| 「导出 Excel」 | X01 | 说明能否触发导出 / 给出筛选条件与下载指引 |
| 「看 BI」 | X03 | 报告名 + 打开路径/链接说明 |
| 「上架/审核/删除」 | I01–I03 | 写确认 → `call_api` → 回读结果 |
| 「播放/看视频」 | V04 | 返回可访问地址或「请在 PC 播放器打开」，不播流 |

---

## 8. 变更规则

1. PC 新增页面形态时：更新本文件 **§4 枚举**，必要时补 skill/tool。  
2. 字段展示变更：先改 `field-mapping.json`，再改 `normalize_output` 行为。  
3. 禁止仅靠改 system prompt 固化「某种输出类型」规则（遵循 AGENT_CHARTER 五层）。  

---

## 9. 复核记录

| 日期 | 动作 |
|---|---|
| 2026-08-20 | 首次基于仓库统计生成；List=186、Edit=20、DeptModal=148、路由模块=24、api ts=212；确认无地图依赖 |
