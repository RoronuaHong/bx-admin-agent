# Analytics Metabase 表结构说明（自动生成）

> 由 live catalog 生成，**不要手改**。刷新：`pnpm --filter @bx/agent-server catalog-digest`

- 生成时间：2026-09-14T06:54:46.737Z
- metadata 拉取：2026-09-14T06:54:46.015Z
- 数据库：Metabase db 2
- 表：71（可答 67，隐藏 4）
- 字段：1045（其中 284 个有 Metabase description）

## 怎么用

- 问数 agent 用这份说明对表/列；已建模 KPI 由代码编译，其余由模型对着目录写 SQL。
- 观影人数 / 完播 / 人均时长：默认 `elt_watch_detail` + overlay 口径。
- 其它可答表：按文档/字段检索后写 SQL，不要求用户先点名表。
- `_tmp` / `_dict` / `upload_*` 不可查。
- 无表级 description 的表：暂存推断见 [ANALYTICS_CATALOG_INFERRED.md](./ANALYTICS_CATALOG_INFERRED.md)。

## 隐藏表（不可查询）

- `film_report.elt_user_full_tmp`
- `film_report.elt_watch_detail_lang_dict`
- `gather.action_config_detail_entry_dict`
- `metabase_upload.upload_test`

## Schema `film_report`

### `film_report.active_user_report_log`

- active_user_report_log（Active User Report Log）
- 时间列：`reportDate`
- 说明：无表级说明；18 列
- 字段 18，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `id` | ID | BigInteger |  |
| `channelId` | ChannelId | BigInteger |  |
| `planId` | PlanId | BigInteger |  |
| `groupsId` | GroupsId | BigInteger |  |
| `appChannelId` | AppChannelId | Integer |  |
| `isNewUser` | IsNewUser | Integer |  |
| `activity` | Activity | Integer |  |
| `appVersion` | AppVersion | Text |  |
| `countryId` | CountryId | Integer |  |
| `reportDate` | ReportDate | DateTime |  |
| `deviceId` | DeviceId | Text |  |
| `uid` | UID | BigInteger |  |
| `packageName` | PackageName | Text |  |
| `contentType` | ContentType | Integer |  |
| `contentId` | ContentId | BigInteger |  |
| `isOldAccount` | IsOldAccount | Boolean |  |
| `logged` | Logged | Boolean |  |
| `createdTime` | CreatedTime | DateTime |  |

### `film_report.active_users_realtime_total_log`

- active_users_realtime_total_log（Active Users Realtime Total Log）
- 时间列：`createdTime`
- 说明：无表级说明；2 列
- 字段 2，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `createdTime` | CreatedTime | DateTime |  |
| `activeUserCount` | ActiveUserCount | Integer |  |

### `film_report.ad_india_click_report_log`

- ad_india_click_report_log（Ad India Click Report Log）
- 时间列：`createdTime`
- 说明：无表级说明；19 列
- 字段 19，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `id` | ID | BigInteger |  |
| `createdTime` | CreatedTime | DateTime |  |
| `clientType` | ClientType | Integer |  |
| `sh` | Sh | Integer |  |
| `sw` | Sw | Integer |  |
| `deviceId` | DeviceId | Text |  |
| `ext` | Ext | Text |  |
| `groupsId` | GroupsId | BigInteger |  |
| `planId` | PlanId | BigInteger |  |
| `channelId` | ChannelId | BigInteger |  |
| `ua` | Ua | Text |  |
| `ip` | IP | Text |  |
| `deviceSign` | DeviceSign | Text |  |
| `packageName` | PackageName | Text |  |
| `eventType` | EventType | Integer |  |
| `contentType` | ContentType | Integer |  |
| `contentId` | ContentId | BigInteger |  |
| `statisticsDate` | StatisticsDate | DateTime |  |
| `shareId` | ShareId | BigInteger |  |

### `film_report.ad_india_promote_activity_log`

- ad_india_promote_activity_log（Ad India Promote Activity Log）
- 时间列：`createdTime`
- 说明：无表级说明；19 列
- 字段 19，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `id` | ID | BigInteger |  |
| `clientType` | ClientType | Integer |  |
| `deviceId` | DeviceId | Text |  |
| `activity` | Activity | Integer |  |
| `groupsId` | GroupsId | BigInteger |  |
| `planId` | PlanId | BigInteger |  |
| `channelId` | ChannelId | BigInteger |  |
| `appChannelId` | AppChannelId | Integer |  |
| `packageName` | PackageName | Text |  |
| `contentType` | ContentType | Integer |  |
| `contentId` | ContentId | Integer |  |
| `googleDeviceId` | GoogleDeviceId | Text |  |
| `gaid` | Gaid | Text |  |
| `androidId` | AndroidId | Text |  |
| `oaid` | Oaid | Text |  |
| `imei` | Imei | Text |  |
| `createdTime` | CreatedTime | DateTime |  |
| `updatedTime` | UpdatedTime | DateTime |  |
| `_id` | ID | Integer |  |

### `film_report.elt_active_guid`

- elt_active_guid（每天日活用户表）
- 时间列：`activeDate`
- 说明：记录最近1年每天的活跃用户，存储为每天一个分区，按排序键去重。
核心信息：可通过内联（inner join）此表来确认一个设备是否活跃。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过10天的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `activeDate` | 日期 | Date |  |

### `film_report.elt_active_guid_2`

- elt_active_guid_2（用户活跃日期表）
- 时间列：`latestActiveDate`
- 说明：记录每个设备的活跃日期，此表是以设备维度记录活跃数据，elt_active_guid是以天的维度记录活跃数据。
核心信息：最后活跃日期，活跃日期列表
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
2、本表还有一个activeDates字段，记录设备活跃过的日期列表。
2、本表使用AggregatingMergeTree引擎，必须指定guid作为查询条件（不指定限制数目的查询条件容易OOM），并使用类似语句进行聚合方能得到结果：
SELECT
    guid,
    anyLast(channel) AS channel,
    max(latestActiveDate) AS latestActiveDate,
    arraySort(groupUniqArrayMerge(activeDates)) AS activeDates
FROM elt_active_guid_2 where guid in ('00b50716b5e04a32a25d59aee1f2adbf2310')
GROUP BY guid
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `channel` | 渠道 | Text |  |
| `latestActiveDate` | 最后活跃日期 | Date |  |

### `film_report.elt_ap_callback_log`

- elt_ap_callback_log（用户召回日志表）
- 时间列：`ct`
- 说明：本表记录用户召回的信息，存储按创建时间每天一个分区，按排序键去重。
核心信息：当前渠道最近两次的访问时间和两次的间隔天数、渠道无关的最近两次的访问时间和间隔天数
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
2、本表为召回用户判定的关键依赖数据。如果仅想知道是否为召回用户，elt_callback_guid表是更便捷的选择。
- 字段 8，其中 6 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `ch` | 渠道 | Text |  |
| `ct` | 本次当前渠道的访问时间 | DateTime |  |
| `ut` | 上次当前渠道的访问时间 | DateTime | 召回只发生在相同渠道，所以上次访问的渠道跟本次渠道相同 |
| `ds` | 两次当前渠道访问间隔天数 | Integer | 值为本次当前渠道的访问时间减去上次当前渠道的访问时间，即ds=ct-ut |
| `fch` | 本次之前活跃的渠道 | Text | 可能与本次渠道相同、也可能不同 |
| `fut` | 本次之前最后活跃的时间 | DateTime | 可能与本次渠道相同、也可能不同 |
| `fds` | 两次访问间隔天数 | Integer | 值为本次当前渠道的访问时间减去本次之前最后活跃的时间，即fds=ct-fut |

### `film_report.elt_ap_channel`

- elt_ap_channel（用户渠道表）
- 时间列：`ct`
- 说明：本表记录每个设备在每个渠道包的信息，存储按创建时间每月一个分区，按排序键去重。
核心信息：设备首访时间、当前渠道的首访/最近活跃时间、之前活跃渠道、之前渠道的最后活跃时间。
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
2、本表为次新用户判定的关键依赖数据。如果仅想知道是否为次新用户，elt_channel_new_guid或elt_channel_new_90_guid表是更便捷的选择。
- 字段 7，其中 4 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `ch` | 当前渠道 | Text |  |
| `pch` | 之前活跃的渠道 | Text | 如果之前没有访问过其他渠道包，为空 |
| `ct` | 设备在当前渠道的首访时间 | DateTime |  |
| `ut` | 设备在当前渠道的最近访问时间 | DateTime |  |
| `put` | 之前渠道的最后活跃时间 | DateTime | 渠道变换时保存下来后不再变化 |
| `dct` | 设备首访时间 | DateTime | 设备在整个应用中的首访时间，跟渠道无关 |

### `film_report.elt_app_params`

