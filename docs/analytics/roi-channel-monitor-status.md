# 投放渠道 ROI 异常监控：需求对照（2026-09-14）

对照来源：陈鸿梳理的 Demo Agent 场景（投放渠道 ROI 异常监控）。  
核对对象：当前仓库实现（问数 `analyticsAsk` + M3 巡检 `watch-users`），不是旧草案「已规划即已完成」。  
模型探测：DeepSeek-V4-Flash（`dsflash` / `deepseek-v4-flash-202605`）当日可用（约 1.3s，HTTP 200）。

**总评：投放 ROI 监控 Demo 没有做完。** 已落地的是「渠道日活巡检」骨架。指标、渠道口径、漏斗、自动下钻都对不上这份需求。M3 验收写明默认指标是 `channel_daily_users`，真·ROI 公式不在范围内。

权威口径见：

- `docs/analytics/m3-acceptance.md`
- `docs/superpowers/specs/2026-09-09-metabase-analytics-agent-design.md` §9
- `apps/agent-server/config/analytics/rules/watch-users.ruleset.json`

---

## 一、数据需求（每日粒度）

| 点 | 结果 | 现状 |
|---|---|---|
| 日期（日粒度） | **部分完成** | 问数和巡检都能按自然日切（业务时区 `Asia/Shanghai`，巡检默认 T-1）。没有「投放 ROI 日表」。 |
| 渠道：fb / tt / gg / apple-ads / 自然流 / 裂变拉新 / 其它（默认汇总） | **未完成** | 现渠道是产品包码（`IndiaA`、`FoxA`、`GoGo`…），没有这套投放媒体映射，也没有「其它」汇总桶。 |
| 语言：印度语 / 英语 / 泰米尔语 / 泰卢固语 / 玛拉雅拉姆语（可下钻） | **未完成（仅有相近字段）** | 观影表有 `contentLang`（如 `ta-IN` / `te-IN` / `ml-IN` / 空）。没有绑到 ROI 巡检，也没有「印度语/英语」这套业务别名下钻。 |
| 包体：默认汇总、支持下钻 | **未完成** | 规则里预留了 `dimensions.drilldown`，默认 ruleset 没配包体。没有包体维的取数和汇总。 |
| 曝光量 | **未完成** | 语义层 / 巡检 / 编译指标里都没有曝光。 |
| 点击量 | **未完成** | 目录里有印度广告点击流水表（`ad_india_click_*`），没有接到漏斗或巡检。 |
| 播放量 | **未完成** | 有观影/播放相关表，不是投放漏斗里的「播放量」。 |
| 支付人数 | **未完成（表在、口径不在）** | 订单表能编「订单数 / 人数」，没有「投放渠道 → 支付人数」链路。 |
| 支付金额 | **未完成（同上）** | 订单金额能编，没有和投放消耗对齐的金额口径。 |
| CTR | **未完成** | 无公式、无预聚合、无巡检指标。 |
| CVR | **未完成** | 同上。 |
| ROI | **未完成** | 全仓巡检只跑 `uniq(guid)` 渠道日活。文档写明 ROI 待业务对齐后再换 ruleset。 |

---

## 二、监控逻辑

| 点 | 结果 | 现状 |
|---|---|---|
| 每日自动算各渠道 ROI | **未完成（日活日报已接）** | `ANALYTICS_SCAN_WORKER=1` + `ANALYTICS_SCAN_CRON=1` 时，进程内每日入队 `watch-users`（`digest: true`，默认 10:00 业务时区，T-1）。会推「问数巡检日报」渠道日活（无 webhook 则静默）。**算的不是 ROI**，也没有投放渠道维。 |
| 对比昨日 + 上周同期 | **框架完成，指标不对** | `dod`（T-2）+ `wow`（T-8）已实现，任一破线可告警（`baselineLogic=any`）。对比的是观看人数，不是 ROI。需求里的「同比」按上下文应理解为上周同期（wow），不是自然年同比。 |
| 某渠道下降超过 10% 就预警 | **框架完成，指标不对** | `thresholdRatio=0.9`（降幅 >10%）已实现，可钉钉 + 深链。预警文案是渠道日活，不是 ROI。 |
| 预警后自动按语言 / 包体下钻，定位细分群体 | **未完成** | 告警 runbook 只写了一句「请按语言/包体下钻」。runner 不会自动再查语言或包体。`maxChildAlerts` 配了，没有子查询。 |

