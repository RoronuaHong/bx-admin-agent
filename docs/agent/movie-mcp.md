# movie-mcp —— 观影助手（TMDb）MCP 集成规范

> 现行（live）集成规范，对应 `roles.ts` 的 `movie` 角色与 `skills/movie/SKILL.md`。`docs/agent/` 下以「观影助手」为名的 `VIEWING_ASSISTANT_AGENT.md` 等描述的是旧 PC 后台 Agent 形态，已标记历史；本文件描述当前 movie 角色的 TMDb MCP 接入。

## 1. 概述

观影助手角色的数据源是 **TMDb**（The Movie Database），通过**公共托管的 MCP 服务器**（Streamable HTTP，远程）接入，经 `.env` 的 `MCP_BUILTIN_SERVERS` 注入，serverId 为 `movie`，工具命名空间 `mcp__movie__*`。

- 全部 TMDb 数据工具**只读**（外部数据源）；`roles.ts` 白名单放行该服务器「全部只读工具」（注明约 21 个）。
- 反编造双保险：**人设纪律**（`skills/movie/SKILL.md`：先查真实数据再答、禁止编造）+ **`enforceGrounding` 接地护栏**（`src/grounding.ts`：本轮零工具数据不得收束结论，否则作废文本并回灌纠正/诚实兜底）。

## 2. 接入与角色配置（`roles.ts` 的 `movie` 角色）

| 配置项 | 值 | 作用 |
|---|---|---|
| `defaultMcpServers` | `["movie"]` | 该角色默认启用 TMDb MCP 服务器 |
| `forceEagerTools` | `true` | 21 个电影工具对模型始终可见（通用角色 `TOOL_SEARCH_MODE=auto` 在工具定义超窗口 10% 时切 deferred，弱模型不会主动检索就凭记忆作答 → 编造；movie 工具数 < 上限故强制 eager） |
| `forceToolCall` | `true` | 首轮尝试强制工具调用（逼一次工具通道）；端点不支持 `tool_choice=required` 时由 `chat.ts` 降级 `auto` 并记住，真正的反编造靠人设纪律 + `enforceGrounding` |
| `enforceGrounding` | `true` | 接地护栏：零工具数据不得以正文结论收束（通用角色不开启） |
| `defaultModel` | 不钉死（auto） | 跟随服务端默认（`MODEL_PROVIDERS` 首位），失败按候选链自动切下一个可用模型 |

- transport：**Streamable HTTP**（公共托管，非 stdio）。
- 接地证据判定：`isGroundingEvidenceTool("mcp__movie__*")` 为真（见 `tests/grounding-guard.test.ts`），即这些工具返回算「外部数据证据」。

## 3. 工具清单（来自 `skills/movie/SKILL.md`，前缀 `mcp__movie__`）

**语言硬规则**：每次调用都要传 `language: "zh-CN"`（默认 `en-US`，不传返回英文标题/简介）。

| 工具 | 用途 |
|---|---|
| `movies_search` | 按片名/关键词搜索（电影/剧集/人物），返回**数字 TMDB id**（其它工具的入口） |
| `movies_details` | 一部片/剧详情：简介/类型/时长/多源评分/演职员/预告 |
| `movies_discover` | 按类型/年份/最低评分/最低票数筛选 |
| `movies_trending` | 当下热门（日/周） |
| `movies_similar` | 相似片与「喜欢这部的人还看了」 |
| `movies_reviews` | 用户评论（作者、评分、摘要、链接） |
| `movies_ratings` | 单片多源评分：TMDB / IMDb（+票数）/ IMDb Top250 / Letterboxd Top500 排名 |
| `movies_compare_lists` | IMDb Top250 与 Letterboxd Top500 排名对照 |
| `movies_collection` | 系列/三部曲的观看顺序（按上映排列，含时长与评分） |
| `movies_person` | 影人资料：生平、代表作、导演作品 |
| `movies_keywords` / `movies_companies` | 主题词/制片厂 → TMDB id，供 `movies_discover` 筛选 |
| `tv_season` / `tv_episode` / `tv_episodes` | 剧集分季/单集/全量分集（标题、播出日期、时长、评分、简介） |
| `movies_videos` / `movies_artwork` | 预告片与片段（YouTube）/ 海报、剧照、背景图 |
| `movies_where_to_watch` | 某片在指定国家的流媒体/租买渠道（需 TMDB id；国内平台覆盖有限，如实标注地区） |
| `release_calendar` | 即将上映/正在播出的新片新剧（按地区） |
| `find_by_external_id` / `person_watch_path` | IMDb id（tt…）反查 TMDB id / 某影人的入门片单 |
| `record_watched_movies` | 写入**本地观影画像**（MongoDB，见 `movie/profile.ts`），属本地状态持久化，**非对 TMDb 的外部写入**；不在「只读数据源」约束范围内，但仍属该角色工具集 |

> 工具总数与 `roles.ts` 白名单「约 21 个只读工具」一致；精确集合以 TMDb MCP 服务器实际暴露为准（名称/数量随服务器版本可能微调）。

## 4. 使用纪律（来自 `skills/movie/SKILL.md`）

- **事实只来自工具返回**：工具报错/超时/被限流（公共服务偶发限流正常）时如实说明当前拿不到，不要用记忆补齐详情。
- **剧集与短剧**：数据源覆盖电影与剧集（TV，含分季分集），**没有「短剧」类别**——据实说明，可用相近剧集替代或建议其他榜单，不硬凑。
- **国家/地区分组**：无结构化「出品国」字段，只能用工具 schema 实际可用条件（类型/年份/评分/原始语言/地区）筛选并写明口径；拿不到归属时如实说明。
- **数据来源署名**：涉及 TMDb 数据的回答，必要时末尾带「数据来源：TMDb（themoviedb.org）」。
- **口味记忆**：用户明确表达看过/喜欢/不喜欢时调 `record_watched_movies` 静默记录（带 TMDB id 更准）；不把「推荐给用户的片」当成用户看过的片；当前无推荐界面，不承诺「以后自动推荐」。

## 5. 与历史文档的关系

`docs/agent/VIEWING_ASSISTANT_AGENT.md` 等以「观影助手」为名，但描述的是**旧版 PC 后台 Agent**（`bx-film-admin-in2` 集成：`search_api_module` / `call_api` / `render_table` / `get_list_columns` 等工具），与当前 movie 角色（TMDb MCP）无关，已标记历史。当前观影助手是**活跃角色**，本规范为其现行依据。
