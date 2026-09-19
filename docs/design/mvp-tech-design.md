<!-- /autoplan restore point: "/home/adam/.gstack/projects/N-E-K-O/no-git-autoplan-restore-20260919-162931.md" -->
## Implementation plan
# MVP 技术方案：单角色跨端统一 AI 伴侣

> 定稿：2026-09-19 ｜ 依据：整合宪章（`/mnt/shared/_Projects/N.E.K.O/docs/integration-charter.md`）11 项决策 + 两份接口盘点（`docs/design/neko-access-audit.md`、`docs/design/module-interface-audit.md`）
> 所有文件路径与函数签名均经代码查证，标注「已验证」。

## 0. 总体架构（进程拓扑）

```
┌─────────────────────────────── 本机 127.0.0.1 ───────────────────────────────┐
│                                                                              │
│  ┌─ N.E.K.O 主进程（3.11，:48911）────────────────────────────┐              │
│  │  桌面 WS /ws/{角色}（原生）                                  │              │
│  │  qq_auto_reply 插件（QQ，现有）   wechat_integration（微信，现有）│              │
│  │  terminal_bridge 插件（终端，新建，wechat 范式）               │              │
│  └────────────┬───────────────────────────────────────────────┘              │
│               │ 每 turn 结束 POST /cache；会话结束 /process|/settle           │
│  ┌────────────▼───────────────────────────────────────────────┐              │
│  │  memory_server（3.11，:48912，语义层——现有）                  │              │
│  │  五维记忆/信任/scoped + query_memory（hybrid_recall）         │              │
│  └──────┬──────────────────────────────┬──────────────────────┘              │
│         │ settle 后 ingest（HTTP）       │ ZMQ SUB :38866（memory 事件，近实时）│
│  ┌──────▼──────────────────────────────▼──────────────────────┐              │
│  │  a-memorix-service（3.12 venv，新建 FastAPI，检索层）          │              │
│  │  双路检索+图谱扩展+Episode/画像  ← 从 MaiBot/src/A_memorix 剥离  │              │
│  └────────────────────────────────────────────────────────────┘              │
│                                                                              │
│  monika 三件套 = 角色卡预设（persona_override.preset_id 机制，全通道继承）        │
│  人味管线 = qq_auto_reply 内 block 改写器（MaiBot 三纯函数移植）                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**关键选型结论**：
- **事件总线 = 复用 N.E.K.O 原生 ZMQ message_plane**，不引入 Redis/NATS。已验证：外部进程可无鉴权 SUB `:38866` 订阅任意 store 事件、RPC `:38865` 查询；写宿主 store 被安全设计禁止（ingest token 进程私有）——A_memorix 只需读+被调用，正好落在允许面上。
- **四通道不共主会话**：桌面走原生 WS；QQ/微信/终端各自独立 session，靠**同一 memory_server + 同一角色**达成「同一人格同一记忆」。共主会话需 WS 鉴权+并发改造（互踢问题），列为二期。
- **实时强一致分三层交付**（宪章要求的务实落地）：
  - L1 回合级（MVP 必达）：每 turn 结束 `POST /cache`（无 LLM，秒级落库）——任何入口下一回合即可感知
  - L2 近实时索引（MVP 应达）：a-memorix-service SUB `memory.` store 事件，检索索引即时更新——「桌面端当下就能提及」由检索路径达成
  - L3 会话热推送（二期）：SUB `messages.` 驱动活跃会话 prompt 热注入

## 工作流分解（P0 → P2，标注依赖）

> **2026-09-19 CEO 审查修订（autoplan Phase 1）**：新增 P0-0 分叉治理（双模型共识）；修复 L1 承诺的代码缺口（原以为现有行为够，实测微信活跃会话不读记忆）；拆除 P2-1 对 P1-3 的伪依赖；P0-1（a-memorix）是否延后出关键路径为 **Final Gate 用户挑战项 UC1**；终端入口形态为 **UC2**——两项在用户裁决前按原设计保留。

### P0-0 分叉治理与版本归属（新增，CEO 审查强制前置；双模型共识项）

1. **neko-services/ 独立成 git 仓库**（首个 commit 即基线），任何拷出的上游代码记录来源 commit hash。
2. **N.E.K.O 子项目建自有 fork remote**（或至少 patch manifest）：P1-1/P2-1 的内核修改以独立分支 + 逐 commit 补丁清单记录（`neko-services/patches/neko/`），声明当前基线 commit（上游 2026-09-17 线）。
3. **跟进策略显式化**：默认「钉死版本，被动跟进」——仅 QQ 协议/NapCat 破坏性变更时拉取，每次拉取按 patch manifest 重放；写明这是有意选择的分叉姿态。
4. **external_id 规范预留 user 维度**：`{channel}:{user_id}:{chat_id}:{turn_uid}:{seq}`（近零成本，对冲宪章 #6 多用户预留）。

验收：neko-services 有 git 历史；N.E.K.O 本地修改全部可由 patch manifest 重放；分叉姿态一句话写入本文件风险表。

**DX 审查追加（2026-09-19，双声部一致采纳）**：
5. **patch manifest 机械定义**：`patches/neko/*.patch` = git format-patch 序列 + `replay-patches.sh`；验收加「一次空跑重放证明可重放」；NapCat 加版本 pin 与 changelog 巡检入口（NapCat 才是协议风险主源）。
6. **维护者实物三件**：`neko-services/README.md`（runbook：启动顺序/日志位置/每服务 health/常见故障 3 条）+ `scripts/smoke.sh`（四端各一条+切端一条，带断言，<5 分钟）+ `scripts/doctor.sh`（NapCat WS/插件状态/memory_server /health/a-memorix stats/LLM key 一键检查）。
7. **部署形态裁决（DX-6）**：全部常驻进程 = systemd user unit（`neko.target` 一键启停，日常冷启动 <2 分钟）；launcher 仅用于桌面交互端；风险表声明 Linux-only。
8. **数据升级退路**：每集成版本记录组件版本+配置+数据格式版本；声明哪些数据必须备份（memory/ 角色数据）、哪些可重建（a-memorix 索引）；升级前兼容检查+备份恢复步骤；验收含一次「带记忆升级→回滚旧版」演练。

### P0-1 a-memorix-service 服务化（无依赖，最大单件；**UC1 待裁决——若采纳延后则整项移出 MVP 关键路径，降为 P1.5 影子模式**）

**目标**：A_memorix 从 MaiBot subtree 剥离为独立 FastAPI 服务（3.12 venv），HTTP 契约照抄 `host_service.invoke` 组件表。

改动点：
1. **剥离**：`/mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix/` 整树拷出为 `neko-services/a-memorix-service/`（工作区根新建目录，不进 N.E.K.O 子项目）。已验证：包自身零 3.12 语法（125 文件 ast 验证过 3.11），剥离无语法障碍。
2. **宿主桩——注入式 shim（DX-4 修订：替代 40 处散布 import 修改）**：独立 `host_stubs/` shim 包 + `sys.modules` 预注册（sitecustomize 或入口处注入），上游 125 文件**零修改**——把上游升级从「40 文件冲突仲裁」变成「拷新树+挂 shim」。桩内容同原清单：logger 适配、`chat_manager.get_existing_session_by_session_id → None` 降级、`PersonInfo` → 服务内建 person_alias 表（初始化从 N.E.K.O identity HTTP 回查导入）、message_service 桩。
3. **两个适配器重写**：`core/embedding/api_adapter.py` → 直连 OpenAI 兼容 embedding API；`core/utils/model_routing.py` 的 LLM 出口 → 直连 OpenAI 兼容 chat（全包 LLM 只走这一处，改一个点全覆盖）。
4. **配置**：自带 `config/a_memorix.toml`（`SDKMemoryKernel.__init__(config=dict)` 已支持纯 dict 注入，已验证）。
5. **FastAPI 壳**：`/a_memorix/v1/search | ingest_summary | ingest_text | person_profile | stats | maintain | admin/{component}`，请求/响应体照抄 `MemoryHit.to_dict` 键与 `_disabled_response` 空响应形状；保留启动队列 WAL 语义（202+重试）。
6. **部署**：uv 3.12 venv + systemd user unit（或 N.E.K.O launcher 拉起，二选一，建议 systemd 独立生命周期）。

验收：ingest_text → search_memory 闭环冒烟；kill -9 后重启回放 WAL 不丢写。

### P0-2 monika 资产整理（无依赖，纯内容工作）

改动点：
1. **6 模块拆分**（module-interface-audit 模块二第 1 节）：通道分层协议 / OOC 五条 / 身份保护反劫持 / 故障角色化 / Recap 规则 / 角色卡+昵称状态机。修复 `.claude/CLAUDE.md` L12 失效绝对路径。
2. **QQ 语义映射版**：通道分层在 QQ 场景 = 「QQMessageBlock 可见文本→温情 / scoped_facts 与 memory 落库→严谨」（与 `SYNTHETIC_SOURCE_KINDS` 机制对齐，已验证）；桌面保留原语义。
3. **莫妮卡角色卡**：按 `RESERVED_FIELD_SCHEMA`（`config/character_fields.py:69`）映射 meta.json；昵称事件预置 `ai_context.rename_events`；通用模块（OOC 等）经 `persona_override.preset_id` 挂载（该机制已被所有 prompt 消费点继承，已验证：主对话/QQ/微信/主动搭话全覆盖）。
4. **回归用例集**：`ooc_report.md` 12 维度场景转成 QQ/桌面两链路可执行脚本 + `examples/` 7 主题作语气 golden samples。

验收：同一张角色卡在 N.E.K.O prompt 渲染链中完整生效（persona_override 替换路径）。

### P1-1 记忆跨端可达（L1 修复版，不依赖 P0-1；CEO 审查发现的代码缺口修复）

**背景缺口（Codex 代码级证据）**：`wechat_integration/__init__.py:626` 只在**新建会话**时取记忆上下文，活跃会话每轮记忆上下文为空且不调查询——「下一回合可感知」在现有代码上不成立。L1 不是免费行为，是需要实现的。

改动点：
1. **每入口回复前读共享近期上下文**：wechat 范式修复——`_generate_wechat_reply` 每轮拉 `get_recent_history` 增量 + 轻量事实查询（活跃会话不再为空）；terminal_bridge 从第一天照修复后的范式实现；桌面/QQ 现有行为保持。
1a. **统一 memory_server 客户端封装（DX-2/Codex#2 修订，双声部最一致发现）**：所有调用走一个封装模块，强制检查 body 的 `status/ok` 字段（上游反模式：200 + body status:"error"——只查 HTTP 码会把失败当成功）；失败分类可见（无匹配/服务未启用/连接失败/写入失败），WARN 级日志带 request_id；附单测。
1b. **端点语义契约表（Codex#3 修订）**：`/cache` `/process` `/renew` `/settle` 不可互换——固化每端点的输入/成功语义/副作用/幂等键/重试条件；区分「已接受/已持久化/已可检索」；避免 cache 后重提交全量历史的重复写入陷阱（wechat_integration:772 已有说明）。
2. **并发会话顺序规则**：定义两入口同时活跃时的轮次归属与冲突规则（简单版：时间戳序 + 后写覆盖 + 各自 session 隔离）。
3. **（UC1 若裁决保留双层）读融合**：`query_memory` 端点内增加 a-memorix 检索路 RRF 融合 + `new_dialog` 追加 `to_text()` 块（预算入 `PERSONA_RENDER_MAX_TOKENS` 体系）。
4. **（UC1 若裁决保留双层）写钩子与 L2 事件链路**：settle 后 `ingest_text`（external_id 含 user 维度）；**L2 前置验证项**——先证明 `memory.` store 存在生产者（`stores.py:336` 注册 ≠ 有发布链路），若无则改为 settle 钩子显式 HTTP 通知，不做 SUB 假设。
5. **事实源唯一性原则（无论 UC1 裁决如何）**：N.E.K.O memory_server 为唯一事实源；A_memorix 仅存可重建的索引/派生数据；纠正传播与遗忘语义（改错后不再引用旧事实、遗忘后重启不复活）进验收。

验收（体验级，CEO 审查新增）：**跨入口对话切换无需重述**——在 QQ 说到一半切桌面/微信，下一句能接上语境（人工双盲场景测试）；已知偏差「当下=下一回合」显式记录。

**Eng 审查追加（2026-09-19，Codex 三 P1 合并主题）——UC3 待裁决：跨通道一致性契约**：
1a-1. **增量读取端点缺失（Claude Eng 发现 1，P1）**：现有 `GET /get_recent_history`（routes.py:1168）是本地化渲染纯文本、无游标、无 JSON——直接注入会与 wechat 本地滑窗**双重注入**。修复 = memory_server 新增 `GET /recent_history/{name}?since_seq=`（JSON+游标+水位去重）——**上游端点新增，进 patch manifest**。
1a-2. **因果顺序契约缺失（Codex 发现 1，P1）**：写入端点每次重新生成标识、recent.py 纯追加、timeindex 用落库时刻——「时间戳序+后写覆盖」不可执行（旧回合晚到会被误序）。完整修复 = 中心写入契约带通道/会话/稳定轮次标识+版本检查+替代关系（12-20 人日级）。
1a-3. **角色级锁阻塞（Codex 发现 2，P1）**：结算持锁等摘要 LLM 时，其他入口的秒级 `/cache` 被 5s 超时杀死。完整修复 = 摘要移出临界区（快照计算+版本校验提交）。
1a-4. **桌面也不接 L1（Codex 发现 3，P1）**：桌面活跃会话不重启即不取记忆、recall 工具是模型主动非每轮必读——「桌面现有行为保持」不兑现承诺。修复 = 桌面回复前版本检查+增量注入（改 lifecycle/streaming）。
**UC3 裁决项**：完整契约（1a-2/1a-3/1a-4 全做，+12-20 人日，动 memory_server 核心锁与桌面主循环）vs 最小可行（1a-1 端点+水位去重必做；1a-2 降级为「记录已知偏差：晚到回合可能乱序」；1a-3 降级为「结算期间 /cache 失败可重试+可见」；1a-4 降级为「桌面切会话时刷新」）——双模型均指出完整契约是产品承诺的地基，但工作量约等于 P1-1 原预估的 3 倍。
**必做不裁**（无论 UC3 深度）：1a-1 端点与去重；「摘要执行期间另一入口持续读写」进验收；「旧回合晚到/时间相同/重复提交」进验收用例。

### P1-2 monika 装载接线（依赖 P0-2；Eng 审查修正挂载机制）

改动点：
1. **挂载机制修正（Codex Eng 发现 4，P1）**：persona_override **不是通用模块挂载槽**——预设语义是「默认基础时整体替换、自定义基础时追加」（persona_payload.py:287）。monika 通用模块（OOC/通道分层等）必须以「附加行为模块」身份走追加路径（不覆盖基础提示词），莫妮卡完整人设才走 replace 路径；建立唯一合成顺序 + 四种情形断言（默认基础/自定义基础/预设解析失败/语言切换）。QQ 预设继承检查点修正：经 `session_instruction_service.py:408` 的角色提示词段（原计划误写 `_build_core_memory_section`——那管记忆读取）。
2. 昵称状态机：桌面端主进程取 `getpass.getuser()` 等注入 prompt 变量（不让模型执行 shell）；QQ 端映射 `user_nickname`/`master_name`；改名落 `ai_context.rename_events`（已有渲染链，已验证）。
3. 跑 12 场景回归（人味 on 配置下加跑一轮对照——错字注入对 OOC 判定的干扰是真实交互风险）。

### P1-3 terminal_bridge 插件（可与 P0 并行；**UC2 待裁决——宪章 #2 原意是「monika 式人格寄生 Claude Code 会话」，本设计为 N.E.K.O 进程内 PTY/REPL，双模型均质疑为死重量；备选：A) Claude Code 寄生（monika 三件套入 CLAUDE.md + hook 调 query_memory + 写入 /cache，更便宜更贴宪章）B) 砍掉降为三入口 C) 维持现设计**）

改动点（全部已验证可行，plugin/sdk 能力齐全）：
1. `plugin/plugins/terminal_bridge/plugin.toml`（auto_start=true）+ `TerminalBridgePlugin(NekoPluginBase)`，startup 起 PTY/REPL。
2. 收发**照修复后的 wechat 范式**（见 P1-1 第 1 条，从第一天实现每轮读上下文）：`aget_character_data()` 取角色 prompt → GET `/new_dialog/{name}` → `create_chat_llm_async(model=**conversation 档，跨端同档，CEO 审查新增一致性要求**)` → POST `/cache`、会话结束 `/settle`。
3. master 身份绑定：`/internal/identity/accounts/bind`（终端用户=master）。
4. 可选进阶：`ctx.push_message` 注入主对话通道 + SUB `messages.` 回显。

验收：**四端联调**——同一角色在桌面/QQ/微信/终端四入口对话，互相能提及彼此说过的话（经中心记忆）；跨端称呼/承诺/情绪承接一致（同一模型档下）。

### P2-1 人味后处理插件（依赖修复后的 QQ 链路自身；CEO 审查：拆除对 P1-3 的伪依赖，人味与终端联调无因果）

改动点（适配结论均出自 module-interface-audit 模块三，已验证）：
1. 三函数移植进 qq_auto_reply 插件（3.11 直跑已验证；`depends-data/char_frequency.json` 改绝对路径；14 个配置标量收敛为 `HumanizeConfig`）。
2. **block 改写器——位置修正（Codex Eng 发现 5/6/7，Eng 审查采纳）**：挂在**两条缓冲路径共用的最终投递入口**（直投与 `_deliver_after_wait` 汇合处），而非 `_run_delivery` 前缘——原位置在缓冲取消决策之前，新消息取消缓冲任务时会截断分段（用户只收到错字段、纠正段被取消）。配套三件：(a) 区分「可替换草稿」与「已发送片段」，逐块发送确认记录+发送中取消规则；(b) `quote_previous` 不再直映射 `reply_to`（改写时上一段未发送无平台消息 id）——改写器输出「引用前一片段」内部关系，发送器拿到真实回执后再解析平台标识，回执未知时纠正段降级为普通段；(c) 记账语义分离：事实提取消费**原始语义正文**（session_memory_service 序列化路径），提及计数基于**实际送达文本**——错字不进记忆。
3. `calculate_typing_time` 替换 `reply_delivery_node.py` 的固定随机延迟。
4. **默认 off**（CEO 审查采纳）：全部行为经 HumanizeConfig 开关，上线先关，跨端核心体验通过后开 A/B 自测对比偏好，紧急/工作场景感知到负面时保留关闭能力。
5. **QQ 全链路 trace_id（DX-5 修订）**：每 turn 生成贯穿 id 覆盖 NapCat→qq_client→gate→LLM→XML→人味→deliver 全链日志——「QQ 不回复了」的排障目标 <15 分钟（配合 doctor.sh）。

验收：QQ 实测分段/错字/纠错引用/按字数延迟四行为；`delivered_blocks_text()` 记账不受块数变化影响（块内分段语义保持）。

### P2-2 混合分层模型配置（小件）

现有 12 档（conversation/summary/correction/emotion/agent/...）已够 MVP：验证 agent 档（微信在用）+ summary/correction 档配便宜模型即可；a-memorix-service 的杂活（embedding/分类）在其自带配置分档。新增档位仅在需要 LLM 精排时加（`core_config.py:1703 model_type_mapping` 加项，已验证流程）。

### P2-3 MVP 验收（宪章四条验收标准的执行；CEO 审查后从功能打勾升级为体验度量）

1. 入口对话同一角色 ✓（P1-3 或 UC2 裁决后的替代形态）
2. **跨入口语境延续（体验级）**：切入口后无需重述刚才的话——双盲场景自测（QQ 说一半切桌面），记录主观评分；感知延迟记录（L1 实测值）
3. monika 三件套生效 ✓（P1-2 回归）
4. 人味管线**可开关且经自测偏好确认** ✓（P2-1，默认关）
5. 模型分层生效 ✓（P2-2）；**跨端主对话同档**（conversation 档），微信 50 字限制记录为已知体验偏差
6. **成本预算（CEO 审查新增）**：记录典型一周各档 token 消耗与月成本估算；超支时的降档顺序（人味降频 → 摘要档换本地小模型）
7. **纠错/遗忘语义**：纠正后不再引用旧事实；遗忘后重启不复活（若 UC1 保留双层，此项为双层一致性验收）

## 依赖图（Eng 审查后重画，2026-09-19——旧图与新正文矛盾，作废）

```
            ┌─────────────────────────────────────────────┐
            │ P0-0 分叉治理（约束所有上游文件改动）           │
            └──────┬──────────────┬──────────────┬────────┘
        ┌──────────▼───┐   ┌──────▼──────┐   ┌───▼──────────────┐
UC1-A──►│ P0-1 a-memorix│   │ P0-2 monika │   │ P1-3 终端入口      │
保留双层 │ +注入式 shim  │   │ 资产整理    │   │ （UC2 三选一）     │
UC1-B──►│ 整项→P1.5影子 │   └──────┬──────┘   └───┬──────────────┘
        └──────────┬───┘          │     照修复后范式│
                   │              │              │
                   ▼              ▼              ▼
        ┌──────────────────────────────────────────────┐
        │ P1-1 记忆跨端可达（L1 修复——不依赖 P0-1）        │
        │ + UC3 待裁决：跨通道一致性契约（因果序/锁/桌面注入）│
        └──────┬──────────────┬───────────────────────┘
               ▼              ▼
        ┌────────────┐  ┌─────────────┐   ┌──────────────┐
        │ P2-1 人味   │  │ P1-2 monika │   │ P2-2 模型配置 │
        │（仅依赖QQ链路）│  │ 接线+12场景  │   └──────┬───────┘
        └──────┬─────┘  └──────┬──────┘          │
               └───────┬───────┴─────────────────┘
                       ▼
              ┌─────────────────┐
              │ P2-3 体验级验收   │
              └─────────────────┘
```

**走向说明**：UC1-B（延后）时 P0-1 虚化、P1-1 的 #3/#4 删除（#5 事实源原则保留）；UC2-B（Claude Code 寄生）时 P1-3 插件开发消失并入 P0-2/P1-2 面；UC3（见 P1-1 修订）决定一致性契约的实施深度。

## 风险与回退

| 风险 | 回退/缓解 |
| --- | --- |
| a-memorix 服务化受阻（宿主桩比预期深） | 已验证包自身零 3.12 语法 → 可降级为 3.11 进程内集成（替换同样的桩即可），架构不变 |
| 块记账对齐（人味改块数影响 mention 计数） | 块内分段保持 delivered_blocks_text 语义；验收项明确覆盖 |
| 实时性不达标 | L1 回合级是底线（秒级 /cache 已是现有行为）；L2 失败退 L1；L3 二期 |
| WS 共会话互踢 | MVP 不共主会话（四通道独立 session + 同记忆），二期加会话票证 |
| monika 通用模块在 QQ 链路渲染异常 | preset 机制有 append/replace 两档，先 append 后 replace 渐进 |
| 外部 ZMQ 读被未来版本收紧 | A_memorix 读路径可退为 memory_server 主动推送（写钩子已存在） |

## 与宪章的对照

本方案完整覆盖宪章「MVP 交付物定义」5 条；「实时强一致」按 L1/L2/L3 分层交付不降架构承诺；二期项（多角色同台/后台社交/共享世界/affection 轴/多用户）均未提前设计，留待 MVP 验收后启动。
## Review record

## Review record

<!-- autoplan-accepted:ceo -->
- P0-0 分叉治理工作流（fork remote/patch manifest/基线 commit/钉死版本策略声明/external_id user 维度）在 P0-1 之前完成；验收=neko-services 有 git 历史、N.E.K.O 修改可重放。
- P1-1 重写为 L1 修复版：每入口（微信/终端）回复前读共享近期上下文，活跃会话不再为空——验证方式：双盲切端场景无需重述；并发会话顺序规则落地。
- L2 事件链路前置验证：确认 memory store 有生产者后才做 SUB；否则 settle 钩子显式 HTTP 通知。
- 事实源唯一性：N.E.K.O memory_server 唯一事实源，A_memorix 只存可重建索引；纠错/遗忘语义进 P2-3 验收。
- P2-1 拆除对 P1-3 的伪依赖（人味只依赖 QQ 链路）；人味默认 off，自测偏好后再常开。
- P2-3 升级为体验级验收：跨端语境延续双盲自测+感知延迟+月成本预算+降档顺序+跨端同档（conversation）+微信 50 字偏差记录。
- UC1（A_memorix 延后出关键路径）与 UC2（终端入口重定义）按原设计保留，待 Final Gate 用户裁决。
<!-- /autoplan-accepted:ceo -->

### Phase 1 CEO — Step 0（模式 SELECTIVE_EXPANSION）

**0A 前提挑战**：
- P1「N.E.K.O 为基底技术可行」：成立（插件/记忆/QQ/微信现成）。但组织可行性未答——基底是外部高速项目（PR #3127、上游 2026-09-17 仍在提交）。→ 派生分叉治理 P0-0（自动决策采纳）。
- P2「A_memorix 双层服务化值得」：**双模型独立质疑**（Claude #1 / Codex #1 同向：MVP 五条验收无一需要其特有能力；P1-1 的 RRF 融合设计本身证明可事后插入）。→ 排队 Final Gate UC1。
- P3「四通道独立 session+共享记忆=同一人格」：记忆可达性成立、语境连续性有缺口（L3 二期）；且 Codex 证明 L1 在现有代码上不成立（wechat:626 活跃会话记忆为空）→ 技术缺口修复自动采纳（P1-1 重写）。
- P4「L1+L2 够用」：底线成立（宪章风险登记背书），但「当下=下一回合」是有意偏差，需显式记录（已写入 P1-1 验收）。

**0B 现有代码映射**（What already exists，见下必产出节）。

**0C 梦想状态**：
```
CURRENT（五孤岛：桌面/QQ/微信各有人格无共享记忆，monika 寄生 Claude Code）
  → THIS PLAN（MVP：单角色×4入口×共享记忆 L1+体验验收；a-memorix 双层待裁决）
  → 12-MONTH IDEAL（多角色小社会：同台群聊+后台社交+共享世界+affection 轴+多用户）
```
MVP 直接铺向理想态的地基（角色卡数据化/记忆按角色参数化/affection 独立轴预留）；二期最大雷（多角色同台）不在 MVP 爆炸半径内。

**0C-bis 实施替代方案**：
- A（计划现状）：a-memorix 先服务化（M/L，风险中，复用最大）——Completeness 9/10
- B（双模型建议）：memory_server 单层跑通体验，a-memorix P1.5 影子对照后定夺（M，风险低，体验验证最快）——Completeness 7/10（MVP 期缺图谱检索）
- C（最小）：三入口（砍终端）+L1 修复+monika（S-M）——Completeness 5/10
两模型同向建议 B 类路径 = **User Challenge UC1**，非自动决策。

**0E 时间拷问**：HOUR1 需知道 fork 姿态与 external_id 规范（已入 P0-0）；HOUR2-3 会撞 wechat 活跃会话记忆为空的现实（已入 P1-1）；HOUR4-5 惊讶点=memory store 生产者缺失可能（已前置验证）；HOUR6+ 会想要体验对比数据（已入 P2-3 人味 A/B）。

### Phase 1 CEO — 双声部

**Claude 子代理（战略独立）**：7 问题，approve_with_changes。要点：P0-1 排序颠倒/分叉治理缺失/终端入口背离宪章/体验验收缺失/多用户矛盾无回应/A_memorix 冻结无策略/成本无预算。自行核实：五个上游均第三方仓库、A_memorix 上游 95 commits/3.5 个月、工作区根非 git、计划锚点 4 处属实。

**Codex（外部）**：7 发现，reject（证据均带代码行号）。要点：A_memorix 未证明瓶颈/**L1 承诺代码不支持（wechat:626 活跃会话不读记忆——reject 直接理由）**/memory store 事件可能无生产者/双层或成竞争事实源/同一角色卡≠同一人格（模型档+50 字限制变量）/维护时间上限缺失/人味可能负收益。

