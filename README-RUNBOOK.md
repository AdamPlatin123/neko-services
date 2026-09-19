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
export NEKO_DATA_ROOT="$HOME/.local/share/N.E.K.O"
```

数据根内部布局（已对照 `utils/config_manager/storage_roots.py` 与 `utils/logger_config.py` 查证）：

| 子路径 | 内容 |
| --- | --- |
| `$NEKO_DATA_ROOT/memory/<角色名>/` | **角色记忆数据（五维记忆落盘），必备份**。角色名以 `ls $NEKO_DATA_ROOT/memory/` 实际所见为准 |
| `$NEKO_DATA_ROOT/logs/` | 日志目录。宿主进程日志形如 `N.E.K.O_Main_YYYYMMDD.log`、`N.E.K.O_Memory_YYYYMMDD.log`（按服务名+日期滚动，保留 30 天） |
| `$NEKO_DATA_ROOT/logs/plugin/` | 插件子进程日志（qq_auto_reply / wechat_integration 等） |

> **注意**：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/memory/` 是**代码包**（memory 系统的 Python 源码），不是数据目录。角色数据只存在于 `$NEKO_DATA_ROOT/memory/`。升级备份时不要搞混。

## 1. 服务清单

端口全景（上游 `config/network.py`，另见 `docs/design/neko-access-audit.md` 开头）：48911 主服务、48912 memory_server、48913 monitor、48915 agent/tool 服务、48916 插件服务器；ZMQ 消息面 38865（RPC）/ 38866（PUB）/ 38867（INGEST）。

| 服务 | 端口 | 启动方式 | 日志位置 | 健康检查 |
| --- | --- | --- | --- | --- |
| **主进程**（launcher，merged 模式） | 48911（同进程内还监听 48912、48915） | `cd $NEKO_SRC && uv run launcher.py`。launcher 以合并模式在**单进程**内依次起 memory(48912) → main(48911) → agent(48915) 三个 uvicorn server（`launcher_core/runtime.py` 的 SERVERS 表，按内存从轻到重排序） | `$NEKO_DATA_ROOT/logs/N.E.K.O_Main_YYYYMMDD.log`（launcher 自身 bootstrap 输出在 stdout） | `curl -s http://127.0.0.1:48911/health`，期望 `"service":"main"`、`"status":"ok"` |
| **memory_server**（中心记忆，五维记忆+scoped+query_memory） | 48912 | 常规随 launcher 合并模式拉起（无单独命令）；开发调试可独立运行：`cd $NEKO_SRC && uv run python -m app.memory_server`（加 `--enable-shutdown` 才会响应 `/shutdown`）。**与 merged 模式互斥：48912 端口只能一方占用** | `$NEKO_DATA_ROOT/logs/N.E.K.O_Memory_YYYYMMDD.log` | `curl -s http://127.0.0.1:48912/health`，期望 `"service":"memory"`。**指纹校验**：响应含 `"app":"N.E.K.O"` 与 `instance_id`——三个端口的 instance_id 应一致（merged 模式同进程）；`app` 字段不是 `N.E.K.O` 说明端口被别的进程占了 |
| **a-memorix-service**（检索层，从 MaiBot A_memorix 剥离） | 未定 | **P0-1 完成后生效**（FastAPI + uv 3.12 venv + systemd user unit，绑定 127.0.0.1）。届时此行更新为实际启动命令与端口 | P0-1 完成后生效 | `curl -s http://127.0.0.1:<端口>/a_memorix/v1/stats`（P0-1 完成后生效；doctor.sh 会自动纳入） |
| **NapCat**（QQ 协议端，无 HTTP 端口，以 WS 客户端身份连 qq_auto_reply 插件） | —（出站 WS） | **插件托管**：由 qq_auto_reply 插件的 `napcat_service.py` 自动拉起/守护（sweep 重连），不设独立 systemd unit。默认目录 `$NEKO_SRC/plugin/plugins/qq_auto_reply/NapCat.Shell/`，可在插件设置 `napcat_directory` 改路径 | NapCat 自身日志：`<NapCat目录>/logs/`；插件侧日志：`$NEKO_DATA_ROOT/logs/plugin/`。当前 NapCat 子进程 stdout 丢弃（DEVNULL）——「stdout 接日志文件供 doctor」是 P0-0 计划中的 patch，落盘后此行更新 | 无 `/health` 端点。用 `$NEKO_SERVICES/scripts/doctor.sh`（NapCat WS 连通性检查）+ NapCat 日志判断 |

