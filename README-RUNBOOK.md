# 维护者运行手册（Runbook）

> 面向对象：三个月后的你自己（solo 维护者）。所有命令可直接复制粘贴。
> 依据：`docs/workplan.md` P0-0 节 #6/#8/#9、`docs/design/mvp-tech-design.md`、`docs/design/neko-access-audit.md`。
> 本文所有路径均为绝对路径；唯一的环境变量约定见下节。

## 0. 路径与变量约定

```bash
# 本仓库（集成服务仓库）
export NEKO_SERVICES=/mnt/shared/_Projects/N.E.K.O/neko-services

# 上游 N.E.K.O 子项目源码（被 patch 的对象，注意与工作区根同名不同层）
export NEKO_SRC=/mnt/shared/_Projects/N.E.K.O/N.E.K.O

# 运行时数据根。Linux 上由 storage_roots.py 决定：
#   未设 XDG_DATA_HOME  =>  $HOME/.local/share/N.E.K.O （本机即 /home/adam/.local/share/N.E.K.O）
#   设了 XDG_DATA_HOME   =>  $XDG_DATA_HOME/N.E.K.O
# 角色记忆数据、角色卡、日志全在数据根下。首次启动前该目录可能不存在，属正常。
# ⚠ 这是「默认值」而非权威值——实际运行根可能被改写，见下方「探测实际数据根」。
export NEKO_DATA_ROOT="$HOME/.local/share/N.E.K.O"
```

### 探测实际数据根（备份/排障前必做）

默认路径会被两种机制改写：环境变量 `NEKO_STORAGE_SELECTED_ROOT`（storage_roots.py:94，launcher / systemd unit 注入），以及已提交到磁盘的 storage policy（`<锚定根>/state/storage_policy.json`，首次启动后可能把运行根选定到别处）。所以**备份和排障前先探测实际根**，不要盲目用默认值。

**⚠ 环境绑定陷阱**：服务实际用的根取决于**服务进程自己的环境**（systemd unit 的 `Environment=`、launcher 注入），这些变量不会传回你的终端——在你的 shell 里 `echo` 只能证明「终端没设」，不能代表服务。按下面顺序探测，越往后越接近服务视角的真实值：

```bash
# 0. 当前终端（仅当服务是你自己从终端手动拉起时才准确）
echo "NEKO_STORAGE_SELECTED_ROOT=$NEKO_STORAGE_SELECTED_ROOT"

# 1. systemd 场景：user manager 全局环境 + unit 自己声明的 Environment=
systemctl --user show-environment | grep NEKO_STORAGE
# unit 内 Environment= 行（unit 落盘后可用；unit 名以 systemd 节为准，示例：
systemctl --user show neko-memory.service -p Environment

# 2. 终极兜底：直接读运行中进程的真实环境（最权威；同用户无需 sudo）
cat /proc/$(pgrep -f app.memory_server | head -1)/environ | tr '\0' '\n' | grep NEKO_STORAGE
# 服务跑在其他用户下时：sudo cat /proc/$(pgrep -f app.memory_server | head -1)/environ | tr '\0' '\n' | grep NEKO_STORAGE

# 3. 把查到的服务环境对齐到当前 shell（没查到就确认清空），再问上游代码权威根
export NEKO_STORAGE_SELECTED_ROOT=<第1/2步查到的值>    # 服务确实设了才 export；否则 unset
cd $NEKO_SRC && uv run python -c \
  "from utils.config_manager import get_config_manager; print(get_config_manager(migrate=False).app_docs_dir)"
# migrate=False = 只读解析路径、不触发任何数据迁移（上游 launcher 预启动路径即此用法，见 launcher_core/runtime.py:393）
```

探测输出的路径若与 `$NEKO_DATA_ROOT` 不同，后续命令请以探测结果为准（重新 `export NEKO_DATA_ROOT=<探测结果>`）。

数据根内部布局（已对照 `utils/config_manager/storage_roots.py` 与 `utils/logger_config.py` 查证）：