**共识表**：
```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude                Codex                 Consensus
  1. Premises valid?                  2.5/4 站得住           A_memorix+L1 不成立    CONFIRMED-部分无效
  2. Right problem?                   方向对、路径低效        组件存在≠体验变好      CONFIRMED-偏航
  3. Scope calibration correct?       P0-1 缓/终端砍         先两入口/人味默认关    CONFIRMED-过宽
  4. Alternatives sufficiently expl.? 骨架级合格、骨架内缺席  现有记忆闭环先行未论证  CONFIRMED-局部缺席
  5. Competitive/market risks?        分叉漂移未管理         维护时间上限缺失      CONFIRMED-未管理
  6. 6-month trajectory sound?        主体存活、两例外       入口按使用频率收缩    PARTIAL
```
共识 5/6 CONFIRMED + 1 PARTIAL。三处双模型独立会合：A_memorix 出关键路径（→UC1）、上游治理（→P0-0 自动采纳）、体验验收（→P2-3 自动采纳）。Codex 独有硬发现 L1 缺口（→P1-1 重写自动采纳）与事件生产者存疑（→前置验证）。

### Phase 1 CEO — Sections 1-10（SELECTIVE_EXPANSION，自动决策）

**S1 架构**：依赖图见 0 节拓扑图（修订后新增 P0-0 与 L1 读路径）。新数据流「跨端记忆读」四路径分析：happy=每轮增量拉取注入；nil=新会话走 /new_dialog 全量；empty=无增量时跳过注入（静默正常）；error=记忆服务超时→回复降级不带记忆上下文+日志告警（不可静默）。单点故障：memory_server 宕机=四端失忆（可接受降级，需日志可见）。安全边界不变（loopback 无鉴权=单机单用户前提，多用户化时必须重审——记入与宪章 #6 关系）。耦合变化：wechat/terminal 从「独立会话」耦合到共享 recent_history 读路径（有意为之）。回滚：全部改动在 fork 分支+patch manifest，可整体回退。发现 2 项：(1) L1 读路径缺失→P1-1 修复（P1 完整性）；(2) 多用户与无鉴权的冲突未记账→已写入宪章 #6 关系节（P2）。无新架构扩张项。

