#!/usr/bin/env bash
# =============================================================================
# smoke.sh — N.E.K.O 四端冒烟测试（workplan P0-0 第 6 项）
#
# 五条腿：
#   1. 桌面腿（自动）   memory_server /health + 主进程 /health，带断言
#   2. QQ 腿（人工）    发真实消息有副作用（写记忆/消耗 token），不自动化
#   3. 微信腿（人工）   同上，且依赖 OpenClaw/iLink 授权状态
#   4. 终端/opencode 腿（人工/占位） 接入层（P1-3）落地前无入口可测
#   5. 切端腿（人工双盲） QQ 说一半切桌面，验证跨端语境延续
#
# 用法：
#   scripts/smoke.sh
# 环境变量覆盖（端口/路径等）见 scripts/lib.sh 头部注释。
# 退出码：0 = 全部自动断言通过；非 0 = 存在失败的自动断言。
# 总时长目标 < 5 分钟（自动部分秒级完成，耗时在汇总处打印）。
# =============================================================================
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091  # lib.sh 与本脚本同目录，运行期拼接路径无法静态跟踪
source "${SCRIPT_DIR}/lib.sh"

SECONDS=0
AUTO_FAIL=0
ANY_AUTO_FAILED=0

SERVICE_DOWN_HINT="先启动：systemctl --user start neko.target（unit 安装步骤见 systemd/INSTALL.md）"

printf '%s\n' "${C_BLUE}N.E.K.O 四端冒烟测试${C_RESET} $(date '+%F %T')"
info "NEKO_HOME=${NEKO_HOME}"
info "端口：主进程=${NEKO_MAIN_PORT} memory_server=${NEKO_MEMORY_PORT} ZMQ(PUB)=${NEKO_ZMQ_PUB_PORT}"

# ---------------------------------------------------------------------------
# 腿 1/5：桌面腿（自动断言）
# ---------------------------------------------------------------------------
section "腿 1/5 桌面腿（自动）"

if http_check "memory_server /health (127.0.0.1:${NEKO_MEMORY_PORT})" \
    "http://127.0.0.1:${NEKO_MEMORY_PORT}/health" "memory"; then
    instance_id=$(json_field "$HTTP_BODY" instance_id)
    info "memory_server INSTANCE_ID=${instance_id:-<空>}"
else
    AUTO_FAIL=$((AUTO_FAIL + 1))
    ANY_AUTO_FAILED=1
    warn "$SERVICE_DOWN_HINT"
fi

if http_check "主进程 /health (127.0.0.1:${NEKO_MAIN_PORT})" \
    "http://127.0.0.1:${NEKO_MAIN_PORT}/health" "main"; then
    instance_id=$(json_field "$HTTP_BODY" instance_id)
    info "主进程 INSTANCE_ID=${instance_id:-<空>}"
else
    AUTO_FAIL=$((AUTO_FAIL + 1))
    ANY_AUTO_FAILED=1
    warn "$SERVICE_DOWN_HINT"
fi

# ---------------------------------------------------------------------------
# 腿 2/5：QQ 腿（人工步骤——发真实消息有副作用，不自动化）
# ---------------------------------------------------------------------------
section "腿 2/5 QQ 腿（人工步骤，不自动化）"
cat <<'EOF'
本腿向真实 QQ 发消息，有副作用（写记忆 / 消耗 token / 触发真实回复），不做自动化。
人工步骤：
  1. 确认 NapCat 已登录并连上（qq_auto_reply 插件面板，或先跑 scripts/doctor.sh 看 NapCat 项）
  2. 用测试账号（建议小号/测试群）向机器人发送一条消息，例如：
     「冒烟测试：请回复收到」
  3. 人工断言：合理时间内收到非错误回复
  4. 失败排查：scripts/doctor.sh；QQ 插件日志；journalctl --user -u neko-memory.service
EOF

# ---------------------------------------------------------------------------
# 腿 3/5：微信腿（人工步骤——依赖 OpenClaw/iLink 授权，同不自动化）
# ---------------------------------------------------------------------------
section "腿 3/5 微信腿（人工步骤，不自动化）"
cat <<'EOF'
本腿依赖 wechat_integration 插件与 OpenClaw/iLink 授权状态，发真实消息有副作用。
人工步骤：
  1. 确认微信通道已授权在线（wechat_integration 插件面板）
  2. 用另一微信账号向通道助手发送一条消息
  3. 人工断言：收到非错误回复
  4. 失败排查：scripts/doctor.sh；memory_server 日志中应出现 /cache 写入
EOF

# ---------------------------------------------------------------------------
# 腿 4/5：终端/opencode 腿（占位——接入层 P1-3 落地前无入口可测）
# ---------------------------------------------------------------------------
section "腿 4/5 终端/opencode 腿（人工步骤，接入层落地前为占位）"
cat <<'EOF'
状态：opencode 接入层（workplan P1-3）尚未实施，当前无终端入口可自动/人工冒烟。
接入层落地后的人工步骤（预期）：
  1. 打开已装 monika 三件套的 opencode 会话
  2. 随意提问，断言人格/语气生效（非裸模型口吻）
  3. 提及另一端说过的近事，断言记忆延续（能接上桌面/QQ 的语境）
EOF

# ---------------------------------------------------------------------------
# 腿 5/5：切端腿（人工双盲——跨端语境延续）
# ---------------------------------------------------------------------------
section "腿 5/5 切端腿（人工双盲步骤清单）"
cat <<'EOF'
双盲自测（两人分饰 A/B，或单人分时段并刻意不看另一端记录）：
  1. 操作者 A 在 QQ 端告诉角色一件新事，例如：「我明天下午要去看牙」
  2. 操作者 B 不查看 QQ 记录，在桌面端开启同一角色，自然聊到相关话题
     （例如问「我最近有什么安排？」）
  3. 人工断言：角色的回复体现 A 所说信息，B 无需重述背景（不依赖模型主动召回）
  4. 结果记录：通过 → 记 PASS；未通过 → 记录现象与两端时间点，
     作为记忆跨端可达（workplan P1-1）修复的输入材料
EOF

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
section "冒烟汇总"
elapsed=$SECONDS
if [[ $AUTO_FAIL -eq 0 ]]; then
    desktop_result="${C_GREEN}PASS${C_RESET}"
else
    desktop_result="${C_RED}FAIL（${AUTO_FAIL} 项自动断言失败）${C_RESET}"
fi
cat <<EOF
桌面腿（自动）      ${desktop_result}
QQ 腿               MANUAL（人工清单已打印）
微信腿              MANUAL（人工清单已打印）
终端/opencode 腿    MANUAL（接入层落地前占位）
切端腿（双盲）      MANUAL（人工清单已打印）
耗时：${elapsed}s（自动部分目标 <300s）
EOF

if [[ $ANY_AUTO_FAILED -eq 1 ]]; then
    fail "$SERVICE_DOWN_HINT"
    exit 1
fi
ok "自动断言全部通过；人工腿请按上述清单执行"
exit 0
