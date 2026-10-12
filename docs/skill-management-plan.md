# 本地技能与技能管理页（方案，尚未改代码）

> 2026-10-12。状态：**已按本文落地**（管理页 `/skills`，本地目录 `.data/skills/`，全局开关 `.data/skills-state.json`）。对话飞出仍只做本对话全文注入。
> 对话里的「技能」飞出面板继续负责「本对话要不要把全文塞进提示」；新建独立管理页负责「这台机器上有哪些技能、本地技能怎么增删、全局开不开」。两件事不要合成一个开关。

## 0. 现在实际是什么

飞出面板（`ChatPage.vue` 的 `tools-flyout`，接口 `GET/PUT /chat/skills`）列的不是全部技能。`listSelectableSkillMetas` 会丢掉 `default: true`。当前 8 个技能里，只有 `pdf` 没有这个标记，所以面板里只剩「PDF 资料问答」。其余 7 个（业务取数、探库、口径核对、图表、观影、客服会话、联网检索）索引仍在系统提示里，命中时走 `read_skill`，只是不出现在勾选列表。空列表时的文案已经写了这件事：「没有可勾选的技能（默认技能无需勾选即已生效）」。

勾选的含义写在页脚：勾上的全文注入本对话系统提示的**动态段**（`renderEnabledSkills`，上限 `SKILLS_INJECT_CHARS`，缺省 12000 字，超出的注明未注入）；没勾的仍可按需加载。启用集存在对话文档的 `skillsEnabled`，和连接器的「本对话启用哪些 MCP」同构，但技能侧没有「添加」入口。

技能文件只来自仓库目录 `apps/agent-server/skills/<目录>/SKILL.md`。`skills.ts` 启动扫 frontmatter（`name` / `description` / `roles` / `default`），30 秒缓存。`read_skill` 只读这一层目录下的 `SKILL.md`，拒绝 `..` 和路径分隔符。没有用户目录、没有上传、没有启用开关落盘、没有管理路由。对照 `best-practice-alignment-review.md` 的 F12：技能少、静态目录，当时结论是维持。本地技能和管理页就是把这条从「维持」改成「要做」的范围。

连接器已经有可写层：`.data/mcp-servers.json` 相对 `.env` 的 `MCP_BUILTIN_SERVERS`。技能应对齐同一分层，而不是把用户文件写进仓库 `skills/`。

## 1. 网上做法（对齐用，不照搬产品）

| | Anthropic Agent Skills | 千问办公 | CodeBuddy Code | WorkBuddy | 本项目现在 |
|---|---|---|---|---|---|
| 载体 | 目录 + `SKILL.md` | `~/.qwenworkcn/skills/<名>/SKILL.md` | 项目 `.codebuddy/skills/` 与用户 `~/.codebuddy/skills/` | 已安装的本地包 | 仅仓库 `skills/` |
| 加载 | 启动只放 name + description；命中再读正文；正文再指向同级参考文件；脚本只跑、不把源码塞进上下文 | 描述命中后自动用；也可 `/` 点名、对话里指名 | 同上，另有 `disable-model-invocation`（只能手点）、`user-invocable` | 关闭后不参与自动调用，文件不改 | 索引常驻 + `read_skill`；勾选才全文注入。没有第三层文件，没有 `/` |
| 管理界面 | 工作区上传 zip，或仓库 `.claude/skills` 扫描 | 扩展 → 技能：广场、上传、文件系统直接改 | 设置页分项目级 / 用户级，右上角导入文件夹 | 技能市场 + 已安装；上传 / 用对话查找或创建；搜索；开关；卸载（可批量） | 只有对话飞出：搜索、勾选、取消全部 |
| 开关 | 挂到智能体，可钉版本 | 装上即在目录里，删目录即卸 | `disable` 写在 frontmatter，或设置里的覆盖项 | **开关不改 `SKILL.md`**，记在用户配置；关闭 ≠ 卸载 | `default: true` 只影响是否出现在飞出；没有全局关闭 |
| 编写约束 | `name` 小写连字符 ≤64；`description` 同时写「做什么」和「何时用」≤1024；正文建议 <500 行；参考文件只从 `SKILL.md` 链一层 | 同样要 frontmatter；正文写步骤、边界、输出；可带 examples / templates / references / scripts | 另有 `allowed-tools` | 安装前看来源、脚本、会不会把输入发到第三方 | 自有 frontmatter 很松：缺 `name` 就用目录名；`description` 可空 |
| 获取渠道 | 自己上传或随仓库 | 对话里找、广场、GitHub、本地上传 | 导入本地文件夹、插件 | 市场一键安装、上传、对话里创建 | 只能改仓库 |

