# patches/neko/ — N.E.K.O 子项目补丁清单（patch manifest）

本目录存放对 N.E.K.O 子项目（默认位于本仓库的 `../N.E.K.O`）的**全部本地修改**，以 `git format-patch` 序列维护：可重放、可审计、可随基线升级迁移。基线 commit 与分叉姿态见 [BASELINE.md](BASELINE.md)。

当前状态：**基线已锚定**。补丁清单（P1-2 分支带入 003/004；001/002 为 P1-1（L1 上游修复）预留序号，其分支合并后序号自然连续；010-012 为 P1-1 UC3-B（main 进程侧），005-009 预留给 UC3-A 的 memory_server 侧补丁）：

| 序号 | 补丁 | 来源任务 | 内容 |
| --- | --- | --- | --- |
| 003 | `003-persona-mount-mode.patch` | P1-2 #1 | persona_override 挂载分轨：声明式 `mount_mode`（完整人设 replace / 附加模块 append）+ `append_guidance` append-only 模块轨 + `env_context` 开关键 + 四情形断言测试 |
| 004 | `004-desktop-env-injection.patch` | P1-2 #2 | 桌面昵称状态机数据面：主进程采集宿主环境（getpass/platform 等，无 shell）经 `utils/persona_env_context.py` 注入 `_build_initial_prompt`，未声明零注入 |
| 005 | `005-humanize-pipeline.patch` | P2-1 | 人味后处理（默认 off）：MaiBot 三函数移植进 qq_auto_reply 插件 `humanize/`（分段/错字/打字延迟，HumanizeConfig 收敛 14 标量、char_frequency.json 绝对路径化）；block 改写器挂两条缓冲路径共用的最终投递入口（`QQReplyDeliveryNode.deliver` 前缘，缓冲取消不截断已发送段）；quote_previous 内部关系+发送回执解析+未知降级；记账分离（事实提取/fallback 补行用改写前语义正文、提及计数用送达文本）；QQ 全链 trace_id（contextvar helper + dispatcher 入口 + pipeline traces + 投递日志）。代审 P2 修复：空段守卫（max_split_num<=0 原文透传不崩）+ 错字默认对齐 official_configs（麦麦级密度 0.01/9/0.1/0.006/1.0）。依赖 jieba/pypinyin。41 项新测试（plugin_unit） |
| 010 | `010-desktop-cross-injection.patch` | P1-1 #5（UC3 1a-4） | 桌面活跃会话每轮跨端增量注入：stream_text 组装 user content 前经 `on_cross_context_refresh` 回调取 `/recent_history` 增量拼「[跨端最近对话]」块（水位懒对齐防与 /new_dialog 双重注入，`_reset_cross_context_alignment` helper 覆盖全部三处会话取用：start_session 主路径/offline handoff 候选/热切换 pending 直连；文本轮+独立 ASR 语音轮全覆盖；失败 WARN 降级不阻塞） |
| 011 | `011-amemorix-write-hook.patch` | P1-1 #9（UC1 转正） | settle 成功后批量写 a-memorix 索引（session end /process|/settle + renew 两接入点，`chat_history.clear()` 前快照）：turn 块切分 + external_id 五段规范（64 位内容哈希幂等；同批逐字重复 turn 坍缩为一条记为已知局限）+ `/a_memorix/v1/ingest_summary`（chat_summary 语义，P0-1b 约束）；`A_MEMORIX_URL` 未设=off；近实时 notify 评估后降级为 settle 批量（决策见 patch 内 docstring） |
| 012 | `012-wechat-conversation-tier.patch` | P1-1 #11 | 微信主对话从 agent 档换 conversation 档（跨端同档、与桌面同模型同人格）；`max_completion_tokens=300` 保留（与桌面 textGuard 300 对齐的权衡）；50 字提示词保留（已登记偏差） |

> ⚠️ 在 001/002 落地前，`replay-patches.sh` 会因序号不连续（003 起始）拒绝整组重放——这是校验的预期行为。单独验证 003/004 可直接 `git am` 这两个文件到基线（P1-2 已在干净基线 worktree 上做过：双补丁干净应用 + 新增测试全绿 + OOC 回归 23/23）。
>
> 010-012 同理：在 001-009 落位前整组重放会被序号连续性校验拒绝。已验证的叠加顺序为 `001 → 002 → 010 → 011 → 012`（干净基线 worktree 上五个补丁依次 `git am` 全部成功，叠加态新增测试 54 passed；012 与 002 同改 `wechat_integration/__init__.py` 但区域不相交，无冲突）。

## 命名规范

```
NNN-<slug>.patch
```

- `NNN`：三位递增序号（`001` 起）。文件名字典序即应用顺序，`replay-patches.sh` 依赖这一点；
- `<slug>`：全小写、短横线分隔的短名，概括补丁内容，例如 `001-memory-server-recent-history.patch`；
- **只追加、不插队**：新补丁永远取当前最大序号 +1。需要修改历史补丁时，等价于从该补丁起重建其后整段序列。

## 补丁如何生成（仓库内暂存 → 核对 → 可回滚替换）