---

## 三、和这份 Demo 的关系

已经能复用的只有：日窗、环比/周比、降幅 10%、freshness、钉钉、页面手工巡检。

还缺、而且是业务前提的是：

1. 投放侧日表（或接口）：渠道（fb / tt / …）× 语言 × 包体 × 曝光 / 点击 / 播放 / 支付 / 消耗
2. 书面口径：ROI = ?（支付金额 / 消耗？），CVR 分母是点击还是曝光
3. 新 ruleset + 取数，替换现在的 `channel_daily_users`
4. 预警后的自动下钻
5. 投放 ROI 口径与自动下钻（进程内日活 cron 已接，不能代替本条）

这些和「数据获取难度大可以约时间讨论」是对上的：数据层还没对齐，Agent 侧无法假装 ROI 已经能监控。

---

## 四、实现锚点（便于复核）

| 能力 | 位置 |
|---|---|
| 默认巡检规则 | `apps/agent-server/config/analytics/rules/watch-users.ruleset.json` |
| 日活取数（非 ROI） | `apps/agent-server/src/analytics/scan/metrics.ts` → `fetchChannelDailyUsers` |
| 阈值（ratio &lt; 0.9） | `apps/agent-server/src/analytics/scan/threshold.ts` |
| 巡检编排 | `apps/agent-server/src/analytics/scan/runner.ts` |
| 告警文案 / 深链 / runbook / 日报 | `apps/agent-server/src/analytics/scan/notify.ts` |
| 进程内每日入队 | `apps/agent-server/src/analytics/scan/scheduler.ts`（`ANALYTICS_SCAN_CRON=1`） |
| M3 验收（明确排除真 ROI） | `docs/analytics/m3-acceptance.md` |

## 五、本期修复记录（2026-09-15）

针对"钉钉消息打不开 / 下钻无效"的体验问题，已落地代码修复（仓库未提交，待评审）。

