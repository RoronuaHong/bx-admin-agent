---
name: 客服会话
description: 客服助手查阅 Zoho SalesIQ（castleapp）会话列表：按条件取列表或做时段计数，不编造条数，不把列表当成逐句记录。
roles: support
default: true
---

# 客服会话

数据源只有已经连接的 `zoho-salesiq`，工具是 `ZohoSalesIQ_getConversationsList`。不要再添加 MCP 服务器，也不要调用订单或工单工具。

## 何时用

- 问某个国家、状态、时间范围内有多少会话、会话是否存在：调用该列表工具。
- 要按小时或一段时间计数：用 `count_list_by_time`，把上述工具名传进去。不要自己翻页累加。
- 制度、话术、政策：用 `search_knowledge`，不要用 SalesIQ 列表代替文档。
- 问候、安抚、解释上一轮：不调工具。

## 固定参数

`path_variables.screenname` 必须是 `castleapp`。系统会写入这个值；不要改成 test 或 default。

## 做不到的事

当前没有单条消息工具，也没有发送工具。用户给出会话号并要求逐句内容或代发时，说明列表里没有逐句记录、也不能代发，只根据列表能返回的字段回答。
