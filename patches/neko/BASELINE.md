# N.E.K.O 子项目分叉基线（BASELINE）

> 记录日期：2026-09-19 ｜ 来源任务：workplan P0-0 分叉治理（#2/#3/#5）
> 本文件是 `patches/neko/` 补丁清单（patch manifest）的锚点：所有补丁重放的前提是目标 N.E.K.O 仓库处于下方记录的基线 commit。机器可读基线见文末第 5 节，由 `scripts/replay-patches.sh` 解析校验。

## 1. N.E.K.O 子项目（整合基底）

- 本地仓库：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O`（独立 git 仓库，上游 GitHub Project-N-E-K-O/N.E.K.O，Apache-2.0）
- 基线 commit（完整 40 位）：`a3c82b5a8eeb63afcc0a344fa1113a176b8defd2`
- commit 日期：2026-09-17 11:01:33 +0800
- commit 主题：`fix(realtime): 修复插件工具重建丢失与 Gemini 语音回复卡死 (#3127)`
- 分支状态：`main`，与 `origin/main` 一致（无本地领先/落后）

### 1.1 工作树状态（2026-09-19 实查）

**干净**：`git status --porcelain` 输出为空（无未提交修改、无未跟踪文件），`git stash list` 为空。

这是 patch manifest 的起点事实：补丁链从完全干净的基线出发，不存在游离于补丁体系之外的隐性本地改动。

## 2. MaiBot（a-memorix 剥离来源记录，供 P0-1 使用）

- 本地仓库：`/mnt/shared/_Projects/N.E.K.O/MaiBot`（独立 git 仓库，上游 GitHub Mai-with-u/MaiBot，GPL-3.0）
- 基线 commit（完整 40 位）：`65b31f916d1b846469d72d01b22e79f69cb4ec41`
- commit 日期：2026-09-18 03:46:12 +0000
- 分支：`main`
- 用途：P0-1 任务 #1 将 `MaiBot/src/A_memorix` 整树拷出为 `neko-services/a-memorix-service/`，验收要求「树拷贝完成 + 基线 hash 记录」——届时以本节 hash 作为剥离来源登记。

## 3. NapCat 当前版本

**版本未 pin。** 来源（查证线索）：

1. N.E.K.O 的 `.gitignore`（第 216-226 行）把 `plugin/plugins/qq_auto_reply/NapCat.Shell/*` 整目录排除在版本控制之外，仅保留 `.gitkeep` 占位——NapCat 以用户自行放置的 `NapCat.Shell` 发行包目录形态存在，仓库不追踪其版本；
2. `plugin/plugins/qq_auto_reply/napcat_service.py` 的 `find_napcat_launcher()`（第 85-99 行）只查找 `launcher-user.bat` / `launcher.bat`，或接受用户经 `napcat_directory` 设置指向任意安装位置；代码与配置中无版本号、无下载 URL、无摘要 pin；
3. 本机该工作树为干净 checkout，`NapCat.Shell/` 目录不存在，无运行时版本可查。

**pin 落地办法（P0-0 #5 后续项）**：首次部署 NapCat 时，将其发行包确切版本号补记到本节，并在 `scripts/doctor.sh` 中增加版本回显与 changelog 巡检入口。

## 4. 分叉姿态声明（workplan P0-0 #3）

**钉死版本、被动跟进**：N.E.K.O 子项目固定在上述基线 commit，日常不追 upstream；仅当 QQ 协议 / NapCat 出现破坏性变更时才拉取上游，更新本文件的基线记录，并按 `patches/neko/README.md` 流程重放补丁。

## 5. 机器可读基线（供 scripts/replay-patches.sh 解析，勿改动格式）

```text
NEKO_BASELINE_COMMIT=a3c82b5a8eeb63afcc0a344fa1113a176b8defd2
NEKO_BASELINE_DATE=2026-09-17
MAIBOT_BASELINE_COMMIT=65b31f916d1b846469d72d01b22e79f69cb4ec41
MAIBOT_BASELINE_DATE=2026-09-18
BASELINE_RECORDED=2026-09-19
```
