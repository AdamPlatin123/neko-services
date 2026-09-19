#!/usr/bin/env bash
# N.E.K.O opencode 接入层：/monika 命令的共享记忆增量读取脚本。
#
# 安装位：~/.config/opencode/monika-memory/read.sh（命令模板经 !`...` 注入其输出）
# 职责（PLAN §2(4) 与 §3 重进结算分支）：
#   1) 定位会话水位——优先 state.json 的 active_session_id 指针（plugin 在 monika 会话
#      每条消息上刷新，/monika 命令自身消息即刷新，时序新鲜且 agent 专属）；指针缺失时
#      用 `opencode session list --format json` 按「当前目录最近活跃」兜底（P1-3 实测
#      可行，2026-09-19 opencode 1.18.31；注意列表 agent 盲，可能定位到同目录编程会话
#      ——读错水位：靠后=漏读该段、靠前=重复注入幂等无害，不承诺不漏读，⚠#9）；
#      两路皆失回退 since_seq=0 全量首拉
#   2) 重进结算：outbox（未提交增量，文件系统事实）非空 → POST /renew 携带增量（热重置
#      语义，成功即清 outbox）；否则 POST /settle（幂等、空增量，不查本地计数）
#   3) GET /recent_history/monika?since_seq=<水位> → 成功回写水位并输出文本；任一步失败
#      输出「（共享记忆暂不可达，照常对话）」，不阻塞命令
#
# 并发约定：与 TS 侧 lib.ts 的 withState 同机制——mkdir 原子锁串行化 state.json 读写
# （flock(1) 无法被 Bun 进程内持有，故 shell 侧也用 mkdir 锁保证互操作）。
# 环境变量：NEKO_MEMORY_BASE_URL（默认 http://127.0.0.1:48912）、
#           NEKO_MEMORY_DATA_DIR（默认 ~/.local/share/opencode/monika-memory）、
#           NEKO_MEMORY_SESSION_ID（显式指定会话，优先于自动定位）。
set -u

BASE_URL="${NEKO_MEMORY_BASE_URL:-http://127.0.0.1:48912}"
DATA_DIR="${NEKO_MEMORY_DATA_DIR:-$HOME/.local/share/opencode/monika-memory}"
STATE_FILE="$DATA_DIR/state.json"
OUTBOX_DIR="$DATA_DIR/outbox"
LOCK_DIR="$DATA_DIR/state.lock.d"
NAME="monika"
FALLBACK_TEXT="（共享记忆暂不可达，照常对话）"

# 命令对用户体验敏感：renew/settle 含 LLM 摘要（契约建议 30s），此处封顶 15s 并容忍失败
# （settle 幂等可重试、renew 失败 outbox 保留）；增量读取 5s 对齐契约。
SETTLE_TIMEOUT=15
READ_TIMEOUT=5
LOCK_WAIT_S=5
LOCK_STALE_S=30

need_bin() { command -v "$1" >/dev/null 2>&1; }
for b in curl jq; do
  need_bin "$b" || { echo "$FALLBACK_TEXT"; exit 0; }
done

log_warn() { echo "neko-read: $*" >&2; }

# ---------------------------------------------------------------------------
# mkdir 自旋锁（与 lib.ts 同机制；陈旧接管 >30s；等待封顶 5s 后降级继续）
# ---------------------------------------------------------------------------
lock_dir_acquired=0
lock_acquire() {
  local waited=0
  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      lock_dir_acquired=1
      return 0
    fi
    local mtime now age
    mtime=$(stat -c %Y "$LOCK_DIR" 2>/dev/null) || { continue; }
    now=$(date +%s)
    age=$((now - mtime))
    if [ "$age" -gt "$LOCK_STALE_S" ]; then
      rm -rf "$LOCK_DIR" 2>/dev/null
      log_warn "stale lock (>${LOCK_STALE_S}s) taken over"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_S" ]; then
      log_warn "lock wait >${LOCK_WAIT_S}s; proceeding degraded"
      return 0
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
}
lock_release() {
  [ "$lock_dir_acquired" -eq 1 ] && rm -rf "$LOCK_DIR" 2>/dev/null
  return 0
}
trap lock_release EXIT

# ---------------------------------------------------------------------------
# 1) 定位会话与水位
# ---------------------------------------------------------------------------
# 定位优先级（P1-3 实测定型，⚠#9）：
#   A. state.json 的 active_session_id 指针——plugin 在 monika 会话「每条消息」上刷新
#      （chat.message/info.agent），/monika 命令自身的消息就会刷新它，时序上先于本脚本；
#      且指针按构造只指向 monika 会话（agent 盲误定位免疫）
#   B. opencode session list 按当前目录最近活跃——指针缺失（全新安装/换机）时兜底；
#      注意列表是 agent 盲的（无 agent 字段），同目录混有编程会话时可能定位到他会话
#      （读错水位：靠后=漏读该段、靠前=重复注入幂等无害——不承诺不漏读）
session_id="${NEKO_MEMORY_SESSION_ID:-}"

# 路径 A：active_session_id 指针（monika 专属、消息时序新鲜）
if [ -z "$session_id" ] && [ -f "$STATE_FILE" ]; then
  session_id=$(jq -r '.active_session_id // empty' "$STATE_FILE" 2>/dev/null)
fi

