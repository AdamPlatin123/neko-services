# 本机 opencode 环境（P1-3 实施记录）

- 安装日期：2026-09-19（P1-3 实施首日）
- 安装方式：`npm install -g opencode-ai`（npm 11.13.0 / node v24.17.0，nvm）
- **opencode 版本：`1.18.31`**（`opencode --version`；npm 包 `opencode-ai` 与
  插件包 `@opencode-ai/plugin` 同版本 1.18.31）
- 二进制路径：`/home/adam/.nvm/versions/node/v24.17.0/bin/opencode`
- 安装前本机无任何 opencode 痕迹（RESEARCH.md §0 结论复核属实：无 `~/.config/opencode/`、
  无 `~/.local/share/opencode/`、无 `~/.opencode`）
- 版本验证清单（RESEARCH C1）核对结果（2026-09-19 实测）：
  - ① TUI `/sessions` 及别名：TUI 未逐项断言（非交互环境）；CLI `opencode run -c/-s/--fork` 存在 ✓
  - ② `opencode run -c` / `-s <id>` / `--fork`：help 确认存在 ✓（实测见 PLAN ⚠#5 证据）
  - ③ `opencode session list --format json` 存在 ✓（`export`/`import` 为顶层子命令
    `opencode export/import`，非 `session` 子命令——与旧文档快照有出入）
  - ④ plugin 事件表：`session.created/updated/idle/error`、`message.updated` 等均存在 ✓
    （`@opencode-ai/plugin` 1.18.31 类型 + 实抓日志）
  - ⑤ `tool()` helper 与 `@opencode-ai/plugin` 导出 ✓（tool.d.ts：args 为 ZodRawShape，
    `tool.schema = zod`；Bun 运行时下 `import { tool } from "@opencode-ai/plugin"` 可解析）
  - ⑥ permissions bash glob：frontmatter 语义按文档；本接入层主路径整体 `bash: "*": deny`，
    未依赖 glob 优先级（消除该风险面）
  - ⑦ 内置命令 `/init` `/compact` 未逐项断言（非交互实测范围外）
- 本机 Bun（独立安装 `~/.bun/bin/bun`）用于跑本仓库单测；opencode 自身内嵌 Bun 运行插件/工具
- 模型：实测轮使用 GLM（BigModel，OpenAI 兼容 provider，key 经 `{env:GLM_API_KEY}` 引用，
  不落盘）；隔离配置目录实测（`XDG_CONFIG_HOME`/`XDG_DATA_HOME` 指向临时目录），未污染真实
  `~/.config/opencode`

## 与旧文档快照的差异（DeepWiki sst/opencode 迁移前 vs 1.18.31 实测）

- 消息模型为**分离式**：`Message = UserMessage | AssistantMessage`（assistant 消息独立，
  带 `parentID`/`error`/`summary` 字段）；parts 独立对象（`TextPart.messageID` 挂靠）。
  旧快照「assistant 回复作为 user 消息的 parts」的描述已过时
- `UserMessage` 自带 `agent` 字段（agent 判定的兜底数据源）
- `session.idle` 载荷**只有 `{sessionID}`**（无 agent/状态字段）——见 PLAN ⚠#1 实测结论
