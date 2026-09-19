# P1-0 opencode 扩展点调研笔记

> 分支：`p1-0-opencode`（worktree `/mnt/shared/_Projects/N.E.K.O/neko-services/.worktrees/p1-0-opencode`）
> 日期：2026-09-19（同日按 codex pre-merge review 修订 HTTP 契约/每轮读取/失败语义等）。调研对象：opencode（开源 AI coding agent，TUI/桌面/IDE 三形态）。
> 背景：整合方案已裁决（UC2）终端入口 = 「人格寄生在 opencode 会话」——monika 三件套装入 opencode 配置 + 记忆经工具调 N.E.K.O memory_server HTTP（`127.0.0.1:48912`）。
>
> **HTTP 契约（以 `docs/design/neko-access-audit.md` 为准，本笔记全文统一）**：
> - **GET** `/new_dialog/{name}` → PlainTextResponse（persona markdown + 内心活动 + recent history + gap 提示 + 节假日；写 prompt-locale、持 settle_lock）——是**读取**端点，不是「开档写入」
> - **POST** `/cache/{name}`，body = `HistoryRequest`：`{input_history: "<JSON 序列化的 messages 数组**字符串**>", language?, render_language?}` → 响应 `{"status": "cached|processed|settled|error"}`（注意 200 + status:error 反模式）
> - **POST** `/process/{name}`：完整结算管线（LLM 摘要）
> - **POST** `/renew/{name}`：同 process 但持 settle_lock（热重置且有增量时）
> - **POST** `/settle/{name}`：结算已 cache 的增量（无增量时）
> - **POST** `/query_memory/{name}`，body = `QueryMemoryRequest{query?, time?, subjects?[]}` → `{results:[], query, candidates_total, elapsed_ms}`（服务端失败永返空结果）
> - 确切节奏（照抄桌面/wechat 范式）：**turn 结束 → /cache（增量）；会话重开（热重置）→ /renew（有增量）或 /settle（0 增量）；会话结束 → /process（有增量）或 /settle（0 增量）**
> - `GET /recent_history/{name}?since_seq=`（JSON+游标）为 P1-1 待交付的新端点，opencode 侧增量读取依赖它

## 0. 本机检查结论与仓库归属

- 本机（adam@linux）**未安装 opencode**：`command -v opencode`、`npm ls -g`、`~/.config/opencode/`、`~/.local/share/opencode/`、`~/.opencode` 均无痕迹。故不附 `local-env.md`；P1-3 实施时先安装（推荐 `curl -fsSL https://opencode.ai/install | bash`，或 `npm install -g opencode-ai`），安装后立即记录版本并按下文「版本验证清单」逐项核对。
- **仓库归属变化**：GitHub 仓库已从 `sst/opencode` 迁移到 `anomalyco/opencode`（官方文档安装命令 `brew install anomalyco/tap/opencode`、`docker run ghcr.io/anomalyco/opencode`、`mise use -g github:anomalyco/opencode`，文档页脚「© Anomaly」）。`sst/opencode` 旧地址仍可重定向，DeepWiki 索引的也是**迁移前旧快照**。实施时 issue/文档以 `github.com/anomalyco/opencode` 为准。

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
   - frontmatter 字段：`description`（必填）、`mode`（`primary`/`subagent`/`all`，缺省 all）、`model`（`provider/model-id`）、`temperature`、`top_p`、`permission`（可精细到 bash 命令 glob：权限对**整条命令串**做 glob 匹配、**后匹配的规则优先**，故 `"*"` 通配在前、具体规则在后；curl 参数顺序多变，放行模式建议用前置通配，如 `"*": "deny"` 在前、`"curl *http://127.0.0.1:48912*": "allow"` 在后）、`steps`（最大迭代数）、`hidden`、`color`、`disable`。
   - **markdown 正文 = 该 agent 的完整系统提示词**。
