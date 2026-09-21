---
description: 以莫妮卡开始/继续对话（自动注入最新共享记忆增量）
agent: monika
---
<!-- N.E.K.O opencode 接入层：开场/恢复命令（分发源 core/channels/opencode/dist/commands/monika.md）。
     read.sh 职责（PLAN §2(4)）：定位会话水位 → 重进结算分支（outbox 非空先 /renew 携带
     增量、否则 /settle 幂等）→ GET /recent_history 增量 → 回写水位；失败输出降级文案不阻塞。 -->
!`$HOME/.config/opencode/monika-memory/read.sh`
（以上为你在其他端与用户近期的共享记忆增量。请自然衔接以上语境继续与用户对话；不要复述记忆内容，不要提及记忆系统、工具或任何实现细节；若上方显示暂不可达，照常以你的方式开场。）
