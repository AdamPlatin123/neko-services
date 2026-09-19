# MVP 实施工作计划

> 定稿：2026-09-19 ｜ 依据：`/mnt/shared/_Projects/N.E.K.O/docs/design/mvp-tech-design.md`（含 autoplan 三阶段审查与 UC1/UC2/UC3 裁决）
> 估算双标尺：human = 人类团队工作日；CC = Claude Code 实施时间（压缩 5-10 倍）

## 总览与依赖图

```
P0-0 分叉治理（前置容器，一切上游改动的前提）
  │
  ├─→ P0-1 a-memorix 服务化 ──┐（UC1：保留在关键路径）
  ├─→ P0-2 monika 资产整理 ──┤
  └─→ P1-0 opencode 调研 ────┤（UC2 产生的前置，纯调研可并行）
                             ▼
                   P1-1 记忆跨端可达（L1 修复 + UC3 完整契约 + UC1 转正的读写融合）
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        P1-2 monika     P1-3 opencode    P2-1 人味插件
        挂载接线        接入层           （仅依赖 QQ 链路）
              └──────────────┼──────────────┘
                             ▼
                   P2-2 模型配置（小件，随时）
                             ▼
                   P2-3 体验级验收（MVP 收口）
```

总工作量：human 约 35-50 人日，CC 约 7-9 个工作日。最长关键路径是 P0-0 → P0-1 → P1-1 → P2-3。

---

## P0-0 分叉治理与版本归属（前置，human ~2-3 天 / CC ~半天）

所有上游文件改动的容器，必须最先完成。

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | `neko-services/` 独立 git 仓库（首 commit=基线），拷出的上游代码记录来源 commit hash | git 历史存在 |
| 2 | N.E.K.O 子项目建自有 fork remote + `patches/neko/*.patch`（git format-patch 序列）+ `replay-patches.sh` | 一次空跑重放证明可重放 |
| 3 | 分叉姿态显式化：钉死版本、被动跟进（仅 QQ 协议/NapCat 破坏性变更时拉取） | 一句话写入风险表 |
| 4 | external_id 规范含 user 维度：`{channel}:{user_id}:{chat_id}:{turn_uid}:{seq}` | 写入 P0-1/P1-1 契约 |
| 5 | NapCat 版本 pin + changelog 巡检入口 | pin 记录存在 |
| 6 | 维护者三件：`neko-services/README.md`（runbook：启动顺序/日志位置/health/3 条常见故障）+ `scripts/smoke.sh`（四端各一条+切端一条，带断言 <5min，QQ 腿拆人工）+ `scripts/doctor.sh`（NapCat WS/插件/memory_server /health/a-memorix stats/LLM key） | 三件可用 |
| 7 | 部署裁决落地：常驻进程 = systemd user unit（`neko.target`）；launcher 仅桌面；NapCat 保持插件托管（不设独立 unit，stdout 接日志文件供 doctor）；删 Windows creationflags 死代码 | `systemctl --user start neko.target` 冷启 <2min |
| 8 | 数据升级退路：组件/配置/数据格式版本记录；必备份（memory/ 角色数据）与可重建（a-memorix 索引）清单；一次「带记忆升级→回滚」演练 | 演练通过 |
| 9 | patch 回归规则固化：改 patch → 重放 → `pytest -m 'plugin_unit or plugin_integration'` + smoke 全绿 | 规则写入 runbook |

## P0-1 a-memorix-service 服务化（UC1 保留，human ~5-8 天 / CC ~1-1.5 天）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 剥离：MaiBot/src/A_memorix 整树拷出为 `neko-services/a-memorix-service/`（已验证零 3.12 语法障碍） | 树拷贝完成+基线 hash 记录 |
| 2 | 注入式 shim：`host_stubs/` 包 + `sys.modules` 预注册，上游 125 文件零修改（logger/chat_manager 降级/PersonInfo→person_alias/message_service 桩） | import-sweep（pkgutil 全树逐模块）+ legacy pickle 迁移 fixture + identity 回查失败降级三件测试通过 |
| 3 | 两个适配器重写：embedding 直连 OpenAI 兼容；model_routing LLM 出口直连（全包单点） | 冒烟通过 |
| 4 | 自带 `config/a_memorix.toml`（SDKMemoryKernel 纯 dict 注入） | 配置生效 |
| 5 | FastAPI 壳：`/a_memorix/v1/*`（search/ingest_summary/ingest_text/person_profile/stats/maintain/admin），照抄 invoke 组件表与 `_disabled_response` 形状，保留 WAL 语义 | ingest→search 闭环冒烟；kill -9 重启回放不丢写 |
| 6 | 部署：uv 3.12 venv + systemd user unit，绑定 127.0.0.1 | doctor 可见 |