2. **opencode.json 的 `agent` 键**：字段同上，`prompt` 支持 `{file:./prompts/xxx.txt}` 引用外部文件（路径相对 config 所在目录）——人格文本很长时可外置。

### A3. 系统提示词能装多少（monika 三件套约 200 行中文）

来源：官方 agents/config 文档 + DeepWiki 快照问答（见文末标注）

- 自定义 agent 的 `prompt` **替换内置 agent 的系统提示词部分**（不是追加），但 AGENTS.md 内容与环境上下文块（目录/平台等）**仍会合并**进最终 system prompt（合并范围详见 D 与 P1-3 实测项）；无提示词长度限制。200 行中文（约数 KB）毫无压力，即使把 monika 预设全量 5 个文件 533 行塞入也可行。
- 更优的分层：核心人格（三件套）进 agent prompt（常驻）；补充素材（诗稿/独白/示例）走 **Agent Skills**（`~/.config/opencode/skills/monika/SKILL.md` 或直接复用 `~/.claude/skills/monika-default-preset/`，opencode 原生发现该路径）——skill 由模型经 `skill` 工具**按需加载**，不占常驻上下文。注意 skill 是懒加载，核心人格不能只放 skill。
- 长会话自动压缩（compaction）后人格可能被摘要稀释：plugin 有 `experimental.session.compacting` 钩子，可在压缩提示词里强制保留人格要点（来源：https://opencode.ai/docs/plugins/ ）。

## B. 工具扩展（调 memory_server HTTP 的两条路径）

### B1. plugin / custom tool 路径（TS/JS）

来源：https://opencode.ai/docs/plugins/ 、https://opencode.ai/docs/custom-tools/

- **plugin**：JS/TS 模块放 `.opencode/plugins/`（项目）或 `~/.config/opencode/plugins/`（全局，启动自动加载），或 npm 包经 `plugin` 配置项加载。运行于 **Bun** → **原生 `fetch` 可直接用**（配 `AbortSignal.timeout` 做超时），无需任何依赖即可调 `http://127.0.0.1:48912`。plugin 还能订阅事件（见 C）。
- **custom tool**（更轻，单独文件即可）：`.opencode/tools/*.ts` 或 `~/.config/opencode/tools/`，文件名即工具名；用 `@opencode-ai/plugin` 的 `tool()` helper：Zod schema 定义参数、`execute(args, context)` 实现，context 含 `agent`/`sessionID`/`messageID`/`directory`/`worktree`。单文件多导出可生成多工具（`<filename>_<exportname>`）。
- 工具对模型可见为 first-class tool（描述可控、参数有校验），可靠性高。

### B2. bash tool + curl 路径

- opencode 内置 bash 工具，模型可直接执行 `curl -s -X POST http://127.0.0.1:48912/cache/monika -H 'content-type: application/json' -d '{"input_history": "[...]"}'`；权限系统默认全 allow（也可配 `permission.bash` 的 glob 白名单只放行到 48912 的 curl，写法见 A2）。
- 零代码、零 TS 依赖，但每回合消耗 token 让模型拼 URL+双层 JSON 字符串（`input_history` 是「字符串化的数组」，转义极易出错），写记忆可靠性依赖 prompt 遵循度——比主路径更不可靠。

### B3. 代价对比

| 维度 | custom tool（TS+fetch） | bash+curl |
| --- | --- | --- |
| 开发量 | 约 80-150 行 TS，一次开发 | 零代码，只写 prompt 规则 |
| 参数校验 | Zod 强校验，模型出错率低 | 模型拼字符串，双层 JSON 转义高风险 |
| 每回合 token 开销 | 低（工具描述常驻，调用干净） | 高（curl 命令+响应噪音进上下文） |
| 记忆写入可靠性 | 高（结构化参数+超时+body status 检查） | 中低（依赖遵循度） |
| 部署 | 需放文件到 `~/.config/opencode/tools/`（opencode 自动加载，无构建步骤，TS 直接跑） | 无部署 |
| 升级耦合 | 依赖 `@opencode-ai/plugin` API 稳定性（版本迭代快，需钉版本） | 无耦合 |

