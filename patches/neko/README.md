# patches/neko/ — N.E.K.O 子项目补丁清单（patch manifest）

本目录存放对 N.E.K.O 子项目（默认位于本仓库的 `../N.E.K.O`）的**全部本地修改**，以 `git format-patch` 序列维护：可重放、可审计、可随基线升级迁移。基线 commit 与分叉姿态见 [BASELINE.md](BASELINE.md)。

当前状态：**基线已锚定，0 个补丁**（所有对 N.E.K.O 的改动从本目录起步）。

## 命名规范

```
NNN-<slug>.patch
```

- `NNN`：三位递增序号（`001` 起）。文件名字典序即应用顺序，`replay-patches.sh` 依赖这一点；
- `<slug>`：全小写、短横线分隔的短名，概括补丁内容，例如 `001-memory-server-recent-history.patch`；
- **只追加、不插队**：新补丁永远取当前最大序号 +1。需要修改历史补丁时，等价于从该补丁起重建其后整段序列。

## 补丁如何生成（仓库内暂存 → 核对 → 目录级原子切换）

在 N.E.K.O 仓库中基于 BASELINE.md 记录的基线 commit 建分支、提交改动，然后在**本仓库内的暂存目录**导出全量补丁，核对无误后对 `patches/neko/` 做**目录级原子切换**——整个流程要么整体成功，要么旧补丁集合原样保留：

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
# 目录级原子切换：两步 rename；olddir 目标名不存在，mv 语义即为 rename
olddir="patches/.old-patches.$$"
if mv patches/neko "$olddir" && mv "$stage/neko" patches/neko; then
    rm -rf "$olddir" "$stage"      # 成功：清理
else
    [ -d patches/neko ] || mv "$olddir" patches/neko   # 失败：切换未完成则恢复旧集合
    echo "替换失败：旧集合已恢复（或原样未动），暂存目录保留待查: $stage" >&2
    exit 1
fi
```

要点：

- **不要**直接向 `patches/neko/` 追加导出，也不要先删后逐文件 mv——中断会留下空集或不完整集合；
- **导出零补丁一律报错不替换**：空集合几乎必然意味着分支/区间选错，静默替换会抹掉既有补丁链；
- 流程意外中断时，`patches/.tmp-patches.*` / `patches/.old-patches.*` 残留即回滚材料：若 `patches/neko` 缺失或不完整，手动 `mv <.old 目录> patches/neko` 恢复后清理残留。

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