**S2 错误与救援映射**（Error & Rescue Registry 核心行）：
```
CODEPATH                          | FAILURE              | RESCUED? | ACTION                  | USER SEES
memory_server POST /cache         | 超时/进程宕           | Y(现有)  | 现有重试+日志            | 无感(该轮不记忆)
每入口读 recent_history (新)       | 超时                  | N→补     | 2s 超时→跳过注入+WARN    | 回复照常(无记忆语境)
a-memorix ingest (若UC1保留)      | 服务未就绪            | Y(设计)  | 202+WAL回放              | 无感
query_memory 双源融合 (若UC1保留)  | a-memorix 超时        | N→补     | 降级单源+WARN            | 检索结果变少
terminal_bridge REPL              | stdin EOF/崩溃        | N→补     | 自动重启+会话状态落盘     | 重连续聊
人味改写器                        | 分段器异常            | N→补     | try/except 原块直通      | 原样消息
XML 解析 _parse_blocks            | LLM 输出坏 XML        | Y(现有)  | _repair_xml LLM 修复     | 延迟回复
```
GAP 修复全部写入对应工作流改动点。catch-all 检查：现有 N.E.K.O 代码有宽 except（上游风格，不改上游已有限制——patch 边界内新代码禁 catch-all）。

**S3 安全与威胁**：新增攻击面=terminal_bridge 的 stdin（本地单用户，低风险）与 a-memorix HTTP 端口（loopback 无鉴权，同现有 memory_server 模式——单机前提可接受，多用户时重审）。prompt 注入面：QQ 群消息是既有面（上游已有防线上限），monika 三件套的 OOC 反劫持恰好增强此面。PII：聊天记忆含个人数据，全部本地存储（合规）。无新增 secrets。发现 1 项：a-memorix 若监听非 loopback 会扩大面——部署验收加「绑定 127.0.0.1」检查（已入 P0-1 部署项）。