**结论：主路径用 custom tool（fetch 直连），备选 bash+curl（用于 5 分钟快速验证端到端链路）。**

## C. 会话边界（持久化 / 回合结束钩子 / 记忆读写时机）

### C1. 会话持久化与恢复

来源：https://opencode.ai/docs/tui/ 、https://opencode.ai/docs/cli/ ；持久化实现细节为 DeepWiki 快照推断（见文末标注）

- 持久化：会话与消息**持久化在数据根目录 `~/.local/share/opencode/` 下**（项目级数据位于 `project/<项目slug>/storage/`），底层为 **SQLite**（Drizzle ORM 的 SessionTable/MessageTable）。⚠️ 「SQLite 库文件」与「storage 目录」的具体对应布局（库文件在 storage 目录内还是别处）官方文档未明示，属快照推断——**P1-3 实测项**，以钉定版本 `opencode session list/export` 实际行为为准。
- 恢复：TUI `/sessions`（别名 `/resume`、`/continue`）列表切换；CLI `opencode run -c` 继续上一会话、`opencode run -s <sessionID>` 指定会话、`--fork` 分叉；`opencode session list/export/import` 管理/导出/导入。会话天然跨重启存活——「跨次对话同一人格连续」由 opencode 免费提供。
- **版本验证清单（安装钉定版本后逐项核对，文档为现行版、钉定版本可能滞后）**：① TUI `/sessions` 及 `/resume`、`/continue` 别名存在性；② `opencode run -c` / `-s <id>` / `--fork` 行为；③ `opencode session list --format json` / `export` / `import`；④ plugin 事件表（session.created/idle/updated 载荷形状）；⑤ `tool()` helper 与 `@opencode-ai/plugin` 导出；⑥ permissions bash glob 的整串匹配与后匹配优先语义；⑦ `/init`、`/compact` 等内置命令。

### C2. 回合结束钩子（能自动写 /cache 吗）

来源：https://opencode.ai/docs/plugins/ （事件列表）+ DeepWiki 快照问答

- **能。** plugin 事件 `session.idle`：会话完成当前执行时触发——即 agent 结束对用户消息的回复、无 pending 工具调用时（快照源码 `SessionPrompt.run` 循环在 lastAssistant 到达 finish 态且无 pending tool calls 后退出→idle）。**语义上等于「每回合结束」**；但触发细节（取消/失败/重复等）见 PLAN.md 风险表的 P1-3 实测清单。
- plugin 拿内容：事件回调里可经 opencode SDK client（`session.messages()`/`session.history()`）取本回合用户消息与最后一条 assistant 回复，再 `fetch` **POST `/cache/{name}`**（body 见文首契约：`input_history` 为 JSON 序列化 messages 数组的**字符串**）——全自动、不依赖模型自觉。失败语义（超时/双层错误判定/outbox 重试/幂等去重键）在 PLAN.md §主路径 3。
- 开场读取：**GET `/new_dialog/{name}`** 是读取端点（persona+内心活动+近期记忆，持 settle_lock），不是「开档写入」。opencode 主路径中人格已常驻 agent prompt，开场/恢复的近期记忆注入走 `/monika` 命令（C4）；plugin 的 `session.created` 事件只做**本地初始化**（确保水位/outbox 目录存在、登记会话），不调服务端。
- **`/process`/`/settle`（会话终结/热重置结算）没有对应系统事件**（opencode 无「会话结束」概念，只有 `session.deleted`）。可行方案：`/monika-settle` 手动命令（按「有无未结算增量」选 POST `/process` 或 POST `/settle`，照抄文首节奏）或 plugin 内 idle 去抖计时（如 idle 超 N 分钟自动结算）；重进会话（热重置语义）时有增量走 POST `/renew`。

### C3. 靠 prompt 规则让模型自己写记忆的可靠性