辅助进程（不单独维护，随主进程/插件服务器生命周期）：

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 48915 | agent/tool 服务 | merged 模式下与主进程同体；`/health` 响应 `"service"` 为 agent 侧 |
| 48916 | 插件服务器（plugin host） | qq_auto_reply / wechat_integration 等插件进程由此管理；`GET /plugins` 可查插件清单与状态 |
| 48913 | monitor | 监控服务 |
| 38865 / 38866 / 38867 | ZMQ 消息面 | RPC / PUB / INGEST。外部进程可无鉴权 SUB 38866 订阅事件（a-memorix 未来 L2 用） |

## 2. 启动与停止顺序

**语义顺序**（谁先谁后为什么）：

1. memory_server（48912）——先就绪，主进程 start_session 就要读 `/new_dialog`
2. a-memorix-service（未来，P0-1 完成后生效）——检索层，晚于 memory、早于主进程
3. 主进程（48911 + merged 同体的 48915/48916）——插件服务器随之拉起 qq_auto_reply / wechat_integration
4. NapCat——由 qq_auto_reply 插件自动拉起并守护，**永远不要手动先启 NapCat**

merged 模式下 1/3 由 launcher 一个命令保证（launcher 内部就是这个顺序并等 health ready）；只有 dev 分进程调试时才需要手工遵守。

**停止顺序**（反向，核心是让 memory 最后死、结算写完盘）：

1. 主进程先停（插件、NapCat 随之退出）——merged 模式向 launcher 进程发 SIGTERM/SIGINT，launcher 有序停机（先 main 后 memory，见 `launcher_core/runtime.py` 的有序停机逻辑）
2. memory_server 最后停；独立运行时可用 `/shutdown` 端点（需以 `--enable-shutdown` 启动）

### systemd 用法（neko.target，P0-0 部署裁决的形态）

unit 文件由 P0-0 的部署任务落盘到 `$NEKO_SERVICES/systemd/user/`（若该目录不存在说明任务未完成，先用下节手动方式）。安装（一次性）：

```bash
mkdir -p ~/.config/systemd/user
cp $NEKO_SERVICES/systemd/user/* ~/.config/systemd/user/
systemctl --user daemon-reload
```

日常操作：

```bash
systemctl --user start neko.target    # 冷启动（验收目标 <2min；内部按上述语义顺序拉起各 unit）
systemctl --user stop neko.target     # 按反向顺序停止
systemctl --user status neko.target   # 总览；单个服务加 unit 名细查
journalctl --user -u <unit名> -f      # 跟踪某 unit 的 stdout/stderr
```

### 手动方式（systemd 不可用或 unit 未落盘时的兜底）

```bash
cd $NEKO_SRC && uv run launcher.py    # 一条命令起齐 memory+main+agent（merged），Ctrl+C 有序停机
```

## 3. 常见故障 3 条

### 故障 1：QQ 不回复了（最高频）

1. **先跑 doctor**：`$NEKO_SERVICES/scripts/doctor.sh`——它一键检查 NapCat WS 连通、插件状态、memory_server `/health`、a-memorix stats（P0-1 后）、LLM key。多数情况一步定位。
2. doctor 指向 NapCat：看 `$NEKO_SRC/plugin/plugins/qq_auto_reply/NapCat.Shell/logs/`（或插件设置里的自定义路径）有没有掉线/风控/扫码过期；插件侧重连日志 `grep -h 'NapCat' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_*.log | tail -50`。
3. doctor 指向插件：`curl -s http://127.0.0.1:48916/plugins` 确认 qq_auto_reply 已启用未崩溃；崩溃看 `$NEKO_DATA_ROOT/logs/plugin/` 当天日志尾部。
4. 都正常但群里沉默：查注意力/权限门控——`grep -h 'attention\|gate\|ignore' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_$(date +%Y%m%d).log | tail -30`（可能是疲劳度/权限/主动忽略的有意行为，不是故障）。

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

