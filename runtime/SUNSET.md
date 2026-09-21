# runtime/ 退役路线（SUNSET）

> 定位声明：runtime/ 是 N.E.K.O 上游的桥接层，**不是终态**。终态方向是
> core/ 组件独立演进 + 记忆服务自有化，N.E.K.O 逐步退化为可选运行时直至移除。

## 治理规则

1. **补丁数单调不增**：新增上游能力优先在 core/ 或独立服务实现；
   只有必须改 N.E.K.O 内部时才加补丁，且需在下方映射表登记去向。
2. **每次新增补丁必须回答**：这个能力什么时候能搬出上游？
3. **契约单一事实源**：任何触碰 memory 端点的补丁，**同一 commit** 必须更新
   `core/memory-client/neko_mem_client/contract.py`（客户端契约表）与
   `core/memory-client/tests/test_contract.py`。补丁不得逆向定义契约。

## 补丁迁移映射（13 → 0）

| 补丁 | 内容 | 去向 |
| --- | --- | --- |
| 001 增量端点 | recent_history 游标 | 记忆服务自有化时并入 core 记忆服务 |
| 002 wechat 注入 | 每轮读增量 | 通道适配独立（wechat 适配器脱离插件体系时收编） |
| 003 挂载分轨 | persona mount_mode | core/persona 自带组装器后废弃 |
| 004 桌面环境注入 | getpass 变量 | 同上（并入 persona 组装） |
| 005 人味管线 | 三纯函数 | 已是独立函数集 → 可直接迁 core/humanize |
| 006 墓碑 | — | 永久保留（序号连续性） |
| 007 因果契约 | turn_uid 幂等 | 记忆服务自有化时并入 |
| 008 锁重构 | 摘要出临界区 | 记忆服务自有化时并入 |
| 009 读融合 | query_memory RRF | 记忆服务自有化时并入 |
| 010 桌面注入 | stream_text 回调 | 桌面会话自有化（companion WS 客户端成熟）后评估 |
| 011 写钩子 | settle→a-memorix | 并入记忆服务写路径 |
| 012 wechat 换档 | conversation 档 | 通道适配独立时收编 |
| 013 QQ 官方修复 | intents/msg_seq/ark | QQ 适配器脱离插件体系时收编 |

## 下线红线

- 记忆服务自有化完成（007/008/009/011 迁出）→ N.E.K.O memory_server 可降级为只读兼容层
- 全部通道适配独立（002/012/013）→ N.E.K.O 插件体系可整体移除
- 那时 runtime/ 目录清空，仓库只剩 core/ + services/ + desktop-app/
