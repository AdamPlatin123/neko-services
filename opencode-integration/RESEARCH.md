# P1-0 opencode 扩展点调研笔记

> 分支：`p1-0-opencode`（worktree `/mnt/shared/_Projects/N.E.K.O/neko-services/.worktrees/p1-0-opencode`）
> 日期：2026-09-19。调研对象：opencode（开源 AI coding agent，TUI/桌面/IDE 三形态）。
> 背景：整合方案已裁决（UC2）终端入口 = 「人格寄生在 opencode 会话」——monika 三件套装入 opencode 配置 + 记忆经工具调 N.E.K.O memory_server HTTP（`127.0.0.1:48912` 的 `/new_dialog/{name}`、`/cache/{name}`、`/settle/{name}`、`/query_memory/{name}`）。

## 0. 本机检查结论与仓库归属

- 本机（adam@linux）**未安装 opencode**：`command -v opencode`、`npm ls -g`、`~/.config/opencode/`、`~/.local/share/opencode/`、`~/.opencode` 均无痕迹。故不附 `local-env.md`；P1-3 实施时先安装（推荐 `curl -fsSL https://opencode.ai/install | bash`，或 `npm install -g opencode-ai`）。
- **仓库归属变化**：GitHub 仓库已从 `sst/opencode` 迁移到 `anomalyco/opencode`（官方文档安装命令 `brew install anomalyco/tap/opencode`、`docker run ghcr.io/anomalyco/opencode`、`mise use -g github:anomalyco/opencode`，文档页脚「© Anomaly」）。`sst/opencode` 旧地址仍可重定向，DeepWiki 索引的也是旧快照。实施时 issue/文档以 `github.com/anomalyco/opencode` 为准。

## A. 人格注入点

### A1. AGENTS.md 加载机制（全局 vs 项目级）

来源：https://opencode.ai/docs/rules/

- 查找顺序（每类取第一个命中，**不是**叠加）：
  1. **本地/项目级**：从当前目录向上遍历到 git 工作树根，找 `AGENTS.md`（无则回退 `CLAUDE.md`）——只在该目录树内生效；
  2. **全局**：`~/.config/opencode/AGENTS.md`；
  3. **Claude Code 兼容回退**：`~/.claude/CLAUDE.md`（仅当全局 AGENTS.md 不存在时）。
- 另有 `instructions` 配置项（opencode.json）可追加任意 md 文件/glob/远程 URL，**与 AGENTS.md 合并注入**（叠加而非互斥）。
- 关键陷阱：本机存在 `~/.claude/CLAUDE.md`（用户全局 Claude 指令）。若 opencode 侧不放置全局 `~/.config/opencode/AGENTS.md`，宿主的 Claude 全局指令会被带进 opencode 会话（人格污染/规则串扰）。可设 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`（或 `OPENCODE_DISABLE_CLAUDE_CODE=1` 全关，含 skills）规避。

### A2. 自定义 agent 定义

来源：https://opencode.ai/docs/agents/ 、https://opencode.ai/docs/config/

两种定义方式：

1. **markdown agent 文件**（推荐给人格用）：
   - 位置：全局 `~/.config/opencode/agents/` 或项目 `.opencode/agents/`；**文件名即 agent 名**（`monika.md` → `monika` agent）。
   - frontmatter 字段：`description`（必填）、`mode`（`primary`/`subagent`/`all`，缺省 all）、`model`（`provider/model-id`）、`temperature`、`top_p`、`permission`（可精细到 bash 命令 glob，如 `"curl http://127.0.0.1:48912/*": allow`）、`steps`（最大迭代数）、`hidden`、`color`、`disable`。
   - **markdown 正文 = 该 agent 的完整系统提示词**。
2. **opencode.json 的 `agent` 键**：字段同上，`prompt` 支持 `{file:./prompts/xxx.txt}` 引用外部文件（路径相对 config 所在目录）——人格文本很长时可外置。

### A3. 系统提示词能装多少（monika 三件套约 200 行中文）

来源：DeepWiki 问答（基于 sst/opencode 源码）+ agents 文档

- 自定义 agent 的 `prompt` **完全替换**内置默认系统提示词（不是追加），但 AGENTS.md 内容与环境上下文块（目录/平台等）仍会合并进最终 system prompt；无提示词长度限制。200 行中文（约数 KB）毫无压力，即使把 monika 预设全量 5 个文件 533 行塞入也可行。
- 更优的分层：核心人格（三件套）进 agent prompt（常驻）；补充素材（诗稿/独白/示例）走 **Agent Skills**（`~/.config/opencode/skills/monika/SKILL.md` 或直接复用 `~/.claude/skills/monika-default-preset/`，opencode 原生发现该路径）——skill 由模型经 `skill` 工具**按需加载**，不占常驻上下文。注意 skill 是懒加载，核心人格不能只放 skill。
- 长会话自动压缩（compaction）后人格可能被摘要稀释：plugin 有 `experimental.session.compacting` 钩子，可在压缩提示词里强制保留人格要点（来源：https://opencode.ai/docs/plugins/ ）。

## B. 工具扩展（调 memory_server HTTP 的两条路径）

### B1. plugin / custom tool 路径（TS/JS）

来源：https://opencode.ai/docs/plugins/ 、https://opencode.ai/docs/custom-tools/

- **plugin**：JS/TS 模块放 `.opencode/plugins/`（项目）或 `~/.config/opencode/plugins/`（全局，启动自动加载），或 npm 包经 `plugin` 配置项加载。运行于 **Bun** → **原生 `fetch` 可直接用**，无需任何依赖即可调 `http://127.0.0.1:48912`。plugin 还能订阅事件（见 C）。
- **custom tool**（更轻，单独文件即可）：`.opencode/tools/*.ts` 或 `~/.config/opencode/tools/`，文件名即工具名；用 `@opencode-ai/plugin` 的 `tool()` helper：Zod schema 定义参数、`execute(args, context)` 实现，context 含 `agent`/`sessionID`/`messageID`/`directory`/`worktree`。单文件多导出可生成多工具（`<filename>_<exportname>`）。
- 工具对模型可见为 first-class tool（描述可控、参数有校验），可靠性高。

