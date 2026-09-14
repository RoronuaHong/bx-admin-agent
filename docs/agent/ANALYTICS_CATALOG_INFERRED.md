# Analytics 无官方说明表（暂存推断）

> 由 `apps/agent-server/config/analytics/catalog-inferred.json` **生成，不要手改本文件**。
> 对照同族已有 Metabase 说明 + 列名推断，**不是仓库官方文档**。官方说明补上后删 JSON 对应条目并重跑 `pnpm --filter @bx/agent-server catalog-digest`。

- 表数：32
- 问数选表会读取 JSON；观看人数 / 完播 / 人均时长默认仍走 `elt_watch_detail`。

## Schema `film_report`

### `film_report.active_user_report_log`

- 对照：`elt_active_guid`、`elt_user_active`
- 本表为活跃用户上报流水，按上报日记录设备/账号的一次活跃事件。对照 elt_active_guid（按天确认设备是否活跃）与 elt_user_active（设备使用时长）。
核心信息：渠道与计划、是否新用户、活跃标记、设备、账号、内容类型、上报日期。
注意事项：
1、这是上报日志，不是「每天去重后的活跃设备集合」；人数请优先 uniq(deviceId) 并带 reportDate。
2、正式活跃口径仍以 elt_active_guid 为准。

### `film_report.active_users_realtime_total_log`

- 对照：`elt_active_guid`
- 本表为实时活跃用户总数快照，每行是一个时间点的合计人数，没有设备明细。对照 elt_active_guid（设备是否活跃）。
核心信息：快照时间、当时活跃用户数。
注意事项：
1、只能看合计曲线，不能按渠道/设备拆。
2、设备级活跃仍用 elt_active_guid。

### `film_report.ad_india_click_report_log`

- 对照：`elt_ap_callback_log`
- 本表为印度广告点击上报流水。结构接近投放/归因日志（计划、组、渠道、设备、内容），不是观影事实。
核心信息：点击时间、设备、计划/组/渠道、内容类型与内容、统计日、分享。
注意事项：
1、人数用 deviceId，不要套观看人数 overlay。
2、channelId 是数字投放渠道，不是 IndiaA 文本码。

### `film_report.ad_india_promote_activity_log`

- 对照：`elt_ul_activity_device`
- 本表为印度广告推广活动参与/上报流水。对照 elt_ul_activity_device（用户参与优惠活动记录）。
核心信息：设备与广告标识（gaid/oaid/imei）、活动、计划/组/渠道、内容、创建/更新时间。
注意事项：
1、这是投放活动日志，不是分层优惠活动配置（elt_ul_activity）。

### `film_report.elt_film_app_channel`

- 对照：`elt_ap_channel`
- 本表为渠道配置维表（渠道包名称、是否推广、下载文案/URL、归属国家、变现方式）。对照 elt_ap_channel（设备在各渠道包上的首访/活跃）。
核心信息：渠道名称、推广状态、下载信息、授权观影、隐藏、国家、变现方式。
注意事项：
1、这是配置表，不是设备活跃事实；查「某渠道有多少人」应走 elt_ap_channel / elt_watch_detail。

### `film_report.elt_film_movie_daily_statistics`

- 对照：`elt_film_movie`
- 本表为影片按日+渠道的统计表，指标来自影片资料上的观影/下载/互动，不是 elt_watch_detail 的设备明细。对照 elt_film_movie（影片资料，含 watchCount/downloadCount/热度）。
核心信息：影片、统计日、渠道、下载/观看/点赞/评论/分享次数、订单数与已结算金额。
注意事项：
1、观看次数是影片侧计数，不是 uniq(guid)。
2、时间列优先 day（统计日），不要用影片 updateTime。

### `film_report.elt_film_movie_episode2`

- 对照：`elt_film_movie_episode`
- 本表为剧集媒体变体切片（时长、分辨率、语言、体积），对照正式剧集资料 elt_film_movie_episode。
核心信息：剧集ID、时长、分辨率、语言、存储大小。
注意事项：
1、无业务事件时间列；问「有多少条」用 count，不要套 lastWatchTime。
2、剧集中英文名/片头片尾仍以 elt_film_movie_episode 为准。

### `film_report.elt_film_movie_episode3`

- 对照：`elt_film_movie_episode`
- 本表为剧集媒体变体的更窄切片（时长、分辨率、体积），对照 elt_film_movie_episode。
核心信息：剧集ID、时长、分辨率、存储大小。
注意事项：
1、无业务事件时间列。
2、正式剧集资料用 elt_film_movie_episode。

### `film_report.elt_film_movie_video_play_error`

- 对照：`elt_film_movie`、`elt_watch_detail`
- 本表为影片播放错误上报。对照 elt_film_movie（影片）与 elt_watch_detail（成功观影明细）：本表只记失败/卡顿类错误，不是观看人数。
核心信息：用户/设备、影片与剧集、错误码与信息、播放地址、网络与 IP 地理、码率场景、创建时间。
注意事项：
1、人数用 guid 或 deviceId。
2、不要与观看人数、完播口径混用。

