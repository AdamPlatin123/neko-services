#!/usr/bin/env bash
# replay-patches.sh — 将 patches/neko/*.patch 整组重放到 N.E.K.O 子项目仓库。
#
# 配套文档：patches/neko/README.md（patch manifest 使用说明）
#           patches/neko/BASELINE.md（基线 commit 记录，本脚本校验其一致性）
set -euo pipefail

usage() {
    cat <<'EOF'
用法: replay-patches.sh [--dry-run] [--force]

将本仓库 patches/neko/ 下的全部补丁按 NNN 序（文件名字典序）作为**一次
git am 调用**应用到目标 N.E.K.O 仓库——失败时 git am --abort 撤销的是
整组补丁（回到重放前 HEAD），修复后重新运行本脚本从基线整体重放，
不存在「部分残留」的中间态。

前置校验:
  - 目标仓库 HEAD 须与 BASELINE.md 记录的基线一致（--force 可跳过）。
  - 目标仓库工作树须干净（含零补丁场景，--dry-run 除外）。
  - 补丁文件名须为 NNN-<slug>.patch（三位序号-小写短横线短名），
    且序号从 001 起严格连续；不符合即拒绝执行。

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
  1  参数错误 / 校验拒绝（基线不一致、目标仓库脏、补丁命名不合规）/
     git am 失败（此时请进目标仓库 git am --abort 清理后再重试）
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

# --- 脏树检查：任何非 dry-run 场景（含零补丁）都要求目标工作树干净 ---
# 放在零补丁提前返回之前，避免「基线匹配但树脏」被误报为重放成功。
if [ "$DRY_RUN" -eq 0 ]; then
    [ -z "$(git -C "$NEKO_REPO" status --porcelain)" ] \
        || die "目标仓库有未提交修改: $NEKO_REPO（git am 及重放成功判定均要求干净工作树，请先提交或清理）"
fi

# --- 收集补丁（nullglob：目录为空时得到空数组而非字面量）---
shopt -s nullglob
patches=( "$patch_dir"/*.patch )
shopt -u nullglob

# --- 补丁命名与序号校验：NNN-<slug>.patch，序号从 001 起严格连续 ---
expected_seq=1
for p in "${patches[@]}"; do
    name="$(basename "$p")"
    if ! [[ $name =~ ^[0-9]{3}-[a-z0-9][a-z0-9-]*\.patch$ ]]; then
        die "补丁文件名不符合 NNN-<slug>.patch 规范: $name（三位序号-小写短横线短名）"
    fi
    seq_num="${name%%-*}"
    want_seq="$(printf '%03d' "$expected_seq")"
    if [ "$seq_num" != "$want_seq" ]; then
        die "补丁序号不连续或乱序: $name（按应用序此处应为 ${want_seq}- 开头；补丁只追加不插队，改历史须整组重建）"
    fi
    expected_seq=$((expected_seq + 1))
done

if [ "${#patches[@]}" -eq 0 ]; then
    log "patches/neko/ 下没有 *.patch —— 基线状态无补丁可应用，视为重放成功。"
    log "（后续有补丁时，成功应用后请运行回归："
    log "  cd \"$NEKO_REPO\" && pytest -m 'plugin_unit or plugin_integration'"
    log "  $repo_root/scripts/smoke.sh ）"
    exit 0
fi

log ""
log "将整组应用 ${#patches[@]} 个补丁（一次 git am，目标仓库: $NEKO_REPO）:"

if [ "$DRY_RUN" -eq 1 ]; then
    for p in "${patches[@]}"; do
        log "  [dry-run] $(basename "$p")"
    done
    log ""
    log "空跑结束: 未改动目标仓库。实际应用请去掉 --dry-run。"
    exit 0
fi

# --- 实际应用：整组一次 git am（失败时 --abort 撤销整组，无部分残留）---
if ! git -C "$NEKO_REPO" am "${patches[@]}"; then
    errlog ""
    errlog "整组补丁应用失败。请勿带着失败状态重跑（会因基线不匹配被拒）。"
    errlog "回滚方法（撤销本次全部已应用补丁，回到重放前 HEAD）:"
    errlog "  git -C \"$NEKO_REPO\" am --abort"
    errlog "修复补丁或目标仓库后，重新运行本脚本从基线整体重放。"
    exit 1
fi

log ""
log "全部 ${#patches[@]} 个补丁应用完成。请运行回归确认（全绿才算完成，P0-0 #9 规则）:"
log "  1) cd \"$NEKO_REPO\" && pytest -m 'plugin_unit or plugin_integration'"
log "  2) $repo_root/scripts/smoke.sh"
