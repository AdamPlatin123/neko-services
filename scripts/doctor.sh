#!/usr/bin/env bash
# =============================================================================
# doctor.sh — N.E.K.O 一键体检（workplan P0-0 第 6 项）
#
# 检查项（输出 ✅[OK] / ❌[FAIL] / ⚠️[WARN] / ⏭️[SKIP]，文本标签便于 grep）：
#   1. memory_server /health（含 INSTANCE_ID 打印）           [核心项]
#   2. 主进程 48911 /health 探活                               [核心项]
#   3. ZMQ PUB 38866 可达性（zmq 探测→TCP 降级）               [核心项]
#   4. NapCat 状态（提示性：目录/日志文件存在性）              [提示项]
#   5. LLM key 有效性（读环境变量，未设置则 SKIP 提示人工）     [提示项]
#   6. a-memorix /a_memorix/v1/stats（P0-1 服务化后生效，       [提示项]
#      当前 404/拒连时 SKIP）
#
# 退出码：核心项（1-3）全部通过 = 0；任一核心项失败 = 1。
# 提示项失败不影响退出码，仅给出排障线索。
# 环境变量覆盖（除 lib.sh 通用项外）：
#   NEKO_LLM_BASE_URL  OpenAI 兼容端点（如 https://api.example.com/v1）
#   NEKO_LLM_API_KEY   对应 API key（Bearer）
#   NEKO_AMEMORIX_URL  a-memorix 服务地址（默认 http://127.0.0.1:48921）
# =============================================================================
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091  # lib.sh 与本脚本同目录，运行期拼接路径无法静态跟踪
source "${SCRIPT_DIR}/lib.sh"

CORE_FAIL=0
SERVICE_DOWN_HINT="先启动：systemctl --user start neko.target（main/memory/agent 三件套；与桌面 launcher 二选一，勿同时。安装见 systemd/INSTALL.md）"

printf '%s\n' "${C_BLUE}N.E.K.O 一键体检${C_RESET} $(date '+%F %T')"
info "NEKO_HOME=${NEKO_HOME}"

# ---------------------------------------------------------------------------
# 1. memory_server /health
# ---------------------------------------------------------------------------
section "1/6 memory_server /health（核心项）"
if http_check "memory_server (127.0.0.1:${NEKO_MEMORY_PORT})" \
    "http://127.0.0.1:${NEKO_MEMORY_PORT}/health" "memory"; then
    instance_id=$(json_field "$HTTP_BODY" instance_id) || instance_id=""
    ok "INSTANCE_ID=${instance_id:-<空>}"
else
    CORE_FAIL=$((CORE_FAIL + 1))
    warn "$SERVICE_DOWN_HINT"
fi

# ---------------------------------------------------------------------------
# 2. 主进程 /health
# ---------------------------------------------------------------------------
section "2/6 主进程 /health（核心项）"
if http_check "主进程 (127.0.0.1:${NEKO_MAIN_PORT})" \
    "http://127.0.0.1:${NEKO_MAIN_PORT}/health" "main"; then
    instance_id=$(json_field "$HTTP_BODY" instance_id) || instance_id=""
    ok "INSTANCE_ID=${instance_id:-<空>}"
else
    CORE_FAIL=$((CORE_FAIL + 1))
    warn "先启动三件套：systemctl --user start neko.target（main/memory/agent 三 unit），或桌面 launcher（uv run launcher.py）——二选一，勿同时（部分占用端口会触发 launcher 换端口另起第二套）"
fi

# ---------------------------------------------------------------------------
# 3. ZMQ PUB 38866 可达性
# ---------------------------------------------------------------------------
section "3/6 ZMQ PUB ${NEKO_ZMQ_PUB_PORT} 可达性（核心项）"
zmq_probe_rc=0
probe_out=$(zmq_pub_probe "127.0.0.1" "${NEKO_ZMQ_PUB_PORT}" 1500) || zmq_probe_rc=$?
case $zmq_probe_rc in
    0)
        ok "ZMQ SUB 已连上 ${NEKO_ZMQ_PUB_PORT} 且窗口内收到消息（${probe_out%%$'\n'*}）"
        ;;
    1)
        # PUB/SUB 的 connect 是异步排队的，永远「成功」——rc=1 不能区分
        # 「端口存在但静默」与「端口不存在」，必须 TCP 层兜底判定
        if tcp_port_open "127.0.0.1" "${NEKO_ZMQ_PUB_PORT}" 3; then
            ok "TCP ${NEKO_ZMQ_PUB_PORT} 监听正常（ZMQ SUB 已连上但等待窗口内无消息——PUB 无订阅者重发机制，静默属正常）"
        else
            fail "TCP ${NEKO_ZMQ_PUB_PORT} 不可达（消息面未启动）"
            CORE_FAIL=$((CORE_FAIL + 1))
        fi
        ;;
    3)
        # pyzmq 不可用：降级 TCP 探测
        if tcp_port_open "127.0.0.1" "${NEKO_ZMQ_PUB_PORT}" 3; then
            ok "TCP ${NEKO_ZMQ_PUB_PORT} 可达（pyzmq 不可用，已降级为 TCP 探测；仅确认端口监听，未验证消息流）"
        else
            fail "TCP ${NEKO_ZMQ_PUB_PORT} 不可达（消息面未启动）"
            CORE_FAIL=$((CORE_FAIL + 1))
        fi
        ;;
    *)
        fail "ZMQ PUB ${NEKO_ZMQ_PUB_PORT} 连接失败（消息面未启动）"
        CORE_FAIL=$((CORE_FAIL + 1))
        ;;