### `film_report.elt_invite_user`

- 对照：`elt_invite_invitee`
- 本表为邀请人（邀请者）账户与进度宽表。对照 elt_invite_invitee（受邀人明细）。
核心信息：邀请者账号/设备、上级、渠道、邀请步骤、是否有受邀人、分享页浏览/下载/安装、成功邀请人数、提现银行与联系方式。
注意事项：
1、查「请来了多少人」看 successInviteUserCount 或关联 elt_invite_invitee。
2、提现流水在 elt_invite_withdraw。

### `film_report.elt_invite_withdraw`

- 对照：`elt_invite_invitee`、`elt_film_order`
- 本表为邀请提现申请单（邀请赚钱兑会员），对照 elt_invite_invitee（邀请关系）与 elt_film_order（订单支付状态机）。
核心信息：申请人、渠道、提现金额与余额、申请单号与审核、支付单号与支付时间、是否退款。
注意事项：
1、金额用 sum(amount)，时间列优先 payTime（已支付）或 createTime（申请）。
2、不是观影表，不要套观看人数。

### `film_report.elt_sport_activity_guess`

- 对照：`elt_ul_activity_device`
- 本表为体育竞猜参与记录（谁赢、是否猜对、是否结算）。对照 elt_ul_activity_device（活动参与）。充值日志里的「板球竞猜积分兑换」是兑奖入账，不是本表。
核心信息：账号/设备、比赛、竞猜选项、是否正确、是否结算、渠道、创建时间。
注意事项：
1、人数用 guid 或 uid。
2、中奖与提现看 elt_sport_activity_winner。

### `film_report.elt_sport_activity_winner`

- 对照：`elt_sport_activity_guess`
- 本表为体育竞猜中奖与兑奖状态。对照竞猜参与表 elt_sport_activity_guess。
核心信息：设备、中奖场次与金额、分享次数、提现状态、渠道。
注意事项：
1、中奖金额 winAmount；提现状态 withdrawStatus。
2、不是会员充值订单。

### `film_report.elt_ul_user_group_36`

- 对照：`elt_user_group`、`elt_user_group_ex`
- 本表为人群包 36 的设备清单，仅 guid 一列。对照 elt_user_group（按天人群包结果）与 elt_user_group_ex（带 TTL 的限时人群包）。
核心信息：设备是否在该固定人群包中。
注意事项：
1、无时间列，count/uniq(guid) 即为包内规模。
2、按天变化的人群包请用 elt_user_group。

### `film_report.elt_user_group_config`

- 对照：`elt_user_group`
- 本表为人群包配置维表（名称、是否启用、刷新周期、覆盖渠道/国家）。对照 elt_user_group（每天算出的设备结果）。
核心信息：人群名称、备注、人数快照、刷新时间、启用状态、渠道与国家、刷新周期。
注意事项：
1、count 字段是配置上的规模快照，不是当天实时计算结果。
2、某设备在不在包里，查 elt_user_group。

### `film_report.elt_user_login_history`

- 对照：`elt_film_user`
- 本表为账号登录历史流水。对照 elt_film_user（账号资料，含 lastLoginTime）。
核心信息：账号、昵称、设备、IP、国家、渠道、登录方式、登录时间。
注意事项：
1、登录次数 count()；登录人数 uniq(uid) 或 uniq(guid)。
2、时间列 createdTime。

### `film_report.elt_watch_detail_lang`

- 对照：`elt_watch_detail`
- 本表为观影明细用的语言对照维表（源语言→目标语言）。对照 elt_watch_detail 的 contentLang / 字幕 / 音轨。
核心信息：src_lang、target_lang。
注意事项：
1、不是观影事实，无时间列。
2、观看人数/完播仍走 elt_watch_detail。

### `film_report.film_user_device_info_simple`

- 对照：`elt_user_guid`、`elt_film_user`
- 本表为账号与设备的简易对照（uid↔deviceId）。对照 elt_user_guid（近 6 个月设备-账号关联）与 elt_film_user（账号资料）。
核心信息：账号 UID、设备 ID。
注意事项：
1、无时间列，只做对照，不替代活跃/观影事实。

### `film_report.film_user_simple`

- 对照：`elt_film_user`
- 本表为账号资料的精简切片（手机、登录方式、邮箱）。对照完整账号表 elt_film_user。
核心信息：UID、手机区号与手机号、登录方式、邮箱。
注意事项：
1、无时间列；资料字段不全（无生日/会员/渠道）。
2、完整资料与注册时间用 elt_film_user。

### `film_report.mv_elt_active_guid_2`

- 对照：`elt_active_guid_2`
- 本表为 elt_active_guid_2 的物化/裁剪视图：设备 + 渠道 + 最后活跃日。对照 elt_active_guid_2（设备维活跃，含 activeDates 数组，查询需带 guid）。
核心信息：guid、channel、latestActiveDate。
注意事项：
1、比原表轻，适合「最后活跃日」；完整活跃日期列表仍在 elt_active_guid_2。
2、按天是否活跃用 elt_active_guid。