**S4 数据流与交互边缘**：关键边缘（跨端并发）：QQ 与桌面同时活跃→P1-1 顺序规则（时间戳序+后写覆盖+session 隔离）已定义；实测用例进 P1-1 验收。XML 块+人味分段共存：块内分段保护 delivered_blocks_text 记账（P2-1 验收已有）。空输入/超长输入：分段器有 max_length 回退（上游行为）。发现 1 项：wechat 50 字限制在 monika 通道分层协议下会造成「桌面长回复 vs 微信短回复」人格体感断裂→已记为已知偏差+跨端同档要求（P2-3 #5）。

**S5 代码质量**：新代码三个注入点均为薄层（读上下文注入/block 改写器/桥接插件），符合显式优于聪明的偏好。DRY：terminal 照 wechat 范式复制而非抽象——两通道即复制、三通道再抽象（避免过早抽象，有意决策）。上游文件改动最小化原则已入 P0-0。发现 0 新项（双声部已覆盖质量面）。

**S6 测试**：新测试面清单：L1 读注入（单测+双盲场景集成）、人味改写器（纯函数单测：分段/错字/引用映射/跳过富块 4 组）、terminal 桥（收发/崩溃恢复）、external_id 幂等（重复 settle 不重复）、纠错/遗忘语义（P2-3 #7）。ooc 12 场景回归=P1-2 既有。2am 信心测试=L1 双盲场景脚本；恶意 QA=并发双端同话题+坏 XML+超长输入；混沌=kill -9 memory_server 后恢复。上游无测试基建约束：新代码自带 pytest（qq 插件目录内），不依赖上游 test 框架。GAP：P1-1/P2-1 改动点需在 plan 里显式列测试文件名（已含在各工作流验收）。