esac

# ---------------------------------------------------------------------------
# 4. NapCat（提示性检查：目录与日志文件存在性）
# ---------------------------------------------------------------------------
section "4/6 NapCat WS 状态（提示项，不自动探测 WS）"
napcat_hint="NapCat 由 qq_auto_reply 插件托管（sweep 重连），无独立 unit；确切登录状态请在插件面板查看"
if [[ -d "$NEKO_NAPCAT_DIR" ]]; then
    ok "NapCat 目录存在：${NEKO_NAPCAT_DIR}"
    napcat_log_dir="${NEKO_NAPCAT_DIR%/}/logs"
    if [[ -d "$napcat_log_dir" ]] && find "$napcat_log_dir" -maxdepth 1 -type f -print -quit | grep -q .; then
        newest=$(find "$napcat_log_dir" -maxdepth 1 -type f -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
        ok "NapCat 日志存在：${napcat_log_dir}/${newest}"
    else
        warn "NapCat 日志目录为空或不存在：${napcat_log_dir}（从未启动过 NapCat 属正常）"
    fi
else
    warn "NapCat 目录不存在：${NEKO_NAPCAT_DIR}（插件设置里可配置 napcat_directory 覆盖，或从未安装）"
fi
log_dir=$(neko_log_dir)
if [[ -n "$log_dir" ]]; then
    ok "N.E.K.O 日志目录：${log_dir}"
    newest_log=$(find "$log_dir" -maxdepth 1 -type f -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
    if [[ -n "$newest_log" ]]; then
        info "最新日志文件：${newest_log}"
    fi
else
    warn "未找到 N.E.K.O 日志目录（查找顺序：\$NEKO_STORAGE_SELECTED_ROOT/logs → ~/Documents/N.E.K.O/logs → \$NEKO_HOME/logs）"
fi
info "$napcat_hint"

# ---------------------------------------------------------------------------
# 5. LLM key 有效性（读环境变量；未设置 SKIP 转人工）
# ---------------------------------------------------------------------------
section "5/6 LLM key 有效性（提示项）"
if [[ -z "${NEKO_LLM_BASE_URL:-}" ]]; then
    skip "未设置 NEKO_LLM_BASE_URL——转人工：在 N.E.K.O 设置页核对 API 配置，或 export NEKO_LLM_BASE_URL / NEKO_LLM_API_KEY 后重跑"
elif ! have_cmd curl; then
    skip "curl 不可用，跳过 LLM 端点探测"
else
    llm_url="${NEKO_LLM_BASE_URL%/}/models"
    llm_code=$(curl --silent --show-error --max-time "${NEKO_CURL_TIMEOUT}" \
        -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${NEKO_LLM_API_KEY:-}" "$llm_url" 2>/dev/null) || llm_code=000
    case "$llm_code" in
        200) ok "LLM 端点可达且 key 有效：${llm_url}" ;;
        401|403) warn "LLM key 无效（HTTP ${llm_code}）：${llm_url}——请核对 NEKO_LLM_API_KEY" ;;
        404) warn "LLM 端点无 /models 路由（HTTP 404）：${llm_url}——部分网关不支持，可人工在设置页验证" ;;
        *) warn "LLM 端点异常（HTTP ${llm_code}）：${llm_url}" ;;
    esac
fi

# ---------------------------------------------------------------------------
# 6. a-memorix /a_memorix/v1/stats（P0-1 服务化后生效）
# ---------------------------------------------------------------------------
section "6/6 a-memorix /a_memorix/v1/stats（提示项，P0-1 服务化后生效）"
amemorix_url="${NEKO_AMEMORIX_URL%/}/a_memorix/v1/stats"
amemorix_code=$(curl --silent --show-error --max-time "${NEKO_CURL_TIMEOUT}" \
    -o /dev/null -w '%{http_code}' "$amemorix_url" 2>/dev/null) || amemorix_code=000
case "$amemorix_code" in
    200)
        if http_check "a-memorix stats" "$amemorix_url"; then
            info "a-memorix 服务已上线（P0-1 交付物），统计端点可用"
        else
            warn "a-memorix stats 返回 200 但 body 异常（见上）"
        fi
        ;;
    404|000)
        skip "a-memorix 未部署（HTTP ${amemorix_code}）——正常：a-memorix 服务化（workplan P0-1）完成后此项生效"
        ;;
    *)
        warn "a-memorix stats 异常（HTTP ${amemorix_code}）：$amemorix_url"
        ;;
esac

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
section "体检汇总"
if [[ $CORE_FAIL -eq 0 ]]; then
    ok "核心项（memory_server / 主进程 / ZMQ PUB）全部通过"
    exit 0
fi
fail "核心项失败 ${CORE_FAIL} 项——排查建议：$SERVICE_DOWN_HINT"
exit 1
