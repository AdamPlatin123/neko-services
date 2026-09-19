#!/usr/bin/env bash
# =============================================================================
# lib.sh — N.E.K.O 维护脚本公共函数库（供 smoke.sh / doctor.sh source 使用）
#
# 用法：在同级脚本内
#     SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
#     source "${SCRIPT_DIR}/lib.sh"
#
# 本库 source 时即开启 bash 严格模式（set -euo pipefail），调用方无需重复设置。
# 设计约束：
#   - 外部命令缺失时优雅降级（返回非 0 / 输出 SKIP），不允许让脚本崩溃；
#   - 所有外部路径与端口均可通过环境变量覆盖（见下方「可配置项」）。
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# 可配置项（环境变量覆盖，全部有默认值）
# ---------------------------------------------------------------------------
# N.E.K.O 子项目根（=上游 git 仓库根，非工作区根）
: "${NEKO_HOME:=/mnt/shared/_Projects/N.E.K.O/N.E.K.O}"
# 进程端口全景（config/network.py 与 plugin/settings.py）
: "${NEKO_MAIN_PORT:=48911}"      # 主进程 HTTP（/health 可用）
: "${NEKO_MEMORY_PORT:=48912}"    # memory_server HTTP
: "${NEKO_ZMQ_RPC_PORT:=38865}"   # ZMQ ROUTER（RPC，消息面）
: "${NEKO_ZMQ_PUB_PORT:=38866}"   # ZMQ PUB（消息面订阅）
: "${NEKO_CURL_TIMEOUT:=5}"       # HTTP 探测超时（秒）
# /health 的 app 指纹（utils/port_utils.py HEALTH_APP_SIGNATURE），用于识别
# 「端口被无关进程占用」的情况
: "${NEKO_APP_SIGNATURE:=N.E.K.O}"
# NapCat 安装目录（qq_auto_reply 插件默认位置；可在插件设置里另行配置）
: "${NEKO_NAPCAT_DIR:=${NEKO_HOME}/plugin/plugins/qq_auto_reply/NapCat.Shell}"
# a-memorix 服务地址（占位端口，P0-1「a-memorix 服务化」定稿后可改）
: "${NEKO_AMEMORIX_URL:=http://127.0.0.1:48921}"

# ---------------------------------------------------------------------------
# 颜色输出（非 tty 或设置 NO_COLOR 时自动关闭）
# ---------------------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_BLUE=$'\033[34m'
    C_DIM=$'\033[2m'
else
    C_RESET=""
    C_RED=""
    C_GREEN=""
    C_YELLOW=""
    C_BLUE=""
    C_DIM=""
fi

info()    { printf '%s\n' "ℹ️  ${C_BLUE}[INFO]${C_RESET} $*"; }
ok()      { printf '%s\n' "✅ ${C_GREEN}[OK]${C_RESET} $*"; }
fail()    { printf '%s\n' "❌ ${C_RED}[FAIL]${C_RESET} $*" >&2; }
warn()    { printf '%s\n' "⚠️  ${C_YELLOW}[WARN]${C_RESET} $*"; }
skip()    { printf '%s\n' "⏭️  ${C_DIM}[SKIP]${C_RESET} $*"; }
section() { printf '\n%s\n' "${C_BLUE}===== $* =====${C_RESET}"; }

