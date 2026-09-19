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
# JSON 字段提取（jq > python3 两级；无可靠解析器时宁可失败也不降级猜测）
# 用法：json_field <json文本> <字段名>
# 出口码：0 = 解析成功，stdout 输出字段值（字段缺失输出空串）
#         1 = 解析失败——调用方必须视为检查失败，不得放行
# 失败条件（codex review 两轮收紧）：
#   body 非单一合法 JSON 对象、含尾部垃圾、多值输入流（如 "{} {}" 或
#   追加 null——jq 用 [(inputs)] 验证恰好一个值）、空输入、顶层非对象
#   （数组/字符串/null）、jq 与 python3 均不可用。
# 注意：本函数输出值仅供展示（如 INSTANCE_ID）；安全敏感的相等比较
# 必须用 json_field_eq（bash 命令替换会剥尾换行，"x\n" 会被误当 "x"）。
# ---------------------------------------------------------------------------
json_field() {
    local json=$1 key=$2 out
    if have_cmd jq; then
        # [(inputs)] 收集首个值之后的全部输入：非空即多值输入流 → null →
        # jq -e 对 null/false 输出退出非 0；空输入流则 filter 零次执行、
        # 无输出 → jq -e 退出 4。两者均判失败。
        if ! out=$(jq -er --arg k "$key" '
                if (type == "object") and ([(inputs)] | length == 0)
                then (if has($k) then (.[$k] | tostring) else "" end)
                else null
                end
            ' <<<"$json" 2>/dev/null); then
            return 1
        fi
        # 单值验证通过后，多行只可能来自字段值内嵌换行——同样拒绝
        if [[ "$(printf '%s\n' "$out" | wc -l)" -gt 1 ]]; then
            return 1
        fi
        printf '%s\n' "$out"
    elif have_cmd python3; then
        python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)  # 非法 JSON / 尾部垃圾 / 多文档（json.load 拒绝 "Extra data"）
if not isinstance(data, dict):
    sys.exit(1)  # 顶层必须是对象（数组/字符串/null 均失败；空输入同样抛异常）
value = data.get(sys.argv[1])
print("" if value is None else value)
' "$key" <<<"$json" 2>/dev/null
    else
        # 无 jq 且无 python3：不做文本猜测，明确失败（安装其一即可恢复）
        return 1
    fi
}

# ---------------------------------------------------------------------------
# json_field_eq <json文本> <字段名> <期望值> — 解析器内部的严格相等断言
# 出口码：0 = 解析成功且字段值严格等于期望值
#         1 = 解析失败 / 多值输入 / 字段缺失 / 值不等 / 值内嵌换行等不可见差异
# 为什么比较必须在解析器内做（codex review P2 修复）：bash 命令替换会剥掉
# 尾部换行，"N.E.K.O\n" 经 $(...) 后变成 "N.E.K.O" 从而绕过 bash 层 == 比较；
# jq 的字符串比较与 Python 的 == 均不剥换行，"N.E.K.O\n" != "N.E.K.O"。
# ---------------------------------------------------------------------------
json_field_eq() {
    local json=$1 key=$2 expected=$3
    if have_cmd jq; then
        jq -e --arg k "$key" --arg exp "$expected" '
            if (type == "object") and ([(inputs)] | length == 0)
            then (if has($k) and ((.[$k] | tostring) == $exp) then true else false end)
            else false
            end
        ' <<<"$json" >/dev/null 2>&1
    elif have_cmd python3; then
        python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
value = data.get(sys.argv[1])
if isinstance(value, (dict, list)):
    sys.exit(1)  # 结构体值不参与字符串比较
sys.exit(0 if ("" if value is None else str(value)) == sys.argv[2] else 1)
' "$key" "$expected" <<<"$json" >/dev/null 2>&1
    else
        return 1
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
#   2) body 为单一合法 JSON 对象且 status == "ok"（解析失败=失败，不放行）
#   3) app 字段必须存在且严格等于 NEKO_APP_SIGNATURE——缺失/为空/不符/
#      含不可见字符差异（如尾部换行）均失败
#   4) 可选：service 字段严格匹配（memory / main / ...）
# 相等比较全部在解析器内部完成（json_field_eq），不经过 bash 命令替换
# （其会剥尾换行导致 "x\n" 被误当 "x"）。
# 通过后调用方可读取全局变量 HTTP_CODE / HTTP_BODY。
# 出口码：0=通过；1=失败（已打印原因）
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034  # HTTP_CODE/HTTP_BODY 供 source 方读取，本文件内不使用
HTTP_CODE=""
HTTP_BODY=""

http_check() {
    local name=$1 url=$2 expect_service=${3:-}
    local raw code status app
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
    if ! status=$(json_field "$HTTP_BODY" status); then
        fail "${name}: body 无法解析为单一 JSON 对象（非法 JSON/多值输入/空输入/无 jq 与 python3）body=${HTTP_BODY:0:160}"
        return 1
    fi
    if [[ -z "$status" ]]; then
        fail "${name}: body 无 status 字段（非 N.E.K.O 健康格式）body=${HTTP_BODY:0:160}"
        return 1
    fi
    if ! json_field_eq "$HTTP_BODY" status "ok"; then
        # 相等判定在解析器内做：拦截 200+error 反模式，以及 "ok\n" 等
        # 剥换行后视觉相同但字节不同的值
        fail "${name}: status 非严格 'ok'（200+error 反模式或含不可见字符差异，显示值 '${status}'）body=${HTTP_BODY:0:160}"
        return 1
    fi
    if ! app=$(json_field "$HTTP_BODY" app); then
        fail "${name}: app 字段解析失败 body=${HTTP_BODY:0:160}"
        return 1
    fi
    if ! json_field_eq "$HTTP_BODY" app "${NEKO_APP_SIGNATURE}"; then
        fail "${name}: app 指纹缺失/为空/不符或含不可见字符差异（显示值 '${app:-<缺失>}'，期望 '${NEKO_APP_SIGNATURE}'；端口可能被其他进程占用）URL=${url}"
        return 1
    fi
    if [[ -n "$expect_service" ]]; then
        if ! json_field_eq "$HTTP_BODY" service "$expect_service"; then
            fail "${name}: service 非严格等于 '${expect_service}'（缺失/不符/含不可见差异）URL=${url}"
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
