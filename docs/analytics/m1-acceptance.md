# Analytics M1 验收清单

计划：[2026-09-09-metabase-analytics-agent-m1.md](../superpowers/plans/2026-09-09-metabase-analytics-agent-m1.md)

- [x] 有权限用户可打开 `/analytics`（路由 + 门户卡片 + 权限键已落地；浏览器登录手测建议再点一次）
- [x] 缺日期 /「最近」会澄清，且不调 Metabase 执行（冒烟 + pipeline 单测）
- [x] 带日期 NL 返回表格 + 时间回显 + SQL 折叠（冒烟 3/3；页面已渲染 timeEcho / ResultTable / details）
- [x] 模型输出的 `uniqExact` 在执行前被归一（`normalizeDistinctCount` 单测 + pipeline）
- [x] 并行 NL 返回 ≥2 张结果表（冒烟 case 3）
- [x] `POST /analytics/ask` 可用（`app.ts` 已挂载；冒烟走同一 `analyticsAsk`）
- [x] MCP `analytics_ask` 在 `/mcp` 可列出/调用（`mcp.ts` 已注册）
- [x] analytics worker 白名单无 `call_api`（`analytics-bi` toolWhitelist 已核对）

## 收尾补丁（M1 后）

- [x] `FROM`/`JOIN` 表白名单一并校验（`extractFromTables`）
