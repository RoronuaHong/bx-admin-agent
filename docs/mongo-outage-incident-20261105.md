# MongoDB 存储层事故复盘（2026-11-05）

> **定位**：一次真实存储层故障的完整复盘 + 随之落地的代码防线。
> **取证口径**：全部结论可回溯到 `apps/agent-server/logs/agent-server-dev.out-12.log`（pm2 输出）与当时的进程启动参数。无法从证据得出的部分标注为「推断」。
> **边界**：只讲存储层（Mongo 连接 / 错误语义 / 降级策略）。BI 取数、模型配额等无关链路不在本文范围。

---

## 0. 结论速览

**现象**：前端侧栏与定时任务页持续报错，`GET /chat/conversations` / `GET /chat/schedules` 一律 **500**，持续约 16 小时（2026-11-04 18:16 → 2026-11-05 10:20）。服务端日志里真正有用的信息只有一行：

```
MongoServerError: Command find requires authentication   (code 13, codeName: Unauthorized)
```

**根因（一句话）**：Mongo 侧开启了认证，而服务端的 `MONGO_URI` 没有带凭据 —— **握手能通过、每条命令都被拒**。

**为什么拖了 16 小时、还差点查不出来**：四个放大器叠在一起。

| # | 放大器 | 后果 |
|---|---|---|
| ① | 存储层故障被当成「服务端内部错误」（500 `INTERNAL_ERROR`） | 排查者默认去查程序 bug，真实原因（一条配置）被淹没 |
| ② | 客户端单例只在**连接失败**时才重建 | 连接「活着」但命令被拒时永远复用坏连接，**恢复必须重启进程** |
| ③ | 文档宣称的「失败降级内存」只覆盖**连接期**失败 | 查询期错误直接冒泡成 500；而若简单地把它也降级，用户会看到「会话列表空了」——数据其实还在库里 |
| ④ | 连接串被原样打进日志 | 密码进了 `logs/agent-server-dev.out-12.log`（已随本次修复改为脱敏） |

---

## 1. 时间线取证

| 时间 | 证据 | 说明 |
|---|---|---|
| 2026-11-04 18:14:35 | `[db] MongoDB 已连接 mongodb://127.0.0.1:27017/bx_agent` | 进程启动，**连接串里没有凭据**；握手成功（驱动在 URI 无凭据时根本不做认证） |
| 2026-11-04 18:16:55 | `GET /chat/conversations 500 4ms` / `GET /chat/schedules 500 3ms` | 故障起点：Mongo 侧开启认证后，未认证连接的任何命令都被拒 |
| 2026-11-05 09:39 / 09:52 / 09:55 … | 同样的 500 反复出现 | 持续 16 小时无自愈（②：单例不会重建） |
| 2026-11-05 10:15:12 | `MongoServerError: Command find requires authentication` + `[scheduler] tick 失败` | 日志终于露出 Mongo 侧原因；此前只有「500」这条无用信息（①） |
| 2026-11-05 10:20:42 | `[db] MongoDB 已连接 mongodb://bxagent:***@127.0.0.1:27017/?authSource=bx_agent` | 手工补凭据 + 重启进程 → 立即恢复 200 |

---

## 2. 根因链：为什么「连上」不等于「能用」

1. **URI 无凭据 ⇒ 驱动不认证**：`mongodb://127.0.0.1:27017/bx_agent` 里没有用户名密码，驱动握手时直接跳过认证，于是 `connect()` 成功。
2. **mongod 开启认证 ⇒ 命令被拒**：此后任何 `find` / `update` 都返回 `code 13 requires authentication`。
3. **我们的兜底只覆盖连接期**：`conversations.getColl()` 原来 `catch { return null }` 只在 `getMongoClient()` 失败时触发；连接成功、查询报错时，错误一路冒泡到 Hono 的兜底 handler → 500（③）。
4. **单例不会因「命令被拒」而重建**：`db.ts` 原来只在 `connect()` 失败时清空 `clientPromise`；本例中连接始终「活着」，于是永远复用它 → 只能靠重启进程（②）。

> 注：Mongo 侧的具体变更（何时开认证、账号如何建）不在本仓取证范围内，属**推断**：从「连接串没有凭据却能连上」与「命令一律要认证」两点反推，最可能是 mongod 启用了 `--auth` 而连接串未同步更新。

---

## 3. 修复（本次已落地）