在 N.E.K.O 仓库中基于 BASELINE.md 记录的基线 commit 建分支、提交改动，然后在**本仓库内的暂存目录**导出全量补丁，核对无误后对 `patches/neko/` 做**目录级可回滚替换（rollback-able swap）**——整个流程要么整体成功，要么旧补丁集合可恢复保留。注意：两步 rename 之间存在短暂的目录缺失窗口，且意外中断不会自动恢复，故称「可回滚」而非「原子」，中断后按下方要点手动恢复：

```bash
cd <neko-services>
# 暂存目录建在仓库内（与 patches/neko 同文件系统，目录级 mv 是 rename 而非跨设备复制）
stage="$(mktemp -d "$PWD/patches/.tmp-patches.XXXXXX")"
mkdir -p "$stage/neko"
# 非补丁文件随行拷入暂存目录（缺失它们的新目录不可用；有其他非 .patch 文件也一并拷）
cp patches/neko/BASELINE.md patches/neko/README.md "$stage/neko/"

cd <N.E.K.O 仓库>    # 默认 ../N.E.K.O，可用环境变量 NEKO_REPO 覆盖
git format-patch <基线commit>..<你的分支> -o "$stage/neko"    # $stage 是绝对路径，跨目录可用

cd "$stage/neko"
# 核对并重命名：数量 = 分支 commit 数（git rev-list --count <基线commit>..<你的分支>）；
# 逐个把 0001- 前缀重命名为 NNN-<slug>.patch（序号从 001 严格连续、slug 全小写短横线）
shopt -s nullglob; news=(./*.patch); shopt -u nullglob
[ "${#news[@]}" -gt 0 ] || { echo "导出为空：分支区间或分支选错，不替换"; exit 1; }

cd <neko-services>
# 目录级可回滚替换：两步 rename（olddir 目标名不存在，mv 语义即为 rename）；
# 之间有短暂缺失窗口，失败/中断不自动恢复——恢复分支执行后必须检查结果
olddir="patches/.old-patches.$$"
if mv patches/neko "$olddir" && mv "$stage/neko" patches/neko; then
    rm -rf "$olddir" "$stage"      # 成功：清理
else
    [ -d patches/neko ] || mv "$olddir" patches/neko   # 切换未完成则恢复旧集合
    if [ -d patches/neko ]; then
        echo "替换失败：旧集合已恢复（或原样未动），暂存目录保留待查: $stage" >&2
    else
        echo "替换失败且自动恢复未成功：请按下方要点从 $olddir 手动恢复" >&2
    fi
    exit 1
fi
```

要点：

- **不要**直接向 `patches/neko/` 追加导出，也不要先删后逐文件 mv——中断会留下空集或不完整集合；
- **导出零补丁一律报错不替换**：空集合几乎必然意味着分支/区间选错，静默替换会抹掉既有补丁链；
- 流程意外中断时，`patches/.tmp-patches.*` / `patches/.old-patches.*` 残留即回滚材料。手动恢复时**先把缺失/不完整的 `patches/neko` 移走，再换回旧集合**——目标目录存在时直接 `mv <.old 目录> patches/neko` 会把旧目录移进其内部而非替换：

  ```bash
  mv patches/neko patches/.broken-$$      # 移走缺失/不完整的目录（若存在）
  mv <.old 目录> patches/neko             # 换回旧集合
  [ -f patches/neko/BASELINE.md ] && rm -rf patches/.broken-$$ && echo "已恢复"
  ```

`replay-patches.sh` 会自动校验：文件名符合 `NNN-<slug>.patch`、序号从 001 起严格连续，不合规即拒绝重放。

生成或修改任何补丁后，必须完成下述重放 + 回归，才算完成一次改动。

## 补丁如何重放

```bash
# 空跑：只列出将应用的补丁与基线校验结果，不改动目标仓库
scripts/replay-patches.sh --dry-run

# 实际应用（按 NNN 序依次 git am 到目标仓库）
scripts/replay-patches.sh [--force]
```

脚本行为细节、参数与环境变量（`NEKO_REPO` 覆盖目标仓库路径）见脚本内 usage（`scripts/replay-patches.sh -h`）。

重放是**整组一次 `git am`**：中途失败时 `git am --abort` 撤销的是本次全部补丁（回到重放前 HEAD），不存在部分残留；修复后重新运行脚本从基线整体重放。

## 回归规则（workplan P0-0 #9 固化）

**改 patch → 重放 → 回归全绿**，三步缺一不可：

```bash
cd <N.E.K.O 仓库> && pytest -m 'plugin_unit or plugin_integration'
<neko-services>/scripts/smoke.sh    # P0-0 #6 产出，随该任务合并后可用
```

## 与 BASELINE.md 的关系

- BASELINE.md 记录补丁链出发的 N.E.K.O 基线 commit（40 位 hash）、MaiBot 剥离来源 hash 与 NapCat 版本状态；
- `replay-patches.sh` 启动时校验目标仓库 HEAD 与基线一致，不一致即拒绝执行（`--force` 可强制继续，补丁可能冲突或语义漂移，风险自负）；
- 升级上游（仅限 QQ 协议 / NapCat 破坏性变更触发）：目标仓库前移到新 commit → 更新 BASELINE.md 基线 → 重放全部补丁 → 回归全绿。
