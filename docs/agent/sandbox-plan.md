# 子进程 OS 级沙箱方案对比（审计第 1 项）

> 背景：安全审计遗留 4 项局限，其中第 2（Node ESM 命名导入绕过 permission model）、3（凭据文件读取守卫）、4（SQL 只读绑定）已在 `936c691` 收口并推送。本文档只处理**第 1 项：子进程 OS 级沙箱**——这是唯一剩下的代码级缺口，且需要架构决策。

## 0. 现状

`run_tool_code` 子进程（Node 经 tsx + `--require` 守卫预加载，或 Python）执行模型写出的代码。当前约束层：

| 维度 | 现状 |
|---|---|
| 凭据文件读取 | ✅ `tool-code-fs-guard.ts` 模块级补丁拦截（`.env`/私钥/云凭据目录） |
| 命令执行（Node） | ✅ `node:child_process` 的 exec/spawn 家族已在模块层打补丁抛错（ESM 命名导入 / require / createRequire / 动态 import() 均拿不到可用函数） |
| 命令执行（Python） | ⚠️ `subprocess` / `os.system` / `os.popen` 已包装抛错，但 `from subprocess import Popen` 这类把名字绑到局部变量的写法**仍绕过** |
| 原生插件 / `process.binding` | ❌ 不拦 |
| 绝对路径读任意**非凭据**文件 | ❌ 不拦（可读其它项目源码、业务数据） |
| 出网 | ❌ 不拦（凭据外带的真正出口） |
| 文件系统越界写 | ❌ 不拦（`../` 越界） |
| 进程数 / 资源 | ⚠️ 仅进程内信号量（`TOOL_SUBPROCESS_MAX_CONCURRENT`），多实例不共享 |

结论：prompt 注入场景下**最直接**的几步（读 `.env`、`execSync` 跑命令）已被封死；剩下的是「决心明确的绕过」——原生插件、`process.binding`、Python `from subprocess import Popen` 重绑定、以及"不靠命令执行、纯靠文件读/写/出网"的数据外带。这些只有 OS 级隔离能真正挡住。

## 1. 待隔离的目标（威胁模型）

把"模型生成代码"视为不可信，要实现的边界：

1. **文件只读范围收敛**：只能读写任务工作区（`.data/fs/<conv>` + 临时目录），看不到宿主其它目录。
2. **凭据零暴露**：`.env` / 私钥 / 云凭据目录**根本不挂载进沙箱**。
3. **出网可治理**：默认禁出网；合法出网只走服务端工具桥（`callTool` 代理），不依赖子进程自己联网。
4. **越界写不可达**：容器/命名空间之外无写权限。
5. **资源封顶**：内存 / PID / CPU 有硬上限，防 fork-bomb、防 OOM 拖垮宿主。

## 2. 方案对比

### 方案 A：Docker 容器隔离 `run_tool_code` 子进程（推荐，opt-in）

把"直接 spawn 子进程"改为"spawn 一个一次性容器跑子进程"。

**执行形态**（示意）：

```
docker run --rm
  --network none            # 默认禁出网
  --cap-drop ALL            # 去掉所有 Linux capabilities
  --security-opt no-new-privileges
  --memory=256m --memory-swap=256m
  --pids-limit=64
  --cpus=1.0
  -v "<workspace>:/work:rw"  # 只挂任务工作区，读写
  --user 1000:1000
  bx-tool-runner
  node --import tsx --require /guard.cjs /work/<script>.mjs
```

**镜像 `bx-tool-runner`（基于 `node:20-slim`）**：预装 tsx、Python3、把 `tool-code-fs-guard` 的 Node/Python 预加载源码烤进镜像作纵深防御；入口固定。

**Windows 可行性（已实测本机）**：

- 本机 `docker --version` = 29.4.0 且 `docker info` 正常 → Docker Desktop（WSL2 后端）可用。
- 路径映射：Windows 宿主路径 `d:\Code\bx-admin-agent\apps\agent-server\.data\fs\...` 经 Docker Desktop 可直接挂载为容器内的 `/work`；模型代码用相对路径（cwd=`/work`），无需改代码。
- 挂载范围：只挂**当前会话的任务目录** `d:\...\agent-server\.data\fs\<conv>`，绝挂 `.env`、绝不挂仓库根。这是比"拒绝清单"更强的隔离——凭据文件物理上不在容器内。
- 用户归属：容器默认 root 写出的文件在宿主侧属主会变；用 `--user 1000:1000` 对齐，或事后 `chown`。属可接受摩擦。
- 性能：Windows 下挂载的 `/mnt` 类路径 I/O 偏慢；把任务工作区放在 WSL2 文件系统（如 `\\wsl$\...`）更快，但 agent 当前写 Windows 路径，需权衡。一次性容器冷启动 ~0.3–1.5s，会叠加到每次 `run_tool_code` 的延迟。
- CI：GitHub Actions 的 ubuntu runner 自带 Docker，集成测试可跑（本机开发机需 Docker Desktop 在跑）。