- elt_app_params（设备明细表）
- 时间列：`createTime`
- 说明：设备详细资料表。存储按创建时间每月一个分区，按排序键去重。
核心信息：多个标识资料、多个设备基础资料、IP资料、网络资料、apk包资料、安装资料、安装天数、累计活跃天数。
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
- 字段 96，其中 46 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `createTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `uid` | 最近活跃UID | BigInteger |  |
| `createIp` | 首次IP | Text |  |
| `updateIp` | 最近IP | Text |  |
| `screenWidth` | 屏幕宽度 | Integer |  |
| `screenHeight` | 屏幕高度 | Integer |  |
| `devicePixelRatio` | 设备像素比 | Text |  |
| `gpuVendor` | gpu供应商 | Text |  |
| `gpuRenderer` | gpu型号 | Text |  |
| `gaid` |  | Text | Google广告ID |
| `androidId` | AndroidId | Text |  |
| `mediaDrm` | MediaDrm | Text | 数字版权标识ID |
| `firebaseId` | FirebaseId | Text | firebase标识ID |
| `fcmToken` | FcmToken | Text | firebase推送token |
| `customDeviceId` | CustomDeviceId | Text | 自定义的设备ID |
| `deviceType` | 设备类型 | Text | 映射关系：mobile：手机，tablet：平板，tv：电视，car：车载，watch：手表 |
| `deviceBrand` | 设备品牌 | Text |  |
| `deviceName` | 设备名称 | Text |  |
| `osName` | 操作系统名称 | Text |  |
| `osVersion` | 操作系统版本 | Text |  |
| `buildId` | BuildId | Text |  |
| `board` | 主板名称 | Text |  |
| `hardware` | 硬件名称 | Text |  |
| `cpuAbi` | CPU指令集 | Text |  |
| `cpuAbi2` | CPU指令集2 | Text |  |
| `cpuName` | CPU名称 | Text |  |
| `manufacturer` | 设备制造商 | Text |  |
| `fingerprint` | 设备指纹 | Text |  |
| `product` | 产品名称 | Text |  |
| `device` | Device | Text |  |
| `socManufacturer` | SocManufacturer | Text |  |
| `socModel` | SocModel | Text |  |
| `bootLoader` | BootLoader | Text |  |
| `radio` | Radio | Text |  |
| `sku` | Sku | Text |  |
| `odmSku` | OdmSku | Text |  |
| `display` | Display | Text |  |
| `host` | Host | Text |  |
| `tags` | Tags | Text |  |
| `sdkVersion` | SdkVersion | Text |  |
| `baseBandVersion` | BaseBandVersion | Text | 基带版本 |
| `ramTotal` | 内存大小 | BigInteger |  |
| `storageTotal` | 内部存储大小 | BigInteger |  |
| `apkVersionName` | Apk包版本名称 | Text |  |
| `apkVersionCode` | Apk包版本号 | Text |  |
| `apkPackageName` | Apk包名 | Text |  |
| `apkChannel` | 最近使用的渠道 | Text |  |
| `apkSignMd5sn` | ApkSignMd5sn | Text | md5签名 |
| `apkSignSha1sn` | ApkSignSha1sn | Text | sha1签名 |
| `apkSignSha256sn` | ApkSignSha256sn | Text | sha256签名 |
| `apkType` | ApkType | Text | apk包类型 |
| `elapsedRealtime` | 系统开机时间 | Text | 单位毫秒 |
| `buildTime` | BuildTime | Text |  |
| `networkOperatorName` | 网络运营商名称 | Text |  |
| `networkOperatorCode` | 网络运营商代码 | Text |  |
| `networkMcc` | 网络MCC | Text |  |
| `networkType` | 网络类型 | Text | 2G/3G/WIFI等 |
| `phoneType` | PhoneType | Text | GSM/CDMA等 |
| `networkCountryIso` | NetworkCountryIso | Text | 移动网络国家代码 |
| `localeIso3Language` | 系统语言缩写 | Text | 3字母的ISO标准 |
| `localeIso3Country` | 系统国家设置缩写 | Text | 3字母的ISO标准 |
| `timeZoneId` | 时区ID | Text |  |
| `cid` | Cid | Text | 基站编号 |
| `simCount` | SimCount | Text | sim卡数量 |
| `simImsi` | SimImsi | Text | Sim卡移动用户身份 |
| `simSn` | SimSn | Text | Sim卡序列号 |
| `simNum` | SimNum | Text | Sim卡手机号 |
| `simCountryIso` | SimCountryIso | Text | Sim卡国家代码 |
| `simOperatorName` | SimOperatorName | Text | Sim卡运营商名称 |
| `root` | Root | Boolean | 设备是否有Root权限 |
| `proxy` | Proxy | Boolean | 是否使用网络代理 |
| `usbDebug` | UsbDebug | Boolean | 设备是否处于调试模式 |
| `simulator` | Simulator | Boolean | 是否模拟器 |
| `mockLocation` | MockLocation | Boolean | 是否使用模拟位置 |
| `vpn` | Vpn | Boolean | 是否使用VPN |
| `canNewInvite` | CanNewInvite | Boolean | 是否可以邀请，新设备默认为true，存量设备为null则为false |
| `newInviteRemarks` | NewInviteRemarks | Array | 邀请备注 |
| `ipHistory` | IpHistory | Array | 曾用IP，保留最近5个 |
| `startMs` | StartMs | BigInteger | 距离App启动的毫秒数 |
| `notify` | Notify | Boolean | 是否允许推送 |
| `reqLang` | ReqLang | Text | 请求带的语言参数 |
| `ipCountryCode` | IpCountryCode | Text | IP信息中的国家编码 |
| `ipRegionName` | IpRegionName | Text | IP信息中的区域名称 |
| `ipAreaCode` | IpAreaCode | Text | IP信息中的大区域编码 |
| `createApkChannel` | 首访时的渠道 | Text |  |
| `lastUpdateTime` | 上次更新时间 | DateTime |  |
| `firstInstallTime` | FirstInstallTime | BigInteger | App安装时间，时间戳，毫秒 |
| `dataDirLastModified` | DataDirLastModified | BigInteger | App数据目录最后修改时间，时间戳，毫秒 |
| `countryCode` | CountryCode | Integer | 自定义的国家代号，映射关系：91：印度，92：巴基斯坦，55：巴西，52：墨西哥，880：孟加拉 |
| `ipCity` | IpCity | Text | IP信息中的城市 |
| `ipIsp` | IpIsp | Text | IP信息中的ISP |
| `createMode` | CreateMode | Integer | 创建模式，1：AB面包安全模式创建，其他值为普通模式创建 |
| `activeDays` | 累计活跃天数 | Integer |  |
| `contentLang` | ContentLang | Text |  |

### `film_report.elt_callback_guid`

- elt_callback_guid（每天召回用户表）
- 时间列：`createDate`
- 说明：记录最近1年每天的召回用户，存储为每天一个分区，按排序键去重。
核心信息：可通过内联（inner join）此表来确认一个设备是否召回。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `createDate` | 日期 | Date |  |

### `film_report.elt_channel_new_90_guid`

- elt_channel_new_90_guid（每天次新（90天内）用户表）
- 时间列：`createDate`
- 说明：记录最近1年每天的90天内次新用户，存储为每天一个分区，按排序键去重。
核心信息：可通过内联（inner join）此表来确认一个设备是否90天内次新。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `createDate` | 时间 | Date |  |

### `film_report.elt_channel_new_guid`

- elt_channel_new_guid（每天次新用户表）
- 时间列：`createDate`
- 说明：记录最近1年每天的次新用户，存储为每天一个分区，按排序键去重。
核心信息：可通过内联（inner join）此表来确认一个设备是否次新。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `createDate` | 日期 | Date |  |

### `film_report.elt_film_app_channel`

- elt_film_app_channel（渠道配置表）
- 时间列：`createTime`
- 说明：_id: 渠道的唯一标识；name: 渠道名称；promotionStatus: 是否在推广；remark: 备注
- 字段 11，其中 2 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | Integer | 渠道的唯一标识 |
| `name` | 渠道名称 | Text |  |
| `promotionStatus` | 是否在推广 | Boolean |  |
| `remark` | 备注 | Text |  |
| `downloadText` | 渠道包下载展示文本 | Text |  |
| `downloadUrl` | 渠道包下载URL | Text |  |
| `isAuthorized` | 是否授权观影 | Boolean |  |
| `createTime` | 创建时间 | DateTime |  |
| `hide` | 是否隐藏 | Boolean |  |
| `countryIds` | 归属国家ID | Array |  |
| `earnWay` | 变现方式 | Integer | 映射关系：0：不开启；1：仅广告；2：仅会员；3：广告+会员 |

### `film_report.elt_film_movie`

- elt_film_movie（影片数据表）
- 时间列：`onlineTime`
- 说明：本表为影片资料表，一个影片可包含多个剧集。
核心信息：中英文名称、原名称、评分、影片类型、上线时间、影片状态、标签、国家、语言、季信息、集数、观影次数、下载次数、热度
- 字段 27，其中 13 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger | 影片的唯一标识 |
| `titleCn` | 中文名称 | Text |  |
| `titleEn` | 英文名称 | Text |  |
| `originalTitle` | 原名称 | Text |  |
| `score` | 评分 | Float |  |
| `movieType` | 影片类型 | Integer | 映射关系：1：电视剧，2：电影，3：真人秀，4：短剧，5：动漫 |
| `onlineTime` | 上线时间 | DateTime |  |
| `publishTime` | 发布时间 | DateTime |  |
| `status` | 影片状态 | Integer | 映射关系：1:上线，2:下架，3:待审核，4:审核不通过 |
| `newTags` | 标签列表 | Array | 列表中元素为元组，元组第1个元素为标签ID，第2个元素为标签中文名，第2个元素为标签英文名 |
| `newCountries` | 国家列表 | Array | 列表中元素为元组，元组第1个元素为国家ID，第2个元素为国家中文名，第2个元素为国家英文名 |
| `newLanguages` | 语言列表 | Array | 列表中元素为元组，元组第1个元素为语言ID，第2个元素为语言中文名，第2个元素为语言英文名 |
| `seasonNumber` | 季序号 | Integer | 所属季，如第一季、第二季 |
| `seasonVersion` | 特殊季名称 | Text | 比如番外篇、特别版等 |
| `totalNumber` | 集数 | Integer |  |
| `updateNumber` | 最新集序号 | Integer | 更新到第几集集 |
| `watchCount` | 观看次数 | BigInteger |  |
| `downloadCount` | 下载次数 | BigInteger |  |
| `heat` | 最近六个月热度 | BigInteger | 热度=播放次数+下载次数 |
| `heatOfSevenDay` | 七天热度 | BigInteger | 七天热度，根据最近7天内进入影片详情统计。 |
| `honorTag` | 荣誉标签 | Text |  |
| `createdTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `containsEpisode` | 是否包含剧集 | Boolean |  |
| `severity` | 严重级别 | Integer | 映射关系：0：没有，1：轻微，2：中等，3：严重 |
| `memberLevel` | 需要的会员级别 | Integer | 影片需要观看需要的会员级别，2为会员，其他为非会员 |
| `woolUser` | 是否限制高频未充值用户 | Boolean |  |

### `film_report.elt_film_movie_category`

- elt_film_movie_category（影片专辑表）
- 时间列：`createdTime`
- 说明：本表为影片专辑资料表，一个专辑可包含多条内容。
核心信息：中英文名称、类型、跳转类型
- 字段 22，其中 4 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger | 专辑唯一标识 |
| `nameCn` | 中文名称 | Text |  |
| `nameEn` | 英文名称 | Text |  |
| `type` | 类型 | Integer | 映射关系：1:常规分类 2:即将上线 3:大图分类 4:横幅 5:电影题材分类 6:影星分类 7:影视速递 8:高级会员专享 12:短剧 13:在线人数最多  14:动漫更新 |
| `redirectType` | 跳转类型 | Integer | 映射关系：1:影片详情  2:人物详情 3:影片专题  4:链接跳转 5:影视速递专题 6:高级会员专享 7:短剧专题 |
| `parentId` | 父专辑ID | BigInteger |  |
| `coverImage` | 封面图片 | Text |  |
| `coverImageHeight` | 封面图片高度 | Integer |  |
| `coverImageWidth` | 封面图片宽度 | Integer |  |
| `startDate` | 开始启用时间 | DateTime |  |
| `endDate` | 结束启用时间 | DateTime |  |
| `enable` | 是否启用 | Boolean |  |
| `isBuiltIn` | 是否是系统内置项 | Boolean |  |
| `order` | 排序 | Integer |  |
| `briefIntroductionCn` | 专题中文简介 | Text |  |
| `briefIntroductionEn` | 专题英文简介 | Text |  |
| `count` | 数量 | Integer |  |
| `createdTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `locationId` | 广告位ID | Integer |  |
| `channelIds` | 支持的渠道Id列表 | Array |  |
| `secure` | 内容A/B面 | Integer | 1:安全面，其实值为正常面 |

### `film_report.elt_film_movie_category_content`

- elt_film_movie_category_content（影片专辑内容表）
- 时间列：`createdTime`
- 说明：本表为影片专辑内容表，一个专辑可包含多个影片，一个影片可归属多个专辑，是人为设定的关联关系。
核心信息：所属专题、中英文名称、跳转类型、跳转目标
- 字段 11，其中 4 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger | 专辑内容唯一标识 |
| `movieCategoryId` | 所属专辑ID | BigInteger |  |
| `coverImage` | 封面图片 | Text |  |
| `redirectType` | 跳转类型 | Integer | 映射关系：1:影片详情 2:人物详情 3:影片专题 4:以URL方式跳转至APP内浏览器  5:以URL方式跳转至系统浏览器 |
| `redirectId` | 跳转目标ID | BigInteger | 例如：跳转类型为影片详情，目标ID即为影片ID |
| `redirectUrl` | 跳转Url | Text | 例如：跳转类型为浏览器，需提供跳转url |
| `order` | 排序 | Integer |  |
| `titleCn` | 中文名称 | Text |  |
| `titleEn` | 英文名称 | Text |  |
| `createdTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |

### `film_report.elt_film_movie_daily_statistics`

- elt_film_movie_daily_statistics（Elt Film Movie Daily Statistics）
- 时间列：`day`
- 说明：无表级说明；14 列
- 字段 14，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `movieId` | MovieId | BigInteger |  |
| `day` | Day | DateTime |  |
| `channelId` | ChannelId | Integer |  |
| `channelName` | ChannelName | Text |  |
| `downloadCount` | DownloadCount | BigInteger |  |
| `watchCount` | WatchCount | BigInteger |  |
| `likeCount` | LikeCount | BigInteger |  |
| `unlikeCount` | UnlikeCount | BigInteger |  |
| `commentCount` | CommentCount | BigInteger |  |
| `clickShareCount` | ClickShareCount | BigInteger |  |
| `createTime` | CreateTime | DateTime |  |
| `orders` | Orders | Integer |  |
| `settledOrders` | SettledOrders | Integer |  |
| `settledAmount` | SettledAmount | Integer |  |

### `film_report.elt_film_movie_episode`

- elt_film_movie_episode（剧集数据表）
- 时间列：`createdTime`
- 说明：本表为剧集资料表，一个影片可包含多个剧集。
核心信息：所属影片、剧集序号、中英文名称、全片时长、片头片尾时长、会员等级限制、字幕、音轨、分辨率、存储大小
- 字段 18，其中 11 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger | 剧集唯一标识 |
| `movieId` | 影片ID | BigInteger | 所属影片ID |
| `number` | 当前集序号 | Integer | 1为第一集，2为第二集等 |
| `titleCn` | 中文名称 | Text |  |
| `titleEn` | 英文名称 | Text |  |
| `languageId` | 剧集默认的语言ID | BigInteger |  |
| `languageNameCn` | 剧集默认的语言的中文名称 | Text | 如中文、英文等 |
| `languageNameEn` | 剧集默认的语言的英文名称 | Text |  |
| `duration` | 全片时长(秒) | Integer | 剧集全片时长，单位秒 |
| `episodeOpeningTime` | 片头时长(秒) | Integer | 剧集片头时长，单位秒 |
| `episodeEndingTime` | 片尾时长(秒) | Integer | 剧集片尾时长，单位秒 |
| `createdTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `visible` | 是否可见 | Boolean |  |
| `memberLevel` | 需要的会员级别 | Integer | 影片需要观看需要的会员级别，2为会员，其他为非会员 |
| `videos` | 视频列表 | Array | 剧集包含的视频列表，以分辨率区分，列表中元素为元组，元组第1个元素为分辨率，第2个元素为存储大小，分辨率的映射关系：0：流畅，1：标清（480P），2：高清（720P），3：超清（1080P），4：4K |
| `subtitles` | 字幕列表 | Array | 剧集包含的字幕列表，以语言区分，列表中元素为元组，元组第1个元素为语言ID，第2个元素为语言的中文名称，第3个元素为语言的英文名称，第4个元素为是否AI字幕 |
| `tracks` | 音轨列表 | Array | 剧集包含的音轨列表，以语言区分，列表中元素为元组，元组第1个元素为语言ID，第2个元素为语言的中文名称，第3个元素为语言的英文名称，第4个元素为是否默认音轨 |

### `film_report.elt_film_movie_episode2`

- elt_film_movie_episode2（Elt Film Movie Episode2）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；6 列
- 字段 6，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `duration` | Duration | Integer |  |
| `resolution` | Resolution | Integer |  |
| `languageId` | LanguageId | BigInteger |  |
| `languageName` | LanguageName | Text |  |
| `size` | Size | BigInteger |  |

### `film_report.elt_film_movie_episode3`

- elt_film_movie_episode3（Elt Film Movie Episode3）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；4 列
- 字段 4，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `duration` | Duration | Integer |  |
| `resolution` | Resolution | Integer |  |
| `size` | Size | BigInteger |  |

### `film_report.elt_film_movie_video_play_error`

- elt_film_movie_video_play_error（Elt Film Movie Video Play Error）
- 时间列：`createTime`
- 说明：无表级说明；33 列
- 字段 33，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `userId` | UserId | BigInteger |  |
| `movieId` | MovieId | BigInteger |  |
| `episodeId` | EpisodeId | BigInteger |  |
| `errorCode` | ErrorCode | BigInteger |  |
| `videoUrl` | VideoUrl | Text |  |
| `model` | Model | Text |  |
| `memory` | Memory | Text |  |
| `version` | Version | Text |  |
| `status` | Status | Integer |  |
| `checkResult` | CheckResult | Text |  |
| `createTime` | CreateTime | DateTime |  |
| `date` | Date | Integer |  |
| `deviceId` | DeviceId | Text |  |
| `appVersion` | AppVersion | Text |  |
| `channelId` | ChannelId | Integer |  |
| `cdnDomain` | CdnDomain | Text |  |
| `isOnline` | IsOnline | Boolean |  |
| `errorMessage` | ErrorMessage | Text |  |
| `currentPosition` | CurrentPosition | Integer |  |
| `sceneType` | SceneType | Integer |  |
| `guid` | GUID | Text |  |
| `ip` | IP | Text |  |
| `networkType` | NetworkType | Text |  |
| `isp` | Isp | Text |  |
| `quality` | Quality | Text |  |
| `netWorkType` | NetWorkType | Text |  |
| `phoneModel` | PhoneModel | Text |  |
| `ipCountry` | IpCountry | Text |  |
| `ipRegion` | IpRegion | Text |  |
| `ipRegionName` | IpRegionName | Text |  |
| `ipCity` | IpCity | Text |  |
| `ipIsp` | IpIsp | Text |  |

### `film_report.elt_film_order`

- elt_film_order（会员订单表）
- 时间列：`payTime`
- 说明：本表为用户订单表，含明细信息，存储按创建时间每月一个分区，按排序键去重。
核心信息：下单用户资料、下单设备、订单明细、订单类型、购买次数、购买会员天数/月数、订单状态、订单金额、创建时间、支付信息、结算前会员信息快照。
统计相关的信息：相关影片、会员入口、客户端类型、App版本号。
根据订单类型，还额外保存有兑换码信息、优惠活动信息。
- 字段 42，其中 30 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | 订单ID | BigInteger | 订单的唯一标识 |
| `uid` | 下单人UID | BigInteger | 可作为人数统计维度的标识 |
| `nickname` | 下单人昵称 | Text |  |
| `orderType` | 订单类型 | Integer | 映射关系：1:新购，2:续费，3:会员升级（废弃），4:兑换码兑换，5:优惠活动，6:兑换码采购，7:游戏充值，8:会员页推广，9:会员升级套餐，10:单片解锁付费 |
| `orderStatus` | 订单状态 | Integer | 映射关系：1:未支付，2:支付中，3:支付成功，4:支付失败，5:支付超时，6:已结算，6:已退款。 支付成功是个短暂状态，最终会转化成已结算状态，所以已结算状态是订单支付成功的标识状态。 |
| `payType` | 支付渠道 | Integer |  |
| `tradeNo` | 支付流水号 | Text |  |
| `products` | 订单明细 | Array | 订单中包含的商品，目前只有一个：会员商品信息。 |
| `amount` | 订单实付金额 | Integer | 国家相关的原币实付金额，只用来显示，不参与计算、统计相关的操作 |
| `currencyType` | 货币类型 | Integer | 映射关系：0:法币，1:金币，2:兑换码 |
| `redeemCodeUseType` | 兑换码类型 | Integer | 映射关系：1:免费，2:付费。仅订单类型为兑换码兑换时有效。 |
| `redeemCodeCountryId` | 兑换码国家ID | BigInteger | 仅订单类型为兑换码兑换时有效。 |
| `failedDetail` | 失败原因 | Text |  |
| `payTime` | 支付时间 | DateTime |  |
| `buyTimes` | 购买次数 | Integer | 账号维度或设备维度的累计购买次数，次数统计仅限订单类型：新购、续费 |
| `buyTimes2` | 购买次数2 | Integer | 账号维度的累计购买次数，次数统计仅限订单类型：新购、续费、优惠活动 |
| `clientType` | 客户端类型 | Integer | 映射关系：1:安卓，2:iOS，4:H5，6:安卓TV |
| `movieId` | 相关影片ID | BigInteger |  |
| `vipEntryId` | 会员入口ID | Integer |  |
| `activityId` | 优惠活动ID | Text | 仅订单类型为优惠活动时有效。 |
| `guid` | GUID | Text | 设备唯一标识，可作为设备数、人数统计维度的标识 |
| `agentOrderId` | 兑换码采购单号 | BigInteger | 仅订单类型为兑换码采购时有效。 |
| `changeAmount` | 卢比总金额 | Float | 换算成印度卢比的订单金额；计算和统计应使用此字段 |
| `createdTime` | 创建时间 | DateTime | 核心的时间过滤字段 |
| `updatedTime` | 更新时间 | DateTime |  |
| `channelName` | 渠道 | Text |  |
| `srcOrderId` | 原订单ID | BigInteger | 仅订单类型为会员升级套餐时有效 |
| `months` | 购买月数 | Integer | 购买的会员月数，0表示购买不足1月，结合购买天数看 |
| `appVersion` | App版本号 | Text | 下单App的版本号 |
| `days` | 购买天数 | Integer | 购买的会员天数，旧数据为0 |
| `preVip` | 订单结算前是否会员 | Boolean | 仅订单状态为已结算时有效。 |
| `preDays` | 订单结算前会员天数 | Integer | 仅订单状态为已结算时有效。正数表示剩余会员天数，负数表示会员过期天数 |
| `preRechargeType` | 订单结算前上次充值类型 | Integer | 仅订单状态为已结算时有效。 |
| `preOrderId` | 订单结算前上次的结算订单ID | BigInteger | 仅订单状态为已结算时有效。 |
| `preOrderType` | 订单结算前上次的结算订单类型 | Integer | 仅订单状态为已结算时有效。映射关系：同本表的订单类型字段 |
| `preOrderTime` | 订单结算前上次的结算订单创建时间 | DateTime | 仅订单状态为已结算时有效。 |
| `preOrderMonths` | 订单结算前上次的结算订单的购买月数 | Integer | 仅订单状态为已结算时有效。 |
| `preOrderDays` | 订单结算前上次的结算订单的购买天数 | Integer | 仅订单状态为已结算时有效。 |
| `preOrderAmount` | 订单结算前上次的结算订单的金额 | Float | 仅订单状态为已结算时有效。 |
| `episodeId` | EpisodeId | BigInteger |  |
| `anonymous` | Anonymous | Integer |  |
| `benefitGranted` | BenefitGranted | Boolean |  |

### `film_report.elt_film_user`

- elt_film_user（用户表）
- 时间列：`createdTime`
- 说明：账号详细资料表。存储按创建时间每月一个分区，按排序键去重。
核心信息：基础资料、登录资料。
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
- 字段 32，其中 7 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | 用户UID | BigInteger | 账号唯一标识 |
| `email` | Email | Text |  |
| `provider` | 登录方式 | Text |  |
| `mobileArea` | 手机国家代码 | Text | 如印度为91，中国为86 |
| `mobile` | 手机号 | Text |  |
| `nickname` | 昵称 | Text |  |
| `birthday` | 生日 | DateTime |  |
| `userImg` | 头像 | Text |  |
| `status` | 状态 | Integer | 映射关系：0：未初始化，1：正常，2：冻结，3：设备过载，4：注销 |
| `createdTime` | 创建时间 | DateTime |  |
| `signature` | 签名档 | Text |  |
| `gender` | 性别 | Integer | 映射关系：0：未知，1：男，2：女 |
| `forbiddenStatus` | 禁言状态 | Integer | 映射关系：0：解禁，1：禁言 |
| `forbiddenReason` | 禁言原因 | Text |  |
| `forbiddenEndTime` | 禁言结束时间 | DateTime |  |
| `lastLoginTime` | 最后登录时间 | DateTime |  |
| `clientType` | 客户端类型 | Integer | 映射关系：0：未知，1：Android，2：iOS，4：H5，6：Android TV |
| `lastNickNameModifyTime` | 最后修改昵称时间 | DateTime |  |
| `country` | 国家 | Text |  |
| `isServiceAccount` | 特殊账号类型 | Integer | 映射关系：0：普通，1：测试，2：提审专用 |
| `channel` | 渠道 | Text |  |
| `language` | 语言 | Text |  |
| `userInfoIsInitialized` | 是否已初始化 | Integer |  |
| `age` | 年龄 | Integer |  |
| `packageName` | 包名 | Text |  |
| `appVersion` | App版本号 | Text |  |
| `registerCountryId` | 注册国家ID | BigInteger |  |
| `promotionChannelId` | 推广渠道ID | BigInteger |  |
| `logoutTime` | 注销时间 | DateTime |  |
| `isPremium` | 是否会员 | Boolean |  |
| `contentLang` | ContentLang | Text |  |
| `guid` | GUID | Text |  |

### `film_report.elt_fo_ap_src`

- elt_fo_ap_src（设备首登归因表-线下）
- 时间列：`createTime`
- 说明：线下包用户首登的归因信息，存储按创建时间每天一个分区。
注意事项：
1、同一个设备同一天可能会有多条记录。
- 字段 8，其中 5 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `channel` | 渠道 | Text |  |
| `src` | 归因到的来源 | Integer | 映射关系：10：Facebook，20：Instagram，30：Google，40：其他 |
| `srcType` | 归因到的来源类型 | Integer | 通过什么方式来判断归因来源的，如通过发现请求参数带有fbclid，来判断归因来源是Facebook。 映射关系：0：无，10：fbclid，20：utm_source，30：self，40：gad_source/gad_campaignid，50：gclid |
| `domain` | 归因到的域名 | Text |  |
| `udfrom` | 归因到的自定义来源 | Text | 参数中有可能存在udfrom这个参数，是我们定义的来源参数 |
| `createTime` | 创建时间 | DateTime |  |
| `attrUser` | 是否60天内首次归因成功 | Boolean | 因为有些设备短期内会反复重装、清缓存而触发归因，此标记可以识别此类情况。 |

### `film_report.elt_gp_install_referrer_log`

- elt_gp_install_referrer_log（Google Play归因日志）
- 时间列：`ct`
- 说明：Google Play应用市场包用户首登时的归因信息，即install referrer信息，存储按创建时间每天一个分区，按排序键去重。
注意事项：
1、同一个设备同一天可能会有多条记录。
- 字段 12，其中 10 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识 |
| `channel` | 渠道 | Text |  |
| `type` | 类型 | Integer | 映射关系：1:日常收集，2:AB面接口收集 |
| `ct` | 创建时间 | DateTime |  |
| `installReferrer` | 归因信息 | Text | install referrer信息 |
| `platform` | 广告平台 | Text | 从install referfer识别到的广告平台，映射关系：fb:Facebook,gg:Google |
| `adAccountId` | 广告账号ID | Text | 仅识别到为Facebook广告时有效 |
| `campaignId` | Campaign Id | Text | 仅识别到为Facebook广告时有效 |
| `campaignName` | Campaign Name | Text | 仅识别到为Facebook广告时有效 |
| `adGroupId` | Ad Group Id | Text | 仅识别到为Facebook广告时有效 |
| `adGroupName` | Ad Group Name | Text | 仅识别到为Facebook广告时有效 |
| `adId` | Ad Id | Text | 仅识别到为Facebook广告时有效 |

### `film_report.elt_invite_invitee`

- elt_invite_invitee（邀请赚钱受邀人表）
- 时间列：`createTime`
- 说明：记录受邀人的信息，存储按创建时间每月一个分区。
核心信息：受邀者信息、邀请者信息、归因信息
- 字段 12，其中 4 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | 受邀者的GUID | Text | 受邀者的设备唯一标识 |
| `channelName` | 渠道 | Text |  |
| `userId` | 受邀者的UID | BigInteger | 受邀者的UID |
| `parentId` | 邀请者的UID | BigInteger |  |
| `createTime` | 创建时间 | DateTime |  |
| `firstLoginTime` | 受邀者的首次登入时间 | DateTime |  |
| `attributionTime` | 归因时间 | DateTime |  |
| `attributionCost` | 归因耗时 | BigInteger | 单位毫秒 |
| `loginNextDay` | 是否次留 | Boolean |  |
| `loginNextDay7` | 7天内是否活跃 | Boolean |  |
| `step` | 邀请赚钱所处阶段 | Integer |  |
| `linkTime` | 邀请链接的生成时间 | BigInteger | 时间戳，单位毫秒 |

### `film_report.elt_invite_user`

- elt_invite_user（Elt Invite User）
- 时间列：`createTime`
- 说明：无表级说明；33 列
- 字段 33，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `createTime` | CreateTime | DateTime |  |
| `updateTime` | UpdateTime | DateTime |  |
| `userId` | UserId | BigInteger |  |
| `userName` | UserName | Text |  |
| `guid` | GUID | Text |  |
| `parentId` | ParentId | BigInteger |  |
| `channelId` | ChannelId | Integer |  |
| `channelName` | ChannelName | Text |  |
| `status` | Status | Integer |  |
| `currStep` | CurrStep | Integer |  |
| `hasInvitee` | HasInvitee | Boolean |  |
| `fraudWarn` | FraudWarn | Boolean |  |
| `goodWithdraw` | GoodWithdraw | Boolean |  |
| `goodWithdrawCoopStatus` | GoodWithdrawCoopStatus | Integer |  |
| `goodWithdrawFollowTime` | GoodWithdrawFollowTime | DateTime |  |
| `goodWithdrawRemark` | GoodWithdrawRemark | Text |  |
| `goodWithdrawMarkTime` | GoodWithdrawMarkTime | DateTime |  |
| `goodWithdrawFollowUserId` | GoodWithdrawFollowUserId | BigInteger |  |
| `goodWithdrawFollowUserName` | GoodWithdrawFollowUserName | Text |  |
| `sharePageViewCount` | SharePageViewCount | Integer |  |
| `sharePageDownloadCount` | SharePageDownloadCount | Integer |  |
| `sharePageDownloadUserCount` | SharePageDownloadUserCount | Integer |  |
| `sharePageInstallUserCount` | SharePageInstallUserCount | Integer |  |
| `successInviteUserCount` | SuccessInviteUserCount | Integer |  |
| `bankName` | BankName | Text |  |
| `bankAccount` | BankAccount | Text |  |
| `bankCode` | BankCode | Text |  |
| `bankAccountOwner` | BankAccountOwner | Text |  |
| `email` | Email | Text |  |
| `phoneArea` | PhoneArea | Text |  |
| `phone` | Phone | Text |  |
| `steps` | Steps | Array |  |

### `film_report.elt_invite_withdraw`

- elt_invite_withdraw（Elt Invite Withdraw）
- 时间列：`payTime`
- 说明：createTime: 创建时间；userId: 申请人UID；userName: 申请人名称；userGuid: 申请人GUID
- 字段 30，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `createTime` | 创建时间 | DateTime |  |
| `userId` | 申请人UID | BigInteger |  |
| `userName` | 申请人名称 | Text |  |
| `userGuid` | 申请人GUID | Text |  |
| `channelId` | 渠道ID | Integer |  |
| `channelName` | 渠道名称 | Text |  |
| `type` | 类型 | Integer |  |
| `amount` | 提现金额 | Float |  |
| `afterBalance` | 提现后余额 | Float |  |
| `vipId` | 购买的会员产品ID | BigInteger |  |
| `applyNo` | 申请单号 | Text |  |
| `applyStatus` | 申请状态 | Integer |  |
| `applyMsg` | 申请信息 | Text |  |
| `applyTime` | 审核时间 | DateTime |  |
| `applyUserId` | 审核人UID | BigInteger |  |
| `applyUserName` | 审核人名称 | Text |  |
| `payOrderNo` | 支付单号 | BigInteger |  |
| `payStatus` | 支付状态 | Integer |  |
| `payMsg` | 支付信息 | Text |  |
| `payTime` | 支付时间 | DateTime |  |
| `packageName` | 包名 | Text |  |
| `clientType` | 客户端类型 | Integer |  |
| `refund` | 是否退款 | Boolean |  |
| `refundType` | 退款类型 | Integer |  |
| `refundMsg` | 退款信息 | Text |  |
| `step` | Step | Integer |  |
| `paySuccessType` | 支付成功类型 | Integer |  |
| `expandAmount` | ExpandAmount | Float |  |
| `lotteryAmount` | LotteryAmount | Float |  |

### `film_report.elt_new_guid`

- elt_new_guid（每天新增用户）
- 时间列：`createDate`
- 说明：记录最近1年每天的全新用户，存储为每天一个分区，按排序键去重。
核心信息：可通过内联（inner join）此表来确认一个设备是否全新。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `createDate` | 日期 | Date |  |

### `film_report.elt_old_guid`

- elt_old_guid（每天重装的旧用户）
- 时间列：`createDate`
- 说明：记录最近1年每天的重装的旧用户，存储为每天一个分区，按排序键去重。
核心信息：最近活跃日期、没有活跃天数。可通过内联（inner join）此表来确认一个设备是否重装。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 5，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备的唯一标识 |
| `channel` | 渠道 | Text |  |
| `lastActiveDate` | 最近活跃日期 | Date |  |
| `lastActiveDays` | 没有活跃天数 | Integer |  |
| `createDate` | 日期 | Date |  |

### `film_report.elt_sport_activity_guess`

- elt_sport_activity_guess（Elt Sport Activity Guess）
- 时间列：`createdTime`
- 说明：无表级说明；11 列
- 字段 11，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `createdTime` | CreatedTime | DateTime |  |
| `updatedTime` | UpdatedTime | DateTime |  |
| `uid` | UID | BigInteger |  |
| `matchId` | MatchId | BigInteger |  |
| `guid` | GUID | Text |  |
| `ip` | IP | Text |  |
| `channel` | Channel | Text |  |
| `whoWin` | WhoWin | Integer |  |
| `isRight` | IsRight | Integer |  |
| `isSettled` | IsSettled | Boolean |  |

### `film_report.elt_sport_activity_winner`

- elt_sport_activity_winner（Elt Sport Activity Winner）
- 时间列：`createdTime`
- 说明：无表级说明；14 列
- 字段 14，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `createdTime` | CreatedTime | DateTime |  |
| `updatedTime` | UpdatedTime | DateTime |  |
| `matchIds` | MatchIds | Array |  |
| `guid` | GUID | Text |  |
| `ip` | IP | Text |  |
| `channel` | Channel | Text |  |
| `shareNum` | ShareNum | Integer |  |
| `win` | Win | Boolean |  |
| `winDate` | WinDate | DateTime |  |
| `winMatchId` | WinMatchId | BigInteger |  |
| `winMatchDesc` | WinMatchDesc | Text |  |
| `winAmount` | WinAmount | Integer |  |
| `withdrawStatus` | WithdrawStatus | Integer |  |

### `film_report.elt_ul_activity`

- elt_ul_activity（优惠活动配置表）
- 时间列：`createTime`
- 说明：本表包含用户分层优惠活动的配置信息。
- 字段 26，其中 9 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | Text | 活动的唯一标识 |
| `createTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `userGroupId` | 关联的人群包ID | Integer |  |
| `name` | 活动名称 | Text |  |
| `startTime` | 活动有效起始时间 | DateTime |  |
| `endTime` | 活动有效结束时间 | DateTime |  |
| `cycle` | 活动周期 | Integer | 定义用户多少天内只能参与一次 |
| `channels` | 渠道列表 | Array | 能够参与活动的渠道列表 |
| `timeLimit` | 活动限时（小时） | Integer | 活动参与后的倒计时，单位：小时 |
| `enabled` | 是否启用 | Boolean |  |
| `remark` | 备注 | Text |  |
| `triggerPos` | 触发点列表 | Array | 映射关系：1：首页，2：影片详情页，3：个人中心，4：会员购买页 |
| `type` | 类型 | Integer | 映射关系：10：首充，20：回归 |
| `retainImage` | 挽回图片 | Text |  |
| `showStyle` | 展示样式 | Integer | 映射关系：10：单个优惠，20：多个优惠 |
| `indexImage` | 首页弹窗图片-旧样式使用字段 | Text |  |
| `movieImage` | 影片详情页弹窗图片-旧样式使用字段 | Text |  |
| `price` | 优惠价格-旧样式使用字段 | Integer |  |
| `originPrice` | 原价-旧样式使用字段 | Integer |  |
| `month` | 会员月数-旧样式使用字段 | Integer |  |
| `days` | 当月数不足1月，启用天数配置-旧样式使用字段 | Integer |  |
| `newStyleDiscounts` | 新样式优惠信息列表 | Array | 列表元素为元组，元组第1个元素：首页弹窗图片，元组第2个元素：影片详情页弹窗图片，元组第3个元素：优惠价格，元组第4个元素：原价，元组第5个元素：会员月数，元组第6个元素：月数不足1月，启用天数配置，元组第7个元素：是否主优惠 |
| `newStyleBgImage` | 新样式背景图 | Text |  |
| `priority` | 优先级 | Integer |  |
| `preUserGroupId` | 前置人群包ID | Integer | 需满足前置人群包才可参与活动 |