| 项 | 改动 | 位置 | 状态 |
|---|---|---|---|
| 深链可点击 | `buildDeepLink` 在配置 `ANALYTICS_WEB_BASE_URL` 时拼绝对 URL，否则退化相对路径 | `src/analytics/scan/notify.ts` + `src/config.ts`(`scan.webBaseUrl`) + `.env` 占位 | ✅ 已修，填 IP 才生效 |
| 深链打开即出来源条 | 前端 `onMounted` 在深链带 `q` 时预填并自动发送 | `apps/web/src/pages/AnalyticsAgentPage.vue` | ✅ 已修（web 需重建 / HMR） |
| runbook 如实化 | "按语言/包体下钻" 改为说明是人工 NL 追问，非系统自动下钻 | `src/analytics/scan/notify.ts`(`buildRunbook`) | ✅ 已改 |
| 图表 / 分析图（内嵌）—— 路径核实 | **实测结论（两来源一致）**：钉钉自定义机器人 webhook 只支持 `text / link / markdown / actionCard / feedCard`，**不支持 `msgtype=image`**（base64 图片属「企业内部应用机器人」media_id 通道，需 appkey/agentId）。故「image + base64」这条我原先记的路在本通道**不存在**；内嵌图唯一通道 = markdown `![alt](公网URL)` | 钉钉开放平台文档核对 | ✅ 已核实 |
| 消息 markdown 化 + 内嵌报告截图 | 告警/日报由 text 改为 `msgtype=markdown`：加粗结论 + 细分列表 + **报告页整页截图** `![巡检趋势图](url)` + 可点击链接。截图由本服务 `GET /analytics/report/:token/image.png` 用**本机 headless 浏览器对报告页整页截图**生成并缓存（零新增依赖，自动探测 Chrome/Edge） | `src/alert-notify.ts`（markdown 载荷，sender 第 4 参可选、旧 3 参 sender 兼容）、`src/analytics/scan/report-image.ts`（新增）、`src/app.ts`（PNG 端点）、`src/analytics/scan/notify.ts` | ✅ 已实现（开关 `ALERT_REPORT_IMAGE`，**默认关**） |
| 文本柱状图（兜底可视化） | 内嵌图要求图 URL **公网可达**（钉钉服务端要能取到），内网/未配公网域名时图不会显示 → 消息里同时用 Unicode 方块（`█▉▊▋▌▍▎▏`）画渠道趋势，零依赖、零公网要求，**内网也立刻可见** | `src/analytics/scan/report-markdown.ts`（新增） | ✅ 已实现（默认生效） |
| 可点击只读报告链接 | 除图外仍附报告链接，点开为网页版报告（预警 + 趋势 + 明细表 + 来源条入口），手机端自适应 | `src/analytics/scan/report-store.ts`、`src/app.ts`、`src/analytics/scan/runner.ts`、`apps/web/src/pages/AnalyticsReportPage.vue` + `apps/web/src/router.ts` | ✅ 已实现 |
| **真机推送实测（2026-09-15）** | 向真实钉钉群推 2 条（markdown：无图 / 有图），**API 均 errcode=0 送达**；**文本柱状图在内网 base 下也正常显示**（`█▉▊▋` 未被 markdown 折叠破坏）；但**内嵌图不显示**（base 为 `192.168.50.129` 私网）→ 证明钉钉取图不是客户端行为，**必须公网可达** | 实测 | ✅ 结论确认 |
| 内嵌图公网可达性预检 | 既然私网 base 必然裂图，出链接前先判公网：回环 / `10.x` / `172.16-31.x` / `192.168.x` / `169.254.x` / 组播 / `::1` / `fc00::/7` / `fe80::/10` / `.local` 一律**跳过内嵌图**并打一条一次性 warn 说明原因（避免群里出现裂图占位）；私网自建钉钉确实能取到图时可用 `ALERT_REPORT_IMAGE_FORCE=1` 强制 | `src/analytics/scan/report-image.ts`(`isPubliclyReachableUrl`)、`src/analytics/scan/notify.ts`(`reportImageUrl`) | ✅ 已实现 |
| 值班文案去术语 | 实测发现原文案对人不可读：`[深链（核对来源条/追问细分）]` 这种标签无意义（markdown 把 URL 藏了），`处置：…确认后可 forceRerun` 里的 forceRerun 是**内部接口参数**（问数页只有「运行巡检」，UI 给不了 forceRerun）→ 改为 `[查看完整报告（图表 / 趋势 / 明细表）]`、`[去问数继续追问细分维度]`；处置改为「先看报告确认异常范围；需要细分维度时到问数里继续追问」 | `src/analytics/scan/notify.ts`(`buildRunbook` + 两个消息构造器)、`scripts/analytics-scan-notify.test.ts` | ✅ 已改（单测加 `doesNotMatch(/forceRerun/)` 护栏） |
| **告警图漏掉异常渠道（功能性缺陷）** | 柱状图原按「体量 topN」取，而异常渠道往往是**小体量**（21 个渠道里 Wowlok=140 排倒数第二）→ **告警点名"BD / Wowlok 掉了"、图里却找不到这两个渠道**（被"另有 N 个未列出"吞掉）。改为取「topN ∪ 异常渠道」再统一排序，异常项打 `← 异常` 标记 | `src/analytics/scan/notify.ts`(`buildChannelChartLines` 新增 `highlight`) | ✅ 已修（单测新增回归：15 个大渠道 + 1 个极小异常渠道，断言异常渠道必在图中） |
| **日报可能被静默拒收（潜在投递失败）** | 告警标题是 `[bx-agent] 数据分析巡检`（机器人关键词校验靠它），但日报标题只写 `问数巡检日报` → 若机器人用的是关键词安全设置，**日报会被拒收（errcode 310000）**，而调用方只看到一条失败。改为 `[bx-agent] 问数巡检日报` | `src/analytics/scan/notify.ts`(`notifyScanDigest`) | ✅ 已修（单测断言标题带关键词） |
| 去重指纹挪到末尾 | 内部去重串 `[fingerprint: …]` 原本是**第一行**，人第一眼看到的是调试噪音；挪到正文末尾。位置无关（去重按整条消息），它仍承载 `rerunSeq` 以保证重跑能再次推送 | `src/analytics/scan/notify.ts` | ✅ 已改（单测断言 `endsWith("|digest]")`） |
| 数值千分位 | 消息里 `669177` → `669,177`，与报告页展示一致，长数字更好读 | `src/analytics/scan/notify.ts`(`fmtCount`) | ✅ 已改 |
| 报告文件保留期清理 | 报告 JSON + 配图 PNG 原来**永不过期**（`.data/analytics-reports` 无限堆积）→ 落盘时顺带清理超期文件；`ANALYTICS_REPORT_RETENTION_DAYS`（默认 30，0/负数=永久） | `src/analytics/scan/report-store.ts`(`purgeOldScanReports`) | ✅ 已改（实测：40 天前的 `.json`/`.png` 被清，正常文件保留） |
| 文案写死阈值百分比 | 日报里「异常：N 条（降幅>10%）」的 `10%` 是**写死**的，而真实阈值来自 ruleset 的 `ratio` —— ruleset 一改这句话就变成假话（同 forceRerun 类"文案骗人"问题）。改为只给条数 `异常：N 条`，具体降幅由上方细分与柱状图逐条给出 | `src/analytics/scan/notify.ts` | ✅ 已改（单测加 `doesNotMatch(/降幅>10%/)` 护栏） |
| **消息排版（分段 / 层级 / 编号）** | 实测渲染反馈"所有内容糊成一整块"：小标题与正文同字号同粗细、节与节无空行、`时间窗` 孤零零挂在中间。改为：加粗结论置顶 + `时间窗` 紧跟其下；三个加粗小标题 `**异常细分**` / `**渠道日活（当日 · DoD · WoW）**` / `**下一步**`；节间空行分段；动作项改编号列表（`1.` `2.`）；柱状图行去掉逐行重复的 `DoD`/`WoW` 标签（含义由小标题统一交代）→ 行更短、手机更好读。**只用钉钉 markdown 实测支持的语法**（加粗 / 列表 / 链接 / 图片），标题、引用、表格、代码块**未验证故不使用**，避免渲染成乱码 | `src/analytics/scan/notify.ts`(两个消息构造器) | ✅ 已改（单测加 `**异常细分**` / `**下一步**` / 编号动作 断言护栏） |
| **显示模式升级（对照网上最佳实践 + 实测）** | 按告警内容设计规范（What/Where/When/Action 四要素、"通知=信号+动作、细节放链接后面"）落地两件事：①**通知预览标题带信号**——会话列表首屏透出的就是它，由泛化的 `[bx-agent] 数据分析巡检` 改为 `[bx-agent] 巡检预警 2026-09-14：2 个渠道异常`（仍含机器人关键词）；②**卡片+按钮模式** `ALERT_MSGTYPE=action_card`：卡片正文压缩到 top6 渠道（官方建议 ≤1000 字符，实测 948），动作**按钮与正文编号链接并存**——底部实体按钮（`查看完整报告` / `去问数追问细分`，竖排）直达，正文链接可单独复制/在浏览器打开；③**颜色标记** `ALERT_FONT_COLOR=1`（默认开启）：`<font color="#RRGGBB">`、**异常与预警统一用红**（`#f5222d`：预警/严重徽标、异常细分、异常计数、异常标记、下跌；`#cf1322` 与橙 `#fa8c16` 已废弃，预警 vs 严重靠徽标文字区分），绿=正常/上涨，蓝=日报徽标/柱条（真机验证 6 位 hex+闭合；如客户端不渲染可显式关闭） | `src/alert-notify.ts`、`src/analytics/scan/notify.ts`、`.env.example` | ✅ 已实现并实测（见下） |
| **actionCard 字段形状踩坑（实测 400105）** | 首推被拒：`errcode=400105 不支持类型 msgType:action_card`。根因：`action_card`/`btn_json_list`/`action_url` 是**员工服务台机器人**的字段形状；**自定义机器人（webhook）是驼峰 `actionCard` + `text`（markdown 正文）+ `btns[{title, actionURL}]`**。修正后 errcode=0 送达。教训：钉钉不同机器人面的消息 schema 不同，必须以「自定义机器人」文档为准并以真机推送验证 | `src/alert-notify.ts`(`defaultDingTalkSender`) | ✅ 已修（实测送达） |
| **下载 / 复制能力** | 报告页新增操作栏：**复制表格**（TSV，粘进 Excel 自动分列；含 http 环境的 `execCommand` 降级——报告页常以 `http://内网IP` 打开、非安全上下文没有 async clipboard）/ **下载 Excel** / **下载报告图** / **复制链接**（带 2s 反馈提示）。服务端新增 `GET /analytics/report/:token/export.xlsx`（exceljs 生成：概览 sheet + 明细 sheet，异常行加粗红字；列头用通用对照词「对象/当日/昨日/上周同期/DoD/WoW/状态」不写业务词）。钉钉卡片加第 3 个按钮「下载 Excel」（仅当报告链接为绝对 URL 时配置） | `src/analytics/scan/report-export.ts`（新增）、`src/app.ts`（导出端点）、`src/analytics/scan/notify.ts`（第 3 按钮）、`apps/web/src/pages/AnalyticsReportPage.vue`（操作栏） | ✅ 已实现（实测 xlsx 200/8.7KB、读回校验通过：概览 9 行 + 明细 21 行） |