- 中低：模型遵循「回复后调工具写记忆」规则在短对话尚可，长对话/上下文压缩后易遗忘，且每次写记忆都是一次工具调用开销与失败点。**作为唯一路径不可靠；最佳分工是：写路径靠 session.idle 钩子自动兜底，读路径靠模型主动调 query_memory/recent_history 工具（读漏了只影响当轮语境，不产生脏数据）。**

### C4. 回复前读取（每轮/边界的共享记忆注入）

来源：https://opencode.ai/docs/commands/ （shell 输出注入）+ 事件表 https://opencode.ai/docs/plugins/

- **文档化可靠点**：自定义命令支持 `` !`command` `` 把 shell 输出注入 prompt——`/monika` 命令模板里 `` !`curl -s --max-time 5 "http://127.0.0.1:48912/recent_history/monika?since_seq=<水位>"` `` 每次执行都现拉。适合**开场与恢复**。
- **每轮读取（降级表述，如实）**：opencode 文档化事件表中**没有**「发给模型前改写/注入 prompt」的钩子（`tui.prompt.append` 是 TUI 输入框预填，不是发给模型前的注入；chat 级改写钩子未出现在现行事件表）。因此**每轮自动热注入在 opencode 现有机制下不可靠/不可得**，每轮读取只能依赖：① 模型自读——agent prompt 规则要求「被唤起后的首条回复前调 `neko-memory_recent_history` 工具拉增量」（可靠性=中，依赖遵循度，读漏不产生脏数据）；② 会话边界重跑 `/monika` 命令（可靠）。**真正的「回复前必读」依赖 P1-1 的桌面热注入（UC3-3 lifecycle/streaming 级）方案落地后，评估 memory_server 侧统一推送/拉取机制，opencode 作为消费端跟随，不自造轮子。**
- **水位（since_seq）持久化**：plugin 本地 state 文件 `~/.local/share/opencode/monika-memory/state.json`（`{"since_seq": N, "pending_cache": M}`），由读取方（`/monika` 命令的辅助脚本、recent_history 工具）成功读取后更新 since_seq，plugin 写 `/cache` 成功后递增 pending_cache、`/process`/`/settle` 成功后清零。last-writer-wins，读取幂等（重复注入同一段只浪费少量 token，不破坏正确性）。详见 PLAN.md。
- **Tab 切换与 `/sessions` 恢复的读取保障**：切回 monika agent 后由用户重跑 `/monika`（一次命令，现拉现注入，文档化可靠）；plugin 能否经 `session.updated` 等事件探测「切 agent」并提醒用户跑 `/monika`——P1-3 实测项。

## D. 并存性（编程 agent 与莫妮卡人格按项目/目录切换）

来源：https://opencode.ai/docs/agents/ 、https://opencode.ai/docs/rules/ 、https://opencode.ai/docs/config/ ；合并语义为 DeepWiki 快照推断+文档互证

- **切换支持，三种粒度**：
  1. **会话内切换**：primary agent 用 Tab 键轮换（build/plan/自定义 monika 并列）；`@monika` 也可手动唤起（若 mode 含 subagent）。`default_agent` 配置项可指定启动默认 agent。
  2. **项目级**：`.opencode/agents/monika.md` + 项目 `opencode.json`（可设 `"default_agent": "monika"`）只在该项目生效——建一个「陪聊目录」放 monika 配置即得「进这个目录=莫妮卡，进代码目录=build」；项目配置后加载、可覆盖全局。
  3. **全局**：`~/.config/opencode/agents/monika.md` 所有项目可见（Tab 随时可切），编程项目默认仍是 build。
