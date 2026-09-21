#!/usr/bin/env bash
# N.E.K.O opencode 接入层安装/卸载脚本。
#
# 用法：
#   ./install.sh              安装/更新三件套到 ~/.config/opencode/（拷贝式部署）
#   ./install.sh --uninstall  移除已部署文件（保留本地运行时数据 state.json/outbox）
#   ./install.sh --purge      卸载并删除本地运行时数据（~/.local/share/opencode/monika-memory）
#
# 部署清单（源 → 目标，见 core/channels/opencode/PLAN.md §1 文件表）：
#   dist/agents/monika.md            → ~/.config/opencode/agents/monika.md
#   dist/tools/neko-memory.ts        → ~/.config/opencode/tools/neko-memory.ts
#   dist/plugins/monika-memory-sync.ts → ~/.config/opencode/plugins/monika-memory-sync.ts
#   dist/commands/monika.md          → ~/.config/opencode/commands/monika.md
#   dist/commands/monika-settle.md   → ~/.config/opencode/commands/monika-settle.md
#   dist/monika-memory/read.sh       → ~/.config/opencode/monika-memory/read.sh
#   dist/monika-memory/lib.ts        → ~/.config/opencode/monika-memory/lib.ts
#   （另有全局 AGENTS.md 占位，仅当 ~/.config/opencode/AGENTS.md 不存在时创建——
#     阻断 ~/.claude/CLAUDE.md 回退加载，防宿主 Claude 全局指令串扰人格，RESEARCH A1）
#
# 安装时把 agents/monika.md 中的 __NEKO_USER__ 替换为本机系统用户名（昵称状态机
# 的宿主用户标识注入位），并记录 opencode 版本戳到 monika-memory/installed.json。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist"
OC_DIR="${HOME}/.config/opencode"
DATA_DIR="${NEKO_MEMORY_DATA_DIR:-${HOME}/.local/share/opencode/monika-memory}"
AGENT_MARKER="N.E.K.O opencode 接入层占位"

AGENTS_PLACEHOLDER="# ${AGENT_MARKER}
# 本文件存在的目的：阻断 opencode 对 ~/.claude/CLAUDE.md 的回退加载（RESEARCH A1），
# 防宿主 Claude 全局指令串扰所有 opencode 会话（含莫妮卡人格）。本文件内容会合并进
# 全局 system prompt，请保持精简；如需自定义全局规则，在下方追加即可。
"

die() { echo "install.sh: $*" >&2; exit 1; }

check_dist() {
  local f
  for f in agents/monika.md tools/neko-memory.ts plugins/monika-memory-sync.ts \
           commands/monika.md commands/monika-settle.md \
           monika-memory/read.sh monika-memory/lib.ts; do
    [ -f "$SRC_DIR/$f" ] || die "missing dist source: $SRC_DIR/$f"
  done
}

