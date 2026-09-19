#!/usr/bin/env bash
# replay-patches.sh — 将 patches/neko/*.patch 按序重放到 N.E.K.O 子项目仓库。
#
# 配套文档：patches/neko/README.md（patch manifest 使用说明）
#           patches/neko/BASELINE.md（基线 commit 记录，本脚本校验其一致性）
set -euo pipefail

usage() {
    cat <<'EOF'
用法: replay-patches.sh [--dry-run] [--force]

将本仓库 patches/neko/ 下的补丁按文件名序（NNN-<slug>.patch 的字典序即应用序）
依次 git am 到目标 N.E.K.O 仓库。

选项:
  --dry-run     空跑：列出将应用的补丁与基线校验结果，不改动目标仓库。
  --force       目标仓库 HEAD 与 BASELINE.md 基线不一致时仅警告并继续
                （补丁可能冲突或语义漂移，风险自负）。
  -h, --help    显示本帮助。

环境变量:
  NEKO_REPO     目标 N.E.K.O 仓库路径。未设置时依次尝试：
                1) 本仓库根的 ../N.E.K.O（主 checkout 场景）
                2) git 主仓库根的 ../N.E.K.O（worktree 场景，经
                   git-common-dir 回到主 checkout 再取相对位置）

退出码:
  0  成功（含「无补丁可应用」的基线状态）
  1  参数错误 / 基线校验拒绝 / 目标仓库不可用或脏 / git am 失败
EOF
}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
errlog() { printf '%s\n' "$*" >&2; }

DRY_RUN=0
FORCE=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --force) FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "未知参数: $1" ;;
    esac
    shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
patch_dir="$repo_root/patches/neko"
baseline_file="$patch_dir/BASELINE.md"

[ -f "$baseline_file" ] || die "找不到基线文件: $baseline_file"

# --- 定位目标 N.E.K.O 仓库（无硬编码个人路径，NEKO_REPO 可覆盖）---
if [ -z "${NEKO_REPO:-}" ]; then
    candidate="$repo_root/../N.E.K.O"
    if [ ! -d "$candidate/.git" ] \
        && git -C "$repo_root" rev-parse --git-common-dir >/dev/null 2>&1; then
        # 在 git worktree 中：回到主 checkout 根再取相对位置
        common_dir="$(cd "$repo_root" && git rev-parse --git-common-dir)"
        case "$common_dir" in
            /*) git_dir="$common_dir" ;;
            *) git_dir="$repo_root/$common_dir" ;;
        esac
        main_root="$(cd "$git_dir/.." && pwd)"
        candidate="$main_root/../N.E.K.O"
    fi
    NEKO_REPO="$candidate"
fi
if [ -d "$NEKO_REPO" ]; then
    NEKO_REPO="$(cd "$NEKO_REPO" && pwd)"
fi

git -C "$NEKO_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "目标不是 git 仓库: $NEKO_REPO（可用 NEKO_REPO=<路径> 覆盖）"

# --- 基线校验：目标仓库 HEAD 必须与 BASELINE.md 记录一致 ---
expected="$(grep -E '^NEKO_BASELINE_COMMIT=[0-9a-f]{40}$' "$baseline_file" \
    | head -n 1 | cut -d= -f2)"
[ -n "$expected" ] || die "BASELINE.md 中未找到 NEKO_BASELINE_COMMIT=<40位hash> 机器可读行"
actual="$(git -C "$NEKO_REPO" rev-parse HEAD)"
if [ "$actual" = "$expected" ]; then
    log "基线校验通过: 目标仓库 HEAD 与 BASELINE.md 一致"
    log "  $actual"
else
    errlog "警告: 目标仓库 HEAD 与 BASELINE.md 基线不一致！"
    errlog "  BASELINE.md 记录: $expected"
    errlog "  目标仓库实际  : $actual"
    if [ "$FORCE" -eq 1 ]; then
        errlog "（--force 已指定，继续执行；补丁可能冲突或语义漂移）"
    else
        die "拒绝重放。确认目标仓库版本后重试，或加 --force 强制继续"
    fi
fi

# --- 收集补丁（nullglob：目录为空时得到空数组而非字面量）---
shopt -s nullglob
patches=( "$patch_dir"/*.patch )
shopt -u nullglob

if [ "${#patches[@]}" -eq 0 ]; then
    log "patches/neko/ 下没有 *.patch —— 基线状态无补丁可应用，视为重放成功。"
    log "（后续有补丁时，成功应用后请运行回归："
    log "  cd \"$NEKO_REPO\" && pytest -m plugin_unit,plugin_integration"
    log "  $repo_root/scripts/smoke.sh ）"
    exit 0
fi

log ""
log "将按序应用 ${#patches[@]} 个补丁（目标仓库: $NEKO_REPO）:"

if [ "$DRY_RUN" -eq 1 ]; then
    for p in "${patches[@]}"; do
        log "  [dry-run] $(basename "$p")"
    done
    log ""
    log "空跑结束: 未改动目标仓库。实际应用请去掉 --dry-run。"
    exit 0
fi

# --- 实际应用 ---
[ -z "$(git -C "$NEKO_REPO" status --porcelain)" ] \
    || die "目标仓库有未提交修改，git am 会拒绝执行；请先提交或清理后重试"

applied=0
for p in "${patches[@]}"; do
    log "应用: $(basename "$p")"
    if ! git -C "$NEKO_REPO" am "$p"; then
        errlog ""
        errlog "补丁应用失败: $(basename "$p")"
        errlog "回滚方法: git -C \"$NEKO_REPO\" am --abort"
        die "中止于第 $((applied + 1)) 个补丁（已应用 $applied 个）"
    fi
    applied=$((applied + 1))
done

log ""
log "全部 $applied 个补丁应用完成。请运行回归确认（全绿才算完成，P0-0 #9 规则）:"
log "  1) cd \"$NEKO_REPO\" && pytest -m plugin_unit,plugin_integration"
log "  2) $repo_root/scripts/smoke.sh"