### `film_report.elt_ul_activity_device`

- elt_ul_activity_device（用户优惠活动表）
- 时间列：`createTime`
- 说明：用户参与优惠活动的记录表，保留最近半年的记录。，存储按创建时间每天一个分区，按排序键去重。
核心信息：活动ID、激活时间、过期时间、状态、相关订单信息
- 字段 12，其中 5 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | Text | 唯一标识 |
| `createTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `activityId` | 活动ID | Text |  |
| `activeTime` | 激活时间 | DateTime |  |
| `expiredTime` | 过期时间 | DateTime |  |
| `channel` | 渠道 | Text |  |
| `status` | 状态 | Integer | 映射关系：10：有效，40：完成 |
| `userId` | 用户UID | BigInteger | 状态为完成时有效，完成订单的下单用户 |
| `orderId` | 订单ID | BigInteger | 状态为完成时有效，完成订单的订单ID |
| `remark` | 备注 | Text |  |

### `film_report.elt_ul_user_group_36`

- elt_ul_user_group_36（Elt Ul User Group 36）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；1 列
- 字段 1，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text |  |

### `film_report.elt_user_active`

- elt_user_active（用户活跃信息表）
- 时间列：`recordDate`
- 说明：记录最近6个月每天的设备使用时长，存储按日期每月一个分区，按排序键去重。
核心信息：使用时长。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过10天的时间范围。
- 字段 3，其中 2 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | 日期 | Date |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `totalActiveSecond` | 使用时长 | Integer | 单位：秒 |

### `film_report.elt_user_full`

- elt_user_full（用户画像表）
- 时间列：`recordDate`
- 说明：本表为用户画像数据的大宽表，设备维度的，仅包含当前最新的用户画像数据。
核心信息：设备基础资料、IP资料、网络资料、apk包资料、安装资料、累计活跃天数、安装天数、近N天观影时长、近N天离线观影时长、近N天观影时长最长时段（深夜/早上/中午/下午/晚上）、近N天各种分辨率的观影时长、近N天观影时长最长的字幕语言、近N天观影时长最长的音轨语言、近N天的观影天数、会员剩余天数、会员已过期天数、累计结算订单数量和金额、近N天创建的订单数量和金额、近N天的活跃时长。
注意事项：
1、本表数据量巨大，连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
- 字段 58，其中 37 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | 画像生成日期 | Date |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `createTime` | 设备首访时间 | DateTime |  |
| `installDay` | 安装天数 | Integer |  |
| `updateTime` | 设备更新时间 | DateTime |  |
| `uid` | 设备最近使用的UID | BigInteger |  |
| `deviceType` | 设备类型 | Text | 映射关系：mobile：手机，tablet：平板，tv：电视，car：车载，watch：手表 |
| `deviceBrand` | 设备品牌 | Text |  |
| `deviceName` | 设备名称 | Text |  |
| `manufacturer` | 设备制造商 | Text |  |
| `osName` | 操作系统名称 | Text |  |
| `osVersion` | 操作系统版本 | Text |  |
| `sdkVersion` | Sdk版本 | Text |  |
| `apkVersionName` | Apk包版本名称 | Text |  |
| `apkVersionCode` | Apk包版本号 | Text |  |
| `apkChannel` | 最近使用的渠道 | Text |  |
| `apkType` | ApkType | Text | apk包类型 |
| `networkOperatorName` | 网络运营商名称 | Text |  |
| `networkMcc` | 网络MCC | Text |  |
| `networkType` | 网络类型 | Text | 2G/3G/WIFI等 |
| `networkCountryIso` | NetworkCountryIso | Text | 移动网络国家代码 |
| `localeIso3Language` | 系统语言缩写 | Text | 3字母的ISO标准 |
| `localeIso3Country` | 系统国家设置缩写 | Text | 3字母的ISO标准 |
| `timeZoneId` | 时区ID | Text |  |
| `root` | Root | Boolean | 设备是否有Root权限 |
| `proxy` | Proxy | Boolean | 是否使用网络代理 |
| `usbDebug` | UsbDebug | Boolean | 设备是否处于调试模式 |
| `simulator` | Simulator | Boolean | 是否模拟器 |
| `mockLocation` | MockLocation | Boolean | 是否使用模拟位置 |
| `vpn` | Vpn | Boolean | 是否使用VPN |
| `notify` | Notify | Boolean | 是否允许推送 |
| `reqLang` | ReqLang | Text | 请求带的语言参数 |
| `ipCountryCode` | IpCountryCode | Text | IP信息中的国家编码 |
| `ipRegionName` | IpRegionName | Text | IP信息中的区域名称 |
| `ipCity` | IpCity | Text | IP信息中的城市 |
| `ipIsp` | IpIsp | Text | IP信息中的ISP |
| `createApkChannel` | 首访时的渠道 | Text |  |
| `firstInstallTime` | FirstInstallTime | BigInteger | App安装时间，时间戳，毫秒 |
| `dataDirLastModified` | DataDirLastModified | BigInteger | App数据目录最后修改时间，时间戳，毫秒 |
| `countryCode` | CountryCode | Integer | 自定义的国家代号，映射关系：91：印度，92：巴基斯坦，55：巴西，52：墨西哥，880：孟加拉 |
| `activeDays` | ActiveDays | Integer | 设备累计活跃天数 |
| `watchTime` | 近N天的观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的观影时长，第2个为近20天的观影时长，以此类推，第18个为近180天的观影时长。不包含预告片、直播的观影时长。单位：秒。 |
| `watchDay` | 近N天的观影天数 | Array | 包含18个整数的列表，第1个为近10天的观影天数，第2个为近20天的观影天数，以此类推，第18个为近180天的观影天数。不包含预告片、直播。 |
| `offlineWatchTime` | 近N天的离线观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的离线观影时长，第2个为近20天的离线观影时长，以此类推，第18个为近180天的离线观影时长。不包含预告片、直播。单位：秒。 |
| `ld0WatchTime` | 近N天的分辨率为流畅的观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的分辨率为流畅的观影时长，第2个为近20天的分辨率为流畅的观影时长，以此类推，第18个为近180天的分辨率为流畅的观影时长。不包含预告片、直播的观影时长。单位：秒。 |
| `sd1WatchTime` | 近N天的分辨率为标清（480P）的观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的分辨率为标清（480P）的观影时长，第2个为近20天的分辨率为标清（480P）的观影时长，以此类推，第18个为近180天的分辨率为标清（480P）的观影时长。不包含预告片、直播的观影时长。单位：秒。 |
| `hd2WatchTime` | 近N天的分辨率为高清（720P）的观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的分辨率为高清（720P）的观影时长，第2个为近20天的分辨率为高清（720P）的观影时长，以此类推，第18个为近180天的分辨率为高清（720P）的观影时长。不包含预告片、直播的观影时长。单位：秒。 |
| `fhd3WatchTime` | 近N天的分辨率为超清（1080P）的观影时长（秒） | Array | 包含18个整数的列表，第1个为近10天的分辨率为超清（1080P）的观影时长，第2个为近20天的分辨率为超清（1080P）的观影时长，以此类推，第18个为近180天的分辨率为超清（1080P）的观影时长。不包含预告片、直播的观影时长。单位：秒。 |
| `audioLang` | 近N天的观影时长最长的音轨语言 | Array | 包含18个元素的列表，第1个为近10天的观影时长最长的音轨语言，第2个为近20天的观影时长最长的音轨语言，以此类推，第18个为近180天的观影时长最长的音轨语言。不包含预告片、直播的观影时长。语言的值为elt_watch_detail_lang_dict的标准值 |
| `subtitleLang` | 近N天的观影时长最长的字幕语言 | Array | 包含18个元素的列表，第1个为近10天的观影时长最长的字幕语言，第2个为近20天的观影时长最长的字幕语言，以此类推，第18个为近180天的观影时长最长的字幕语言。不包含预告片、直播的观影时长。语言的值为elt_watch_detail_lang_dict的标准值 |
| `watchPeriod` | 近N天的观影时长最长的时段 | Array | 包含18个元素的列表，第1个为近10天的观影时长最长的时段，第2个为近20天的观影时长最长的时段，以此类推，第18个为近180天的观影时长最长的时段。不包含预告片、直播的观影时长。时段值映射关系：0：无，1：深夜（[0,6]点），2：早上（[7,10]点），3：中午（[11,13]点），4：下午（[14,17]点），5：晚上（[18,23]点） |
| `vipExpireDay` | 会员过期天数 | Integer | 大于0为会员剩余天数，小于等于0为会员已过期天数 |
| `payedOrderCount` | 累计已结算订单数量 | Integer |  |
| `payedOrderAmount` | 累计已结算订单金额 | Integer |  |
| `orderCount` | 近N天的创建订单数量 | Array | 包含18个元素的列表，第1个为近10天的创建订单数量，第2个为近20天的创建订单数量，以此类推，第18个为近180天的创建订单数量。 |
| `orderAmount` | 近N天的创建订单金额 | Array | 包含18个元素的列表，第1个为近10天的创建订单金额，第2个为近20天的创建订单金额，以此类推，第18个为近180天的创建订单金额。 |
| `activeTime` | 近N天的活跃时长（秒） | Array | 包含18个元素的列表，第1个为近10天的活跃时长，第2个为近20天的活跃时长，以此类推，第18个为近180天的活跃时长。单位：秒。 |
| `contentLang` | ContentLang | Text |  |

### `film_report.elt_user_full_history`

- elt_user_full_history（用户画像历史数据表）
- 时间列：`recordDate`
- 说明：包含过去30天的用户画像历史数据，跟用户画像数据表（elt_user_full）一样的结构。存储按生成日期按天分区。
注意事项：
1、数据量巨大，必须指定具体日期作为查询条件。
- 字段 58，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | 画像生成日期 | Date |  |
| `guid` | GUID | Text |  |
| `createTime` | CreateTime | DateTime |  |
| `installDay` | InstallDay | Integer |  |
| `updateTime` | UpdateTime | DateTime |  |
| `uid` | UID | BigInteger |  |
| `deviceType` | DeviceType | Text |  |
| `deviceBrand` | DeviceBrand | Text |  |
| `deviceName` | DeviceName | Text |  |
| `manufacturer` | Manufacturer | Text |  |
| `osName` | OsName | Text |  |
| `osVersion` | OsVersion | Text |  |
| `sdkVersion` | SdkVersion | Text |  |
| `apkVersionName` | ApkVersionName | Text |  |
| `apkVersionCode` | ApkVersionCode | Text |  |
| `apkChannel` | ApkChannel | Text |  |
| `apkType` | ApkType | Text |  |
| `networkOperatorName` | NetworkOperatorName | Text |  |
| `networkMcc` | NetworkMcc | Text |  |
| `networkType` | NetworkType | Text |  |
| `networkCountryIso` | NetworkCountryIso | Text |  |
| `localeIso3Language` | LocaleIso3Language | Text |  |
| `localeIso3Country` | LocaleIso3Country | Text |  |
| `timeZoneId` | TimeZoneId | Text |  |
| `root` | Root | Boolean |  |
| `proxy` | Proxy | Boolean |  |
| `usbDebug` | UsbDebug | Boolean |  |
| `simulator` | Simulator | Boolean |  |
| `mockLocation` | MockLocation | Boolean |  |
| `vpn` | Vpn | Boolean |  |
| `notify` | Notify | Boolean |  |
| `reqLang` | ReqLang | Text |  |
| `ipCountryCode` | IpCountryCode | Text |  |
| `ipRegionName` | IpRegionName | Text |  |
| `ipCity` | IpCity | Text |  |
| `ipIsp` | IpIsp | Text |  |
| `createApkChannel` | CreateApkChannel | Text |  |
| `firstInstallTime` | FirstInstallTime | BigInteger |  |
| `dataDirLastModified` | DataDirLastModified | BigInteger |  |
| `countryCode` | CountryCode | Integer |  |
| `activeDays` | ActiveDays | Integer |  |
| `watchTime` | WatchTime | Array |  |
| `watchDay` | WatchDay | Array |  |
| `offlineWatchTime` | OfflineWatchTime | Array |  |
| `ld0WatchTime` | Ld0WatchTime | Array |  |
| `sd1WatchTime` | Sd1WatchTime | Array |  |
| `hd2WatchTime` | Hd2WatchTime | Array |  |
| `fhd3WatchTime` | Fhd3WatchTime | Array |  |
| `audioLang` | AudioLang | Array |  |
| `subtitleLang` | SubtitleLang | Array |  |
| `watchPeriod` | WatchPeriod | Array |  |
| `vipExpireDay` | VipExpireDay | Integer |  |
| `payedOrderCount` | PayedOrderCount | Integer |  |
| `payedOrderAmount` | PayedOrderAmount | Integer |  |
| `orderCount` | OrderCount | Array |  |
| `orderAmount` | OrderAmount | Array |  |
| `activeTime` | ActiveTime | Array |  |
| `contentLang` | ContentLang | Text |  |

### `film_report.elt_user_group`

- elt_user_group（人群包数据表）
- 时间列：`recordDate`
- 说明：记录最近2月每天的人群包计算结果，存储为每天一个分区。
核心信息：可通过内联（inner join）此表来确认一个设备是否属于某个人群包。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过7天的时间范围。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | 日期 | Date |  |
| `ugId` | 人群包ID | Integer |  |
| `guid` | GUID | Text | 设备唯一标识 |

### `film_report.elt_user_group_config`

- elt_user_group_config（人群包配置表）
- 时间列：`createTime`
- 说明：_id: 人群包唯一标识；createTime: 创建时间；updateTime: 更新时间；name: 名称
- 字段 16，其中 3 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | Integer | 人群包唯一标识 |
| `createTime` | 创建时间 | DateTime |  |
| `updateTime` | 更新时间 | DateTime |  |
| `name` | 名称 | Text |  |
| `remark` | 备注 | Text |  |
| `count` | 人群数量 | Integer |  |
| `refreshTime` | 数据刷新时间 | DateTime |  |
| `cacheRefreshTime` | 缓存刷新时间 | DateTime |  |
| `creator` | 创建人 | Text |  |
| `channels` | 渠道列表 | Array |  |
| `enabled` | 是否启用 | Boolean |  |
| `countryCodes` | 国家列表 | Array |  |
| `refreshTimerEnabled` | 是否启用周期性数据刷新 | Boolean |  |
| `dataRefreshPeriod` | 数据刷新周期 | Integer | 单位：天 |
| `cacheRefreshTimerEnabled` | 是否启用周期性缓存刷新 | Boolean |  |
| `cacheRefreshPeriod` | 缓存刷新周期 | Integer | 单位：天 |

### `film_report.elt_user_group_ex`

- elt_user_group_ex（人群包数据表（限时））
- 时间列：无（聚合不带日期谓词）
- 说明：记录最具有到期属性人群包结果。到期了设备会自动移除，通过ClickHouse的TTL实现。如：24小时新用户，当用户首访时自动加入人群包，24小时后自动移除。
核心信息：可通过内联（inner join）此表来确认一个设备是否属于某个人群包。
- 字段 3，其中 1 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `expireTime` | 到期时间 | DateTime |  |
| `ugId` | 人群包ID | Integer |  |
| `guid` | GUID | Text | 设备唯一标识 |

### `film_report.elt_user_group_history`

- elt_user_group_history（人群包历史数据表）
- 时间列：`recordDate`
- 说明：包含过去60天的人群包历史数据，跟人群包数据表（elt_user_group）一样的结构。存储按生成日期按天分区。
注意事项：
1、数据量巨大，必须指定具体日期作为查询条件。
- 字段 3，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | RecordDate | Date |  |
| `ugId` | UgId | Integer |  |
| `guid` | GUID | Text |  |

### `film_report.elt_user_guid`

- elt_user_guid（UID与GUID的映射表）
- 时间列：`lastLoginTime`
- 说明：当一台设备登录了一个账号，设备和账号就会建立一种关联关系，本表记录近6个月的关联关系。最后一次登录时间超过6个月的自动删除关联。
可以通过此关联查询：
1、账号被哪些设备使用
2、设备使用过哪些账号
- 字段 3，其中 3 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `uid` | UID | BigInteger | 账号的唯一标识 |
| `guid` | GUID | Text | 设备的唯一标识 |
| `lastLoginTime` | LastLoginTime | DateTime | 最后一次登录时间 |

### `film_report.elt_user_login_history`

- elt_user_login_history（Elt User Login History）
- 时间列：`createdTime`
- 说明：无表级说明；11 列
- 字段 11，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `uid` | UID | BigInteger |  |
| `nickname` | Nickname | Text |  |
| `clientType` | ClientType | Integer |  |
| `ip` | IP | Text |  |
| `deviceId` | DeviceId | Text |  |
| `guid` | GUID | Text |  |
| `country` | Country | Text |  |
| `createdTime` | CreatedTime | DateTime |  |
| `channel` | Channel | Text |  |
| `loginType` | LoginType | Integer |  |
| `loginInfo` | LoginInfo | Text |  |

### `film_report.elt_user_vip_info`

- elt_user_vip_info（会员表）
- 时间列：`createdTime`
- 说明：记录用户的会员信息。只有注册账号才有会员信息，每个账号只有一条记录。存储为按创建时间每月一个分区，按排序键去重。
核心信息：会员状态，会员有效时间。
- 字段 7，其中 3 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `uid` | UID | BigInteger | 账号ID唯一标识 |
| `vipType` | 会员类型 | Integer | 只有值为2是Premium会员标识，其他值为非会员标识 |
| `endDate` | 会员到期时间 | DateTime |  |
| `status` | 会员状态 | Integer | 只有值为0是正常状态，其他值为非正常状态 |
| `packageName` | 包名 | Text |  |
| `appChannel` | 渠道 | Text |  |
| `createdTime` | 创建时间 | DateTime |  |

### `film_report.elt_user_vip_recharge_log`

- elt_user_vip_recharge_log（会员变更日志表）
- 时间列：`createdTime`
- 说明：记录着账号每次成为会员的信息。不记录会员过期的变更。存储按创建时间每月一个分区
- 字段 14，其中 6 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `_id` | ID | BigInteger |  |
| `uid` | 用户UID | BigInteger | 关联的账号ID |
| `orderId` | 订单ID | BigInteger | 关联的订单ID |
| `rechargeType` | 类型 | Integer | 映射关系：0:注册赠送，1:邀请用户，2:系统更新，3:充值购买，4:抽奖获取，5:兑换码兑换，6:金币兑换，7:邀请赚钱余额购买，8:APP版本升级，9:TV版首次登录，10:充值问题补偿活动，11:板球竞猜积分兑换，12:订单退款 |
| `days` | 会员天数 | Integer |  |
| `channel` | 支付通道 | Integer | payType，支付类型 |
| `endTime` | 会员到期时间 | DateTime |  |
| `vipType` | 会员类型 | Integer | 只有值为2是Premium会员标识，其他值为非会员标识 |
| `packageName` | 包名 | Text |  |
| `channelName` | 渠道 | Text |  |
| `isFirst` | 是否首次充值 | Boolean |  |
| `price` | 价格 | Integer |  |
| `redeemCodeId` | 兑换码ID | BigInteger | 关联的兑换码ID |
| `createdTime` | 创建时间 | DateTime |  |

### `film_report.elt_watch_detail`

- elt_watch_detail（每天观影明细（新））
- 时间列：`lastWatchTime`
- 说明：本表为用户设备观影的每天汇总明细表，存储为每天一个分区，按排序键汇总和去重。
核心信息：观影时长、观影进度、完播。
核心过滤字段：渠道、是否登录、是否会员、是否新用户、影片、剧集、影片类型、屏幕类型、是否离线、字幕、音轨、分辨率、影片国家、影片标签。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过1个月的时间范围。
- 字段 23，其中 15 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text | 设备唯一标识，可作为人数维度的标识 |
| `uid` | 用户ID | BigInteger | 注册用户唯一标识，可能为空，不能作为人数维度的标识 |
| `channel` | 渠道 | Text |  |
| `isNew` | 是否新设备 | Boolean |  |
| `isLogin` | 是否登录 | Boolean |  |
| `isVip` | 是否会员 | Boolean |  |
| `mid` | 影片ID | BigInteger |  |
| `eid` | 剧集ID | BigInteger |  |
| `movieType` | 影片类型 | Integer | 映射关系：1:电影，2:电视剧，3:真人秀，4:短剧，5:比赛直播，6:电视直播，7:预告片，8:自制广告，9:第三方广告，10:动漫，11:肥皂剧 |
| `screenType` | 屏幕类型 | Integer | 映射关系：1:全屏，2:半屏 |
| `watchSecond` | 观影时长（秒） | Integer | 按排序键累计的时长数据，单位：秒 |
| `watchCount` | 观影次数 | Integer | 按排序键累计的观影次数，仅表示提交次数，没什么作用 |
| `watchFinishCount` | 完播次数 | Integer | 按排序键累计的完播次数，仅表示提交次数，大于0次表示今天完播过了。 |
| `isOffline` | 是否离线观影 | Boolean | 是否离线观影 |
| `lastWatchTime` | 最后观影时间 | DateTime | 按排序键记录最后的观影时间，常用于时间条件的过滤 |
| `movieSubTitleLang` | 字幕语言 | Text | 观影选择的字幕语言 |
| `isAiSubtitle` | 是否AI字幕 | Boolean |  |
| `movieAudioTrackLang` | 音轨语言 | Text | 观影选择的音轨语言 |
| `movieVideoResolution` | 视频分辨率 | Integer | 观影选择的分辨率，映射关系：0:流畅（LD），1:标清（SD），2:高清（HD），3:超清（FHD），4:4K |
| `movieCountries` | 影片国家 | Array | 影片归属的国家，可多个 |
| `movieTags` | 影片分类 | Array | 影片标签，可多个 |
| `maxWatchProgress` | 最大观影进度 | Integer | 按排序键记录的最大观影进度，80表示80%的进度 |
| `contentLang` | ContentLang | Text |  |

### `film_report.elt_watch_detail_lang`

- elt_watch_detail_lang（Elt Watch Detail Lang）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；2 列
- 字段 2，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `src_lang` | Src Lang | Text |  |
| `target_lang` | Target Lang | Text |  |

### `film_report.elt_watch_summary`

- elt_watch_summary（用户每天观影概要信息）
- 时间列：`recordDate`
- 说明：记录最近6个月每天的设备的观影概要信息，本表数据汇总自elt_watch_detail，存储按日期每月一个分区，按排序键去重。
核心信息：总观影时长、在线观影时长、离线观影时长、广告观影时长、24小时每小时的观影时长、深夜/早上/中午/下午/晚上 各时段的观影时长、各种分辨率的观影时长、各种字幕的观影时长、各种音轨的观影时长、观影数量。
注意事项：
1、本表查询必须带时间条件限定，最多不能超过10天的时间范围。
- 字段 16，其中 15 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `recordDate` | 日期 | Date |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `totalWatchSecond` | 当天总观影时长（秒） | Integer | 总观影时长=在线观影时长+离线观影时长。不包含预告片、直播的观影时长。单位：秒 |
| `onlineWatchSecond` | 当天在线观影时长（秒） | Integer | 不包含预告片、直播的观影时长。单位：秒 |
| `offlineWatchSecond` | 当天离线观影时长（秒） | Integer | 不包含预告片、直播的观影时长。单位：秒 |
| `adWatchSecond` | 当天广告观影时长（秒） | Integer | 单位：秒 |
| `movieWatchCount` | 当天影片观影数量 | Integer | 不包含预告片、直播的观影时长。 |
| `hourlyWatchSecond` | 当天每个小时的观影时长（秒） | Array | 本列表有24个元素，代表24小时每个小时的观影时长，没观影的时长为0，第一个元素的值为0点的观影时长，以此类推。小时已考虑时区的差异，即0点表示的是印度、巴西的0点而非中国的0点。单位：秒 |
| `periodWatchSecond` | 当天每个时段的观影时长（秒） | Array | 本列表有5个元素，分别代表深夜（[0,6]点）、早上（[7,10]点）、中午（[11,13]点）、下午（[14,17]点）、晚上（[18,23]点）5个时段的观影时长，没观影的时长为0。小时已考虑时区的差异，即0点表示的是印度、巴西的0点而非中国的0点。单位：秒 |
| `ld0WatchSecond` | 当天分辨率为流畅的观影时长（秒） | Integer | 单位：秒 |
| `sd1WatchSecond` | 当天分辨率为标清（480P）的观影时长（秒） | Integer | 单位：秒 |
| `hd2WatchSecond` | 当天分辨率为高清（720P）的观影时长（秒） | Integer | 单位：秒 |
| `fhd3WatchSecond` | 当天分辨率为超清（1080P）的观影时长（秒） | Integer | 单位：秒 |
| `4k4WatchSecond` | 当天分辨率为4K的观影时长（秒） | Integer | 单位：秒 |
| `top3SubtitleMap` | 当天前3字幕语言的观影时长（秒） | Dictionary | 结构为Map，key为语言，其值为elt_watch_detail_lang_dict的标准值，value为观影时长，单位：秒 |
| `top3AudioMap` | 当天前3音轨语言的观影时长（秒） | Dictionary | 结构为Map，key为语言，其值为elt_watch_detail_lang_dict的标准值，value为观影时长，单位：秒 |

### `film_report.film_user_device_info_simple`

- film_user_device_info_simple（Film User Device Info Simple）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；2 列
- 字段 2，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `uid` | UID | BigInteger |  |
| `deviceId` | DeviceId | Text |  |

### `film_report.film_user_simple`

- film_user_simple（Film User Simple）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；5 列
- 字段 5，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `uid` | UID | BigInteger |  |
| `mobileArea` | MobileArea | Text |  |
| `mobile` | Mobile | Text |  |
| `provider` | Provider | Text |  |
| `email` | Email | Text |  |

### `film_report.mv_elt_active_guid_2`

- mv_elt_active_guid_2
- 时间列：`latestActiveDate`
- 说明：无表级说明；3 列
- 字段 3，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text |  |
| `channel` | Channel | Text |  |
| `latestActiveDate` | LatestActiveDate | Date |  |

### `film_report.user_preference_actions_report`

- user_preference_actions_report（用户观影行为表）
- 时间列：`actionTime`
- 说明：deviceId: GUID；action: 行为类型；movieType: 影片类型；countryIds: 国家ID
- 字段 9，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `deviceId` | GUID | Text |  |
| `action` | 行为类型 | Integer |  |
| `movieType` | 影片类型 | Integer |  |
| `countryIds` | 国家ID | Array |  |
| `tagIds` | 影片标签 | Array |  |
| `vipType` | 会员类型 | Integer |  |
| `actionTime` | 发生时间 | DateTime |  |
| `movieId` | 影片ID | BigInteger |  |
| `cnt` | Cnt | Integer |  |

### `film_report.user_watch_movie_activity_device_log`

- user_watch_movie_activity_device_log（User Watch Movie Activity Device Log）
- 时间列：`reportDate`
- 说明：无表级说明；13 列
- 字段 13，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `id` | ID | BigInteger |  |
| `deviceId` | DeviceId | Text |  |
| `uid` | UID | BigInteger |  |
| `movieType` | MovieType | Integer |  |
| `isFinish` | IsFinish | Boolean |  |
| `countryId` | CountryId | Integer |  |
| `channelId` | ChannelId | BigInteger |  |
| `appChannelId` | AppChannelId | Integer |  |
| `reportDate` | ReportDate | DateTime |  |
| `logged` | Logged | Boolean |  |
| `isNewUser` | IsNewUser | Boolean |  |
| `packageName` | PackageName | Text |  |
| `createdTime` | CreatedTime | DateTime |  |

### `film_report.user_watch_movie_activity_log`

- user_watch_movie_activity_log（每天观影明细（旧））
- 时间列：`reportDate`
- 说明：不再使用，已被“每天观影明细（新）”替换
- 字段 10，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text |  |
| `uid` | 用户ID | BigInteger |  |
| `channel` | 渠道 | Text |  |
| `movieType` | 影片类型 | Integer |  |
| `reportDate` | 上报时间 | DateTime |  |
| `logged` | 是否登录 | Boolean |  |
| `isNewUser` | 是否新用户 | Boolean |  |
| `isFinish` | 是否完播 | Boolean |  |
| `eid` | 剧集ID | BigInteger |  |
| `mid` | 影片ID | BigInteger |  |

### `film_report.watch_log`

- watch_log（观影日志）
- 时间列：`watchTime`
- 说明：无表级说明；23 列
- 字段 23，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text |  |
| `uid` | UID | BigInteger |  |
| `isNewUser` | IsNewUser | Boolean |  |
| `isVip` | IsVip | Boolean |  |
| `channel` | Channel | Text |  |
| `appVersion` | AppVersion | Text |  |
| `watchTime` | WatchTime | DateTime |  |
| `mid` | Mid | BigInteger |  |
| `eid` | Eid | BigInteger |  |
| `movieType` | MovieType | Integer |  |
| `screenType` | ScreenType | Integer |  |
| `watchSecond` | WatchSecond | Integer |  |
| `isOffline` | IsOffline | Boolean |  |
| `watchProgress` | WatchProgress | Integer |  |
| `movieSubTitleLang` | MovieSubTitleLang | Text |  |
| `isAiSubtitle` | IsAiSubtitle | Boolean |  |
| `movieAudioTrackLang` | MovieAudioTrackLang | Text |  |
| `movieVideoResolution` | MovieVideoResolution | Integer |  |
| `networkOperatorName` | NetworkOperatorName | Text |  |
| `networkOperatorCode` | NetworkOperatorCode | Text |  |
| `networkMcc` | NetworkMcc | Text |  |
| `networkType` | NetworkType | Text |  |
| `url` | URL | Text |  |

## Schema `gather`

### `gather.action`

- action（用户行为表）
- 时间列：`time`
- 说明：本表包含近2个月的埋点数据，存储按创建时间每天一个分区。主要记录的是用户的主动行为，一些被动行为，如曝光类行为并不在此表记录范围内。
核心信息：行为编号、guid、uid、发生时间、客户端类型、行为参数、渠道、App版本、是否会员、是否新设备、是否登录。
注意事项：
1、本表数据量巨大，务必带事件时间参数，时间范围最多不超过10天。
2、连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
- 字段 20，其中 11 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `time` | 发生时间 | DateTime | 核心时间过滤字段 |
| `action` | 行为编号 | Integer |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `uid` | 用户UID | BigInteger | 账号唯一标识 |
| `clientType` | 客户端类型 | Integer | 映射关系：1:安卓，2:iOS，4:H5，6:安卓TV |
| `channel` | 渠道 | Text |  |
| `ip` | IP | Text |  |
| `ext1` | 文本参数1 | Text | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext2` | 文本参数2 | Text | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext3` | 文本参数3 | Text | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext11` | 数值参数1 | BigInteger | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext12` | 数值参数2 | BigInteger | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext13` | 数值参数3 | BigInteger | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `appVersionCode` | App版本号 | Text |  |
| `appVersionName` | App版本名 | Text |  |
| `isLogin` | 是否登录 | Boolean |  |
| `isVip` | 是否会员 | Boolean |  |
| `isNew` | 是否新设备 | Boolean |  |
| `ext14` | 数值参数4 | BigInteger | 根据行为ID和行为配置表的参数映射关系，来确定本字段存储的值的意义 |
| `contentLang` | ContentLang | Text |  |