| 改动 | 文件 | 作用 |
|---|---|---|
| 建连后 **ping 自检** | `src/db.ts` | 把「连上但没认证」拦在建连这一步，而不是等第一条业务查询 |
| 认证类错误 **fail-fast** | `src/db.ts` | 凭据明确错误（code 18）不再每 30s 空转重试；错误信息直接点名「用户名/密码 / authSource / 改完需重启」 |
| **死连接不复用** | `src/db.ts` | 监听 client 的 `close` / `error`，立刻丢弃单例 → 下次请求重建连接（Mongo 恢复后自愈，不必重启进程） |
| **`reportMongoFailure`** | `src/db.ts` | 上层捕获到 Mongo 错误时作废坏连接并升级致命错误 |
| **凭据脱敏** | `src/db.ts` | 日志里的连接串不再出现密码（`mongodb://bxagent:***@…`） |
| **`MongoUnavailableError.degradable`** | `src/db.ts` | 区分「可降级到内存」与「必须显式报错」，把故障语义显式化 |
| **503 `STORAGE_UNAVAILABLE`** | `src/app.ts` | 存储层故障不再混成 500 `INTERNAL_ERROR`：可恢复的存储故障与程序 bug 分开报 |
| 删掉**被覆盖的第二个 `onError`** | `src/app.ts` | Hono 的 `onError` 是「后注册覆盖前者」，原来第一个 handler 是死代码 |
| 查询期故障**不再静默返回空列表** | `src/conversations.ts`、`src/schedules.ts` | 运行期掉线不再「假装没数据」，而是明确报错 |
| 本地测试读 `.env` 的 `MONGO_URI` | `vitest.config.ts` | Mongo 开认证后，依赖 Mongo 的用例会整片失败（看着像回归，其实只是没凭据）；只取这一个变量，不把整份 `.env` 灌进测试环境 |

---

## 4. 故障语义表（改完后的对外行为）

| 情形 | 对外 | 为什么这样定 |
|---|---|---|
| 冷启动，Mongo 压根没起来 | **200 + 内存降级** | 既有契约：存储不可用不该让整个聊天不可用 |
| 冷启动，**凭据不对** | **503** + 服务端日志点名配置 | 降级等于「假装没数据」——用户会以为会话丢了，数据其实还在库里 |
| 运行期掉线 / 认证失效 | **503** | 同上：宁可报错，不要静默给空列表 |
| 运行期 Mongo 恢复 | 自动重连 → 200 | 单例会在失败时被作废，下次请求重建连接，不必重启进程 |

---

## 5. 遗留与运维须知

- **本地测试库权限**：测试默认写 `bx_agent_test`（与运行实例隔离）。本地 Mongo 开了认证时，若账号只有 `bx_agent` 的权限，用 `MONGO_TEST_DB_NAME` 指一个有权限的库，或给账号补 `bx_agent_test` 的 `readWrite`。
- **best-effort 模块不自愈**：`task-store.ts` / `model-cooldown.ts` 在**启动时**连不上会永久退回内存（`mongoReady=false` 不再重试），直到重启进程才恢复落库。这是既有语义，本次未改（它们不直接面向用户展示数据）；若要一并收敛，按 `src/db.ts` 的 `degradable` 语义放开重试即可。
- **CI 不受影响**：`.github/workflows/ci.yml` 的 mongo service 未开认证，并显式传 `MONGO_URI=mongodb://127.0.0.1:27017`（优先级高于 `.env`）。

---

## 6. 回归

`apps/agent-server/tests/mongo-resilience.test.ts`（10 例）把当时缺的几道防线逐条钉死：

| 用例 | 钉住的行为 |
|---|---|
| [A] | 并发首次调用只建一个 client；建连后必做 ping 自检 |
| [B] | 连接失败进 30s 冷却，冷却期内快速失败、不新建 client |
| [C] | ping 失败（凭据不对）视为不可用，错误点名 `authSource` |
| [D] | client 关闭后单例被丢弃，下次调用重建连接（自愈） |
| [E] | 凭据明确错误 fail-fast：不再每 30s 空转重试 |
| [F] | `reportMongoFailure` 让运行期掉线后能重建连接 |
| [G] | 冷启动可降级 / 认证错不可降级的语义分层 |
| [H] | 错误分类不误伤：非 Mongo 错误不被当成存储故障 |
| [I] | 连接串脱敏：日志/错误里不出现密码 |
| [J] | 存储层故障的对外口径固定为 503 + `STORAGE_UNAVAILABLE` |
