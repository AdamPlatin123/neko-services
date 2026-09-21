# core/persona：monika 资产整理（P0-2 产出）

> 来源任务：workplan.md P0-2 ｜ 权威依据：`docs/design/module-interface-audit.md`「模块二：monika 三件套」。
> 本目录把 monika 仓库的纯 prompt 资产拆分为**通用模块**（任何角色可复用）与**莫妮卡角色卡实例**（专属数据），并附回归套件。本目录本身不含素材本体（monologues/poems/examples 以引用方式指向 monika 仓库，部署时拷贝）。

## 1. 目录说明

```
core/persona/
├── README.md                      # 本文件
├── modules/                       # 六件通用模块（中文内容，参数化，任何角色装载即用）
│   ├── channel-layering.md        # ① 通道分层协议：场景版 A「对话 vs 写文件」+ 场景版 B QQ 映射「可见文本 vs 记忆落库」
│   ├── ooc-rules.md               # ② OOC 五条 + 身份保护三条（规则正文逐字保留源材料，仅角色名参数化）
│   ├── fault-persona.md           # ③ 故障角色化：限流/断网/报错/长等待 → 世界观语言（含宿主故障事件钩子需求）
│   ├── recap-rules.md             # ④ Recap 私密独白规则（对接 startup_greeting_policy / session 摘要）
│   ├── nickname-state-machine.md  # ⑤ 昵称状态机：ASCII 状态机图 + 默认名黑名单 + 桌面/QQ 字段映射表 + rename_events 落库
│   └── persona-params.md          # ⑥ 角色卡参数化规范：profile 字段表 + RESERVED_FIELD_SCHEMA 锚定 + meta.json 映射
├── characters/
│   └── monika/                    # 莫妮卡完整角色卡包（persona-params 规范的实例化）
│       ├── character.json         # 角色卡（preset_id=monika-default，rename_events 预置空数组）
│       └── assets/
│           └── manifest.md        # 素材引用清单（monologues/poems/examples 7 主题，本体不拷贝）
└── regression/                    # 回归套件（源自 476 代理 OOC 测试，行为层通过率 99.1%）
    ├── ooc-12-scenarios.md        # 12 维度可执行测试用例（场景/输入/期望/失败判据 + QQ/桌面链路标注）
    └── golden-samples.md          # examples/ 7 主题语气样本引用 + 静态/动态对比方法
```

## 2. 部署方式

### 2.1 拷进 N.E.K.O（neko 子项目）

| 产物 | 目标 | 说明 |
|---|---|---|
| `modules/*.md` 六件 | N.E.K.O 仓库的 prompt 资产目录（建议 `prompts/persona_modules/`，随 `persona_override.prompt_guidance` 引用） | 通用模块随宿主分发；①③④⑤的「宿主实现锚点」小节标注了 QQ/桌面两条链路的注入点 |
| `characters/monika/character.json` | N.E.K.O 角色卡（`_reserved.persona_override` / `ai_context.rename_events` 已按 `config/character_fields.py` 的 `RESERVED_FIELD_SCHEMA` 结构填写，可直接导入或作为 workshop 内置预设种子） | 导入后 `rename_events` 从空数组开始累积真实事件 |
| `characters/monika/assets/` 素材本体 | 从 monika 仓库拷贝（命令见 `characters/monika/assets/manifest.md` 第 3 节），随角色卡资产目录分发 | 本仓库不存素材本体；拷贝后按 manifest 第 2 节校验（动作标记零残留、占位符归一、许可随行） |
| `regression/*.md` | N.E.K.O 测试资产目录（建议 `tests/persona_regression/`） | 12 场景用例 + golden samples 对比方法；重放桩需求见 ooc-12-scenarios.md 附录 |

### 2.2 进 opencode / coding agent 配置（原 skill 用法的等价物）

monika 原「安装」方式是拷 skill 到 `~/.claude/skills/`。整合后等价做法——**五个运行模块全量装载**（`persona-params.md` 是角色卡制作规范而非运行模块，不装载）：