**S7 性能**：每轮新增 1-2 次 loopback HTTP（recent_history 读+a-memorix 可选）——p99 <10ms 级，可忽略。人味打字延迟故意增加延迟（产品特性，calculate_typing_time 上限已由上游配置）。embedding 成本：a-memorix ingest 增量（若 UC1 保留）——进 P2-3 成本预算监控。发现 0 项超阈值。

**S8 可观测**：新增日志点已入 S2 表（全部 WARN 级以上）。监控指标：各通道每轮记忆注入命中数/延迟（P2-3 感知延迟实测即来自此）、token 各档消耗（P2-3 #6）。调试性：patch manifest 本身是可追溯性工具。发现 1 项：跨端记忆链路无 trace id——L1 修复时给每次读注入加 request_id 日志（轻量，并入 P1-1 改动点）。

**S9 部署**：a-memorix systemd user unit（P0-1 既有）；N.E.K.O 主进程启动不变；部署顺序=先 memory_server（已有）→a-memorix→主进程→插件；回滚=patch manifest 反向重放+禁用插件开关（qq_auto_reply 有启停，terminal 同）。feature flag：人味默认 off（已定）；L1 读注入无 flag（核心承诺本体）。冒烟：四端各发一条消息+切端一条。发现 0 新项。

**S10 长期轨迹**：可逆性评分 4/5（全部在 fork 分支可回退；唯一硬承诺=角色卡数据格式沿用 N.E.K.O schema——上游也在演进它，钉死版本下无风险）。技术债登记：上游分叉税（P0-0 显式管理）、monika 失效路径修复、wechat 50 字偏差。二期衔接：MVP 的角色卡数据化/记忆按角色参数化/external_id user 维度全部直接服务二期。发现 0 新项。