| 子路径 | 内容 |
| --- | --- |
| `$NEKO_DATA_ROOT/memory/<角色名>/` | **角色记忆数据（五维记忆落盘），必备份**。角色名以 `ls $NEKO_DATA_ROOT/memory/` 实际所见为准 |
| `$NEKO_DATA_ROOT/logs/` | 日志目录。宿主进程日志按「服务名+日期」滚动（保留 30 天）：`N.E.K.O_Main_YYYYMMDD.log`、`N.E.K.O_Memory_YYYYMMDD.log`、`N.E.K.O_Agent_YYYYMMDD.log`、`N.E.K.O_PluginServer_YYYYMMDD.log`（插件宿主） |
| `$NEKO_DATA_ROOT/logs/plugin/` | 各插件子进程日志，命名 `N.E.K.O_Plugin_<插件id>_YYYYMMDD.log`（如 `N.E.K.O_Plugin_qq_auto_reply_20260919.log`；qq_auto_reply / wechat_integration 的日志都在这） |

> **注意**：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/memory/` 是**代码包**（memory 系统的 Python 源码），不是数据目录。角色数据只存在于 `$NEKO_DATA_ROOT/memory/`。升级备份时不要搞混。

## 1. 服务清单

端口全景（上游 `config/network.py`，另见 `docs/design/neko-access-audit.md` 开头）：48911 主服务、48912 memory_server、48913 monitor、48915 agent/tool 服务、48916 插件服务器；ZMQ 消息面 38865（RPC）/ 38866（PUB）/ 38867（INGEST）。

| 服务 | 端口 | 启动方式 | 日志位置 | 健康检查 |
| --- | --- | --- | --- | --- |
| **N.E.K.O 后端**（launcher 拉起，含 main + memory + agent 三服务） | 48911 主服务；48912/48915 由同组拓扑占用 | `cd $NEKO_SRC && uv run launcher.py`。launcher 有**两种拓扑**（`launcher_core/runtime.py` 的 `_should_use_merged_mode`）：**源码运行默认多进程模式**——1 个 launcher 进程 spawn 3 个子进程（memory→main→agent 顺序 spawn，逐个等模块加载完成再放下一个以防低内存 OOM，最后统一等全部端口就绪，60s 超时）；**合并模式**须显式 `NEKO_MERGED=1 uv run launcher.py`——单进程内 3 个 uvicorn 并发启动、统一健康检查（30s 超时）；打包发行版（IS_FROZEN）默认合并。启动前 launcher 自带端口预检（见第 2 节的 attach/避让行为） | 两种拓扑均按服务名分文件写 `$NEKO_DATA_ROOT/logs/`（Main/Memory/Agent）；launcher 自身 bootstrap 输出在 stdout | `curl -s http://127.0.0.1:48911/health`，期望 `"service":"main"`、`"status":"ok"` |
| **memory_server**（中心记忆，五维记忆+scoped+query_memory） | 48912 | 常规由 launcher 拉起（两种拓扑都包含它，无单独操作）；独立运行仅用于开发调试：`cd $NEKO_SRC && uv run python -m app.memory_server`（加 `--enable-shutdown` 才会响应 `/shutdown`）。**⚠ 陷阱：独立起它之后再跑 launcher，不会「补齐其余服务」——launcher 检测到部分端口被占会整套换到回退端口另起新实例，形成两套记忆。见第 2 节端口预检三态** | `$NEKO_DATA_ROOT/logs/N.E.K.O_Memory_YYYYMMDD.log` | `curl -s http://127.0.0.1:48912/health`，期望 `"service":"memory"`。**指纹校验**：响应含 `"app":"N.E.K.O"` 与 `instance_id`——同一 launcher 拓扑的三个端口 instance_id 一致（launcher 给子进程注入 `NEKO_INSTANCE_ID`）；`app` 字段不是 `N.E.K.O` 说明端口被别的进程占了 |
| **a-memorix-service**（检索层，从 MaiBot A_memorix 剥离） | 48921（127.0.0.1） | **systemd user unit**：`systemctl --user start neko-a-memorix.service`（`neko.target` 已 Wants）。手动方式：`cd $NEKO_SERVICES/a-memorix-service && uv run python -m a_memorix_service.service`（uv 3.12 venv，FastAPI+uvicorn；首次先 `uv sync`，并在 `config/a_memorix.toml` 配 `[model.*]` 的 base_url/api_key/模型清单，未配置时启动仅 WARN + 检索写入降级） | `journalctl --user -u neko-a-memorix.service`；手动运行输出 stdout | `curl -s http://127.0.0.1:48921/health`，期望 `"app":"neko-services"`、`"service":"a-memorix"`、`"status":"ok"`（**注意 app 指纹不是 N.E.K.O**，`startup_state` 字段反映内核启动进度：starting/migrating→ready/failed；未就绪期写入端点 202 进启动队列 WAL） |
| **NapCat**（QQ 协议端，无 HTTP 端口，以 WS 客户端身份连 qq_auto_reply 插件） | —（出站 WS） | **插件托管**：由 qq_auto_reply 插件的 `napcat_service.py` 自动拉起/守护（sweep 重连），不设独立 systemd unit。默认目录 `$NEKO_SRC/plugin/plugins/qq_auto_reply/NapCat.Shell/`，可在插件设置 `napcat_directory` 改路径 | NapCat 自身日志：`<NapCat目录>/logs/`；插件侧日志：`$NEKO_DATA_ROOT/logs/plugin/N.E.K.O_Plugin_qq_auto_reply_YYYYMMDD.log`。当前 NapCat 子进程 stdout 丢弃（DEVNULL）——「stdout 接日志文件供 doctor」是 P0-0 计划中的 patch，落盘后此行更新 | 无 `/health` 端点。`$NEKO_SERVICES/scripts/doctor.sh`（**p0-0-scripts 分支合入后可用**）对 NapCat 仅做**目录/日志存在性提示**（不做 WS 连通性探测）；连通性判断靠 NapCat 日志与插件侧重连日志 |

