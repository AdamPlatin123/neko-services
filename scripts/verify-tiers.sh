#!/usr/bin/env bash
# =============================================================================
# verify-tiers.sh — 模型分层配置验证（workplan P2-2；指南见 docs/model-tiers.md）
#
# 纯只读报告：不写任何文件、不发网络请求、不重启服务。
# 打印 N.E.K.O 12 档 + a-memorix 三任务的实际模型/base_url/自定义或默认。
#
# 输出样式：✅[OK]（PASS 行，DEFAULT 也是合法状态）／⚠️[WARN]（配置断链）／
#           ⏭️[SKIP]（文件缺失/任务未配置，按默认或降级）
# 退出码：0 = 报告完成（未自定义档显示 default 属正常，不判失败）；
#         1 = 无法产出报告（python3 缺失 / 配置文件非法 JSON|TOML）。
#
# 判定为静态近似（按 get_model_api_config 主路径，core_config.py）：
#   自定义生效 = enableCustomApi 为真 且 该档 {prefix}ModelId 与 {prefix}ModelUrl
#   均非空；否则按 fallback 回退（assist/core/conversation/summary）。
#   不复刻 provider 联动、Key 管理簿同源校验、区域改写等运行时细节——
#   「显示 custom 但运行时回退」的边缘情况以运行日志为准。
#
# 环境变量覆盖：
#   NEKO_CORE_CONFIG     N.E.K.O core_config.json 路径
#                        （默认 $HOME/Documents/N.E.K.O/config/core_config.json）
#   NEKO_AMEMORIX_CONFIG a-memorix 配置 toml 路径
#                        （默认 <本仓库>/a-memorix-service/config/a_memorix.toml）
# =============================================================================
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091  # lib.sh 与本脚本同目录，运行期拼接路径无法静态跟踪
source "${SCRIPT_DIR}/lib.sh"

: "${NEKO_CORE_CONFIG:=${HOME%/}/Documents/N.E.K.O/config/core_config.json}"
: "${NEKO_SERVICES:=$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
: "${NEKO_AMEMORIX_CONFIG:=${NEKO_SERVICES%/}/a-memorix-service/config/a_memorix.toml}"

FAIL=0

# print_report — 从 stdin 读 python 输出行（格式 PREFIX|正文，
# PREFIX ∈ OK/WARN/SKIP/INFO），shell 侧转 lib.sh 样式函数
print_report() {
    local line prefix body
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        prefix=${line%%|*}
        body=${line#*|}
        case "$prefix" in
            OK)   ok "$body" ;;
            WARN) warn "$body" ;;
            SKIP) skip "$body" ;;
            *)    info "$body" ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# 1. N.E.K.O 侧：12 档
# ---------------------------------------------------------------------------
section "1/2 N.E.K.O 12 档模型配置（${NEKO_CORE_CONFIG}）"

if ! have_cmd python3; then
    fail "python3 不可用，无法解析配置"
    exit 1
fi

# 内嵌 python：读 core_config.json，按 get_model_api_config 主路径判定。
# python 异常（非法 JSON 等）时无输出，由下方空判定转 FAIL。
neko_report=""
neko_report=$(python3 - "$NEKO_CORE_CONFIG" <<'PY' 2>/dev/null
import json
import os
import sys

path = sys.argv[1]
missing = not os.path.exists(path)
data = {}
if not missing:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)


def s(key):
    v = data.get(key)
    return str(v).strip() if v is not None else ""


enable_custom = bool(data.get("enableCustomApi", False))

# 档名 → (JSON 前缀, fallback 目标)；与 docs/model-tiers.md 第 1 节 12 档表一致
TIERS = [
    ("conversation", "conversation", "assist"),
    ("summary", "summary", "assist"),
    ("correction", "correction", "assist"),
    ("emotion", "emotion", "assist"),
    ("vision", "vision", "assist"),
    ("agent", "agent", "assist"),
    ("game_main", "gameMain", "conversation"),
    ("game_summary", "gameSummary", "summary"),
    ("realtime", "omni", "core"),
    ("tts_default", "tts", "core"),
    ("tts_custom", "tts", "assist"),
]

if missing:
    print(f"SKIP|core_config.json 不存在——按上游默认逻辑全档 default（首次启动前属正常）：{path}")
else:
    note = "" if enable_custom else "（自定义 API 关闭：所有档走默认回退，槽位字段不生效）"
    print(f"INFO|enableCustomApi = {str(enable_custom).lower()} {note}")

# GSV 派生语义（core_config.py）：ttsModelProvider 显式 = gptsovits 即启用；
# 未显式选择（空/follow_*）回落旧 gptsovitsEnabled 开关。
tts_provider = s("ttsModelProvider")
gsv_enabled = tts_provider == "gptsovits" or (
    tts_provider in ("", "follow_assist", "follow_core")
    and bool(data.get("gptsovitsEnabled", False))
)