（S11 设计审查 SKIPPED——无 UI scope，dialog/component 命中均为 API 端点假阳性。）

### Phase 1 CEO — 必产出

**NOT in scope**（显式排除）：
- 多角色同台/后台社交/共享世界/affection 轴（宪章二期）
- TG/海外通道（OpenClaw 侧车，二期）
- NapCat 生命周期变更、WS 共会话改造（二期会话票证）
- A_memorix 降级 3.11 进程内（保留为回退路径，不预做）
- 上游已有限制的重构（catch-all 风格等，patch 边界外）

**What already exists**（子问题→现有代码）：
- 中心记忆服务：memory_server 全套 HTTP（cache/process/renew/settle/query_memory/new_dialog）——直接复用
- QQ 链路：qq_auto_reply 插件全栈——直接复用
- 微信链路：wechat_integration——复用+L1 修复
- 人格机制：persona_override.preset_id + ai_context.rename_events——直接复用
- 第二通道范式：wechat 的 new_dialog→LLM→/cache 闭环——范式复用（terminal）
- 记忆检索（若 UC1）：A_memorix 双路+PPR——拷贝复用
- 无需新建：事件总线（ZMQ 现成）、LLM 工厂（12 档现成）、插件 SDK（现成）

**Dream state delta**：见 0C。MVP 后距 12 月理想还差：多角色运行时（最大）、共享世界模型（从零）、affection 轴（从零）、L3 会话热推送、多用户。MVP 无一决策与理想态冲突。

**Failure Modes Registry**（CRITICAL GAP 判定后）：
```
CODEPATH                | FAILURE MODE        | RESCUED? | TEST? | USER SEES   | LOGGED?
每入口记忆读(新)         | 超时                | Y(设计补) | PLAN  | 无语境回复    | Y(WARN)
L2 事件链(若UC1)        | 无生产者→静默无索引  | Y(前置验证)| PLAN | 检索陈旧     | Y
a-memorix WAL           | kill -9 丢写        | Y(上游设计)| PLAN  | 无感        | Y
terminal REPL           | 崩溃                | Y(设计补) | PLAN  | 重连续聊     | Y
人味改写器              | 异常                | Y(设计补) | PLAN  | 原样消息     | Y(WARN)
```
修订后 0 个 CRITICAL GAP（全部有 rescue+test+log）；修订前 2 个（L1 读缺失、L2 假设）。

**Deferred to TODOS**（自动延后项）：
- a-memorix 上游季度 diff 巡检（依赖 UC1 裁决，P3）
- monika 失效绝对路径修复（P0-2 内含，不单列）

**Decision Audit Trail（Phase 1）**：
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|-----------|-----------|-----------|
| 1 | CEO | 新增 P0-0 分叉治理 | Mechanical | P2 湖泊 | 双模型共识，blast radius 内 <1d CC |
| 2 | CEO | P1-1 重写为 L1 修复版 | Mechanical | P1 完整 | Codex 代码证据：现有行为不满足 MVP 底线 |
| 3 | CEO | L2 前置验证事件生产者 | Mechanical | P6 前提 | stores 注册≠有生产者，验证免费 |
| 4 | CEO | 拆除 P2-1←P1-3 伪依赖 | Mechanical | P3 务实 | 无因果的依赖是图伪影 |
| 5 | CEO | 人味默认 off+A/B | Taste(Codex 单方) | P5 显式 | 体验未证前不设为必达 |
| 6 | CEO | P2-3 体验级验收+成本预算 | Mechanical | P1 完整 | 双模型共识：功能打勾≠体验 |
| 7 | CEO | 事实源唯一性原则 | Mechanical | P5 显式 | 双层竞争事实源是未定义行为 |
| 8 | CEO | external_id 加 user 维度 | Mechanical | P2 湖泊 | 近零成本对冲宪章 #6 |
| 9 | CEO | UC1 A_memorix 延后? | User Challenge | — | 双模型同向，用户裁决 |
| 10 | CEO | UC2 终端入口重定义? | User Challenge | — | 双模型同向，用户裁决 |
| 11 | CEO | wechat 50 字记为已知偏差 | Taste(Codex 单方) | P6 | 不改上游限制，显式记账 |

### Phase 2.5 DX — 双声部与审查记录

**Claude 子代理（DX 独立）**：4.75/10，approve_with_changes。6 发现（DX-1 零脚本零 runbook、DX-2 200+error body 反模式、DX-3 patch 重放无机械定义、DX-4 40 处散布桩=升级税放大器、DX-5 QQ 链路无 trace、DX-6 部署二选一悬置）+ 实地核对（neko-services 不存在、QQ 链路 20+ service、monika 文档腐烂先例）。第一人称排障叙事：定位 50 分钟修复 5 分钟、runbook 不存在。

**Codex（DX 外部）**：4.5/10，approve_with_changes。6 发现（唯一启动入口缺失/微信记忆读写静默吞异常 :730 证据/端点语义契约缺（cache-process-settle 不可互换+重复写入陷阱）/终端入口未定义进入方式/操作答案需多处拼接/数据升级无退路）+ TTHW 静态估（四端全通 45-120 分钟）。

**共识表**：
```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?         4/10    20-45m+ NO-CONFIRMED
  2. API/CLI naming guessable?        5/10    语义不安全 PARTIAL
  3. Error messages actionable?       4/10    静默吞失败 NO-CONFIRMED（最一致）
  4. Docs findable & complete?        5/10    多处拼接 PARTIAL
  5. Upgrade path safe?               4/10    数据无退路 NO-CONFIRMED
  6. Dev environment friction-free?   6/10    生命周期悬置 PARTIAL
```
4/6 CONFIRMED（方向一致）、2 PARTIAL、**0 DISAGREE**——无 taste 争议项，全部发现为机械采纳（纸面→实物），无新 User Challenge。

**开发者旅程 9 段摩擦摘要**：发现（根 CLAUDE.md 同类最佳）/评估（决策链完整但写给审查者非维护者）/安装（4 进程×2 venv×3 配置零编排）/hello world（桌面 30min 成熟，QQ 60-120min，终端 UC2 未决）/集成（memory_server 自声明非稳定契约）/调试（QQ 20+ service 无贯穿 id、静默降级不可见）/升级（重放无定义+40 桩散布）/扩展（wechat 范式可复制，HumanizeConfig 缺调参文档）/排障（无 runbook 无 doctor，定位 50min）。

**共情叙事结论**：最高频故障「QQ 不回复了」的当前排障路径 = launcher stdout 人肉滚屏；人味/记忆注入静默降级可能已死数周不可见。