### `gather.action_config`

- action_config（行为配置表）
- 时间列：无（聚合不带日期谓词）
- 说明：id: 行为ID；name: 行为名称；paramsMapping: 如：影片ID:ext11 表示的是影片ID存储在用户行为表的ext11列中。
遇到详情页入口ID和入口参数时，需要结合字典表action_config_detail_entry_dict来解释。
- 字段 3，其中 2 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `id` | ID | Integer | 行为ID |
| `name` | 行为名称 | Text |  |
| `paramsMapping` | 行为参数跟用户行为表字段的映射关系 | Text | 如：影片ID:ext11 表示的是影片ID存储在用户行为表的ext11列中。 遇到详情页入口ID和入口参数时，需要结合字典表action_config_detail_entry_dict来解释。 |

### `gather.action_config_detail_entry`

- action_config_detail_entry（行为配置-影片详情页入口配置源表）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；2 列
- 字段 2，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `entryId` | EntryId | Integer |  |
| `name` | Name | Text |  |

### `gather.buffer`

- buffer（Buffer）
- 时间列：`serverTime`
- 说明：无表级说明；38 列
- 字段 38，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `serverTime` | ServerTime | DateTime |  |
| `clientTime` | ClientTime | DateTime |  |
| `guid` | GUID | Text |  |
| `uid` | UID | BigInteger |  |
| `clientType` | ClientType | Integer |  |
| `ip` | IP | Text |  |
| `channel` | Channel | Text |  |
| `appVersionCode` | AppVersionCode | Text |  |
| `appVersionName` | AppVersionName | Text |  |
| `isLogin` | IsLogin | Boolean |  |
| `type0` | Type0 | Integer |  |
| `laodingStartTime` | LaodingStartTime | BigInteger |  |
| `laodingEndTime` | LaodingEndTime | BigInteger |  |
| `isVip` | IsVip | Boolean |  |
| `isWifi` | IsWifi | Boolean |  |
| `isVpn` | IsVpn | Boolean |  |
| `networkType` | NetworkType | Text |  |
| `networkOperatorName` | NetworkOperatorName | Text |  |
| `networkOperatorCode` | NetworkOperatorCode | Text |  |
| `mid` | Mid | BigInteger |  |
| `eid` | Eid | BigInteger |  |
| `resolution` | Resolution | Text |  |
| `url` | URL | Text |  |
| `movieName` | MovieName | Text |  |
| `movieLanguage` | MovieLanguage | Text |  |
| `isTrailer` | IsTrailer | Boolean |  |
| `bitrate` | Bitrate | Integer |  |
| `frameRate` | FrameRate | Float |  |
| `mimeType` | MimeType | Text |  |
| `time` | Time | BigInteger |  |
| `pb` | Pb | Float |  |
| `bufferNet` | BufferNet | BigInteger |  |
| `bufferSize` | BufferSize | BigInteger |  |
| `fastCount` | FastCount | Integer |  |
| `rewindCount` | RewindCount | Integer |  |
| `pauseCount` | PauseCount | Integer |  |
| `isH265` | IsH265 | Boolean |  |
| `bufferMs` | BufferMs | BigInteger |  |