辅助进程（不单独维护，随主进程/插件服务器生命周期）：

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 48915 | agent/tool 服务 | merged 模式下与主进程同体；`/health` 响应 `"service"` 为 agent 侧 |
| 48916 | 插件服务器（plugin host） | qq_auto_reply / wechat_integration 等插件进程由此管理；`GET /plugins` 可查插件清单与状态 |
| 48913 | monitor | 监控服务 |
| 38865 / 38866 / 38867 | ZMQ 消息面 | RPC / PUB / INGEST。外部进程可无鉴权 SUB 38866 订阅事件（a-memorix 未来 L2 用） |

> **模型分层**：各服务背后的 12 档模型（主对话 conversation 跨端同档 / summary 等杂活档配便宜模型）、a-memorix 独立模型配置、以及 P2-3 成本取数（token_usage.json），统一见 `$NEKO_SERVICES/docs/model-tiers.md`；配置验证跑 `$NEKO_SERVICES/scripts/verify-tiers.sh`（纯只读）。

## 2. 启动与停止顺序

### launcher 的端口预检三态（先懂这个再启动）

launcher 启动时对 48912/48915/48911 逐个探测（`launcher_core/runtime.py` 端口规划逻辑），有三种结局：

1. **全部空闲** → 正常起一套完整拓扑（多进程或 merged，见第 1 节）。
2. **三个默认端口上已是同一 instance_id 的完整 N.E.K.O 后端** → launcher **attach**（不重起服务，只起桌面 UI 复用现有后端）。
3. **只有部分端口被 N.E.K.O 服务占用**（例如独立跑着的 memory_server，或 instance_id 不一致的一组服务）→ launcher **不补齐也不复用**：整套服务挪到回退端口、以新 INSTANCE_ID 另起一套 → **两套后端并存、记忆分裂**。这是最大的启动陷阱：想用 launcher 就让三个端口都空着；想复用就得保证三口同 instance（systemd 场景见下节）。

### 启动顺序：拉起顺序与就绪顺序是两层（别说混）

**拉起顺序**（launcher 保证，只管「谁先被启动」）：memory(48912) → main(48911) → agent(48915)。多进程模式按此逐个 spawn，每个子进程只等「模块加载完成」（import 稳定，防低内存 OOM）就放行下一个，**不等它服务就绪**；合并模式三个服务并发拉起、无先后。a-memorix-service（systemd 独立生命周期，`After=neko-memory.service`，不进 launcher 拓扑）。NapCat 由 qq_auto_reply 插件自动拉起并守护，**永远不要手动先启 NapCat**。

