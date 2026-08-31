---
name: 对齐 Cursor 的歧义反问机制落地
overview: 对齐 Cursor 46.11 的歧义处理机制：去掉本仓库对反问的写死负面压制（request_clarification 描述 + resident rule「查询不反问可选条件」），改为 Cursor AskQuestion 式纯正向引导 + 「缺参/目标不明时反问用户」的绿灯条款，让模型在目标/词义多义时主动 request_clarification，而非硬猜取数。
---