### `gather.event_config`

- event_config（埋点事件配置表）
- 时间列：无（聚合不带日期谓词）
- 说明：name: 作为唯一标识；remark: 备注；location: 事件触发位置；paramsMapping: 如：影片ID:ext1 表示的是影片ID存储在埋点事件表的ext1列中。
- 字段 4，其中 2 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `name` | 事件名称 | Text | 作为唯一标识 |
| `remark` | 备注 | Text |  |
| `location` | 事件触发位置 | Text |  |
| `paramsMapping` | 事件参数跟埋点事件表字段的映射关系 | Text | 如：影片ID:ext1 表示的是影片ID存储在埋点事件表的ext1列中。 |

### `gather.gather`

- gather（埋点事件表）
- 时间列：`createTime`
- 说明：本表包含近2个月的埋点数据，存储按创建时间每天一个分区。
核心信息：事件名称、guid、uid、事件时间、客户端类型、事件参数、渠道、App版本
注意事项：
1、本表数据量巨大，务必带事件时间参数，时间范围最多不超过5天。
2、连表（join）时需要谨慎，需要考虑ClickHouse的最佳连表策略。
3、如果关注使用/活跃时长的，使用elt_user_active会更加的快捷。
- 字段 20，其中 12 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `createTime` | 事件发生时间 | DateTime | 核心的时间过滤字段 |
| `clientTime` | 客户端的事件发生时间 | DateTime | 客户端上报的事件时间，考虑到客户端的时间并不可靠，这里仅供参考，不要使用此字段作为时间过滤字段。 |
| `eventName` | 事件名称 | Text |  |
| `guid` | GUID | Text | 设备唯一标识 |
| `clientType` | 客户端类型 | Integer | 映射关系：1:安卓，2:iOS，4:H5，6:安卓TV |
| `channel` | 渠道 | Text |  |
| `ip` | IP | Text |  |
| `package_name` | 包名 | Text |  |
| `ext` | Ext | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext1` | Ext1 | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext2` | Ext2 | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext3` | Ext3 | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext4` | Ext4 | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `ext5` | Ext5 | Text | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `params` | Params | Text |  |
| `appVer` | App版本号码 | Text |  |
| `ext6` | Ext6 | BigInteger | 根据事件名称和埋点事件配置表的参数映射关系，来确定本字段存储的值的意义 |
| `appVerName` | App版本名称 | Text |  |
| `uid` | 用户UID | BigInteger | 账号唯一标识 |
| `contentLang` | ContentLang | Text |  |