- **人格隔离的边界（修正表述）**：自定义 agent 的 prompt 替换的只是「内置 agent 系统提示词」；宿主**全局规则**（`~/.config/opencode/AGENTS.md`，含 `~/.claude/CLAUDE.md` 回退）、**当前目录树的项目 AGENTS.md**、`instructions` 配置与环境上下文块**仍会合并**进最终 system prompt——即**人格 agent 无法隔离宿主全局/项目规则的合并**。缓解：陪聊目录不放项目 AGENTS.md、全局放占位 AGENTS.md 阻断 `~/.claude/CLAUDE.md` 回退。合并的确切范围（哪些层、何种顺序、能否按 agent 关闭某些层）为 **P1-3 实测项**。
- 配置优先级（后者覆盖前者）：remote → 全局 → `OPENCODE_CONFIG` → 项目 → `.opencode/` 目录 → 环境变量内联 → 受管配置。

## E. 结论：推荐接入方案

**主路径（置信度 0.85）——「自定义 agent + custom tool + session.idle 插件」三件落地**：

1. `~/.config/opencode/agents/monika.md`：markdown agent（mode: primary），正文 = monika 三件套人格 prompt（约 200 行）+ 记忆工具使用守则（读：每轮自读增量/按需 query_memory；写：钩子自动，模型仅在用户明确要求沉淀时调 settle 类工具）；
2. `~/.config/opencode/tools/neko-memory.ts`：custom tool 单文件多导出（`recent_history`/`query_memory`/`cache`/`process`/`renew`/`settle`，方法与 body 见文首契约），Bun 原生 fetch 直连 `127.0.0.1:48912`，统一 5s 超时+body status 双层检查；
3. `~/.config/opencode/plugins/monika-memory-sync.ts`：`session.created` → 本地初始化；`session.idle` → 取本回合内容 POST `/cache`（失败落 outbox 重试队列）；idle 去抖超时或 `/monika-settle` 命令 → 按增量有无 POST `/process` 或 `/settle`。

**备选路径（置信度 0.6，仅用于 5 分钟端到端冒烟）**：全局 AGENTS.md 注入人格 + bash curl 调端点 + prompt 规则要求模型每回合写记忆。零部署但可靠性低（尤其双层 JSON 转义），不作为长期形态。

**P1-3 文件改动清单**见 `PLAN.md`。

## 来源与质量自评

**官方文档为主（opencode.ai/docs/ 现行版 10 页）+ DeepWiki 基于官方仓库源码的问答 3 次；DeepWiki 索引的是 `sst/opencode` 迁移前旧快照，以下结论属「快照推断」，均已在上文标注 P1-3 实测：SQLite 持久化与数据目录布局（C1）、`session.idle` 触发语义细节（C2）、自定义 agent prompt 替换与 AGENTS.md 合并语义（A3/D）、仓库迁移事实（§0，此项有官方文档旁证）。**

| 来源 | 类型 |
| --- | --- |
| https://opencode.ai/docs/agents/ | 官方文档（现行版） |
| https://opencode.ai/docs/rules/ | 官方文档（现行版） |
| https://opencode.ai/docs/plugins/ | 官方文档（现行版） |
| https://opencode.ai/docs/commands/ | 官方文档（现行版） |
| https://opencode.ai/docs/config/ | 官方文档（现行版） |
| https://opencode.ai/docs/custom-tools/ | 官方文档（现行版） |
| https://opencode.ai/docs/skills/ | 官方文档（现行版） |
| https://opencode.ai/docs/tui/ | 官方文档（现行版） |
| https://opencode.ai/docs/cli/ | 官方文档（现行版） |
| https://opencode.ai/docs/ （安装/概览） | 官方文档（现行版） |
| DeepWiki sst/opencode 问答 ×3（https://deepwiki.com/search/how-are-sessions-persisted-and_a12b449e-174a-4d3d-acf4-fe5acd8e40f7 等） | 源码级问答（**迁移前旧快照**，结论与现行文档互证后采信，未互证部分已标注实测） |
| `/mnt/shared/_Projects/N.E.K.O/neko-services/.worktrees/p1-0-opencode/docs/design/neko-access-audit.md` | 本仓库权威契约（HTTP 方法/body/节奏） |