### `film_report.user_preference_actions_report`

- 对照：`elt_watch_detail`、`action`
- 本表为用户观影偏好行为汇总（点赞/收藏等行为按影片类型、国家、标签计数）。对照 elt_watch_detail（观看）与 gather.action（主动行为埋点）。
核心信息：设备、行为类型、影片类型、国家、标签、会员类型、行为时间、影片、次数。
注意事项：
1、这是行为计数，不是观看时长/完播。
2、时间列 actionTime。

### `film_report.user_watch_movie_activity_device_log`

- 对照：`user_watch_movie_activity_log`、`elt_watch_detail`
- 本表为旧版「设备日观影活动」上报。同系列 user_watch_movie_activity_log 已标明不再使用、由每天观影明细（新）elt_watch_detail 替换。
核心信息：设备/账号、影片类型、是否完播、渠道、上报日、是否登录/新用户。
注意事项：
1、默认不要用本表回答观看人数/完播；请用 elt_watch_detail。
2、仅在明确点名本表时查询。

### `film_report.watch_log`

- 对照：`elt_watch_detail`
- 本表为观影事件流水（单次上报），字段与 elt_watch_detail 高度同构（guid/影片/剧集/时长/进度/字幕音轨/分辨率）。elt_watch_detail 是按天按排序键汇总去重后的正式口径。
核心信息：设备/账号、渠道、会员、观影时间、影片与剧集、时长与进度、是否离线、字幕/音轨/分辨率、网络。
注意事项：
1、观看人数/完播/人均时长默认仍走 elt_watch_detail。
2、只有用户点名「观影日志/watch_log」时才查本表；时间列 watchTime。

## Schema `gather`

### `gather.action_config`

- 对照：`action`
- 本表为 gather.action 的行为配置维表（行为名称、参数字段映射）。对照 action（近 2 个月用户主动行为埋点）。
核心信息：行为ID、行为名称、参数映射。
注意事项：
1、不是行为发生事实；发生次数查 action，并必须带事件时间（最多约 10 天）。

### `gather.action_config_detail_entry`

- 对照：`action`、`action_config`
- 本表为行为配置中的「影片详情页入口」枚举源。对照 action / action_config。
核心信息：入口 ID、入口名称。
注意事项：
1、维表，无时间列。同系列 _dict 表已隐藏不可查。

### `gather.buffer`

- 对照：`gather`、`elt_watch_detail`
- 本表为播放缓冲/卡顿埋点，结构接近 gather（guid/渠道/时间）并带影片播放技术字段。不是观看人数口径。
核心信息：服务器/客户端时间、设备与账号、影片与剧集、缓冲起止与时长、码率/帧率/H265、快进快退暂停次数。
注意事项：
1、数据量大，必须带 serverTime，时间窗宜短。
2、观影时长/完播用 elt_watch_detail。

### `gather.event_config`

- 对照：`gather`
- 本表为 gather 埋点事件配置维表（事件名、触发位置、参数映射）。对照 gather（近 2 个月埋点事实）。
核心信息：事件名称、备注、触发位置、参数映射。
注意事项：
1、不是事件发生事实；次数与人数查 gather / gather_stat。

### `gather.gather_stat`

- 对照：`gather`
- 本表为 gather 埋点的按日+事件汇总。对照 gather（明细，单窗最多约 5 天）。
核心信息：统计日、事件名、事件次数、活跃用户数。
注意事项：
1、看某事件每天多少次/多少人，优先本表，不必扫 gather 明细。时间列 `date`（统计日），不要用写入时间 createTime。
2、要维度拆分（渠道/语言）仍需 gather 明细。

### `gather.gather_stat_view`

- 对照：`gather`、`gather_stat`
- 本表为 gather_stat 的视图裁剪（日期、事件、次数、活跃用户）。对照 gather_stat。
核心信息：统计日、事件名、事件次数、活跃用户数。
注意事项：
1、与 gather_stat 同口径；无 createTime，时间列用 date。

### `gather.gather_t`

- 对照：`gather`
- 本表为 gather 的同源埋点流水变体（含 host/domain/webDeviceId 与多组 ext）。对照 gather。
核心信息：事件名、设备/账号、渠道、客户端时间、扩展参数。
注意事项：
1、按 gather 同样处理：必须带 createTime，窗不宜长。
2、默认埋点问数仍优先 gather；点名 gather_t 再用本表。

### `gather.gather_w`

- 对照：`gather`
- 本表为 gather 的窄切片（事件名、设备、两个扩展字段）。对照 gather。
核心信息：eventName、guid、ext2、ext6。
注意事项：
1、无时间列，只能做去重/计数，不能按日过滤。
2、正式分析用 gather 或 gather_stat。

### `gather.gather_w2`

- 对照：`gather`
- 本表为 gather 的更窄切片（设备 + 两个扩展字段）。对照 gather。
核心信息：guid、ext2、ext6。
注意事项：
1、无事件名、无时间列。
2、正式分析用 gather 或 gather_stat。