### `gather.gather_stat`

- gather_stat（Gather Stat）
- 时间列：`date`
- 说明：无表级说明；5 列
- 字段 5，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `createTime` | CreateTime | DateTime |  |
| `date` | Date | Date |  |
| `eventName` | EventName | Text |  |
| `eventCount` | EventCount | BigInteger |  |
| `activeUsers` | ActiveUsers | BigInteger |  |

### `gather.gather_stat_view`

- gather_stat_view（Gather Stat View）
- 时间列：`date`
- 说明：无表级说明；4 列
- 字段 4，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `date` | Date | Date |  |
| `eventName` | EventName | Text |  |
| `eventCount` | EventCount | BigInteger |  |
| `activeUsers` | ActiveUsers | BigInteger |  |

### `gather.gather_t`

- gather_t（Gather T）
- 时间列：`createTime`
- 说明：无表级说明；22 列
- 字段 22，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `host` | Host | Text |  |
| `createTime` | CreateTime | DateTime |  |
| `clientTime` | ClientTime | DateTime |  |
| `eventName` | EventName | Text |  |
| `guid` | GUID | Text |  |
| `clientType` | ClientType | Integer |  |
| `channel` | Channel | Text |  |
| `ip` | IP | Text |  |
| `package_name` | Package Name | Text |  |
| `webDeviceId` | WebDeviceId | Text |  |
| `domain` | Domain | Text |  |
| `ext` | Ext | Text |  |
| `ext1` | Ext1 | Text |  |
| `ext2` | Ext2 | Text |  |
| `ext3` | Ext3 | Text |  |
| `ext4` | Ext4 | Text |  |
| `ext5` | Ext5 | Text |  |
| `params` | Params | Text |  |
| `appVer` | AppVer | Text |  |
| `ext6` | Ext6 | BigInteger |  |
| `appVerName` | AppVerName | Text |  |
| `uid` | UID | BigInteger |  |

### `gather.gather_w`

- gather_w（Gather W）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；4 列
- 字段 4，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `eventName` | EventName | Text |  |
| `guid` | GUID | Text |  |
| `ext2` | Ext2 | Text |  |
| `ext6` | Ext6 | BigInteger |  |

### `gather.gather_w2`

- gather_w2（Gather W2）
- 时间列：无（聚合不带日期谓词）
- 说明：无表级说明；3 列
- 字段 3，其中 0 个有 description

| 字段 | 显示名 | 类型 | 说明 |
|---|---|---|---|
| `guid` | GUID | Text |  |
| `ext2` | Ext2 | Text |  |
| `ext6` | Ext6 | BigInteger |  |