**整体就绪**（两种模式都是统一收口）：多进程在全部 spawn 后统一等端口+初始化完成（60s 超时），merged 统一健康检查（30s 超时）——它保证「全部就绪」这个终点，**不保证 memory 比 main 先就绪**。主进程依赖 memory 先行（start_session 读 `/new_dialog`）靠拉起顺序与启动耗时自然满足，健康检查只是终点门槛。

**禁止零散启动单个服务**：在完整后端之外手动先起某个 N.E.K.O 服务，会把 launcher 推入预检第 3 态（整套换端口另起、记忆分裂）。合法例外：systemd 完整后端（三口共享同一 instance_id）本身就是 attach 复用的对象，不算零散启动；dev 调试单独起 `python -m app.memory_server` 时，同一时间不要跑 launcher。

### 停止顺序

由 launcher 统一有序停机：向 launcher 进程发 SIGTERM/SIGINT（或 Ctrl+C），停机顺序为 Main → Memory → Agent（`MERGED_SERVER_SHUTDOWN_ORDER`，`launcher_core/runtime.py:145`）。多进程与 merged 两种模式都走这条有序路径，日常无需手工逐个停。独立运行的 memory_server 可用 `/shutdown` 端点（需以 `--enable-shutdown` 启动）。

### systemd 用法（neko.target，P0-0 部署裁决：常驻进程归 systemd，launcher 仅桌面）

unit 文件由 p0-0-scripts 分支落盘到 `$NEKO_SERVICES/systemd/`（**合入前本节命令不可用，用下方手动方式**）。拓扑（已定稿：三 unit 方案，与源码查证一致）：

- **三个 unit：`neko-memory` / `neko-main` / `neko-agent`，全部纳入 `neko.target`**。上游 headless 先例 = docker entrypoint：不用 launcher，三服务各自独立进程 `python -m app.memory_server` / `python -m app.main_server` / `python -m app.agent_server`，unit 间用 After=/Wants= 表达 memory→main→agent 拉起顺序，端口用 `NEKO_MEMORY_SERVER_PORT` / `NEKO_MAIN_SERVER_PORT` / `NEKO_TOOL_SERVER_PORT` 环境变量对齐。
- **三 unit 必须共享同一个 `NEKO_INSTANCE_ID` 环境变量值**（`config/network.py:212`：instance_id 取 env、缺省每进程随机）。共享让三口表现为同一后端（/health 指纹一致、doctor 判断正确）；若违规同时跑 launcher，也是 attach 到这套后端而不是换端口分裂。
- **neko.target 与桌面 launcher 二选一使用，勿同时**：桌面会话要自己跑时，先 `systemctl --user stop neko.target` 再 `NEKO_MERGED=1 uv run launcher.py`（用完反向操作）。同时跑两套后端=两套记忆。
- a-memorix unit 挂在 memory 之后（`After=neko-memory.service`）、同样进 target；启用前置是 `a-memorix-service` 下 `uv sync`（否则 ConditionPathExists 不满足、start 显示 skipped）。

安装（unit 落盘后一次性）：

```bash
mkdir -p ~/.config/systemd/user
cp $NEKO_SERVICES/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
```

日常操作：

```bash
systemctl --user start neko.target    # 冷启动（验收目标 <2min）
systemctl --user stop neko.target     # 有序停止
systemctl --user status neko.target   # 总览；单个服务加 unit 名（neko-memory 等）细查
journalctl --user -u neko-memory -f   # 跟踪某 unit 的 stdout/stderr
```

### 手动方式（unit 未落盘时的兜底）

```bash
cd $NEKO_SRC && uv run launcher.py    # 一条命令起齐全部服务（源码默认多进程；Ctrl+C 有序停机）
# 需要单进程合并模式时：NEKO_MERGED=1 uv run launcher.py
```

## 3. 常见故障 3 条

### 故障 1：QQ 不回复了（最高频）