do_install() {
  check_dist

  mkdir -p "$OC_DIR/agents" "$OC_DIR/plugins" "$OC_DIR/tools" "$OC_DIR/commands" "$OC_DIR/monika-memory"

  local sys_user
  sys_user="$(id -un)"

  # 覆盖已存在文件前备份（同一次安装共用同一时间戳后缀；AGENTS.md 走已有的
  # 「不存在才创建」守卫，不经此备份路径）
  local stamp
  stamp="$(date +%s)"
  backup_if_exists() {
    if [ -f "$1" ]; then
      cp "$1" "$1.bak.${stamp}"
      echo "backed up existing $1 -> $1.bak.${stamp}"
    fi
    return 0
  }

  # agents：占位符替换（宿主用户标识注入，昵称状态机第 3 节）
  backup_if_exists "$OC_DIR/agents/monika.md"
  sed "s/__NEKO_USER__/${sys_user}/g" "$SRC_DIR/agents/monika.md" > "$OC_DIR/agents/monika.md"

  # tools / plugins / commands / monika-memory
  backup_if_exists "$OC_DIR/tools/neko-memory.ts"
  cp "$SRC_DIR/tools/neko-memory.ts" "$OC_DIR/tools/neko-memory.ts"
  backup_if_exists "$OC_DIR/plugins/monika-memory-sync.ts"
  cp "$SRC_DIR/plugins/monika-memory-sync.ts" "$OC_DIR/plugins/monika-memory-sync.ts"
  backup_if_exists "$OC_DIR/commands/monika.md"
  cp "$SRC_DIR/commands/monika.md" "$OC_DIR/commands/monika.md"
  backup_if_exists "$OC_DIR/commands/monika-settle.md"
  cp "$SRC_DIR/commands/monika-settle.md" "$OC_DIR/commands/monika-settle.md"
  backup_if_exists "$OC_DIR/monika-memory/read.sh"
  cp "$SRC_DIR/monika-memory/read.sh" "$OC_DIR/monika-memory/read.sh"
  backup_if_exists "$OC_DIR/monika-memory/lib.ts"
  cp "$SRC_DIR/monika-memory/lib.ts" "$OC_DIR/monika-memory/lib.ts"
  chmod +x "$OC_DIR/monika-memory/read.sh"

  # 全局 AGENTS.md 占位（仅不存在时创建，不覆盖用户已有内容）
  if [ ! -f "$OC_DIR/AGENTS.md" ]; then
    printf '%s\n' "$AGENTS_PLACEHOLDER" > "$OC_DIR/AGENTS.md"
    echo "created placeholder $OC_DIR/AGENTS.md (blocks ~/.claude/CLAUDE.md fallback)"
  fi

  # 版本戳（升级前对照 RESEARCH.md C1 版本验证清单巡检）
  local oc_ver="unknown"
  command -v opencode >/dev/null 2>&1 && oc_ver="$(opencode --version 2>/dev/null || echo unknown)"
  cat > "$OC_DIR/monika-memory/installed.json" <<EOF
{
  "opencode_version": "${oc_ver}",
  "installed_at": "$(date -Is)",
  "source": "neko-services core/channels/opencode/dist",
  "user_binding": "${sys_user}"
}
EOF

  # 运行时数据目录预置（state.json 空态 + outbox/）
  mkdir -p "$DATA_DIR/outbox"
  [ -f "$DATA_DIR/state.json" ] || printf '{"sessions":{}}\n' > "$DATA_DIR/state.json"

  echo "installed (opencode ${oc_ver}):"
  echo "  $OC_DIR/agents/monika.md"
  echo "  $OC_DIR/tools/neko-memory.ts"
  echo "  $OC_DIR/plugins/monika-memory-sync.ts"
  echo "  $OC_DIR/commands/monika.md , monika-settle.md"
  echo "  $OC_DIR/monika-memory/{read.sh,lib.ts}"
  echo "进入方式：任意目录 opencode → Tab 切到 monika → 跑 /monika 注入跨端记忆增量开场。"
}

do_uninstall() {
  local f removed=0
  for f in agents/monika.md tools/neko-memory.ts plugins/monika-memory-sync.ts \
           commands/monika.md commands/monika-settle.md; do
    if [ -f "$OC_DIR/$f" ]; then rm "$OC_DIR/$f"; echo "removed $OC_DIR/$f"; removed=1; fi
  done
  if [ -d "$OC_DIR/monika-memory" ]; then
    rm -rf "$OC_DIR/monika-memory"
    echo "removed $OC_DIR/monika-memory/"
    removed=1
  fi
  # 仅当 AGENTS.md 是我们的占位（含标记且无用户追加内容）才移除
  if [ -f "$OC_DIR/AGENTS.md" ] && grep -q "$AGENT_MARKER" "$OC_DIR/AGENTS.md" \
     && [ "$(wc -l < "$OC_DIR/AGENTS.md")" -le 6 ]; then
    rm "$OC_DIR/AGENTS.md"
    echo "removed placeholder $OC_DIR/AGENTS.md"
  fi
  if [ "$removed" -eq 0 ]; then
    echo "nothing to remove (not installed?)"
  else
    echo "runtime data kept at $DATA_DIR (use --purge to delete)"
  fi
}

do_purge() {
  do_uninstall
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    echo "removed runtime data $DATA_DIR"
  fi
}

case "${1:-install}" in
  install) do_install ;;
  --uninstall|-u) do_uninstall ;;
  --purge) do_purge ;;
  -h|--help)
    sed -n '2,10p' "${BASH_SOURCE[0]}" ;;
  *) die "unknown arg: $1 (use --uninstall / --purge)" ;;
esac