三家产品把「技能在不在这台机器上」和「这一轮要不要把全文拿出来」分开。千问和 WorkBuddy 的市场、一键从网上安装、技能包里的可执行脚本，都不进这一版。

## 2. 这一版要做成什么样

两层状态，名字不要混用：

| 层 | 存在哪 | 作用 | 谁改 |
|---|---|---|---|
| 目录 | 内置：`apps/agent-server/skills/`（只读）。本地：`apps/agent-server/.data/skills/<目录>/`（可写，锚点用现有 `store-util` 的数据目录） | 技能在不在 | 内置随发版。本地由管理页创建、上传、删除 |
| 全局开关 | `.data/skills-state.json` 里的 `disabled` 目录名列表。**不改文件内容**（对齐 WorkBuddy） | 关掉的技能不进索引，`read_skill` 当不存在，对话勾选里也去掉 | 管理页。内置和本地都能关，都不能从页面删内置文件 |
| 本对话全文注入 | 对话文档 `skillsEnabled`（现有） | 勾选 = 全文进动态提示，少一次 `read_skill` | 飞出面板。只列「全局开着、且不是 `default: true`」的技能 |

本地目录与内置**同名时拒绝写入**，不覆盖发版技能。列表合并时带来源：`builtin` / `local`。

`default: true` 继续只影响飞出面板，不从索引拿掉。管理页必须把这 7 个也列出来，并标明「系统自带，对话里按需加载，不用勾选」。用户上传的技能忽略 frontmatter 里的 `default`，一律可勾选，避免一份本地文件把自己从面板藏掉。

全局关闭一个 `default: true` 的技能，等于这条能力从索引消失。这是用户明确关掉，和「不在勾选列表」不是一回事。

加载顺序维持渐进披露，不改成「启用就全文注入」：

1. 系统提示稳定段只放索引行（目录名 + description）。
2. 任务命中时模型调 `read_skill`。
3. 只有本对话勾选的才把正文放进动态段，并守住 12000 字上限。

这一版每个技能只有 `SKILL.md`。不读 `references/`，不执行技能包里的 `scripts/`。上传若带这些文件，整包拒绝并说明原因。脚本执行继续走现有 `run_command` / `run_script` 和写操作闸门，不从技能包侧面绕过去。

## 3. 管理页

新路由 `/skills`，门户顶栏加入口（与「运行追踪」并列）。对话飞出页脚加一行「管理技能」，链到同一页。不在飞出里做创建和删除：飞出保持现在的搜索、勾选、取消全部。

页面两栏，对齐 WorkBuddy 的「已安装」而不是「技能市场」：

| 栏 | 内容 | 操作 |
|---|---|---|
| 系统自带 | 仓库 8 个。显示名称、目录名、description、适用角色、是否 `default` | 查看全文。全局开/关。不能编辑、不能删除 |
| 本地技能 | `.data/skills/` | 新建、上传、查看、编辑、全局开/关、删除。删除前若有对话勾选过，保存时现有逻辑会丢掉不存在的目录名，页面上仍提示「已从各对话勾选中消失」 |

搜索与飞出同一口径（原文 + 拼音，短词只匹配名称），复用 `ToolsSearch` 的匹配函数即可，组件可以不搬进这一页。

新建表单字段：目录名、显示名、description、适用角色（可空 = 全角色）、正文。上传接受单个 `SKILL.md`，或**根目录就是该文件**的 zip（上限 256 KiB，只允许这一个文件）。不提供「把 GitHub 地址交给模型去装」。

创建技能不做成对话里自动写文件。需要时人在管理页写，或自己把 `SKILL.md` 放进 `.data/skills/`。千问的 create-skill、WorkBuddy「描述任务后自动创建」留到以后，而且要走现有写闸门，不在这一版。

## 4. 编写规则（保存时服务端校验）

对齐 Anthropic / 千问对 frontmatter 的硬要求，本项目多出来的 `roles` 保留：

| 字段 | 规则 |
|---|---|
| 目录名 | 小写字母、数字、连字符，1–64，不以连字符开头或结尾。与内置目录重名拒绝 |
| `name` | 必填，显示名，1–80 |
| `description` | 必填，1–1024，同时写清做什么、什么时候用。这是索引里模型用来决定要不要 `read_skill` 的唯一句子，不要把触发条件只写在正文 |
| `roles` | 可选，逗号分隔，只能是已有角色 id。缺省全角色可见（与现在 `listSkillMetas` 一致） |
| 正文 | 必填。超过约 500 行时保存仍允许，响应里带一句「建议把细节拆出去」；这一版还不能拆文件，所以只提示、不拦 |
| `default` | 本地技能写入时丢掉 |