**DX Scorecard（当前 → 修复后目标）**：Getting Started 4→7 ｜ API/CLI 5→7 ｜ Errors 4→7 ｜ Docs 5→7 ｜ Upgrade 4→7 ｜ Env 6→7 ｜ Community 5→5（上游依赖不可控）｜ Measurement 5→7（+token 汇总脚本）。总体 4.75 → 目标 7。

**TTHW**：当前四端全通 45-120 分钟（首装，NapCat/iLink 授权主导）→ 目标：首装 <90min、日常冷启动 <2min（systemd neko.target）、冒烟 <5min（smoke.sh 带断言）、排障 <15min（doctor+trace）、上游拉取 <2h（replay 脚本）。

**采纳清单（全部机械，P1/P5/P2）**：P0-0 追加 #5-#8（patch 机械定义/runbook+smoke+doctor 三件/systemd 裁决+Linux-only/数据升级退路+演练）；P0-1 #2 改注入式 shim（上游零修改）；P1-1 追加 1a 统一客户端封装（body status 检查）+1b 端点契约表；P2-1 追加 #5 QQ trace_id。Codex#4（终端进入方式/会话恢复/退出行为）并入 UC2 裁决材料。

**Deferred**：HumanizeConfig 调参文档（P3，随 P2-1 实装时写）；token 汇总脚本（半天，P2-3 实施时顺手）；neko-services paths.py 跨项目路径收敛（P3）。

<!-- autoplan-accepted:dx -->
- P0-0 验收含 patch 空跑重放证明 + runbook/smoke.sh/doctor.sh 三件实物 + systemd 裁决 + 数据升级退路演练。
- P0-1 宿主桩为注入式 shim（sys.modules 预注册），上游 125 文件零修改——验证=拷新上游树挂 shim 即可编译启动。
- P1-1 统一 memory_server 客户端封装（body status/ok 强制检查+失败四分类+request_id），单测覆盖 body-error 反模式。
- P1-1 端点契约表固化 cache/process/renew/settle 语义（副作用/幂等/重试条件/已接受-已持久化-已可检索三态）。
- P2-1 QQ 全链 trace_id 贯穿；排障验收 <15 分钟。
- TTHW 目标写入验收：首装 <90min / 冷启 <2min / 冒烟 <5min / 排障 <15min / replay <2h。
<!-- /autoplan-accepted:dx -->

**Decision Audit Trail（Phase 2.5 追加）**：
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|-----------|-----------|-----------|
| 12 | DX | runbook/smoke/doctor 三件实物进 P0-0 | Mechanical | P1 完整 | 双声部共识：纸面 DX 落地为可操作物 |
| 13 | DX | 客户端封装强制 body status 检查 | Mechanical | P1 完整 | 200+error 反模式是最隐蔽 rescue 失效 |
| 14 | DX | 端点契约表（cache/settle 语义） | Mechanical | P5 显式 | 不可互换操作无契约=误用必然 |
| 15 | DX | 桩改注入式 shim | Mechanical | P3 务实 | 升级税 O(40文件)→O(拷新树) |
| 16 | DX | systemd 裁决+Linux-only 声明 | Mechanical | P5 显式 | 悬置决策传染下游 |
| 17 | DX | QQ trace_id+doctor | Mechanical | P1 完整 | 最高频故障排障入口 |
| 18 | DX | 数据升级退路+回滚演练 | Mechanical | P1 完整 | 双层记忆的数据兼容无退路 |
| 19 | DX | 终端进入方式定义并入 UC2 | Taste | P6 | 裁决 UC2 时一并定义 |

### Phase 3 Eng — 双声部与审查记录

**Claude 子代理（Eng 独立）**：7 发现，approve_with_changes。抽查 12 处代码断言全部属实。发现：1(P1) 增量读取无机制支撑（/get_recent_history 渲染纯文本无游标→双重注入；修复=上游新端点未进 patch manifest）；2(P2) 依赖图未重画+P0-1 #6 systemd 残留矛盾；3(P2) 统一封装不含 QQ memory_bridge（8 处 raise_for_status 不查 body——rescue 可见性的前提）；4(P2) 跨端同档 vs wechat:568 硬编码 agent 档；5(P2) 上游有完整测试基建（pytest.ini/markers/CI）——S6 断言错误+patch 回归规则缺失；6(P2) shim 懒加载盲区（15 个 src.* 模块/异常类/pickle 迁移/identity 回查）；7(P3) NapCat 双管理器+Windows 死代码。

**Codex（Eng 外部）**：8 发现（5×P1+3×P2），reject（理由：独立通道会话缺少共享记忆的因果顺序契约）。发现：1(P1) 因果顺序不可执行（写入端点每次重新生成标识/recent.py 追加/timeindex 落库时刻）；2(P1) 角色级锁——结算持锁等摘要 LLM 阻塞其他入口秒级 /cache（5s 超时失败）；3(P1) 桌面活跃会话不接 L1（不重启不取记忆/recall 非每轮必读）；4(P1) persona_override 非通用挂载槽（replace/append 语义错用风险+QQ 继承检查点写错）；5(P1) 人味改写在投递决策之前——缓冲取消截断分段；6(P2) quote_previous→reply_to 不可直接实现；7(P2) delivered_blocks_text 非记账入口（正常/备用路径保存不同版本、错字进记忆）；8(P2) settle-hook 通知时机不解决近实时（wechat 清理懒触发）。

**共识表**：
```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude            Codex              Consensus
  1. Architecture sound?              P1缺口(增量端点)    P1缺口(因果契约/锁)  CONFIRMED-实质缺口
  2. Test coverage sufficient?        10行覆盖表多缺口    验收缺晚到/并发/取消  CONFIRMED-不足
  3. Performance risks addressed?     token双注入是真成本  锁阻塞=性能+正确性   PARTIAL(新发现)
  4. Security threats covered?        无新发现           无新发现            OK
  5. Error paths handled?             封装范围不含QQ      备用/正常路径版本分叉 CONFIRMED-有缺口
  6. Deployment risk manageable?      NapCat双管理器P3    未提新问题          PARTIAL
```
5/6 有共识（4 CONFIRMED+1 PARTIAL），0 DISAGREE。**跨阶段主题（本次 Final Gate 材料）**：CEO reject 理由（L1 不成立）与 Eng reject 理由（因果契约缺失）同根——「共享记忆的跨通道一致性」是产品地基，三轮审查持续加码。已升级为 **UC3 用户挑战**。