三条路的取舍（回答"哪个更好实现、都实现"）：

| 路径 | 可行性 | 说明 |
|---|---|---|
| `msgtype=image` + base64（≤2MB） | ❌ **不可实现** | 自定义机器人 webhook 无此类型；要发图片消息得改用「企业内部应用机器人」（appkey/agentId + 上传媒体拿 media_id），属另一套鉴权与链路 |
| markdown + `![](url)` 内嵌图 | ⚠️ 代码已就绪，待公网 base | 唯一内嵌图通道；`url` 必须**公网可达**（已实测私网不显示）。出图 / 托管 / 缓存 / 预检都已完成，只差一个公网域名 |
| 文本图（Unicode 方块柱） | ✅ **当前唯一立刻可见** | 不依赖图片与公网，内网环境唯一能"直接在消息里看到趋势"的方式；默认开启，实测显示正常 |

报告链接 / 图片设计（对齐主流「可分享只读分析快照」做法）：

- 服务端落盘：告警/日报触发时把本次结果（渠道明细 + 阈值预警 + 时间窗 + 问题）写成 JSON，返回 32 位 hex token（不可猜）；文件在 `.data/analytics-reports/<token>.json`。
- 匿名只读端点：`GET /analytics/report/:token`（JSON 快照）、`GET /analytics/report/:token/image.png`（PNG，按 token 缓存 + 并发去重）。token 即访问凭证，无需登录；非法/缺失 404；未配 `ANALYTICS_WEB_BASE_URL` 或无可用浏览器时图片端点回 503，**调用方自动降级**为「文本柱状图 + 链接」。
- 报告页内容：严重度徽标 + 预警横幅（父级结论 + 细分条目）→ 4 个 KPI → 趋势对比（当日/昨日/上周同期分组柱）→ 渠道当日观看人数（横向柱）→ 渠道明细表（DoD/WoW 涨跌着色，异常行高亮）→ 页脚「在对话中核对来源条」深链。图表用项目已有 echarts。
- 长度上限：markdown title ≈180 字符 / text ≈18000 字符；纯 text 载荷仍保留（约 4000 字符）。

生效步骤：
1. `.env` 填 `ANALYTICS_WEB_BASE_URL`（暂填 `http://192.168.50.129:5173`，按实际 host:port 调整）——链接与图片都基于它；
2. 若要**内嵌图**：`ALERT_REPORT_IMAGE=1`，且 `ANALYTICS_WEB_BASE_URL` 必须**公网可达**（已实测私网地址钉钉取不到，会被自动跳过并 warn）；浏览器路径可显式指定 `ALERT_REPORT_CHROME_PATH`；私网自建钉钉能取图时用 `ALERT_REPORT_IMAGE_FORCE=1` 强制；
3. 重启 `agent-server-dev`：`pm2 delete agent-server-dev && pm2 start ecosystem.dev.config.cjs --only agent-server-dev`（加载新代码 + env）；
4. web 重新构建（自动发送生效；vite dev 5173 已 `host:true` 可局域网访问）。

仍未实现（需数据 / 业务对齐，非代码层可解，沿用上文 §一~§三）：真 ROI 监控、投放媒体渠道口径（fb/tt/gg/apple-ads/自然流/裂变拉新/其它）、语言/包体维度接入巡检、曝光→点击→播放→支付 漏斗（CTR/CVR/ROI）、预警后自动下钻。