1. **先跑 doctor**：`$NEKO_SERVICES/scripts/doctor.sh`——检查项：memory/主进程 `/health`、ZMQ PUB 可达、LLM key、NapCat 目录/日志存在性（仅提示项）、a-memorix `/health` 指纹（app=neko-services）。服务侧问题多数一步定位。
2. NapCat 侧（doctor 对它只有目录/日志存在性提示，连通性看这里）：看 `$NEKO_SRC/plugin/plugins/qq_auto_reply/NapCat.Shell/logs/`（或插件设置里的自定义路径）有没有掉线/风控/扫码过期；插件侧重连日志 `grep -h 'NapCat' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_Plugin_qq_auto_reply_$(date +%Y%m%d).log | tail -50`。
3. 插件状态（doctor 不查此项，手工）：`curl -s http://127.0.0.1:48916/plugins` 确认 qq_auto_reply 已启用未崩溃；崩溃看 `$NEKO_DATA_ROOT/logs/plugin/N.E.K.O_Plugin_qq_auto_reply_$(date +%Y%m%d).log` 尾部。
4. 都正常但群里沉默：查注意力/权限门控——`grep -h 'attention\|gate\|ignore' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_Plugin_qq_auto_reply_$(date +%Y%m%d).log | tail -30`（可能是疲劳度/权限/主动忽略的有意行为，不是故障）。

### 故障 2：记忆失败 / 角色失忆

1. `curl -s http://127.0.0.1:48912/health`——不通=进程死或端口被占（看 `app` 指纹区分）；通但 `status` 非 ok=服务内伤，转日志。
2. 查 memory 日志的失败记录（统一客户端封装落地后 WARN 行带 request_id，可精确追一笔失败调用）：
   ```bash
   grep -n 'WARN\|ERROR' $NEKO_DATA_ROOT/logs/N.E.K.O_Memory_$(date +%Y%m%d).log | tail -50
   ```
3. **已知现象（P1-1 完整契约落地前）**：结算（`/process`/`/renew`）持角色级锁等摘要 LLM 期间，其他入口的秒级 `/cache` 可能 5s 超时失败——表现为「某几轮对话没被记住」，日志可见 cache 超时。这是已登记的架构问题（跨通道一致性契约），不是新故障；频繁出现先查 summary 档模型是否变慢/欠费。
4. 注意反模式：memory_server 的 HTTP 失败可能返回 **200 + body `"status":"error"`**——只看 HTTP 码会把失败当成功。排障以 body 内容为准（这也是 P1-1 统一封装强制检查 body 的原因）。

### 故障 3：上游协议变更（NapCat / QQ 协议破坏性更新）

症状：NapCat 自动更新或手滑升级后 QQ 链路全断、消息字段解析报错、WS 反复重连失败。

1. **先核对 pin**：NapCat 版本 pin 与 changelog 巡检入口记录在 `$NEKO_SERVICES/patches/neko/BASELINE.md`。对照 NapCat changelog 确认破坏性变更内容。
2. **决策二选一**：回退 NapCat 到 pin 版本（最快，QQ 恢复优先）或跟进适配（走 replay 流程，见第 4 节——上游 N.E.K.O 源码与 NapCat 两边都可能要动）。
3. 跟进适配完成后：更新 BASELINE.md 的 pin 记录 + `VERSIONS.md` 版本表，跑全量回归。

## 4. patch 回归规则（改上游补丁的铁律）

任何对 `patches/neko/*.patch` 的修改，必须走完下面全流程、**三绿才算成功**，缺一即视为改动未完成（不允许「先合再说」）。`scripts/replay-patches.sh` 与 `scripts/smoke.sh` 分别由 **p0-0-governance / p0-0-scripts 分支合入后可用**；合入前此流程无法执行——不要手工模拟重放（等脚本，别造轮子）。

```bash
# 1. 重放补丁到上游工作树（在干净的上游基线上）
cd $NEKO_SERVICES && ./scripts/replay-patches.sh

# 2. 上游仓库跑插件回归（pytest.ini 与 markers 都在上游根目录；
#    注意 -m 表达式用 or，逗号写法不是合法语法）
cd $NEKO_SRC && uv run pytest -m 'plugin_unit or plugin_integration'

# 3. 四端冒烟（带断言，目标 <5 分钟；QQ 腿含人工部分；需服务在运行，见脚本说明）
cd $NEKO_SERVICES && ./scripts/smoke.sh
```

