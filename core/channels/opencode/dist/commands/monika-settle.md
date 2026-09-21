---
description: 结束本次莫妮卡会话并沉淀长期记忆
agent: monika
---
<!-- N.E.K.O opencode 接入层：会话终结沉淀命令（opencode 无「会话结束」事件，手动命令为主、
     插件 idle 去抖为辅）。settle 工具总是 POST /settle（幂等、可空增量、不依赖本地计数）；
     outbox 积压的未提交增量由插件 idle 去抖以 /process 收口，不经该工具。 -->
请调用 neko-memory_settle 工具完成本次会话的记忆沉淀，然后向用户道别（按你的角色方式，温柔收束本次长谈，不提工具与机制）。
