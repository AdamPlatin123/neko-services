# 组件版本记录与数据升级退路

> 用途：每次升级任何组件前，先查这张表；升级完成后，立即更新这张表。
> 配套：上游基线与 NapCat pin 的**权威记录**在 `/mnt/shared/_Projects/N.E.K.O/neko-services/patches/neko/BASELINE.md`（P0-0 patch manifest 任务维护），本表登记指针与数据面信息。
> 路径变量 `$NEKO_DATA_ROOT` 的定义见 `/mnt/shared/_Projects/N.E.K.O/neko-services/README-RUNBOOK.md` 第 0 节（Linux 默认 `$HOME/.local/share/N.E.K.O`，设了 `XDG_DATA_HOME` 则为 `$XDG_DATA_HOME/N.E.K.O`）。

## 1. 版本记录表

| 组件 | 当前版本 | 数据格式版本 | 升级兼容性说明 | 备份属性 |
| --- | --- | --- | --- | --- |
| **N.E.K.O 上游基线**（`/mnt/shared/_Projects/N.E.K.O/N.E.K.O`） | `a3c82b5a`（tag `nightly-4-ga3c82b5a`，2026-09-17 上游线，PR #3127） | —（见「memory 数据」行） | 分叉姿态=钉死版本、被动跟进：仅 QQ 协议/NapCat 破坏性变更时拉取；每次拉取按 `patches/neko/*.patch` 重放并跑回归三绿（runbook 第 4 节）。基线变更后同步更新 BASELINE.md 与本表 | 代码可随 git 回退，无需备份 |
| **Python 运行时与依赖锁定** | N.E.K.O 上游：Python **3.11.\***（pyproject 锁定），依赖以 `$NEKO_SRC/uv.lock` 为准；a-memorix-service：Python **3.12**（uv venv，P0-1 落地时补记精确版本与 lock 文件路径）；neko-services 自有脚本：系统 bash/python3 | — | 上游升级跨 3.11→3.12 等大版本时属破坏性变更，按 runbook 第 3 节故障 3 流程处理；`uv sync` 以 lock 文件为准，不要手动改依赖 | lock 文件随各仓库 git 管理 |
| **本地补丁序列**（`patches/neko/*.patch`） | 随本仓库 git 历史 | — | 补丁针对特定上游基线制作；上游基线前进后重放冲突=需要人工重做补丁 | 随仓库 git 管理 |
| **NapCat**（QQ 协议端，插件托管） | pin 记录在 BASELINE.md（P0-0 #5 落盘；当前本机 `$NEKO_SRC/plugin/plugins/qq_auto_reply/NapCat.Shell/` 尚未安装，首次安装后立即在此补记版本号） | — | **协议风险主源**。自动更新可能破坏 QQ 链路；升级前必查 changelog（巡检入口在 BASELINE.md），升级后跑 runbook 第 3 节故障 3 流程 | 安装包可重下，登录态会话数据看情况备份 |
| **memory 数据**（`$NEKO_DATA_ROOT/memory/<角色>/`） | 跟随写入它的 N.E.K.O 基线 commit（上游无独立 schema 版本号，格式由上游 `memory/` 代码决定） | 随上游基线演进；`_reserved` 角色卡分层 schema 现为 v2（上游 `config/character_fields.py`） | **升级退路的核心**：数据格式跟代码走，代码升级后新版可能以新格式写入；回滚代码必须连数据一起回滚到升级前备份（见第 3 节演练） | **必备份**（角色记忆不可再生） |
| **角色卡 / 用户配置**（`$NEKO_DATA_ROOT/` 下 config、角色 json 等） | 同上，随基线 | v2 `_reserved` 分层 | 角色卡即数据（monika 预设、persona_override 都挂在卡上）；与 memory 数据同批备份 | **必备份** |
| **embedding 向量索引**（`$NEKO_DATA_ROOT/` 下 memory 向量缓存） | 跟随基线 + 本地 embedding 模型 | 可再生 | 索引损坏/格式不认时删除重建即可（由 memory 数据重算），不影响事实数据 | **可重建** |
| **a-memorix-service**（P0-1 产物） | **P0-1 剥离时填**（剥离即记录来源 MaiBot commit hash） | **P0-1 剥离时填**（A_memorix 索引/schema） | 服务挂掉不影响事实数据——N.E.K.O memory_server 是**唯一事实源**，a-memorix 只存可重建的检索索引/派生数据（整合宪章事实源唯一性原则） | 索引**可重建**；其 config（`config/a_memorix.toml`）随仓库 |
| **monika 资产**（P0-2 产物） | **P0-2 整理时填** | 角色卡预设走 N.E.K.O v2 schema | 纯内容层，随本仓库 git 管理 | 随仓库 git |
| **本仓库**（`/mnt/shared/_Projects/N.E.K.O/neko-services`） | 见 `git log`，每阶段 commit 即版本 | — | — | 随 git |

## 2. 必备份 vs 可重建清单

> 下述路径以 `$NEKO_DATA_ROOT` 为准；执行备份前先按 runbook 第 0 节探测实际运行数据根（可能被 `NEKO_STORAGE_SELECTED_ROOT` 或 storage policy 改写）。

**必备份**（丢失不可再生，升级前必须 tar）：