### B2. bash tool + curl 路径

- opencode 内置 bash 工具，模型可直接执行 `curl -X POST http://127.0.0.1:48912/cache/monika -d '...'`；权限系统默认全 allow（也可配 `permission.bash` 的 glob 白名单只放行 curl 到 48912）。
- 零代码、零 TS 依赖，但每回合消耗 token 让模型拼 URL+JSON，存在引号转义/URL 拼错风险，写记忆可靠性依赖 prompt 遵循度。

### B3. 代价对比

| 维度 | custom tool（TS+fetch） | bash+curl |
| --- | --- | --- |
| 开发量 | 约 50-120 行 TS，一次开发 | 零代码，只写 prompt 规则 |
| 参数校验 | Zod 强校验，模型出错率低 | 模型拼字符串，转义/拼错风险 |
| 每回合 token 开销 | 低（工具描述常驻，调用干净） | 高（curl 命令+响应噪音进上下文） |
| 记忆写入可靠性 | 高（结构化参数） | 中低（依赖遵循度） |
| 部署 | 需放文件到 `~/.config/opencode/tools/`（opencode 自动加载，无构建步骤，TS 直接跑） | 无部署 |
| 升级耦合 | 依赖 `@opencode-ai/plugin` API 稳定性（版本迭代快，需钉版本） | 无耦合 |

**结论：主路径用 custom tool（fetch 直连），备选 bash+curl（用于 5 分钟快速验证端到端链路）。**

## C. 会话边界（持久化 / 回合结束钩子 / 记忆写入时机）

### C1. 会话持久化与恢复

来源：https://opencode.ai/docs/tui/ 、https://opencode.ai/docs/cli/ 、DeepWiki 问答

- 持久化：**SQLite 数据库**（Drizzle ORM，SessionTable/MessageTable），Linux 数据目录 `~/.local/share/opencode/`（`auth.json`、`log/`、`project/<项目slug>/storage/` 存各项目会话与消息）。
- 恢复：TUI `/sessions`（别名 `/resume`、`/continue`）列表切换；CLI `opencode run -c` 继续上一会话、`opencode run -s <sessionID>` 指定会话、`--fork` 分叉；`opencode session list/export/import` 可管理/导出/导入。会话天然跨重启存活——「跨次对话同一人格连续」由 opencode 免费提供。

### C2. 回合结束钩子（能自动 POST /cache 吗）

来源：https://opencode.ai/docs/plugins/ （事件列表）+ DeepWiki 源码问答

- **能。** plugin 事件 `session.idle`：会话完成当前执行时触发——即 agent 结束对用户消息的回复、无 pending 工具调用时（源码 `SessionPrompt.run` 循环在 lastAssistant 到达 finish 态且无 pending tool calls 后退出→idle）。**精确等于「每回合结束」**。
- plugin 拿内容：事件回调里可经 opencode SDK client（`session.messages()`/`session.history()`）取本回合用户消息与最后一条 assistant 回复，再 `fetch` POST `/cache/{name}`——全自动、不依赖模型自觉。
- `session.created` 事件可挂 `/new_dialog/{name}`（会话建立时开档）。
- **`/settle`（会话终结沉淀）没有对应系统事件**（opencode 无「会话结束」概念，只有 `session.deleted`）。可行方案：自定义命令 `/monika-settle` 手动触发（markdown command，见 D）或 plugin 内 idle 去抖计时（如 idle 超 N 分钟自动 settle）。

### C3. 靠 prompt 规则让模型自己写记忆的可靠性