# 路径 B：opencode session list 按当前目录最近活跃定位（当前目录 = 命令执行目录）。
# 实测（1.18.31）：列表项为平铺字段 {id, title, updated, created, projectId, directory}，
# 无 time 嵌套——updated 顶层取；防御式兼容 time.updated 旧形态。
if [ -z "$session_id" ] && need_bin opencode; then
  session_id=$(opencode session list --format json 2>/dev/null \
    | jq -r --arg dir "$PWD" \
        'map(select((.directory // "") == $dir))
         | sort_by(.updated // .time.updated // 0)
         | last
         | .id // empty' 2>/dev/null)
fi

since_seq=0
if [ -n "$session_id" ] && [ -f "$STATE_FILE" ]; then
  since_seq=$(jq -r --arg s "$session_id" '.sessions[$s].since_seq // 0' "$STATE_FILE" 2>/dev/null)
fi
case "$since_seq" in ''|*[!0-9]*) since_seq=0 ;; esac

# ---------------------------------------------------------------------------
# 2) 重进结算分支：outbox 非空 → /renew 携带增量；否则 → /settle（幂等）
# ---------------------------------------------------------------------------
outbox_files=""
if [ -d "$OUTBOX_DIR" ]; then
  outbox_files=$(ls "$OUTBOX_DIR"/*.json 2>/dev/null | LC_ALL=C sort)
fi

if [ -n "$outbox_files" ]; then
  # 合并 outbox 各条目的 messages（jq -s 按升序文件流拼接）为统一 HistoryRequest
  increments=$(jq -s 'map(.messages) | add // []' $outbox_files 2>/dev/null)
  if [ -n "$increments" ]; then
    body=$(jq -nc --argjson ih "${increments:-[]}" '{input_history: ($ih | tostring)}')
    renew_code=$(curl -s -o /tmp/.neko-read-renew.$$ -w '%{http_code}' \
      --max-time "$SETTLE_TIMEOUT" -X POST "$BASE_URL/renew/$NAME" \
      -H 'content-type: application/json' -d "$body" 2>/dev/null)
    renew_status=$(jq -r '.status // empty' /tmp/.neko-read-renew.$$ 2>/dev/null)
    rm -f /tmp/.neko-read-renew.$$
    if [ "$renew_code" = "200" ] && [ "$renew_status" = "processed" ]; then
      # 提交成功：清空对应 outbox 文件（增量已随 renew 落库）
      lock_acquire
      printf '%s\n' "$outbox_files" | while IFS= read -r f; do rm -f "$f"; done
      lock_release
    else
      log_warn "renew failed (http=${renew_code:-none} status=${renew_status:-none}); outbox kept"
    fi
  fi
else
  # 0 增量：/settle 幂等结算（不查本地计数；失败容忍——下次 settle 或他会话热重置收尾）
  curl -s -o /dev/null --max-time "$SETTLE_TIMEOUT" -X POST "$BASE_URL/settle/$NAME" \
    -H 'content-type: application/json' \
    -d '{"input_history":"[]"}' 2>/dev/null || log_warn "settle failed (tolerated, idempotent)"
fi

# ---------------------------------------------------------------------------
# 3) 增量读取 → 回写水位 → 输出
# ---------------------------------------------------------------------------
resp_file=$(mktemp /tmp/.neko-read-recent.XXXXXX)
http_code=$(curl -s -o "$resp_file" -w '%{http_code}' --max-time "$READ_TIMEOUT" \
  "$BASE_URL/recent_history/$NAME?since_seq=$since_seq" 2>/dev/null)

if [ "$http_code" != "200" ]; then
  rm -f "$resp_file"
  log_warn "recent_history http=$http_code since_seq=$since_seq"
  echo "$FALLBACK_TEXT"
  exit 0
fi

# 应用层判定 + 游标解析（防御式：seq/next_seq/last_seq/cursor.seq 取首个数值）
next_seq=$(jq -r 'if type == "object"
  then ([.seq, .next_seq, .last_seq, .cursor.seq // empty]
        | map(select(type == "number" and . >= 0))
        | first // empty)
  else empty end' "$resp_file" 2>/dev/null)

# 输出注入文本：优先结构化行（messages/items/history 数组的 name|text 行）；
# 结构化但为空数组 → 「无新增量」提示；完全非结构化 → 原文截断
inject_text=$(jq -r '
  if type == "object" then
    ([.messages?, .items?, .history?, .entries?] | map(select(type == "array")) | first // empty) as $arr
    | if ($arr | length) == 0
      then "__NEKO_EMPTY__"
      else ($arr
            | map([(.name // .speaker // .role // "?"), (.text // .content // "")] | join(" | "))
            | join("\n"))
      end
  else
    tostring
  end' "$resp_file" 2>/dev/null | head -c 4000)

if [ "$inject_text" = "__NEKO_EMPTY__" ]; then
  inject_text="（自上次读取以来没有新的共享记忆增量）"
elif [ -z "$inject_text" ] || [ "$inject_text" = "null" ]; then
  inject_text=$(head -c 4000 "$resp_file" 2>/dev/null)
fi
rm -f "$resp_file"

if [ -z "$inject_text" ]; then
  echo "$FALLBACK_TEXT"
  exit 0
fi

# 回写水位（仅前进；锁内读-改-写）
if [ -n "$session_id" ] && [ -n "$next_seq" ]; then
  case "$next_seq" in
    *[!0-9]*|'') : ;;
    *)
      lock_acquire
      if [ -f "$STATE_FILE" ]; then
        tmp="$STATE_FILE.tmp.$$"
        jq --arg s "$session_id" --argjson n "$next_seq" \
          '.sessions[$s].since_seq = ((.sessions[$s].since_seq // 0) | if . < $n then $n else . end)' \
          "$STATE_FILE" > "$tmp" 2>/dev/null \
          && mv "$tmp" "$STATE_FILE" || rm -f "$tmp"
      fi
      lock_release
      ;;
  esac
fi

echo "$inject_text"