1. `modules/channel-layering.md` → agent 全局指令（CLAUDE.md / opencode 的 AGENTS.md 片段）：coding 会话的「对话温情 / 写文件严谨」分层，用场景版 A；coding agent 环境无记忆落库动作，无需场景版 B。
2. `modules/ooc-rules.md` → 同上全局指令：OOC 五条 + 身份保护三条。
3. `modules/nickname-state-machine.md` → 同上全局指令：coding agent 场景的初始称呼取系统用户名（由宿主注入，语义等价 `getpass.getuser()`）；用户给出昵称后按状态机全局替换，持久层可达时落 `ai_context.rename_events`，无角色卡持久层时降级为会话内全局替换。
4. `modules/fault-persona.md` → 同上全局指令：coding agent 宿主在故障（限流/断网/工具报错）恢复后注入 `fault_event` 变量；无钩子时模块静默降级不生效。
5. `modules/recap-rules.md` → 会话恢复场景（`--resume` / compact 后的开场摘要）装载：recap 按私密独白写，输入取宿主 session summary。
6. `characters/monika/character.json` 的 `profile` 段 + `assets/` 素材作为角色内容层，供任意 runtime（opencode persona、AstrBot persona 等 monika `meta.json` hosts 清单所列宿主）读取。

装载时的占位符绑定（一次性替换，五个运行模块共用同一套）：

| 占位符 | 绑定值（莫妮卡实例） | 说明 |
|---|---|---|
| `{persona_name}` | 莫妮卡 | ooc-rules 台词示例、fault-persona 翻译基调等处的角色名 |
| `{worldview_voice}` | 角色卡 `profile.worldview.fault_voice`（莫妮卡实例：「故障即天气——这边的世界有点不稳定」） | fault-persona 的世界观翻译基调 |
| `{user_call}` | 动态：按昵称状态机解析（初始 = 系统用户名或 Player） | recap-rules 等处的当前生效称呼 |
| `{initial_placeholder}` | Player | 昵称状态机的初始占位称呼 |
| `{host_channel_user}` / `{host_channel_persist}` | 对话明文输出 / 写文件产出 | channel-layering 场景版 A 的两通道指称 |

### 2.3 源仓库（/mnt/shared/_Projects/N.E.K.O/monika/）处置

本目录是**整理产出**而非迁移搬运：monika 仓库保持只读不动（含 `.claude/CLAUDE.md`、`.claude/skills/monika-default-preset/`、`edgeinfinity/MAICA_ds_basis/distilled/`）。后续若 N.E.K.O 侧验证通过，可在 monika 仓库加指针声明「运行时资产以 neko-services/core/persona 为准」。

## 3. 修复声明（失效绝对路径问题）

- **源问题**：monika 仓库 `.claude/CLAUDE.md` 第 12 行（开场加载第 2 步）写死绝对路径 `/mnt/shared/_Projects/monika/.claude/skills/monika-default-preset/preset.md`——该路径已失效（实际位于 `/mnt/shared/_Projects/N.E.K.O/monika/` 下），源文件按此读取会失败。
- **本目录的修复**：全部模块/角色卡/清单**不使用写死的绝对路径寻址装载素材**——
  - `character.json` 的 `modules` 与 `exemplars.asset_refs` 用相对引用（`modules/...`、`assets/manifest.md`）；
  - `assets/manifest.md` 的部署目标相对素材安装根解析，源仓库引用集中一处管理；
  - 各模块间互引（如 ooc-rules 指向 channel-layering）均为同目录相对引用。
- 因此源文件的失效路径问题在这些模块中**不存在**；唯一的绝对路径出现在「指向 monika 源仓库」的溯源引用（README 与 manifest 的源路径列），它们是文档性引用而非装载路径，失效不影响运行。

## 4. 与审计文档的对应关系

| 审计结论（module-interface-audit.md 模块二） | 落点 |
|---|---|
| 装载拆分建议 6 模块（通道分层/OOC/身份保护/故障角色化/Recap/角色卡+昵称状态机） | `modules/` 六件（身份保护并入 `ooc-rules.md` 第二节，避免碎片化） |
| 通道分层映射「可见文本 vs 记忆落库」 | `modules/channel-layering.md` 场景版 B |
| 昵称状态机挂 `getpass.getuser()`（桌面）/`user_nickname`+`master_name`（QQ），落 `ai_context.rename_events` | `modules/nickname-state-machine.md` 第 3、4 节 |
| 参数化落点 `RESERVED_FIELD_SCHEMA` 的 `persona_override` / `ai_context.rename_events` / `character_origin`；meta.json 映射卡字段 | `modules/persona-params.md` 全文 + `characters/monika/character.json` |
| `.claude/CLAUDE.md` L12 失效路径必改 | 本 README 第 3 节修复声明 |
| `ooc_report.md` 12 场景做回归 | `regression/ooc-12-scenarios.md` |
| examples/ 7 主题作语气回归 golden samples；蒸馏规则做静态检查 | `regression/golden-samples.md` |
