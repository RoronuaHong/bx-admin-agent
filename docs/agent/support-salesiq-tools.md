# Zoho SalesIQ 工具清单（客服助手只用其中几个）

> 2026-10-12。来源：本机已连接的 Zoho MCP `tools/list`，共 **281** 个。控制台 [工具页](https://mcp.zoho.com/mcp-client/941126997#/server/115502000000014020/tools) 需 Zoho 组织账号登录（未登录会被重定向到 `accounts.zoho.com/signin`），**网页直接抓不到**；本机 `tools/list` 才是权威且机器可读的来源，已与本文逐名核对（missing 0 / extra 0）。页面上的标题是展示名，和下面的原始工具名不一定相同。白名单只写原始名。
>
> 客服助手是坐席副驾，不是访客机器人。会话事实从 SalesIQ 来，制度从 `search_knowledge` 来。每轮只把个位数工具交给模型。怎么收、为什么不靠 `search_tools` 从 281 个里挑，见 `support-salesiq-plan.md` §3.1。
>
> 2026-10-12 扩容口径：阶段一白名单 1→10 个只读，阶段二再扩到 26 个只读子集并启用按需加载（deferred 由 schema 体积自动触发）。配置里给每个白名单工具加了 `toolNotes` 中文用途注记（`src/mcp/hub.ts` 的 `withToolNote` 合并进 description，不动上游 schema）——否则按需加载下的检索拿中文问句匹配英文工具名/描述会落空。281 全量任何阶段都不进模型。分阶段方案与预警影响核查见 `support-salesiq-plan.md` §7。

公开接口说明（和工具名对照，不在代码里另起一套名字）：

- 列表：[Get details of a List of Conversations](https://www.zoho.com/salesiq/help/developer-section/get-conversation-list-details-v2.html)
- 消息：[Get Conversation Messages](https://www.zoho.com/salesiq/help/developer-section/conversation-get-message-v2.html)
- 坐席发送：[Send message (Operator)](https://www.zoho.com/salesiq/help/developer-section/send-message-operator-conversation-v2.html)

## 建议放进客服白名单的

都要固定 path_variables，但**分两族**（2026-10-12 按真实 schema 实测，不用 `"*"` 通配——portalid 族没有 screenname 键，通配注入会报 Invalid keys）：

- **screenname 族**（15 个）：会话列表/详情/线程/通话/坐席/部门/门户类 → `screenname=castleapp`；
- **portalid 族**（11 个）：逐句消息、备注、单条消息、反馈、访客信息、标签、近期会话、**发送** → `portalid=castleapp`（Zoho 这几个接口的 `portalid` 参数实际收**门户名**而非数字 id；填数字 id 会报 1002 Invalid authorization header）。

逐工具配置见 `.data/mcp-servers.json` 的 `pathDefaults`。

| 阶段 | 原始工具名 | 做什么 | 风险 |
|---|---|---|---|
| 已有 | `ZohoSalesIQ_getConversationsList` | 分页列会话。可按状态、部门、接待人、时间、访客类型、标签、渠道过滤 | `read` |
| 阶段一（读扩容） | `ZohoSalesIQ_getConversationById` | 按会话 id 取详情：接待人、访客、状态、部门和最后一条消息。有会话号时用它，不要用列表翻页去拼 | `read` |
| 阶段一（读扩容） | `ZohoSalesIQ_getConversationMessages` | 取该会话的消息，可按时间和方向过滤。空数组不表示「没有说过话」，也可能是保留策略裁过 | `read` |
| 阶段一（读扩容） | `ZohoSalesIQ_getConversationVisitorInfo` | 该会话访客的浏览器、系统、地理位置、会话时长与轨迹。坐席问「这位访客从哪来 / 用什么设备」时用它 | `read` |
| 阶段一（读扩容） | `ZohoSalesIQ_getFeedBackByChatId` | 按会话 id 取访客反馈（评分、评论），可按时间过滤 | `read` |
| 阶段一（读扩容） | `ZohoSalesIQ_getConversationsNotesList` | 该会话的内部备注列表：坐席协作记录，不是访客原话。备注的 add/update/delete 写工具不进白名单 | `read` |
| 阶段一（备选） | `ZohoSalesIQ_getFeedbackById` | 按反馈 id 取单条详情（评分、评论、关联会话元数据）。上一条拿到 id 后再用 | `read` |
| 阶段一（备选） | `ZohoSalesIQ_getCurrentOperator` | 当前 API 调用者（坐席）自己的档案。排查「我是谁 / 权限」时用 | `read` |
| 阶段一（备选） | `ZohoSalesIQ_listDepartments` / `ZohoSalesIQ_getDepartmentDetails` | 部门名册与单个部门详情（含邮箱配置和坐席分配）。坐席问「这会话分到哪个部门 / 部门里有谁」时用 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getConversationsNotesById` | 按备注 id 取单条坐席备注详情 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getConversationThreads` / `ZohoSalesIQ_getConversationThreadById` | 会话内的线程（多次聊天 session）列表与详情。一条会话可有多个线程 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getConversationRecentChats` | 该会话访客最近的其它会话，跨会话看访客历史 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getConversationTags` | 该会话上打的标签 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getSpecificMessage` | 按消息 id 取单条消息；可选对敏感数据脱敏恢复 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getListOfFeedbacks` | 全门户反馈列表，可按坐席/部门/评分/日期筛选。已知缺陷：`ratings` 参数过滤不可靠 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_List_Calls` / `ZohoSalesIQ_Get_Call_Details` / `ZohoSalesIQ_List_Thread_Calls` | 通话记录：全门户列表、单条详情、某线程内的通话 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getOperatorDetails` / `ZohoSalesIQ_getOperatorStatus` / `ZohoSalesIQ_listOperators` | 坐席详情（id 或邮箱）/当前状态/名册 | `read` |
| 阶段二（子集） | `ZohoSalesIQ_getDepartmentPresence` | 部门在线状态（按坐席可用性计算；需管理员角色） | `read` |
| 阶段二（子集） | `ZohoSalesIQ_listPortals` / `ZohoSalesIQ_getPortalDetails` | 门户列表与详情 | `read` |
| 阶段四（代发，已放行） | `ZohoSalesIQ_sendMessageInConversation` | 往会话里发一条。调用者必须已是该会话参与者，否则接口回 6018。正文空、Jev 没有结果或承诺概率 ≥ 0.9 时，本服务拒绝发出；其余仍走确认卡 | `write`，已在 `toolRisks` 单独声明（优先于 `"*": "read"`），不要清掉 |

`ZohoSalesIQ_replyToMessage` 是回复某一条具体消息，同样要求已是参与者。代发阶段如果坐席明确要「回复那一条」，再单独加，并标 `write`。不要和发送一起预先放进白名单。

### 白名单工具真实接口参数（来自本机 `tools/list`）

> 描述与参数取自 Zoho MCP `tools/list` 的原始返回，未做本地改写。`path_variables` 分两族（screenname 族 / portalid 族，见上），本机用 `pathDefaults` 逐工具固定为 `castleapp`，模型不必也不可猜门户名；漏配或错族会让接口回 1002「Invalid authorization header」，看起来像授权坏了。

**`ZohoSalesIQ_getConversationsList`**（`read`）
- 真实描述：Retrieves a paginated list of conversations associated with the portal. Supports extensive filtering by status, department, attender, app, time range, visitor type, tags, channels, integration status, and more. Results can be sorted and paginated using index-based or page-based pagination.
- 必填：`path_variables`（含 `screenname`）
- 常用可选：`query_params`（status / department / attender / time range / visitor type / tags / channels / limit 最大 99 / 分页）
- 公开接口：[Get details of a List of Conversations](https://www.zoho.com/salesiq/help/developer-section/get-conversation-list-details-v2.html)

**`ZohoSalesIQ_getConversationById`**（`read`）
- 真实描述：Retrieves the complete details of a specific conversation identified by its unique conversation ID. Returns comprehensive conversation data including owner, attender, visitor information, status, timestamps, department, language, notes, and the last message information.
- 必填：`path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`
- 有会话号时优先用它，不要用列表翻页去拼一条对话。

**`ZohoSalesIQ_getConversationMessages`**（`read`）
- 真实描述：Retrieve all messages in a conversation with pagination and filtering options. Supports filtering by time range, message direction, sync time, and specific message context. Note: An empty data array (data: []) may be returned for conversations that have messages but whose content has been pruned by the message retention policy, archived, or restricted by channel visibility rules.
- 必填：`path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`（time range / direction）
- 空数组不表示「没说过话」，可能是保留策略裁过。

**`ZohoSalesIQ_getConversationVisitorInfo`**（`read`，阶段一）
- 真实描述：Retrieves comprehensive visitor details for a specific conversation, including conversation metadata, visitor browser and system information, location data, session timing, and tracking analytics.
- 必填：`path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`

**`ZohoSalesIQ_getFeedBackByChatId`**（`read`，阶段一）
- 真实描述：Returns the feedback information associated with a given conversation, identified by its conversation ID. Optionally filter by start time to narrow results to a specific feedback thread.
- 必填：`path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`

**`ZohoSalesIQ_getFeedbackById`**（`read`，阶段一备选）
- 真实描述：Returns the complete details of a single feedback entry identified by its feedback ID, including the rating, comment, and associated conversation metadata.
- 必填：`path_variables`（含 `screenname` + 反馈 id）

**`ZohoSalesIQ_getConversationsNotesList`**（`read`，阶段一）
- 真实描述：Retrieves a paginated list of all notes associated with a specific conversation. Each note includes its content, creator details, modification history, edit permissions, and optionally linked chat message details. Results can be filtered by time range and sorted in ascending or descending order.
- 必填：`path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`（time range / 排序）

**`ZohoSalesIQ_getCurrentOperator`**（`read`，阶段一备选）
- 真实描述：Retrieves the details of the currently authenticated operator (the API caller). Useful for identifying the logged-in user's operator profile.
- 必填：`path_variables`（含 `screenname`）

**`ZohoSalesIQ_listDepartments`**（`read`，阶段一备选）
- 真实描述：Retrieves the list of all departments in the specified SalesIQ portal. Supports pagination and incremental sync via last_sync_time.
- 必填：`path_variables`（含 `screenname`）
- 常用可选：`query_params`（分页 / last_sync_time）

**`ZohoSalesIQ_getDepartmentDetails`**（`read`，阶段一备选）
- 真实描述：Retrieves the complete details of a specific department including email configurations and assigned operators.
- 必填：`path_variables`（含 `screenname` + 部门 id）

**`ZohoSalesIQ_sendMessageInConversation`**（`write`，代发阶段才放）
- 真实描述：Send a new message in a conversation with optional file attachments and channel-specific templates. Supports text messages, canned responses, articles, file uploads, and template placeholders. Important: The caller must be an active participant of the conversation. Non-participants will receive error 6018. The 'type' body field should be omitted for standard text messages.
- 必填：`body` + `path_variables`（含 `screenname` + 会话 id）
- 常用可选：`query_params`
- 闸门：正文空、Jev 没有结果、或承诺概率 ≥ 0.9 → 本服务拒绝发出；其余仍走确认卡。不要用 `"*": "read"` 盖住它的 `write`。

**`ZohoSalesIQ_replyToMessage`**（`write`，坐席明确要「回复那一条」时才加）
- 真实描述：Reply to a specific message in a conversation. The reply is linked to the original message and supports text, file attachments, canned responses, and template placeholders. Important: The caller must be an active participant of the conversation. Non-participants will receive error 6018.
- 必填：`body` + `path_variables`（含 `screenname` + 会话 id）
- 同发送一样要求已是参与者；与发送一起预先放进白名单会扩大写面，不要。

## 看得到，但先不放

这些和「查阅一条会话、起草一句回复」无关，或会改 SalesIQ 里的状态。放进来会让模型在相似名字里挑错。

| 原始工具名 | 为什么先不放 |
|---|---|
| `ZohoSalesIQ_getSpecificMessage` | 阶段二已提入白名单（见上表）。名字保留在此供逐名核对 |
| `ZohoSalesIQ_getConversationVisitorInfo` | 阶段一已提入白名单（见上表）。名字保留在此供逐名核对 |
| `ZohoSalesIQ_getConversationsNotesList` | 阶段一已提入白名单（见上表）；备注的 add/update/delete 写工具仍不放 |
| `ZohoSalesIQ_getConversationThreadSummary` | SalesIQ 自己的线程摘要。没有摘要会 204，功能没开会 25001。不能代替本助手的回复，也不能代替 Jev |
| `ZohoSalesIQ_listDepartments` / `ZohoSalesIQ_listOperators` / `ZohoSalesIQ_getCurrentOperator` | 三个都已提入白名单（前两者阶段一、`listOperators` 阶段二，见上表）；坐席/部门的增删改仍不放 |
| `ZohoSalesIQ_shareConversationFileByID` / `ZohoSalesIQ_emailConversationTranscript` / `ZohoSalesIQ_Send_Proactive_Message` / `ZohoSalesIQ_initiateProactiveConversation` / `ZohoSalesIQ_reopenConversation` | 对访客或外部可见，和普通发送一样要单独闸门，现在不接 |
| 接起、转接、关闭、导出、删会话、拉黑、改标签、改访客资料 | 会改会话状态。见下面「会话」里除三个读取以外的名字 |
| WhatsApp、Telegram、Line、微信、群发、机器人、线索、联系人、公司、封禁 IP、门户设置 | 渠道和管理，不是坐席查这一条会话 |

Jev 仍只看坐席的指令和助手草稿，不从这 281 个里选工具。

## 281 个原始名

按 `tools/list` 的名字归类。归类只为阅读，白名单不按这个分类自动扩大。名单与「建议放进客服白名单的」有交叉时，以上表的阶段标注为准（名字仍保留在这里，供逐名核对）。

### 会话（51）

读取且建议使用（白名单）：`ZohoSalesIQ_getConversationsList`、`ZohoSalesIQ_getConversationById`、`ZohoSalesIQ_getConversationMessages`（消息在下一节）、`ZohoSalesIQ_getConversationVisitorInfo`、`ZohoSalesIQ_getConversationsNotesList`、`ZohoSalesIQ_getConversationsNotesById`、`ZohoSalesIQ_getConversationThreads`、`ZohoSalesIQ_getConversationThreadById`、`ZohoSalesIQ_getConversationRecentChats`、`ZohoSalesIQ_getConversationTags`。

其余先不要：

`ZohoSalesIQ_getConversationIntegrations`、`ZohoSalesIQ_updateConversationIntegrationSubAction`、`ZohoSalesIQ_getConversationIntegration`、`ZohoSalesIQ_getConversationTags`、`ZohoSalesIQ_takeoverBotConversation`、`ZohoSalesIQ_getConversationsNotesById`、`ZohoSalesIQ_addConversationsNotes`、`ZohoSalesIQ_reassignConversation`、`ZohoSalesIQ_activeWhishperModeInConversation`、`ZohoSalesIQ_associateConversationTags`、`ZohoSalesIQ_addOperatorInConversation`、`ZohoSalesIQ_deleteConversationsNotesById`、`ZohoSalesIQ_exportConversationById`、`ZohoSalesIQ_closeMissedConversationById`、`ZohoSalesIQ_downloadConversationAttachment`、`ZohoSalesIQ_leaveWhishperModeInConversation`、`ZohoSalesIQ_cancelConversationCloseTimer`、`ZohoSalesIQ_disassociateConversationTags`、`ZohoSalesIQ_downloadConversationAttachmentByChatUrl`、`ZohoSalesIQ_acceptTransferRequestInconversation`、`ZohoSalesIQ_updateConversationsNotesById`、`ZohoSalesIQ_exportConversationsList`、`ZohoSalesIQ_deleteConversations`、`ZohoSalesIQ_scheduleCloseConversation`、`ZohoSalesIQ_getConversationThreadSummaryInsights`、`ZohoSalesIQ_List_Conversation_Calls`、`ZohoSalesIQ_pickupConversation`、`ZohoSalesIQ_updateConversationTags`、`ZohoSalesIQ_bulkTagAssociateConversations`、`ZohoSalesIQ_inviteOperatorToConversation`、`ZohoSalesIQ_removeOperatorInConversation`、`ZohoSalesIQ_assignMissedConversation`、`ZohoSalesIQ_getConversationThreadSummary`、`ZohoSalesIQ_updateVisitorDetailsInConversation`、`ZohoSalesIQ_transferConversation`、`ZohoSalesIQ_joinParticipantsInConversation`、`ZohoSalesIQ_updateConversationCustomInfoById`、`ZohoSalesIQ_getConversationRecentChats`、`ZohoSalesIQ_closeMissedConversations`、`ZohoSalesIQ_getConversationThreads`、`ZohoSalesIQ_getConversationIntegrationData`、`ZohoSalesIQ_closeConversation`、`ZohoSalesIQ_rejectTrasferRequestInConversation`、`ZohoSalesIQ_assignMissedConversations`、`ZohoSalesIQ_getConversationThreadById`、`ZohoSalesIQ_getConversationVisitorInfo`、`ZohoSalesIQ_updateConversationIntegrationAction`、`ZohoSalesIQ_getConversationsNotesList`、`ZohoSalesIQ_blockIpFromConversation`

### 消息（15）

建议使用：`ZohoSalesIQ_getConversationMessages`、`ZohoSalesIQ_getSpecificMessage`（按消息 id 取单条，阶段二进白名单）。

其余先不要：

`ZohoSalesIQ_markMessageAsRead`、`ZohoSalesIQ_getSpecificMessage`、`ZohoSalesIQ_getMessageHandler`、`ZohoSalesIQ_translateConversationMessages`、`ZohoSalesIQ_invokeMessageHandler`、`ZohoSalesIQ_markMessagesAsReadBulk`、`ZohoSalesIQ_editMessageInConversation`、`ZohoSalesIQ_getConversationTranslatedMessages`、`ZohoSalesIQ_list_whatsapp_message_templates`、`ZohoSalesIQ_deleteMessageInConversation`、`ZohoSalesIQ_get_whatsapp_message_template`、`ZohoSalesIQ_create_whatsapp_message_template`、`ZohoSalesIQ_update_whatsapp_message_template`、`ZohoSalesIQ_delete_whatsapp_message_template`

### 对访客可见的发送与主动触达（19）

`ZohoSalesIQ_sendMessageInConversation` 已在阶段四提入白名单（`toolRisks` 单独标 `write`）。`ZohoSalesIQ_replyToMessage` 与其余先不要：

其余先不要：

`ZohoSalesIQ_Get_Proactive_Channel_Accounts`、`ZohoSalesIQ_Get_Proactive_Template_Details`、`ZohoSalesIQ_List_Proactive_Templates`、`ZohoSalesIQ_Create_Proactive_Template`、`ZohoSalesIQ_resendEmailConfirmation`、`ZohoSalesIQ_initiateProactiveConversation`、`ZohoSalesIQ_Update_Proactive_Template`、`ZohoSalesIQ_Get_Proactive_Message_List`、`ZohoSalesIQ_List_Proactive_Messages`、`ZohoSalesIQ_Delete_Proactive_Template`、`ZohoSalesIQ_Get_Proactive_Message_Details`、`ZohoSalesIQ_reopenConversation`、`ZohoSalesIQ_getConversationReopenDetails`、`ZohoSalesIQ_shareConversationFileByID`、`ZohoSalesIQ_emailConversationTranscript`、`ZohoSalesIQ_resendMessage`、`ZohoSalesIQ_Send_Proactive_Message`

### 坐席与部门（22）

建议使用（白名单）：`ZohoSalesIQ_getOperatorDetails`、`ZohoSalesIQ_getOperatorStatus`、`ZohoSalesIQ_listOperators`、`ZohoSalesIQ_listDepartments`、`ZohoSalesIQ_getDepartmentDetails`、`ZohoSalesIQ_getDepartmentPresence`、`ZohoSalesIQ_getCurrentOperator`。

其余先不要：

`ZohoSalesIQ_removeDepartmentsFromOperator`、`ZohoSalesIQ_getOperatorDetails`、`ZohoSalesIQ_getCurrentOperator`、`ZohoSalesIQ_addDepartmentsToOperator`、`ZohoSalesIQ_disableDepartment`、`ZohoSalesIQ_enableOperator`、`ZohoSalesIQ_updateOperatorStatus`、`ZohoSalesIQ_getDepartmentPresence`、`ZohoSalesIQ_updateDepartment`、`ZohoSalesIQ_createDepartment`、`ZohoSalesIQ_listDepartments`、`ZohoSalesIQ_deleteOperator`、`ZohoSalesIQ_listOperators`、`ZohoSalesIQ_removeOperatorsFromDepartment`、`ZohoSalesIQ_addOperatorsToDepartment`、`ZohoSalesIQ_getDepartmentDetails`、`ZohoSalesIQ_deleteDepartment`、`ZohoSalesIQ_getOperatorStatus`、`ZohoSalesIQ_disableOperator`、`ZohoSalesIQ_createOperator`、`ZohoSalesIQ_updateOperator`、`ZohoSalesIQ_enableDepartment`

### 访客路由规则（7）

先不要：

`ZohoSalesIQ_GetVisitorRoutingRuleById`、`ZohoSalesIQ_UpdateVisitorRoutingCommonRule`、`ZohoSalesIQ_GetVisitorRoutingCommonRule`、`ZohoSalesIQ_GetVisitorRoutingRules`、`ZohoSalesIQ_DeleteVisitorRoutingRule`、`ZohoSalesIQ_UpdateVisitorRoutingRule`、`ZohoSalesIQ_CreateVisitorRoutingRule`

### 其余（167）

渠道、群发、机器人、线索、联系人、公司、封禁、门户和模板。其中反馈（`ZohoSalesIQ_getListOfFeedbacks`）、通话（`ZohoSalesIQ_List_Calls`、`ZohoSalesIQ_Get_Call_Details`、`ZohoSalesIQ_List_Thread_Calls`）、门户（`ZohoSalesIQ_listPortals`、`ZohoSalesIQ_getPortalDetails`）已在阶段二提入白名单（见上表），其余先不要：

`ZohoSalesIQ_Get-Blocked-IP-Activities`、`ZohoSalesIQ_Bulk-Delete-DoNotTrack-IPs`、`ZohoSalesIQ_List_Calls`、`ZohoSalesIQ_listBots`、`ZohoSalesIQ_create_telegram_channel_configuration`、`ZohoSalesIQ_Get-Spammer-Comment`、`ZohoSalesIQ_disconnect_line_account_from_app`、`ZohoSalesIQ_Update-Blocked-IP-Comment`、`ZohoSalesIQ_exportsFeedbacks`、`ZohoSalesIQ_GetAllLeadViews`、`ZohoSalesIQ_BulkDeleteCompanies`、`ZohoSalesIQ_DeleteTriggerRuleById`、`ZohoSalesIQ_listPortals`、`ZohoSalesIQ_UpdateLeadByID`、`ZohoSalesIQ_UpdateUserViewsByID`、`ZohoSalesIQ_CreateContactView`、`ZohoSalesIQ_Update-Spammer-Status`、`ZohoSalesIQ_deleteEmailTemplate`、`ZohoSalesIQ_connect_wechat_account_to_app`、`ZohoSalesIQ_Update-DoNotTrack-Status`、`ZohoSalesIQ_deleteWebhookBotKey`、`ZohoSalesIQ_update_telegram_channel_configuration`、`ZohoSalesIQ_verify_whatsapp_phone_number_otp`、`ZohoSalesIQ_updatePortal`、`ZohoSalesIQ_List-DoNotTrack-Comments`、`ZohoSalesIQ_BulkDeleteLeads`、`ZohoSalesIQ_list_line_accounts_with_subscriber_counts`、`ZohoSalesIQ_list_wechat_accounts_subscriber_counts`、`ZohoSalesIQ_Add-Blocked-IP-Comment`、`ZohoSalesIQ_generateWebhookBotKey`、`ZohoSalesIQ_getFailureHandler`、`ZohoSalesIQ_Get_Broadcast_Details`、`ZohoSalesIQ_get_line_channel_configuration`、`ZohoSalesIQ_Block-Spammer`、`ZohoSalesIQ_disconnect_wechat_account_from_app`、`ZohoSalesIQ_List-Spammers`、`ZohoSalesIQ_get_whatsapp_channel_configuration`、`ZohoSalesIQ_list_telegram_bots_for_portal`、`ZohoSalesIQ_GetAllUsers`、`ZohoSalesIQ_updatePortalSettings`、`ZohoSalesIQ_Get-Spammer-Activities`、`ZohoSalesIQ_Delete-Blocked-IP-Comment`、`ZohoSalesIQ_Bulk-Delete-Spammers`、`ZohoSalesIQ_create_wechat_channel_configuration`、`ZohoSalesIQ_GetTrackingPreset`、`ZohoSalesIQ_update_whatsapp_channel_configuration`、`ZohoSalesIQ_updateEmailTemplate`、`ZohoSalesIQ_GetTrackingPresetById`、`ZohoSalesIQ_List-Spammer-Comments`、`ZohoSalesIQ_List_Broadcast_People`、`ZohoSalesIQ_Get-DoNotTrack-Activities`、`ZohoSalesIQ_connect_whatsapp_phone_number_to_app`、`ZohoSalesIQ_createChatmonitor`、`ZohoSalesIQ_Get_Call_Details`、`ZohoSalesIQ_Add-DoNotTrack-IP`、`ZohoSalesIQ_List-Blocked-IP-Comments`、`ZohoSalesIQ_getFeedBackByChatId`、`ZohoSalesIQ_DeleteUserViewByID`、`ZohoSalesIQ_UpdateContactViewByID`、`ZohoSalesIQ_createPortal`、`ZohoSalesIQ_list_whatsapp_business_accounts`、`ZohoSalesIQ_Delete-Spammer`、`ZohoSalesIQ_getEmailTemplate`、`ZohoSalesIQ_GetLeadsByID`、`ZohoSalesIQ_CreateUserView`、`ZohoSalesIQ_List-Blocked-IPs`、`ZohoSalesIQ_create_whatsapp_template_translation`、`ZohoSalesIQ_DeleteContactViewByID`、`ZohoSalesIQ_get_whatsapp_wallet_credits`、`ZohoSalesIQ_List-DoNotTrack-IPs`、`ZohoSalesIQ_GetContactByID`、`ZohoSalesIQ_updateBotHandlers`、`ZohoSalesIQ_updateBot`、`ZohoSalesIQ_Add-Spammer-Comment`、`ZohoSalesIQ_getChatmonitorById`、`ZohoSalesIQ_getContextHandler`、`ZohoSalesIQ_DeleteCompanyByID`、`ZohoSalesIQ_Get-Spammer`、`ZohoSalesIQ_getTriggerHandler`、`ZohoSalesIQ_GetUsersByID`、`ZohoSalesIQ_List_Broadcast_Audience`、`ZohoSalesIQ_get_telegram_channel_configuration`、`ZohoSalesIQ_Get-Blocked-IP-Comment`、`ZohoSalesIQ_convertCallToChat`、`ZohoSalesIQ_GetTriggerRuleById`、`ZohoSalesIQ_BulkDeleteContacts`、`ZohoSalesIQ_UpdateCompanyByID`、`ZohoSalesIQ_Block-IP`、`ZohoSalesIQ_Block-Spammer-From-Chat`、`ZohoSalesIQ_disconnect_whatsapp_phone_number_from_app`、`ZohoSalesIQ_list_available_whatsapp_phone_numbers`、`ZohoSalesIQ_disconnect_telegram_bot_from_app`、`ZohoSalesIQ_deleteChatmonitor`、`ZohoSalesIQ_DeleteLeadViewByID`、`ZohoSalesIQ_Trigger_Broadcast`、`ZohoSalesIQ_Delete-DoNotTrack-Comment`、`ZohoSalesIQ_CreateTriggerRules`、`ZohoSalesIQ_Delete-Spammer-Comment`、`ZohoSalesIQ_update_whatsapp_template_translation`、`ZohoSalesIQ_List_Broadcasts`、`ZohoSalesIQ_get_whatsapp_template_translation`、`ZohoSalesIQ_Get-DoNotTrack-Comment`、`ZohoSalesIQ_Bulk-Delete-Blocked-IPs`、`ZohoSalesIQ_getPortalDetails`、`ZohoSalesIQ_list_waba_phone_numbers`、`ZohoSalesIQ_createEmailTemplate`、`ZohoSalesIQ_updatePortalOwner`、`ZohoSalesIQ_create_line_channel_configuration`、`ZohoSalesIQ_invokeTriggerHandler`、`ZohoSalesIQ_initiate_whatsapp_phone_otp`、`ZohoSalesIQ_BulkDeleteUsers`、`ZohoSalesIQ_getPortalSettings`、`ZohoSalesIQ_deleteBotPreviewFile`、`ZohoSalesIQ_create_whatsapp_channel_configuration`、`ZohoSalesIQ_connect_line_account_to_app`、`ZohoSalesIQ_Add-DoNotTrack-Comment`、`ZohoSalesIQ_Get-DoNotTrack-IP`、`ZohoSalesIQ_bulkDeleteEmailTemplates`、`ZohoSalesIQ_get_wechat_channel_configuration`、`ZohoSalesIQ_DeleteUserByID`、`ZohoSalesIQ_Create_Broadcast`、`ZohoSalesIQ_GetAllCompanies`、`ZohoSalesIQ_deleteBot`、`ZohoSalesIQ_GetAllLeads`、`ZohoSalesIQ_createBot`、`ZohoSalesIQ_uploadBotPreviewFile`、`ZohoSalesIQ_listEmailTemplates`、`ZohoSalesIQ_purchase_whatsapp_wallet_credits`、`ZohoSalesIQ_Update-Spammer-Comment`、`ZohoSalesIQ_CreateCustomLeadView`、`ZohoSalesIQ_Get-Spammer-History`、`ZohoSalesIQ_get_whatsapp_facebook_manager_status`、`ZohoSalesIQ_UpdateTrackingPresetById`、`ZohoSalesIQ_GetAllContactViews`、`ZohoSalesIQ_CreateNewLead`、`ZohoSalesIQ_DeleteContactByID`、`ZohoSalesIQ_getFeedbackById`、`ZohoSalesIQ_connect_telegram_bot_to_app`、`ZohoSalesIQ_update_line_channel_configuration`、`ZohoSalesIQ_DeleteTrackingPresetById`、`ZohoSalesIQ_listAllChatmonitors`、`ZohoSalesIQ_UpdateContactByID`、`ZohoSalesIQ_Update-Blocked-IP-Status`、`ZohoSalesIQ_CreateTrackingPreset`、`ZohoSalesIQ_Update_Broadcast`、`ZohoSalesIQ_delete_whatsapp_template_translation`、`ZohoSalesIQ_CreateCompany`、`ZohoSalesIQ_updateChatmonitor`、`ZohoSalesIQ_update_wechat_channel_configuration`、`ZohoSalesIQ_GetTriggerRules`、`ZohoSalesIQ_getListOfFeedbacks`、`ZohoSalesIQ_GetCompaniesByID`、`ZohoSalesIQ_UpdateLeadViewsByID`、`ZohoSalesIQ_GetAllContacts`、`ZohoSalesIQ_Delete_Broadcast_Executor`、`ZohoSalesIQ_UpdateTriggerRule`、`ZohoSalesIQ_UpdateUserByID`、`ZohoSalesIQ_CreateNewContacts`、`ZohoSalesIQ_get_wechat_server_ip_addresses`、`ZohoSalesIQ_Update_Broadcast_Executor`、`ZohoSalesIQ_Get-Blocked-IP`、`ZohoSalesIQ_getBot`、`ZohoSalesIQ_GetAllUserViews`、`ZohoSalesIQ_List_Thread_Calls`、`ZohoSalesIQ_Update-DoNotTrack-Comment`、`ZohoSalesIQ_DeleteLeadsByID`、`ZohoSalesIQ_Delete_Broadcast`