- `$NEKO_DATA_ROOT/memory/` —— 角色记忆（五维记忆全部落盘）
- `$NEKO_DATA_ROOT/` 其余非日志内容（角色卡、用户配置、信任/身份数据）—— 简化操作：整个数据根打包、只排除 `logs/`

**可重建**（损坏/丢失时删除即可，服务会从事实数据重算）：

- memory 向量 embedding 索引
- a-memorix 检索索引（P0-1 完成后生效，从 memory_server 事实源重新 ingest）

## 3. 「带记忆升级 → 回滚」演练步骤清单（P0-0 #8 验收项）

> 核心原则：**代码与数据必须同代**。新版进程一旦启动并写过记忆，回滚代码时数据不能沿用（旧代码读不懂新写入的格式），必须连数据备份一起恢复。这就是升级前必做备份的原因。

### 第 1 步：升级前记录（三个 commit 一个都不能少）

```bash
# ① 上游基线（应与本表第 1 行一致）
git -C /mnt/shared/_Projects/N.E.K.O/N.E.K.O log --oneline -1
# ② 集成仓库 commit（决定「当时的补丁集合」——回滚时重放的是它，不是最新补丁）
git -C $NEKO_SERVICES log --oneline -1
# ③ 补丁基线声明
cat $NEKO_SERVICES/patches/neko/BASELINE.md    # p0-0-governance 分支合入后可用
# 把 ①②③ 的输出记到安全的地方（升级出问题时你要靠它们还原）
```

### 第 2 步：探测实际数据根 + 停服务 + 备份

```bash
# 先探测实际运行数据根（可能被 NEKO_STORAGE_SELECTED_ROOT 或 storage policy 改写，
# 详见 runbook 第 0 节；探测结果若非默认值，重新 export NEKO_DATA_ROOT=<探测结果>）
echo "NEKO_STORAGE_SELECTED_ROOT=$NEKO_STORAGE_SELECTED_ROOT"
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O && uv run python -c \
  "from utils.config_manager import get_config_manager; print(get_config_manager().app_docs_dir)"

systemctl --user stop neko.target    # 手动模式则停掉 launcher 进程
mkdir -p $HOME/neko-backup
tar --exclude='*/logs' -czf $HOME/neko-backup/neko-data-$(date +%Y%m%d-%H%M%S).tar.gz \
    -C "$(dirname $NEKO_DATA_ROOT)" "$(basename $NEKO_DATA_ROOT)"
ls -lh $HOME/neko-backup/    # 确认 tar 存在且体积合理
```

### 第 3 步：升级（代码面，此时服务保持停止）

```bash
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O
git fetch origin && git checkout <新基线commit>
cd $NEKO_SERVICES && ./scripts/replay-patches.sh    # p0-0-governance 分支合入后可用
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O && uv run pytest -m 'plugin_unit or plugin_integration'
```

### 第 4 步：起服务 + 升级后验证（代码面冒烟 + 数据面人工）

```bash
systemctl --user start neko.target    # 手动模式：cd $NEKO_SRC && uv run launcher.py
curl -s http://127.0.0.1:48912/health    # status ok、instance_id 与 48911 一致

# 四端冒烟（smoke.sh 需要服务在运行；p0-0-scripts 分支合入后可用，
# 脚本若声明自带起停则以脚本为准）
cd $NEKO_SERVICES && ./scripts/smoke.sh

# 然后人工验证：
#   1. QQ 发一条消息，确认正常回复（新代码能读旧数据）
#   2. 问角色一件升级前聊过的旧事，确认记忆还在
#   3. 桌面端开一次会话，确认 /new_dialog 正常渲染 persona
```

验证全过 → 把新基线写进 BASELINE.md 与本表第 1 行，升级结束（旧备份保留至少一个版本周期）。

### 第 5 步：回滚方法（升级失败或发现数据问题时）

```bash
# 1. 停服务
systemctl --user stop neko.target

# 2. 代码回滚 = 上游旧基线 + 「升级前那个集成仓库 commit」的补丁集
#    （不是重放最新补丁！第 1 步记录的 ①② 就是用在这里）
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O && git checkout <第1步记录的上游基线>
cd $NEKO_SERVICES && git checkout <第1步记录的集成仓库commit> && ./scripts/replay-patches.sh

# 3. 数据回备份（新版若启动过，此步 mandatory，不可跳过）
mv $NEKO_DATA_ROOT ${NEKO_DATA_ROOT}.broken-$(date +%Y%m%d%H%M%S)
tar -xzf $HOME/neko-backup/neko-data-<备份时间戳>.tar.gz -C "$(dirname $NEKO_DATA_ROOT)"

# 4. a-memorix 派生索引处理（P0-1 完成后生效，届时补精确路径与命令）：
#    索引从 memory_server 事实源派生、可重建——升级/回滚后若检索结果异常，
#    停 a-memorix unit → 清空其索引目录 → 重启 → 触发全量重 ingest 重建。
#    （占位：具体目录与重建命令在 P0-1 落地时补写）

# 5. 起服务 + 重跑第 4 步验证
systemctl --user start neko.target
```

验证通过、确认不再回滚后，再删 `${NEKO_DATA_ROOT}.broken-*`。

## 4. 演练记录

| 日期 | 演练内容（从→到） | 结果 | 发现的问题与处置 |
| --- | --- | --- | --- |
| 待执行（P0-0 #8 验收：完成一次完整的升级→回滚演练后填此行） | — | — | — |