**与现有守卫的纵深**：容器是硬边界，内部仍跑 `tool-code-fs-guard`（fs 守卫 + child_process 守卫）作防御纵深——即使容器逃逸尝试，内部补丁仍拦第一道。

**关键决策点**：
- **网络策略**：`--network none` 最稳（凭据外带彻底堵死），但凡"模型代码自己 fetch 外部 API"的合法需求会失败——这部分本应走 `callTool` 桥，故影响面小。若需放行，可改为挂一个**仅允许访问白名单域名**的 sidecar 代理，复杂度上升。
- **`run_command` / `run_script` 是否也隔离**：这两个是"用户**主动批准**执行任意命令"的语义（不同信任模型），当前**不进沙箱**。若也要隔离，需另开决策（且会牺牲"用户明确要跑的命令"的宿主可达性）。建议本期**只隔离 `run_tool_code`**。

**工作量估算（opt-in，默认关闭）**：

| 子任务 | 估时 |
|---|---|
| `Dockerfile` + `bx-tool-runner` 镜像（node+tsx+python+守卫预加载） | 0.5 天 |
| `tool-code.ts` 改造：`TOOL_CODE_SANDBOX=docker` 开关，spawn 改为 docker run；默认 off 走原路径 | 1–1.5 天 |
| 工作区挂载范围收敛（只挂 `<conv>` 任务目录，cwd 归一化，路径在 Windows/容器间翻译） | 0.5–1 天 |
| 超时 / 清理 / 资源上限（内存、pids、cpu；超时 `docker stop`+`rm` 兜底） | 0.5 天 |
| 网络策略（`none` 起步；allowlist 代理可选） | 0.5 天（none）/ +1 天（allowlist） |
| 集成测试 + 文档（CI 用 ubuntu 自带 Docker） | 0.5–1 天 |
| **合计** | **约 4–6 开发天** |

### 方案 B：WSL2 直接隔离（不推荐）

不借助 Docker，把子进程丢进一个 WSL2 发行版、以非特权用户 + 受限挂载运行。隔离语义类似，但缺少 Docker 的标准化资源上限（`--pids-limit`/`--memory`）、cap-drop、镜像可重现性，编排更毛糙，且仍依赖 WSL2 后端——和方案 A 同样的前提，却少了 Docker 的成熟边界。**结论：有 Docker 就直接用 A，不做 B。**

### 方案 C：gVisor / Firecracker microVM（过度，跳过）

真正 microVM 隔离，多租户场景的标准答案。但本机是 Windows 单机自托管 agent，gVisor 需 Linux + 嵌套虚拟化、Firecracker 需 KVM，在本开发机无原生支持，且引入编排复杂度远超单租户自托管的需要。**结论：当前阶段过度投入，列为"多租户/对外服务化时再评估"。**

### 方案 D：维持现状，标注为已接受风险（零成本）

保持"环境白名单 + 凭据读取守卫 + child_process 守卫 + 超时 + 并发上限 + 只读工具桥"四道护栏，文档如实标注"无 OS 沙箱、原生插件/重绑定可绕过"。**这是当前状态**。优点零成本；缺点是面对"决心明确的绕过"无硬边界，不适合把 agent 部署到不可信/多租户环境。

## 3. 推荐

单租户自托管、Windows 开发机的现实下，**方案 A（Docker 容器，opt-in 默认关闭）是唯一实用的 OS 级边界**。理由：

1. 本机 Docker 已可用，落地无障碍；
2. 镜像可重现、资源上限标准化、cap-drop + `--network none` 直接给出"文件/网络/权限"三层硬边界；
3. opt-in 不破坏无 Docker 的开发机（默认仍走原守卫路径）；
4. 与现有守卫构成纵深，即便容器逃逸尝试也被内部补丁拦第一道。

## 4. 未决决策（需你拍板）

1. **是否要做方案 A**，还是接受方案 D（维持现状标注风险）？
2. 若做 A：**网络策略**取 `--network none`（最稳，牺牲模型代码自联外网）还是加 allowlist 代理（复杂但保留合法出网）？
3. **隔离范围**只 `run_tool_code`，还是 `run_command`/`run_script` 也纳入（后者会改变"用户主动批准命令"的宿主可达语义）？
4. 镜像基础：复用宿主已装的 `node:20-slim` 拉取，还是内网/离线镜像源（本机 registry 是 npmmirror，Docker Hub 拉取需确认可达）？

> 文档状态：草案，待决策。决策后转入实施（建议仍保持"先提交代码、不自动推送、等你确认"的节奏）。