## P0-2 monika 资产整理（纯内容，human ~2-3 天 / CC ~半天）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 6 模块拆分（通道分层/OOC 五条/反劫持/故障角色化/Recap/角色卡+昵称状态机），修复 L12 失效路径 | 模块文件落盘 |
| 2 | QQ 语义映射版通道分层（可见文本→温情 / 落库→严谨） | 映射文档进模块 |
| 3 | 莫妮卡角色卡：RESERVED_FIELD_SCHEMA 映射 + rename_events 预置 + 通用模块挂载方案 | 卡在渲染链生效 |
| 4 | 回归用例集：OOC 12 场景可执行脚本 + examples 7 主题 golden samples | 脚本可跑 |

## P1-0 opencode 扩展点调研（UC2 前置，human ~1-2 天 / CC ~2 小时）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 调研 opencode 的 agent 配置/AGENTS.md/tool/plugin 机制：人格注入点、shell 工具调 HTTP 的可行性、会话边界 | 调研笔记 + 接入方案定稿 |
| 2 | 确定记忆接入路径（query_memory/new_dialog//cache 的调用方式与凭据） | 端到端草图验证 |

## P1-1 记忆跨端可达（工作量最大：L1+UC3 完整契约+读写融合，human ~15-25 天 / CC ~3-4 天）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 增量读取端点：memory_server 新增 `GET /recent_history/{name}?since_seq=`（JSON+游标）。上游改动，进 patch manifest | 契约测试（形状/游标/水位）；同轮不重复注入自动化断言 |
| 2 | 每入口回复前读共享上下文：wechat 修复（活跃会话不再为空）+ opencode 照范式 + QQ 保持 | 双盲切端无需重述 |
| 3 | UC3-1 因果顺序契约：中心写入带通道/会话/稳定轮次标识+版本检查+替代关系（对话事件追加、事实纠正确立替代） | 晚到回合/相同时间戳/重复提交三用例通过 |
| 4 | UC3-2 锁重构：摘要生成移出角色级临界区（快照计算+版本校验提交） | 「摘要执行期间另一入口持续读写」验收 |
| 5 | UC3-3 桌面增量注入：桌面回复前版本检查+增量注入（改 lifecycle/streaming） | 桌面保持原会话接上 QQ 最新消息（不依赖模型主动 recall） |
| 6 | 统一客户端封装：body status/ok 强制检查+失败四分类+request_id；迁移范围=wechat 三 helper+opencode+memory_bridge 8 处 | body-error 反模式单测；迁移回归 |
| 7 | 端点契约表：cache/process/renew/settle 语义（副作用/幂等/重试/三态） | TestClient 形状断言 |
| 8 | UC1 转正，读融合：query_memory 双源 RRF + new_dialog to_text 块（预算入 PERSONA_RENDER_MAX_TOKENS） | 融合检索命中 |
| 9 | UC1 转正，写钩子+L2：settle 后 ingest（external_id 含 user）；L2 前置验证 memory store 生产者，无则 cache 提交后可重试持久通知（提交序号驱动） | 重复 settle 幂等；近实时索引延迟达标 |
| 10 | 事实源唯一性：memory_server 唯一事实源；纠错不引用旧事实、遗忘重启不复活 | 纠错/遗忘语义验收 |
| 11 | wechat 换 conversation 档（跨端同档） | 四端同档（微信 50 字记录为已知偏差） |