任何对 `patches/neko/*.patch` 的修改，必须走完下面全流程、**三绿才算成功**，缺一即视为改动未完成（不允许「先合再说」）：

```bash
# 1. 重放补丁到上游工作树（在干净的上游基线上）
cd $NEKO_SERVICES && ./scripts/replay-patches.sh

# 2. 上游仓库跑插件回归（pytest.ini 与 markers 都在上游根目录）
cd $NEKO_SRC && uv run pytest -m plugin_unit,plugin_integration

# 3. 四端冒烟（带断言，目标 <5 分钟；QQ 腿含人工部分）
cd $NEKO_SERVICES && ./scripts/smoke.sh
```

两条强制配套规则：

- **涉及 reply_pipeline / delivery 的 patch**（QQ 回复管线、投递缓冲、人味改写器挂点）：必带**记账测试**——断言 `delivered_blocks_text()` 语义（事实提取消费原始语义正文、提及计数用实际送达文本）不被分段/块数变化破坏，防止「错字进记忆」「已发送段被截断」两类静默回归。
- **涉及 memory 端点的 patch**（cache/process/renew/settle/query_memory 及新增端点）：必**同步更新端点契约表测试**（P1-1 #7 落地的 TestClient 形状断言：副作用/幂等/重试/三态语义）——契约表与实现不一致时**拒绝重放**。

## 5. 排障入口

### doctor.sh（第一入口）

```bash
$NEKO_SERVICES/scripts/doctor.sh
```

检查项：NapCat WS 连通 / 插件运行状态 / memory_server `/health`（含 instance_id 指纹校验）/ a-memorix stats（P0-1 完成后生效）/ LLM key 有效性。任何「不知道从哪查起」的故障，先跑它。

### trace_id（QQ 链路追踪）

- **目标态**（P2-1 #5 落地后）：QQ 每 turn 生成一个贯穿全链的 trace_id，覆盖 NapCat 接入 → qq_client → 权限门控 → LLM → XML 解析 → 人味后处理 → 投递，全链日志可按同一 id 串联，排障目标 <15 分钟。
- **当前态**（P2-1 落地前）：无贯穿 id。用**时间窗 + 模块关键词**定位（见下）；memory 侧失败的精确追踪用 WARN 行的 request_id（P1-1 统一客户端封装落地后可用）。

### 日志 grep 模式速查

```bash
# QQ 一轮对话在插件侧的全量痕迹（回溯最近 200 行）
grep -h 'qq_auto_reply' $NEKO_DATA_ROOT/logs/plugin/N.E.K.O_$(date +%Y%m%d).log | tail -200

# memory_server 当天所有警告/错误
grep -n 'WARN\|ERROR' $NEKO_DATA_ROOT/logs/N.E.K.O_Memory_$(date +%Y%m%d).log | tail -50

# 主进程当天异常
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

## 7. 相关文档

- `$NEKO_SERVICES/VERSIONS.md`：组件版本/数据格式版本记录、必备份与可重建清单、带记忆升级→回滚演练步骤
- `$NEKO_SERVICES/patches/neko/BASELINE.md`：上游基线 commit 与 NapCat pin（P0-0 patch manifest 任务维护）
- `$NEKO_SERVICES/docs/design/neko-access-audit.md`：全部 HTTP/ZMQ/WS 端点契约（排障查端点语义时的权威参考）
- `$NEKO_SERVICES/docs/workplan.md`：P0-0 → P2-3 工作项索引
