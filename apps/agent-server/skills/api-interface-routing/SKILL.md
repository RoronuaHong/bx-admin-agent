---
name: api-interface-routing
description: 已定位业务模块但需从多个接口中精确选一个时使用：用 read_api_module 读模块源码，依函数名语义选出唯一接口，将完整 operation 填入 call_api。
version: 1.0.0
---

# 接口选路（从模块接口源码选具体接口）

已定位业务模块（如 `user` / `account` / `vipExchangeCode`）后，一个模块下往往有多个接口（列表/详情/新增/修改/删除/导出/统计……）。**必须由你（模型）读取接口源码后选出唯一接口**，把完整 `operation`（`module.func`）填进 `call_api`；服务端仅在**你没给完整 operation** 时按英文命名惯例兜底，不替代你的精确决策。

## 方法（读模块接口源码）

1. **先读接口清单**：调用 `read_api_module`，参数传已定位的模块（`module` 或 `moduleId`），拿到该模块所有接口的完整源码（函数名、参数、URL、method）。
2. **按用户意图选接口**，依据函数名语义匹配：

   | 用户意图 | 接口函数名特征 |
   |---|---|
   | 列表/分页/搜索 | `getList`、`List`、`Page`、`Search`、`Query`、`getAll`、`Stat`/`Report`（统计类） |
   | 详情/单条 | `getById`、`getDetail`、`Info`、`InfoById`、`Detail` |
   | 新增/创建 | `create`、`save`、`add`、`insert`、`createOrUpdate` |
   | 修改/编辑 | `update`、`edit`、`save`、`createOrUpdate` |
   | 删除/移除 | `delete`、`remove`、`del` |
   | 上下线/启停 | `online`/`offline`、`enable`/`disable`、`up`/`down`、`shelf`/`unshelf` |
   | 导出 | `export` |
   | 批量 | `batch`、`bulk`、`batchUpdate`/`batchDelete` |

3. **精确到唯一接口**：若模块内有多个「列表类」接口（如 `getList` 与 `getMovieSearchStatList`），依据用户具体诉求选**语义最贴切**的那个（如「影片搜索统计」→ `getMovieSearchStatList`，而非通用 `getList`）。拿不准时用 `grep_codebase` 查 PC 端 `src/views/<模块>/` 页面实际调用了哪个接口。
4. **⚠️ List.vue 页面但模块无 getList 接口（关键场景）**：目标页面名可能带 `List`（如 `userlayer/accountLayer/List.vue`），但对应模块 `src/api/<模块>.ts` 里**没有名为 `getList` 的标准列表接口**（如 `user/account_layer` 只有 `getStickiness`/`getSummary` 等统计类接口）。此时**必须以页面源码实际 import 的函数为准**：用 `grep_codebase` 或 `read_file` 打开该 `List.vue`，看它 `import { xxx } from '/@/api/...'` 拉数据用的是哪个函数，把那个函数当作列表接口调用（如 `user/account_layer.getStickiness`）。**禁止**因为"找不到 getList 就认为没有列表接口"而绕路/空转/放弃——页面能展示列表，就一定有它正在用的数据函数，抄页面 import 的函数名即可。
5. **⚠️ 别被其他模块的 getList 诱惑（关键场景）**：当你已用 `search_api_module` 定位到目标页面（如「用户分层」→ `userlayer/accountLayer/List.vue` → 接口模块 `user/account_layer`），**即使你在其他模块源码里看到函数名很"标准"的 `getList`（如 `userlayer/account_group_stat.getList`「人群包数据统计」、`user/special_offer.getList`「优惠活动」），只要它们不是目标页面 import 的模块，就不能用**。判定标准只有一个：**目标页面 import 的模块 + 该模块下语义最贴切的函数**。`read_api_module` 返回的 `[接口速览]` 会标注每个函数的 method 与中文描述并标记「← 列表/分页候选」，以此为准选接口，不要因为函数名恰巧叫 getList 就改选别家模块的接口。
6. **确认参数**：从源码函数签名看必填参数（如 `ids`、`page`、`pageSize`、`name`），在 `call_api.params` 里按字段名传。
7. **把完整 operation 填入 call_api**：`call_api` 的 `operation` 字段传 `module.func`（如 `account.getList`、`user/account_layer.getStickiness`、`vipExchangeCode.getById`），`params` 传业务参数。

## ⚠️ 警惕目录 vs 文件命名撞车（模块定位歧义场景）

当存在同名但语义不同的代码单元时，**以目标页面 import 的模块为准，绝不凭文件名相似猜测**：

- `src/api/account.ts`（文件，影视用户模块，`List.vue` import 它）→ 用户要「用户列表」应定位到此。
- `src/api/user`（目录，后台账号/用户分层等子模块）→ 名字含 "user" 但语义是「后台账号」，不是影视用户列表。

若 `search_api_module` 命中多个候选（例如一个是 `<模块>.ts` 文件、另一个是同名/近似名的 `src/api/<模块>` 目录），用 `grep_codebase` 打开目标页面（如 `views/<业务>/<子模块>/List.vue`）看它 `import { xxx } from '/@/api/<模块>'` 具体 import 的是哪个，**以页面实际 import 的模块名作为 `module`**。命名撞车（目录名 vs 文件名相似）一律以页面 import 事实为准，不靠印象。

## 输出要求

- `call_api` 必须带**完整 `operation`**（`module.func`），不要只传 `module`。
- `params` 字段名与接口源码函数参数一致（不自己发明字段名）。
- 找不到语义匹配的接口：用自然语言说明该模块源码中无对应接口，不要编造接口名。
- 禁止：凭印象写接口名（必须读过源码）、把写接口当读接口调、省略 `module` 只给 `func`。
