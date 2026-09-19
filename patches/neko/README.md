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

## 补丁如何生成

在 N.E.K.O 仓库中基于 BASELINE.md 记录的基线 commit 建分支、提交改动，然后导出并按命名规范重命名：

```bash
cd <N.E.K.O 仓库>    # 默认 ../N.E.K.O，可用环境变量 NEKO_REPO 覆盖
git format-patch <基线commit>..<你的分支> -o <neko-services>/patches/neko/
cd <neko-services>/patches/neko/
mv 0001-xxx-yyy.patch 001-<slug>.patch   # format-patch 的 0001- 前缀换成 NNN- 规范
```

生成或修改任何补丁后，必须完成下述重放 + 回归，才算完成一次改动。

## 补丁如何重放

```bash
# 空跑：只列出将应用的补丁与基线校验结果，不改动目标仓库
scripts/replay-patches.sh --dry-run

# 实际应用（按 NNN 序依次 git am 到目标仓库）
scripts/replay-patches.sh [--force]
```

脚本行为细节、参数与环境变量（`NEKO_REPO` 覆盖目标仓库路径）见脚本内 usage（`scripts/replay-patches.sh -h`）。应用失败时脚本会提示进入目标仓库执行 `git am --abort` 回滚。

## 回归规则（workplan P0-0 #9 固化）

**改 patch → 重放 → 回归全绿**，三步缺一不可：

```bash
cd <N.E.K.O 仓库> && pytest -m plugin_unit,plugin_integration
<neko-services>/scripts/smoke.sh
```

## 与 BASELINE.md 的关系

- BASELINE.md 记录补丁链出发的 N.E.K.O 基线 commit（40 位 hash）、MaiBot 剥离来源 hash 与 NapCat 版本状态；
- `replay-patches.sh` 启动时校验目标仓库 HEAD 与基线一致，不一致即拒绝执行（`--force` 可强制继续，补丁可能冲突或语义漂移，风险自负）；
- 升级上游（仅限 QQ 协议 / NapCat 破坏性变更触发）：目标仓库前移到新 commit → 更新 BASELINE.md 基线 → 重放全部补丁 → 回归全绿。