- 中低：模型遵循「回复后调工具写记忆」规则在短对话尚可，长对话/上下文压缩后易遗忘，且每次写记忆都是一次工具调用开销与失败点。**作为唯一路径不可靠，只宜作补充（模型主动调 query_memory 检索仍有价值——读路径靠模型调、写路径靠 session.idle 钩子兜底是最佳分工）。**

### C4. 回复前读增量（P1-1 范式「回复前读共享上下文」）

- 自定义命令支持 **`` !`command` `` shell 输出注入 prompt**（来源：https://opencode.ai/docs/commands/ ）：如 `/monika` 命令模板里写 `` !`curl -s http://127.0.0.1:48912/recent_history/monika` `` 即可把最新共享记忆注入当轮 prompt——文档化能力，可靠。
- P1-1 交付 `/recent_history/{name}?since_seq=` 增量端点后，opencode 侧「回复前读」即用此机制（或 plugin 在 prompt 前缀注入，若版本提供对应钩子——当前文档事件表未暴露 chat 级改写钩子，以命令注入为准）。

## D. 并存性（编程 agent 与莫妮卡人格按项目/目录切换）

来源：https://opencode.ai/docs/agents/ 、https://opencode.ai/docs/rules/ 、https://opencode.ai/docs/config/

- **完全支持，三种粒度**：
  1. **会话内切换**：primary agent 用 Tab 键轮换（build/plan/自定义 monika 并列）；`@monika` 也可手动唤起（若 mode 含 subagent）。`default_agent` 配置项可指定启动默认 agent。
  2. **项目级**：`.opencode/agents/monika.md` + 项目 `opencode.json`（可设 `"default_agent": "monika"`）只在该项目生效——建一个「陪聊目录」放 monika 配置即得「进这个目录=莫妮卡，进代码目录=build」；项目配置后加载、可覆盖全局。
  3. **全局**：`~/.config/opencode/agents/monika.md` 所有项目可见（Tab 随时可切），编程项目默认仍是 build，互不干扰。
- AGENTS.md 项目级天然按目录树隔离，人格相关规则建议全部收进 agent 定义而非 AGENTS.md，避免污染编程会话；反向也成立（编程项目 AGENTS.md 不会进 monika agent，因为 prompt 替换但 AGENTS.md 仍合并——见 A3，若不想要宿主项目规则干扰人格，把人格放进独立的陪聊目录项目即可）。
- 配置优先级（后者覆盖前者）：remote → 全局 → `OPENCODE_CONFIG` → 项目 → `.opencode/` 目录 → 环境变量内联 → 受管配置。

## E. 结论：推荐接入方案

**主路径（置信度 0.85）——「自定义 agent + custom tool + session.idle 插件」三件落地**：

1. `~/.config/opencode/agents/monika.md`：markdown agent（mode: primary），正文 = monika 三件套人格 prompt（约 200 行）+ 记忆工具使用守则；
2. `~/.config/opencode/tools/neko-memory.ts`：custom tool 单文件多导出（`new_dialog`/`cache`/`settle`/`query_memory`），Bun 原生 fetch 直连 `127.0.0.1:48912`；
3. `~/.config/opencode/plugins/monika-memory-sync.ts`：订阅 `session.created` → POST `/new_dialog`；订阅 `session.idle` → 取本回合内容 POST `/cache`（写路径自动兜底）；idle 去抖超时或 `/monika-settle` 命令 → POST `/settle`。

**备选路径（置信度 0.6，仅用于 5 分钟端到端冒烟）**：全局 AGENTS.md 注入人格 + bash curl 调四端点 + prompt 规则要求模型每回合写记忆。零部署但可靠性低，不作为长期形态。

**P1-3 文件改动清单**见 `PLAN.md`。

## 来源清单（全部一手来源：官方文档 10 页 + 基于官方仓库源码的 DeepWiki 问答 3 次）

| 来源 | 类型 |
| --- | --- |
| https://opencode.ai/docs/agents/ | 官方文档 |
| https://opencode.ai/docs/rules/ | 官方文档 |
| https://opencode.ai/docs/plugins/ | 官方文档 |
| https://opencode.ai/docs/commands/ | 官方文档 |
| https://opencode.ai/docs/config/ | 官方文档 |
| https://opencode.ai/docs/custom-tools/ | 官方文档 |
| https://opencode.ai/docs/skills/ | 官方文档 |
| https://opencode.ai/docs/tui/ | 官方文档 |
| https://opencode.ai/docs/cli/ | 官方文档 |
| https://opencode.ai/docs/ （安装/概览） | 官方文档 |
| DeepWiki sst/opencode 问答 ×3（会话持久化与 session.idle 语义；数据目录与仓库迁移；自定义 agent prompt 替换语义），如 https://deepwiki.com/search/how-are-sessions-persisted-and_a12b449e-174a-4d3d-acf4-fe5acd8e40f7 | 源码级问答（索引为迁移前快照，结论与现行文档互相印证） |
