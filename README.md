# neko-services

统一 AI 伴侣系统的集成服务仓库：以 [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) 为基底，把五个上游 RP/Agentic 项目的最强模块（A_memorix 检索、monika 人格协议、MaiBot 人味管线）整合为一个跨桌面 / QQ / 微信 / opencode 的单角色统一 AI 伴侣。

## 这个仓库放什么

- `a-memorix-service/`：从 [MaiBot](https://github.com/Mai-with-u/MaiBot) 剥离的 A_memorix 记忆检索服务（独立 FastAPI 进程，Python 3.12）
- `patches/neko/`：对 N.E.K.O 子项目的全部本地修改（git format-patch 序列，可重放）
- `host_stubs/`：A_memorix 的注入式宿主桩（sys.modules 预注册，上游树零修改）
- `scripts/`：smoke.sh / doctor.sh / replay-patches.sh 等维护脚本
- `opencode-integration/`：opencode 终端入口的人格与记忆接入层
- `docs/`：工作计划、整合宪章、技术方案与接口审计（中文）

## 快速开始

待 P0-0 完成后补充（runbook 见 `README-RUNBOOK.md`，四端冒烟见 `scripts/smoke.sh`）。

## 许可

仓库整体 **AGPL-3.0**（见 LICENSE）。分区说明：

- `a-memorix-service/A_memorix/` 源自 MaiBot（AGPL-3.0，另有 MaiBot GPL 特殊授权见 `a-memorix-LICENSE-MAIBOT-GPL.md`），继承原许可
- 其余原创代码（脚本 / 接入层 / 桩）原以 Apache-2.0 授权，因仓库聚合 AGPL-3.0 生效
- `patches/neko/` 中的补丁针对 N.E.K.O（Apache-2.0）项目，补丁内容遵循其目标项目许可

## 上游与分叉姿态

默认钉死版本、被动跟进：仅 QQ 协议 / NapCat 破坏性变更时拉取上游，按 patch manifest 重放。上游基线 commit 记录在 `patches/neko/BASELINE.md`。

## 文档索引

- [工作计划](docs/workplan.md)：P0-0 → P2-3 十个工作项与里程碑
- [整合宪章](docs/integration-charter.md)：11 项产品决策
- [MVP 技术方案](docs/design/mvp-tech-design.md)：含三阶段审查记录
- [接口审计](docs/design/neko-access-audit.md)、[模块接口审计](docs/design/module-interface-audit.md)