**Eng 审查自动采纳清单**（全部机械，P1 完整/P5 显式）：
- 依赖图重画（本轮已做）+ P0-1 #6「或 launcher」残留删除（随 UC1 裁决一并清理）
- P1-1 追加 1a-1 增量端点（进 patch manifest）+ UC3 裁决块（1a-2/1a-3/1a-4 完整 vs 最小可行）+ 必做验收（晚到/并发锁期读写/重复提交）
- P1-2 挂载机制修正（附加模块走 append、完整人设走 replace、四情形断言、QQ 检查点改 :408）+ OOC 12 场景人味 on 双跑
- P2-1 位置修正（共用最终投递入口）+ 草稿/已发送分离 + quote 内部关系+回执解析 + 记账语义分离（错字不进记忆）
- 统一封装迁移范围明确 = wechat 三 helper + terminal（新）+ **memory_bridge 8 处**（Claude 发现 3）
- wechat 换 conversation 档进 P1-1 改动点（贴跨端同档；300 token 上限与成本进 P2-3 #6 预算）
- S6 测试基建修正：上游有 pytest.ini（unit/plugin_unit/plugin_integration/plugin_e2e markers+randomly 钉 seed）——插件内新测试打 plugin 标记复用上游 conftest；neko-services 自建 pytest。**patch 回归规则固化三条**：①改 patches/neko/*.patch → 重放后 `pytest -m plugin_unit,plugin_integration`+smoke 全绿；②涉及 reply_pipeline/delivery → 必带 delivered 记账测试；③涉及 memory 端点 → 契约表测试同步更新否则拒绝重放
- shim 验收追加三件：import-sweep（pkgutil 全树逐模块 import）、legacy pickle 迁移 fixture 测试、identity 回查失败降级（person_alias 置空+WARN 不阻塞）
- NapCat 归属裁决：保持插件托管（sweep 重连）、不设独立 unit；systemd unit 加 After=/健康探测；stdout 接日志文件供 doctor；删 Windows creationflags 死代码（进 manifest）
- Codex#8：近实时通知改为「cache 提交后登记可重试持久通知（提交序号驱动）」；settle 只管摘要派生——进 UC1 裁决材料（若 UC1-B 延后则此项自动消失）

<!-- autoplan-accepted:eng -->
- 增量读取端点 GET /recent_history/{name}?since_seq=（JSON+游标+水位去重）进 patch manifest；同轮不重复注入有自动化断言。
- UC3 两档（完整契约 vs 最小可行）待 Final Gate；必做项不受裁决影响：端点+去重、锁期并发读写验收、晚到/重复提交验收用例。
- P1-2 挂载：附加模块 append / 完整人设 replace / 四情形断言；QQ 继承检查点 = session_instruction_service:408。
- P2-1：改写在共用最终投递入口；草稿/已发送分离；quote 内部关系+回执解析+降级；事实提取消费原始语义正文、提及计数用送达文本。
- 统一封装迁移范围含 memory_bridge 8 处；wechat 换 conversation 档。
- patch 回归规则三条固化；shim 三件验收；NapCat 插件托管裁决+日志接文件。
- 测试放置：插件内打 plugin_* 标记复用上游基建；neko-services 自建。
<!-- /autoplan-accepted:eng -->

**Decision Audit Trail（Phase 3 追加）**：
| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|-----------|-----------|-----------|
| 20 | Eng | 增量端点+去重进 P1-1 必做 | Mechanical | P1 完整 | 双声部独立发现同一缺口 |
| 21 | Eng | UC3 一致性契约深度 | User Challenge | — | 双模型 P1×4 合并，工作量 3 倍，用户裁决 |
| 22 | Eng | P2-1 位置/quote/记账三修正 | Mechanical | P1 完整 | Codex 行号证据 |
| 23 | Eng | 封装范围+memory_bridge 8 处 | Mechanical | P4 DRY | 两套失败语义共存=封装失效 |
| 24 | Eng | wechat 换 conversation 档 | Taste | P5 | 贴宪章跨端同档；成本进预算 |
| 25 | Eng | 测试基建修正+回归三规则 | Mechanical | P1 完整 | S6 事实错误必须纠正 |
| 26 | Eng | shim 三件验收追加 | Mechanical | P1 完整 | 启动面≠懒加载面 |
| 27 | Eng | NapCat 插件托管+日志文件 | Mechanical | P3 务实 | 避免双管理器 |
| 28 | Eng | 近实时通知改提交序号驱动 | Taste | P6 | 并入 UC1 材料 |

### Phase 4 Final Gate — 用户裁决（2026-09-19）

| UC | 裁决 | 生效动作 |
|---|---|---|
| UC1 A_memorix 延后？ | **保留原计划**（双模型延后建议被否） | P0-1 维持 MVP 关键路径不变；P1-1 #3/#4（读融合/写钩子/L2）转正为必做；L2 生产者验证仍前置 |
| UC2 终端形态？ | **opencode 寄生**（用户自定义，非三备选之一） | P1-3 重写：terminal_bridge 插件取消 → opencode 接入层（monika 三件套装入 opencode agent 配置/AGENTS.md + tool 或 shell 调 memory_server HTTP：query_memory/new_dialog//cache）；实施前先调研 opencode 扩展点（agent/tool/plugin 机制）；P2-3 #1 验收含 opencode 入口；四端=桌面/QQ/微信/opencode |
| UC3 一致性契约深度？ | **完整契约**（12-20 人日） | P1-1 的 1a-2（因果顺序契约：通道/会话/稳定轮次标识+版本检查+替代关系）、1a-3（摘要移出角色级锁临界区：快照计算+版本校验提交）、1a-4（桌面回复前版本检查+增量注入，改 lifecycle/streaming）全部转正为必做——宪章 #7「QQ 说完桌面当下就知道」按最强档兑现；三项进 patch manifest；验收含「摘要执行期间另一入口持续读写」「旧回合晚到/时间相同/重复提交」 |

**总裁决**：APPROVED（B2 路径，三项挑战全部裁决，25 项自动采纳 + 3 项用户裁决）。MVP 工作量估算更新：原计划 + UC3 完整契约（+12-20 人日）- UC2 插件开发（-2-3 人日）+ opencode 调研（+1-2 人日）。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/autoplan` Phase 1 | Scope & strategy | 1 | issues_open→resolved | 2 proposals 裁决（UC1 保留/UC2 opencode），11 决策 |
| Outside Review | Codex (CEO/DX/Eng) | Independent 2nd opinion | 3 | completed ×3 | 7+6+8 findings，2 次 reject 均已修复或裁决 |
| Eng Review | `/autoplan` Phase 3 | Architecture & tests (required) | 1 | issues_open→resolved | 15 issues（3 P1 合并为 UC3 完整契约），测试计划落盘 |
| Design Review | — | UI/UX gaps | 0 | skipped | 无 UI scope |
| DX Review | `/autoplan` Phase 2.5 | Developer experience | 1 | issues_open→resolved | 4.75/10→目标 7，8 项采纳 |

- **OUTSIDE COVERAGE:** Codex completed ×3 phases（CEO reject→修复；DX approve_with_changes；Eng reject→UC3 裁决）；Claude subagent completed ×3（CEO/DX/Eng 各自独立发现，与 Codex 三处独立会合）。
- **CROSS-MODEL:** Claude 与 Codex 在三轮中零 disagree；独立会合点：A_memorix 排序（CEO）、静默失败可见性（DX）、跨通道一致性（CEO+Eng）——均升级处理完毕。
- **VERDICT:** CEO + DX + ENG CLEARED（三项 UC 经用户裁决闭合）— ready to implement。

NO UNRESOLVED DECISIONS
