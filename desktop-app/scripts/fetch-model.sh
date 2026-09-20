#!/usr/bin/env bash
#
# fetch-model.sh —— 下载 xiaomai（小麦）Live2D 模型到 desktop-app-assets/models/xiaomai/
#
# 用法（在 desktop-app/ 目录下任一位置执行均可）：
#   bash scripts/fetch-model.sh            # 下载 xiaomai（默认）
#   bash scripts/fetch-model.sh <model>    # 下载 imuncle/live2d 仓库中的其他模型（如 tsumiki/unitychan）
#
# 说明：
# - 模型来自 https://github.com/imuncle/live2d （model/<name>/<name>.model.json，Cubism 2 格式）
# - 模型文件不进仓库（.gitignore 已忽略 desktop-app-assets/models/）
# - 授权红线（DESIGN.md「桌宠模型选型」）：xiaomai 为动漫衍生（umaru）角色——
#   个人自用可以，不得再分发；开源分发场景请换 unitychan 或 tsumiki。
# - 下载后：npm run dev 打开 http://localhost:5190/pet-demo.html 即可看到模型。
#   也可用 URL 参数切换模型：/pet-demo.html?model=/models/<name>/<name>.model.json
#
set -euo pipefail

MODEL="${1:-xiaomai}"
BASE_RAW="https://raw.githubusercontent.com/imuncle/live2d/master/model/${MODEL}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # desktop-app/scripts/ → 仓库根
TARGET="${REPO_ROOT}/desktop-app-assets/models/${MODEL}"

echo "==> 下载模型 ${MODEL} → ${TARGET}"
mkdir -p "${TARGET}"

# Cubism 2 web 运行时（live2d.min.js）→ desktop-app-assets/vendor/（本地优先加载，CDN 兜底）
# 注意：网上广为流传的 web-sdk/Live2D/lib/ 路径已 404，仓库实际路径是 webgl/Live2D/lib/
VENDOR="${REPO_ROOT}/desktop-app-assets/vendor"
mkdir -p "${VENDOR}"
if [ ! -s "${VENDOR}/live2d.min.js" ]; then
  echo "==> 下载 Cubism 2 运行时 live2d.min.js → ${VENDOR}"
  curl -fsSL --retry 3 -o "${VENDOR}/live2d.min.js" \
    "https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js" \
    || echo "!! 运行时下载失败（页面会尝试 CDN 兜底，离线环境将退到占位模式）" >&2
fi

SETTINGS="${MODEL}.model.json"
if ! curl -fsSL --retry 3 -o "${TARGET}/${SETTINGS}" "${BASE_RAW}/${SETTINGS}"; then
  echo "!! 无法下载 ${BASE_RAW}/${SETTINGS}（模型名是否正确？网络是否可达？）" >&2
  exit 1
fi

# 解析 model.json 里的全部资源文件（moc/贴图/物理/表情/动作），按相对路径下载
python3 - "${TARGET}" <<'PY'
import json, sys, subprocess
from pathlib import Path

target = Path(sys.argv[1])
# 刚下载的 model.json 就是目录里唯一的 settings 文件
candidates = sorted(target.glob("*.model.json"))
if not candidates:
    sys.exit("!! 目录里没有 model.json")
settings = json.loads(candidates[0].read_text(encoding="utf-8"))

base = "https://raw.githubusercontent.com/imuncle/live2d/master/model/" + target.name
files = []
files.append(settings.get("model"))
files.extend(settings.get("textures") or [])
for key in ("physics", "pose"):
    if settings.get(key):
        files.append(settings[key])
for exp in settings.get("expressions") or []:
    if exp.get("file"):
        files.append(exp["file"])
for group in (settings.get("motions") or {}).values():
    for m in group:
        if m.get("file"):
            files.append(m["file"])
        # voice 不下载（DESIGN：桌宠默认安静；且能避免 404 噪音）
files = [f for f in files if f]

ok = fail = 0
for f in files:
    dest = target / f
    if dest.exists() and dest.stat().st_size > 0:
        ok += 1
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{base}/{f}"
    r = subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(dest), url])
    if r.returncode == 0:
        ok += 1
        print(f"  ✓ {f}")
    else:
        fail += 1
        print(f"  ✗ {f}（下载失败，若为可选文件可忽略）")
        dest.unlink(missing_ok=True)

print(f"==> 完成：{ok} 成功 / {fail} 失败；位置 {target}")
PY

cat <<'EOF'

模型就绪。
  演示页：npm run dev → http://localhost:5190/pet-demo.html
  提醒：xiaomai 为动漫衍生角色，仅限个人自用，请勿再分发模型文件。
EOF


# 复制渲染三件套到 vendor（pixi v6 + cubism2 UMD——与 loader 的本地 script 注入配套）
VENDOR_DIR="$ASSETS_ROOT/vendor"
mkdir -p "$VENDOR_DIR"
cp -f "$APP_ROOT/node_modules/pixi.js/dist/browser/pixi.min.js" "$VENDOR_DIR/pixi.min.js" 2>/dev/null || echo "[warn] pixi.min.js 复制失败（npm install 了吗？）"
cp -f "$APP_ROOT/node_modules/pixi-live2d-display/dist/cubism2.min.js" "$VENDOR_DIR/cubism2.min.js" 2>/dev/null || echo "[warn] cubism2.min.js 复制失败"
echo "[vendor] 渲染三件套就绪（pixi.min.js / live2d.min.js / cubism2.min.js）"