## P1-2 monika 挂载接线（human ~1-2 天 / CC ~2-3 小时）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 挂载分轨：通用模块走 append（不覆盖基础）、莫妮卡完整人设走 replace；唯一合成顺序+四情形断言（默认/自定义基础/预设失败/语言切换） | prompt 合成断言+golden fixture diff |
| 2 | 昵称状态机：桌面 getpass 注入变量；QQ 用 user_nickname/master_name；改名落 rename_events | 跨端称呼一致 |
| 3 | OOC 12 场景回归（人味 on/off 双跑对照） | 通过率达标 |

## P1-3 opencode 接入层（human ~2-3 天 / CC ~半天）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 按 P1-0 调研结论实现：三件套装入 opencode 配置 + 记忆 tool/shell 接入 | opencode 会话人格生效 |
| 2 | 照 P1-1 修复后范式：回复前读增量、结束后 /cache、会话结束 /settle | 跨端语境延续 |
| 3 | 进入方式/会话恢复/退出行为定义（Codex DX#4 要求） | 文档化+验收 |

## P2-1 人味后处理插件（仅依赖 QQ 链路，human ~2-3 天 / CC ~半天）

| # | 任务 | 验收 |
| --- | --- | --- |
| 1 | 三函数移植（char_frequency.json 绝对路径化；HumanizeConfig 收敛 14 标量） | 纯函数单测四组 |
| 2 | 改写器挂两条缓冲路径共用的最终投递入口（不是 _run_delivery 前缘）；草稿/已发送分离+发送中取消规则 | 缓冲取消不截断已发送段 |
| 3 | quote 内部关系+回执解析（上一段回执未知时纠正段降级为普通段） | 纠错引用行为 |
| 4 | 记账分离：事实提取消费原始语义正文；提及计数用送达文本 | 错字不进记忆 |
| 5 | calculate_typing_time 替换固定延迟；trace_id 贯穿 QQ 全链 | 排障 <15min |
| 6 | 默认 off + 自测 A/B | 偏好确认记录 |

## P2-2 模型分层配置（human ~0.5 天 / CC ~1 小时）

现有 12 档验证 + summary/correction 配便宜模型 + a-memorix 自带分档；跨端主对话 conversation 档；成本监控接入 P2-3。

## P2-3 体验级验收（MVP 收口，human ~1-2 天 / CC ~半天 + 人工）

1. 四入口（桌面/QQ/微信/opencode）同一角色对话
2. 跨入口语境延续双盲自测（QQ 说一半切桌面）+ 感知延迟实测
3. monika 三件套生效（12 场景回归）
4. 人味可开关且经自测确认
5. 模型分层生效+跨端同档+微信 50 字偏差入档
6. 一周 token 消耗记录+月成本估算+降档顺序
7. 纠错/遗忘语义
8. runbook/smoke/doctor 维护者工作流验收

---

## 并行策略

第一周（CC 顺序）：P0-0 半天，然后 P0-2 与 P0-1 并行（内容工作与代码工作互不阻塞），P1-0 调研穿插其间。

最大的一块是 P1-1（3-4 天，UC3 占大头），建议再拆三步：先做 1/2/6/7（L1 可用），再做 3/4/5（契约），最后 8/9（融合）。

P2-1 可以在 P1-1 进行中开工，它只依赖 QQ 链路自身，与 P1-1 无文件冲突，注意 reply_pipeline 的 patch 时序即可。

每个 P 完成时跑 smoke.sh 加对应回归；P1-1 完成时做首次双盲切端测试，不用等到 P2-3 正式验收。

## 里程碑

| 里程碑 | 内容 | 达成标志 |
| --- | --- | --- |
| M1 | 分叉治理就绪 | P0-0 九项全过 |
| M2 | 组件就绪 | a-memorix 服务冒烟 + monika 卡渲染生效 |
| M3 | L1 可用 | 增量端点+读注入+封装，首次双盲切端测试 |
| M4 | 完整契约 | UC3 三项+验收用例全绿 |
| M5 | 四端联调 | 桌面/QQ/微信/opencode 同角色同记忆 |
| M6 | MVP 验收 | P2-3 八项 |