frontmatter 必须是文件开头 `---` 包裹。裸 YAML 拒绝。保存时由服务端重写 frontmatter，避免模型或用户在正文外再塞一段系统指令式头部。

## 5. 安全

本地技能的正文会在勾选后进入系统提示，或在 `read_skill` 后进入工具结果。它是用户自己装上的指令，不是外部网页，但仍可能带「忽略之前的规则」。边界：

- 只有当前设备 owner 能调管理接口（与现有会话归属同一套）。
- 路径只允许 `.data/skills/<单级目录>/SKILL.md`。zip 解压防目录穿越，拒绝对称链接，拒绝除 `SKILL.md` 以外的成员。
- 不执行包内代码，不根据技能内容改工具权限。技能不能声明 `allowed-tools` 来放大权限；工具风险仍以 `BUILTIN_RISK` 和 MCP `toolRisks` 为准。
- 安装、更新、删除、全局开关写审计（`audit.ts`，kind 用现有可扩展的一类或新增 `skill`）。
- 全局关闭立即从索引消失；已打开的对话下一轮生效。30 秒技能缓存必须在写入后清掉，不能等 TTL。

## 6. 接口与落点（实施时才改）

| 接口 | 行为 |
|---|---|
| `GET /skills` | 合并内置与本地。每项：`dir`、`name`、`description`、`roles`、`source`、`default`、`enabled`、`bytes` |
| `GET /skills/:dir` | 全文，供管理页预览。关闭的也能看 |
| `POST /skills` | JSON 创建本地技能 |
| `POST /skills/import` | multipart：一个 `SKILL.md` 或合规 zip |
| `PUT /skills/:dir` | 只更新本地。内置 403 |
| `DELETE /skills/:dir` | 只删本地目录。内置 403 |
| `PUT /skills/:dir/enabled` | body `{ enabled: boolean }`，改 `skills-state.json`，不改文件 |

现有 `GET/PUT /chat/skills` 保持对话勾选语义。`available` 改为「全局开着的可勾选技能」。`PUT` 校验改为「全局开着且文件还在」，关掉或删掉的目录名不落进 `skillsEnabled`。

| 文件 | 改什么 |
|---|---|
| `apps/agent-server/src/skills.ts` | 合并两个目录；读 `disabled`；写入后清缓存；`readSkill` 对关闭项返回空 |
| `apps/agent-server/src/app.ts` | 上面的管理接口；收紧 `/chat/skills` 的可选集 |
| `apps/agent-server/src/store-util.ts` | 只复用数据目录，不改原子写约定 |
| `apps/web/src/router.ts`、`PortalPage.vue` | `/skills` 与入口 |
| `apps/web/src/pages/SkillsPage.vue` | 新页 |
| `apps/web/src/pages/ChatPage.vue` | 飞出页脚加管理链接。勾选逻辑不改 |
| `apps/web/src/api.ts` | 管理接口客户端 |

不改 `chat.ts` 的工具循环、`renderEnabledSkills` 的注入上限、`default: true` 的展示语义。

## 7. 明确不做

- 技能广场、从 URL / GitHub 安装、对话里自动搜索并安装（千问 find-skills、WorkBuddy 市场）。
- 技能包脚本、`references/` 按需读取、`context: fork`、技能级 hooks、技能自带工具白名单（CodeBuddy / Anthropic 的第三层和 WorkBuddy 的可执行技能）。
- `/` 点名调用。点名的替代是管理页打开全局开关，加上对话里勾选全文。
- 版本号、审查流、多租户共享技能库（百炼那套）。本机一份 `.data` 即可。
- 把 `default: true` 的系统技能改成必须勾选才生效。那会把现在已经在用的取数、联网、图表从索引里拿掉。

## 8. 验收

1. 管理页能看见全部 8 个系统技能，包括现在飞出里没有的那 7 个，并标出「按需加载、不用勾选」。
2. 在管理页新建一份本地技能后，通用助手的飞出里出现它；勾选后下一轮系统提示动态段含其全文；不勾选时索引里仍有一行，模型可用 `read_skill` 读到正文。
3. 全局关闭后，索引、`read_skill`、飞出三处都不再提供它；文件还在，重新打开即恢复。`SKILL.md` 字节不变。
4. 不能通过接口覆盖或删除 `pdf` 等内置目录；不能写入 `../`、zip 内第二层路径、或带 `scripts/` 的包。
5. 观影对话的列表面仍按 `roles` 过滤：只含未限定角色的技能和写了 `movie` 的技能。
6. 未改 `default` 的系统技能行为与现在一致：飞出不出现，索引进系统提示。