# ---------------------------------------------------------------------------
# 命令可用性
# ---------------------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# require_cmd <cmd> [<cmd>...] — 任一命令可用即返回 0；全部缺失返回 1。
# 用于降级链：调用方在返回 1 时应打印 SKIP 而非崩溃。
require_cmd() {
    local c
    for c in "$@"; do
        if command -v "$c" >/dev/null 2>&1; then
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# JSON 字段提取（jq > python3 > grep 三级降级；只支持顶层字符串/数值字段）
# 用法：json_field <json文本> <字段名>；输出字段值（缺失输出空串）
# ---------------------------------------------------------------------------
json_field() {
    local json=$1 key=$2
    if have_cmd jq; then
        jq -r --arg k "$key" 'if has($k) then (.[$k]|tostring) else "" end' \
            <<<"$json" 2>/dev/null || true
    elif have_cmd python3; then
        python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    value = data.get(sys.argv[1]) if isinstance(data, dict) else None
    print("" if value is None else value)
except Exception:
    pass
' "$key" <<<"$json" 2>/dev/null || true
    else
        # 最后一档：仅支持字符串值，够用于 status/app/service/instance_id
        grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$json" 2>/dev/null \
            | head -n1 | sed -e 's/^[^:]*:[[:space:]]*"//' -e 's/"$//' || true
    fi
}

# ---------------------------------------------------------------------------
# TCP 端口探测（python3 socket > nc -z > bash /dev/tcp 降级）
# 用法：tcp_port_open <host> <port> [timeout_s]；0=端口可连
# ---------------------------------------------------------------------------
tcp_port_open() {
    local host=$1 port=$2 timeout_s=${3:-3}
    if have_cmd python3; then
        python3 - "$host" "$port" "$timeout_s" <<'PY' 2>/dev/null
import socket, sys
host, port, timeout_s = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
sock = socket.socket()
sock.settimeout(timeout_s)
code = sock.connect_ex((host, port))
sock.close()
sys.exit(0 if code == 0 else 1)
PY
    elif have_cmd nc; then
        nc -z -w "$timeout_s" "$host" "$port" >/dev/null 2>&1
    else
        # bash 内建 /dev/tcp 兜底（无法精确超时，仅在无 python3/nc 时走到）
        (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
    fi
}

# ---------------------------------------------------------------------------
# ZMQ PUB 端口探测（仅 python3+pyzmq 可用时；否则调用方应降级为 tcp_port_open）
# 用法：zmq_pub_probe <host> <port> [wait_ms]
# 出口码：0=已连且收到消息（stdout 首行 "MSG <topic样例>"）
#         1=已连但等待窗口内无消息（PUB 静默是正常现象，不能据此判死）
#         2=连接失败
#         3=python3 或 pyzmq 不可用
# ---------------------------------------------------------------------------
zmq_pub_probe() {
    local host=$1 port=$2 wait_ms=${3:-1500}
    command -v python3 >/dev/null 2>&1 || return 3
    python3 - "$host" "$port" "$wait_ms" <<'PY' 2>/dev/null || return $?
import sys
try:
    import zmq
except ImportError:
    sys.exit(3)
host, port, wait_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
ctx = zmq.Context.instance()
sub = ctx.socket(zmq.SUB)
sub.setsockopt(zmq.SUBSCRIBE, b"")
sub.setsockopt(zmq.RCVTIMEO, wait_ms)
sub.setsockopt(zmq.LINGER, 0)
try:
    try:
        sub.connect("tcp://%s:%s" % (host, port))
    except Exception:
        sys.exit(2)
    try:
        frame = sub.recv()
        topic = frame.split(b"\x00", 1)[-1][:160].decode("utf-8", "replace")
        print("MSG %s" % topic)
        sys.exit(0)
    except zmq.Again:
        sys.exit(1)
finally:
    sub.close(0)
    ctx.term()
PY
}

# ---------------------------------------------------------------------------
# http_check <检查名> <URL> [期望service字段]
# N.E.K.O 服务健康断言（防「200+error」反模式与端口被无关进程占用）：
#   1) HTTP 状态码 == 200
#   2) body 为 JSON 且 status == "ok"
#   3) body 若带 app 字段，必须等于 NEKO_APP_SIGNATURE（区分真后端与占端口进程）
#   4) 可选：service 字段匹配（memory / main / ...）
# 通过后调用方可读取全局变量 HTTP_CODE / HTTP_BODY。
# 出口码：0=通过；1=失败（已打印原因）
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034  # HTTP_CODE/HTTP_BODY 供 source 方读取，本文件内不使用
HTTP_CODE=""
HTTP_BODY=""

http_check() {
    local name=$1 url=$2 expect_service=${3:-}
    local raw code status app service
    HTTP_CODE=""
    HTTP_BODY=""

    if ! require_cmd curl; then
        fail "${name}: curl 不可用，无法执行 HTTP 检查"
        return 1
    fi
    if ! raw=$(curl --silent --show-error --max-time "${NEKO_CURL_TIMEOUT}" \
        -w $'\n%{http_code}' "$url" 2>/dev/null); then
        fail "${name}: 无法连接 ${url}（服务未启动或超过 ${NEKO_CURL_TIMEOUT}s 超时）"
        return 1
    fi
    code=${raw##*$'\n'}
    HTTP_BODY=${raw%$'\n'*}
    # shellcheck disable=SC2034  # HTTP_CODE 供 source 方使用（库文件内不读取）
    HTTP_CODE=$code

    if [[ "$code" != "200" ]]; then
        fail "${name}: HTTP ${code}（期望 200）URL=${url} body=${HTTP_BODY:0:160}"
        return 1
    fi
    status=$(json_field "$HTTP_BODY" status)
    if [[ -z "$status" ]]; then
        fail "${name}: body 无 status 字段（非 N.E.K.O 健康格式）body=${HTTP_BODY:0:160}"
        return 1
    fi
    if [[ "$status" != "ok" ]]; then
        # 200 + status:error 反模式：状态码健康但业务失败，必须当作失败处理
        fail "${name}: 200+error 反模式——body status='${status}'（期望 'ok'）body=${HTTP_BODY:0:160}"
        return 1
    fi
    app=$(json_field "$HTTP_BODY" app)
    if [[ -n "$app" && "$app" != "${NEKO_APP_SIGNATURE}" ]]; then
        fail "${name}: app 指纹 '${app}' != '${NEKO_APP_SIGNATURE}'（端口可能被其他进程占用）URL=${url}"
        return 1
    fi
    if [[ -n "$expect_service" ]]; then
        service=$(json_field "$HTTP_BODY" service)
        if [[ "$service" != "$expect_service" ]]; then
            fail "${name}: service='${service}'（期望 '${expect_service}'）URL=${url}"
            return 1
        fi
    fi
    ok "${name}: HTTP 200 + status=ok"
    return 0
}

# ---------------------------------------------------------------------------
# neko_log_dir — 推断 N.E.K.O 统一日志目录（utils/logger_config.py 的落盘顺序）
# 输出：找到的日志目录路径（stdout）；找不到输出空串
# 优先级：$NEKO_STORAGE_SELECTED_ROOT/logs > ~/Documents/N.E.K.O/logs > $NEKO_HOME/logs
# ---------------------------------------------------------------------------
neko_log_dir() {
    local candidate
    local -a candidates=()
    if [[ -n "${NEKO_STORAGE_SELECTED_ROOT:-}" ]]; then
        candidates+=("${NEKO_STORAGE_SELECTED_ROOT%/}/logs")
    fi
    candidates+=("${HOME%/}/Documents/N.E.K.O/logs" "${NEKO_HOME%/}/logs")
    for candidate in "${candidates[@]}"; do
        if [[ -d "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 0
}