for tier, prefix, fallback in TIERS:
    mid = s(f"{prefix}ModelId")
    murl = s(f"{prefix}ModelUrl")
    provider = s(f"{prefix}ModelProvider")
    partial = (mid or murl) and not (mid and murl)

    # game 两档：未显式选 provider（默认 follow_*）= 永远跟随，槽位字段无效
    if tier == "game_main" and provider in ("", "follow_conversation"):
        print(f"OK|{tier:12s} model=default(→conversation 跟随) provider={provider or '未设'}")
        continue
    if tier == "game_summary" and provider in ("", "follow_summary"):
        print(f"OK|{tier:12s} model=default(→summary 跟随) provider={provider or '未设'}")
        continue

    if tier == "tts_custom" and gsv_enabled and murl.startswith(("http://", "https://")):
        # GSV 启用时 tts_custom 自愈为自定义（voice_id 即定位，url 即已配置）
        print(f"OK|{tier:12s} model=<GPT-SoVITS 本地运行时> base_url={murl} [CUSTOM·GSV]")
        continue

    if enable_custom and mid and murl:
        print(f"OK|{tier:12s} model={mid} base_url={murl} [CUSTOM]")
    elif tier == "agent" and mid and murl:
        # agent 槽始终读专用 URL/模型，但 is_custom 仅在开关开启时为真；
        # 开关关闭时其 Key 已回落 assist——提示而非 PASS，避免误判已自定义
        print(f"WARN|{tier:12s} model={mid} base_url={murl} [槽位已填但 enableCustomApi 关→is_custom=false，Key 走 assist]")
    else:
        extra = "（槽位 id/url 未双填全，自定义不生效）" if partial else ""
        print(f"OK|{tier:12s} model=default(回退→{fallback}){extra}")

# 第 12 档 image：独立解析（resolve_image_config），无聊天回退
img_provider = s("imageModelProvider")
if img_provider in ("", "disabled"):
    print(f"OK|{'image':12s} 禁用（imageModelProvider 未设）——默认即禁用")
elif not enable_custom:
    print(f"OK|{'image':12s} model=default(禁用) provider={img_provider}（enableCustomApi 关→enabled=False 返回 None）")
else:
    img_model = s("imageModelId") or "<provider 默认模型>"
    print(f"OK|{'image':12s} model={img_model} provider={img_provider} base_url={s('imageModelUrl')} [CUSTOM]")
PY
) || neko_report=""

if [[ -z "$neko_report" ]]; then
    fail "core_config.json 解析失败（非法 JSON）——修复后重试：$NEKO_CORE_CONFIG"
    FAIL=1
else
    print_report <<<"$neko_report"
fi

# ---------------------------------------------------------------------------
# 2. a-memorix 侧：三任务（embedding/memory/utils）解析链
# ---------------------------------------------------------------------------
section "2/2 a-memorix 模型配置（${NEKO_AMEMORIX_CONFIG}）"

if [[ ! -f "$NEKO_AMEMORIX_CONFIG" ]]; then
    skip "配置文件不存在：$NEKO_AMEMORIX_CONFIG（服务未部署属正常；已部署则检查路径）"
else
    # 内嵌 python：读 toml，复刻 resolve_task 主路径（tasks→model_list→models→
    # providers，只报优先序首个可解析候选）。异常（非法 TOML）时无输出转 FAIL。
    amx_report=""
    amx_report=$(python3 - "$NEKO_AMEMORIX_CONFIG" <<'PY' 2>/dev/null
import sys
import tomllib

with open(sys.argv[1], "rb") as fh:
    cfg = tomllib.load(fh)

model = cfg.get("model", {}) or {}
providers = {
    str(p.get("name", "")): p
    for p in model.get("api_providers", [])
    if isinstance(p, dict)
}
models = {
    str(m.get("name", "")): m
    for m in model.get("models", [])
    if isinstance(m, dict)
}
tasks = model.get("tasks", {}) or {}

if not providers:
    print("WARN|[model.api_providers] 为空——LLM 与 embedding 出口均不可用")
if not models:
    print("WARN|[model.models] 为空——任何任务都无法解析出模型")

for task in ("embedding", "memory", "utils"):
    t = tasks.get(task)
    model_list = [str(m).strip() for m in (t.get("model_list", []) or []) if str(m).strip()] \
        if isinstance(t, dict) else []
    if not model_list:
        print(f"SKIP|task[{task:9s}] model_list 未配置——相关组件降级（回填队列/启动 WARN），配置见 docs/model-tiers.md 第 3 节")
        continue
    resolved = False
    for name in model_list:
        m = models.get(name)
        if m is None:
            print(f"WARN|task[{task:9s}] 模型 '{name}' 未在 [model.models] 定义")
            continue
        ident = str(m.get("model_identifier", "") or "").strip()
        if not ident:
            print(f"WARN|task[{task:9s}] 模型 '{name}' 缺少 model_identifier")
            continue
        prov_name = str(m.get("api_provider", "") or "").strip()
        p = providers.get(prov_name)
        if p is None:
            print(f"WARN|task[{task:9s}] 模型 '{name}' 的 provider '{prov_name}' 未在 [model.api_providers] 定义")
            continue
        base_url = str(p.get("base_url", "") or "").strip()
        if not base_url:
            print(f"WARN|task[{task:9s}] provider '{prov_name}' 缺少 base_url")
            continue
        print(f"OK|task[{task:9s}] {name} → {ident} @ {base_url} (provider={prov_name}) [CUSTOM]")
        resolved = True
        break  # 与 resolve_task 一致：只取优先序首个可用候选
    if not resolved:
        print(f"WARN|task[{task:9s}] model_list 无可解析候选（原因见上方 WARN 行）")
PY
    ) || amx_report=""

    if [[ -z "$amx_report" ]]; then
        fail "a_memorix.toml 解析失败（非法 TOML）——修复后重试：$NEKO_AMEMORIX_CONFIG"
        FAIL=1
    else
        print_report <<<"$amx_report"
    fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
    ok "报告完成（DEFAULT/UNSET 均为合法状态；判定为静态近似，详见脚本头部说明）"
else
    fail "报告未完成：存在无法解析的配置文件"
fi
exit "$FAIL"