两条强制配套规则：

- **涉及 reply_pipeline / delivery 的 patch**（QQ 回复管线、投递缓冲、人味改写器挂点）：必带**记账测试**——断言 `delivered_blocks_text()` 语义（事实提取消费原始语义正文、提及计数用实际送达文本）不被分段/块数变化破坏，防止「错字进记忆」「已发送段被截断」两类静默回归。
- **涉及 memory 端点的 patch**（cache/process/renew/settle/query_memory 及新增端点）：必**同步更新端点契约表测试**（P1-1 #7 落地的 TestClient 形状断言：副作用/幂等/重试/三态语义）——契约表与实现不一致时**拒绝重放**。

## 5. 排障入口

### doctor.sh（第一入口；p0-0-scripts 分支合入后可用）

```bash
$NEKO_SERVICES/scripts/doctor.sh
```

检查项：memory_server 与主进程 `/health`（含 instance_id 指纹校验）、ZMQ PUB（tcp://127.0.0.1:38866）可达、LLM key、NapCat 目录/日志存在性（提示项，不含 WS 连通性）、a-memorix `/health`（app=neko-services 指纹 + startup_state）。任何「不知道从哪查起」的故障，先跑它。

### trace_id（QQ 链路追踪）

- **目标态**（P2-1 #5 落地后）：QQ 每 turn 生成一个贯穿全链的 trace_id，覆盖 NapCat 接入 → qq_client → 权限门控 → LLM → XML 解析 → 人味后处理 → 投递，全链日志可按同一 id 串联，排障目标 <15 分钟。
- **当前态**（P2-1 落地前）：无贯穿 id。用**时间窗 + 模块关键词**定位（见下）；memory 侧失败的精确追踪用 WARN 行的 request_id（P1-1 统一客户端封装落地后可用）。

### 日志 grep 模式速查

```bash
# QQ 一轮对话在插件侧的全量痕迹（回溯最近 200 行）
grep -h 'qq_auto_reply' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_Plugin_qq_auto_reply_$(date +%Y%m%d).log | tail -200

# memory_server 当天所有警告/错误
grep -n 'WARN\|ERROR' $NEKO_DATA_ROOT/logs/N.E.K.O_Memory_$(date +%Y%m%d).log | tail -50

# 主服务当天异常
grep -n 'ERROR' $NEKO_DATA_ROOT/logs/N.E.K.O_Main_$(date +%Y%m%d).log | tail -50

# trace_id 落地后：一条 QQ 消息的全链串联（跨插件与宿主日志）
# grep -h '<trace_id>' $NEKO_DATA_ROOT/logs/plugin/*.log $NEKO_DATA_ROOT/logs/N.E.K.O_*.log
```

## 6. 改动后的自检清单（日常维护动作）

| 你改了什么 | 必跑 |
| --- | --- |
| `patches/neko/*.patch` | 第 4 节全流程三绿 |
| memory 端点行为 | 契约表测试 + smoke.sh |
| reply_pipeline / delivery | 记账测试 + smoke.sh QQ 腿 |
| neko-services 自身脚本（smoke/doctor/replay） | 各自空跑一遍 + 本次改动说明进 commit message |
| 每完成一个 P 阶段（workplan） | smoke.sh + 该阶段验收项 |

> smoke.sh / doctor.sh（p0-0-scripts 分支合入后可用）、replay-patches.sh（p0-0-governance 分支合入后可用）——合入前上表涉及这三者的行以「上游 pytest + 手工验证」替代。

## 7. 相关文档

- `$NEKO_SERVICES/VERSIONS.md`：组件版本/数据格式版本记录、必备份与可重建清单、带记忆升级→回滚演练步骤
- `$NEKO_SERVICES/patches/neko/BASELINE.md`：上游基线 commit 与 NapCat pin（P0-0 patch manifest 任务维护）
- `$NEKO_SERVICES/docs/design/neko-access-audit.md`：全部 HTTP/ZMQ/WS 端点契约（排障查端点语义时的权威参考）
- `$NEKO_SERVICES/docs/workplan.md`：P0-0 → P2-3 工作项索引
