# 模型分层配置指南（P2-2）

> 定稿：2026-09-20 ｜ 依据：`docs/design/neko-access-audit.md` 第 7 节（LLM 调用分层现状）、`docs/design/mvp-tech-design.md` P2-2/P2-3 与 Final Gate 裁决、P0-1b 产出的 a-memorix 模型解析链（`a-memorix-service/adapters/openai_compat.py`）。
> 本文是**配置指南 + 验证工具说明**，不改任何用户运行时配置。所有路径均为绝对路径。
> 配置验证脚本：`/mnt/shared/_Projects/N.E.K.O/neko-services/scripts/verify-tiers.sh`（见第 5 节）。

## 0. 一句话总览

N.E.K.O 上游已有 **12 档模型分档**（`utils/config_manager/core_config.py` 的 `get_model_api_config`，核心映射表在 core_config.py:1703 附近），无需新增档位即可满足 MVP：**主对话 conversation 档跨端同档**（整合宪章要求），summary/correction/emotion 等杂活档配便宜模型；a-memorix 检索层在自带 `config/a_memorix.toml` 独立分档（主 LLM 档与 embedding 档分开）；成本取数走上游现成的 token_tracker（见第 4 节）。

**先纠一个名**：早期材料里说的「bot_config.toml」是 MaiBot 侧的叫法——**N.E.K.O 的模型档配置实际存放在 `core_config.json`**（camelCase 键，`get_core_config()` 读取后映射为内部大写下划线键，见 core_config.py:931 起）。本文所有 N.E.K.O 侧命令均以 `core_config.json` 为准。

## 1. 12 档清单表

档位注册表 = `model_type_mapping`（11 项）+ `image` 特例（走 `utils/image_generation/config.py::resolve_image_config`），共 12 档。调用方式统一为 `await config_manager.aget_model_api_config('<档名>')` 后 `create_chat_llm_async(**cfg)`（工厂在 `utils/llm_client/factory.py:29`）——没有中央 router，每处调用点各自选档。

| # | 档名 | 用途 | 主要调用方（代码级查证） | 默认回退（fallback_type） | 建议模型档位 | 成本特征 |
|---|---|---|---|---|---|---|
| 1 | `conversation` | **主对话**。桌面 WS 会话、QQ 回复、微信回复（换档见 2.1）、未来 opencode 入口按 wechat 范式同用此档 | `_streaming.py:964`（set_call_type("conversation")）、QQ reply_model_node、wechat_integration | 辅助 API（assist） | **中高端主力对话模型**——这是「同一人格」的载体，跨端必须同档同模型（宪章要求，Final Gate P2-3 #5 验收项） | **最大头**。长上下文（persona+记忆注入）× 每轮 |
| 2 | `summary` | 记忆摘要压缩、事实提取、去重、回顾、scoped 提炼 | `memory/recent.py`、`memory/facts.py`、`memory/fact_dedup.py`、`memory/recall.py`、`memory/scoped_refine.py`、`brain/deduper.py`（合计 17 处调用，全项目最多） | 辅助 API | **便宜模型**（轻量/flash/turbo 级） | 高频小调用。量大但单次 token 少；最适合降成本 |
| 3 | `correction` | 记忆纠错、精炼、persona 修正 | `memory/recent.py:632`、`memory/refine.py:471`、`memory/persona/corrections.py:576` | 辅助 API | **便宜模型** | 同 summary：高频小调用 |
| 4 | `emotion` | 情绪分析、活动富化、语言检测辅助 | `omni_offline_client/_streaming.py:362`、`activity/llm_enrichment.py:464`、`utils/language_utils.py:1934/2055` | 辅助 API | **便宜模型**（甚至可用最小档） | 高频极小调用，输出短 |
| 5 | `vision` | 截图/摄像头/图像理解 | 屏幕监控、avatar 图片入口（4 处） | 辅助 API | 需多模态模型；无视觉需求可不配 | 按需触发，图像 token 单价高 |
| 6 | `agent` | Agent/工具调用循环（brain.task_executor 等）；**微信通道当前硬编码用此档**（wechat_integration `__init__.py:568`，`max_completion_tokens=300`） | `brain/task_executor.py:512`（set_call_type("agent")）、wechat_integration | 辅助 API | 中档：要工具调用能力，但非人格载体 | 中。微信 50 字限制下的短回复；注意微信换档决策（见 2.1） |
| 7 | `game_main` | 小游戏对话主模型 | `main_routers/game_router/char_info.py:374` | **conversation**（默认 `follow_conversation`，即跟随主对话档） | 跟随 conversation 即可 | 低频（游戏功能启用才有） |
| 8 | `game_summary` | 小游戏内摘要 | game_router（1 处） | **summary**（默认 `follow_summary`） | 跟随 summary | 低频 |
| 9 | `realtime` | 实时语音会话（WebSocket 多模态） | 实时语音链路（3 处） | **核心 API**（core，wss 端点；默认模型取 CORE_MODEL 而非本档字段） | 须选支持 realtime 协议的模型（qwen-omni/gpt-realtime 级）；不适合文字档思路 | 语音会话期间持续计费，单价高 |
| 10 | `tts_default` | 默认 TTS（OmniOfflineClient 用） | TTS 链路（2 处） | **核心 API** | 跟随核心 API 的 TTS 能力 | 按字符计费（token_tracker 以 prompt_chars 记） |
| 11 | `tts_custom` | 自定义音色 TTS（CosyVoice 克隆 / GPT-SoVITS） | TTS 链路（20 处，最多） | **辅助 API**（特殊：CosyVoice 路径优先回退 Qwen 家 Key） | 按需；GSV 是本地运行时不走云 | 按字符计费 |
| 12 | `image` | 图像生成 | 生成入口（1 处） | **无回退**（`resolve_image_config` 独立解析，绝不落到聊天模型/Key——上游有意设计） | 须图像生成模型 + 专用 Key | 按张计费，不进 token 统计 |

> 表中「主要调用方」行号以 2026-09-19 盘点（`docs/design/neko-access-audit.md`）为基准，后续上游演进以 grep 实测为准。

## 2. N.E.K.O 侧配置步骤（core_config.json）

### 2.1 跨端同档：三条硬规则

1. **conversation 档是唯一人格载体**：桌面/QQ/微信/未来 opencode 四入口的主对话全部走 conversation 档、同一模型同一端点。Final Gate 裁决（P2-3 #5）把「跨端主对话同档」列为验收项。
2. **微信当前用 agent 档是待修偏差**：wechat_integration 现硬编码 `create_chat_llm_async(model="agent"档, max_completion_tokens=300)`；Eng 审查决策 #24 已裁定微信换 conversation 档（进 P1-1 改动点）。在那之前配档时注意：**想给微信换模型，临时要动 agent 档**——但别动，等 P1-1 换档，否则 agent 工具调用链路跟着变。
3. **微信 50 字限制是已知体验偏差**（`max_completion_tokens=300` + 微信通道特性），已登记在 P2-3 #5，不属于本指南修改范围。

### 2.2 配置文件在哪

```bash
# 配置目录解析优先级（storage_roots.py get_config_path）：
#   1. $HOME/Documents/N.E.K.O/config/core_config.json   ← 首选（文档目录）
#   2. <上游项目目录>/config/core_config.json             ← 备选
# 均不存在 = 全部档位走默认（免费路由/assist profile）——首次启动前属正常。

export NEKO_SRC=/mnt/shared/_Projects/N.E.K.O/N.E.K.O
CFG="$HOME/Documents/N.E.K.O/config/core_config.json"
ls -l "$CFG" 2>/dev/null || echo "尚不存在（首次启动 N.E.K.O 后生成，或手工创建）"
```

**推荐入口是桌面端设置界面的 API 设置页**（`static/js/api_key_settings.js` 对应页）：勾选「启用自定义 API」即写入 `enableCustomApi: true`，逐档填 URL/模型/Key，UI 会处理 provider 联动与 Key 管理簿。手改 JSON 是等价兜底，见下。

### 2.3 开启自定义 API 总开关 + 为便宜档配模型

`enableCustomApi`（JSON 键，内部映射为 ENABLE_CUSTOM_API）是所有档自定义的总门：不开时各档一律走默认回退（assist/core profile），槽位字段填了也不生效（唯二例外：agent 档始终读专用 URL 字段；tts_custom 在 GPT-SoVITS 选中时自愈为自定义）。

每档在 JSON 里占 4 个键，前缀映射如下（`prefix_by_type`，core_config.py:1798 附近）：

| 档名 | JSON 前缀 | 模型 ID 键 | URL 键 | API Key 键 |
|---|---|---|---|---|
| conversation | `conversation` | `conversationModelId` | `conversationModelUrl` | `conversationModelApiKey` |
| summary | `summary` | `summaryModelId` | `summaryModelUrl` | `summaryModelApiKey` |
| correction | `correction` | `correctionModelId` | `correctionModelUrl` | `correctionModelApiKey` |
| emotion | `emotion` | `emotionModelId` | `emotionModelUrl` | `emotionModelApiKey` |
| vision | `vision` | `visionModelId` | `visionModelUrl` | `visionModelApiKey` |
| agent | `agent` | `agentModelId` | `agentModelUrl` | `agentModelApiKey` |
| game_main | `gameMain` | `gameMainModelId` | `gameMainModelUrl` | `gameMainModelApiKey` |
| game_summary | `gameSummary` | `gameSummaryModelId` | `gameSummaryModelUrl` | `gameSummaryModelApiKey` |
| realtime | `omni` | `omniModelId` | `omniModelUrl` | `omniModelApiKey` |
| tts_default / tts_custom（共用） | `tts` | `ttsModelId` | `ttsModelUrl` | `ttsModelApiKey` |
| image | `image` | `imageModelId` | `imageModelUrl` | `imageModelApiKey`（另有 `imageModelProvider`） |

另有每档 `{prefix}ModelProvider` 下拉值（`follow_conversation` / `follow_summary` / `follow_core` / `follow_assist` / 具名服务商 / `custom`），控制 Key 与协议跟随关系；手改 JSON 时**最省心的组合是 `custom` + 三元组填全**（Key 与 URL 同源，不会触发上游的同源校验回退）。

可复制的最小配置示例（jq 原地合并，先 `command -v jq` 确认可用；主对话中高端档 + summary/correction/emotion 便宜档，全部走同一 OpenAI 兼容中转，仅模型名不同）：

```bash
export NEKO_SRC=/mnt/shared/_Projects/N.E.K.O/N.E.K.O
CFG="$HOME/Documents/N.E.K.O/config/core_config.json"
mkdir -p "$(dirname "$CFG")"

# 便宜档候选示例（OpenAI 兼容生态常见轻量选择，仅示例不锁品牌）：
#   各家 turbo/flash/air 级对话模型（如 Qwen-turbo/flash 系、GLM-Flash、
#   DeepSeek-chat、Gemini Flash 系——任选你所用中转支持的）
BASE_URL="https://your-openai-compatible-gateway.example/v1"
API_KEY="sk-xxxx"
MAIN_MODEL="your-flagship-chat-model"        # conversation：跨端同档的主力
CHEAP_MODEL="your-cheap-chat-model"          # summary/correction/emotion 杂活

# 文件已存在则合并、不存在则新建（只写档位键，不动其他配置）
if [ -f "$CFG" ]; then OLD=$(cat "$CFG"); else OLD='{}'; fi
echo "$OLD" | jq --arg base "$BASE_URL" --arg key "$API_KEY" \
  --arg main "$MAIN_MODEL" --arg cheap "$CHEAP_MODEL" '
  .enableCustomApi = true
  # —— 主对话档（跨端同档）——
  | .conversationModelProvider = "custom"
  | .conversationModelUrl  = $base
  | .conversationModelId   = $main
  | .conversationModelApiKey = $key
  # —— 便宜杂活档 ——
  | .summaryModelProvider = "custom"
  | .summaryModelUrl  = $base | .summaryModelId  = $cheap | .summaryModelApiKey  = $key
  | .correctionModelProvider = "custom"
  | .correctionModelUrl = $base | .correctionModelId = $cheap | .correctionModelApiKey = $key
  | .emotionModelProvider = "custom"
  | .emotionModelUrl   = $base | .emotionModelId   = $cheap | .emotionModelApiKey   = $key
' > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"

# 改完重启后端生效（配置无热加载）：
systemctl --user restart neko.target   # systemd 形态
# 或桌面形态：Ctrl+C 停 launcher 后重新 uv run launcher.py（二选一，勿同时）

# 验证（见第 5 节）：
/mnt/shared/_Projects/N.E.K.O/neko-services/scripts/verify-tiers.sh
```

**自定义生效条件**（get_model_api_config 实测逻辑）：`enableCustomApi` 为真 **且** 该档 `ModelId` 与 `ModelUrl` 均非空 → 用自定义三元组（`is_custom: true`）；否则按上表 fallback 回退（assist 档用 `OPENROUTER_URL`/`OPENROUTER_API_KEY`，core 档用 `CORE_URL`/`CORE_API_KEY`）。缺任一字段=整档回退，不会用半套配置发起请求。

### 2.4 不建议动的档

- `realtime` / `tts_default`：回退 core（WebSocket 协议族），手配易造成「assist 地址+Anthropic 协议」类错配（上游注释里反复强调的坑）。要换须整族换（coreApi 选择器）。
- `game_main` / `game_summary`：默认跟随 conversation/summary，保持跟随即可——主对话换模型它们自动跟上，这正是跨端一致想要的。
- `image`：独立解析、无聊天回退，provider 枚举校验严格（非 custom 的 URL 必须与该家官方端点同源），照 UI 配。

## 3. a-memorix 侧配置（a_memorix.toml）

a-memorix-service 是独立进程（3.12 venv），**不读 N.E.K.O 的 core_config.json**——模型出口全在自带 `config/a_memorix.toml` 的 `[model.*]` 节（P0-1b 落地，解析链在 `a-memorix-service/adapters/openai_compat.py::resolve_task`）。

### 3.1 解析链（30 秒版）

```
任务名（embedding / memory / utils）
  → [model.tasks.<任务>].model_list（数组，按优先序取首个可用）
  → [[model.models]] 按条目 name 匹配 → 取 model_identifier + api_provider
  → [[model.api_providers]] 按条目 name 匹配 → 取 base_url + api_key
  → OpenAI 兼容调用
任一环节缺失 = 返回带 reason 的错误（进程不崩），调用侧降级，启动时 /health 之外的 WARN 汇总可见（model_config_status）
```

三个任务面：**embedding**（向量写入/检索）、**memory**（记忆杂活 LLM：提炼/画像/图谱）、**utils**（工具 LLM）。主 LLM 档与 embedding 档完全独立配置——这正是「便宜 embedding 候选」可以单独落的地方。

### 3.2 配置示例

```bash
export NEKO_SERVICES=/mnt/shared/_Projects/N.E.K.O/neko-services
TOML="$NEKO_SERVICES/a-memorix-service/config/a_memorix.toml"

# 编辑 [model.*] 节（示例值替换为你自己的端点/Key）：
#   - 主 LLM 档（memory/utils 任务）：便宜对话模型即可，a-memorix 的杂活
#     不承载人格，不要求与 conversation 同档
#   - embedding 档：便宜/免费 embedding 候选示例（不锁品牌）：
#       bge-m3（SiliconFlow 等中转常见）、text-embedding-3-small、
#       Qwen text-embedding 系——任选你的端点支持的
${EDITOR:-vi} "$TOML"
```

`[model.*]` 节的完整形状（与仓库内默认模板同构，填掉空串即可）：

```toml
[model]

[[model.api_providers]]
name = "main"                      # 起名自定义；下同
base_url = "https://your-openai-compatible-gateway.example/v1"
api_key = "sk-xxxx"
client_type = "openai"

[[model.api_providers]]
name = "embed"                     # embedding 可走另一家/另一 Key
base_url = "https://your-embedding-provider.example/v1"
api_key = "sk-yyyy"
client_type = "openai"

[[model.models]]
name = "cheap-llm"                 # 任务 model_list 里引用的就是这个名字
model_identifier = "your-cheap-chat-model"   # 真实发给 API 的模型名
api_provider = "main"

[[model.models]]
name = "embed-small"
model_identifier = "your-embedding-model"
api_provider = "embed"

[model.tasks.embedding]            # embedding 档：独立配置
model_list = ["embed-small"]
max_tokens = 4096
temperature = 0.3

[model.tasks.memory]               # 主 LLM 档（记忆杂活）
model_list = ["cheap-llm"]
max_tokens = 4096
temperature = 0.3

[model.tasks.utils]                # 工具 LLM
model_list = ["cheap-llm"]         # 与 memory 同模型则写同名，想分开再加 [[model.models]]
max_tokens = 4096
temperature = 0.3
```

改完重启生效：`systemctl --user restart neko-a-memorix.service`，然后 `curl -s http://127.0.0.1:48921/health` 看 startup_state；未配置时服务照常启动（WARN + 检索写入降级进回填队列），不会崩。

## 4. 成本监控接入点（P2-3「一周 token 记录」从哪取数）

### 4.1 N.E.K.O 侧：token_tracker 现成，直接取数（无需开发）

上游已内置完整用量统计 `utils/token_tracker/`（OpenAI/Anthropic SDK 层全局 hook 自动记录，memory_server 启动即安装，见 `app/memory_server/runtime.py:992`）。**P2-3 的一周记录直接读落盘文件**：

- **位置**：`$HOME/Documents/N.E.K.O/config/token_usage.json`（config_dir 下；与 core_config.json 同目录，storage_roots 改根则跟随）
- **结构**（`_merge_day_stats`/`record` 实测字段）：

```jsonc
{
  "daily_stats": {
    "2026-09-20": {                       // 按天
      "total_prompt_tokens": 0, "total_completion_tokens": 0,
      "total_tokens": 0, "cached_tokens": 0,
      "total_prompt_chars": 0,            // TTS/ASR/按字符计费端点用
      "call_count": 0, "error_count": 0,
      "by_model":  { "<模型名>": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cached_tokens": 0, "prompt_chars": 0, "call_count": 0 } },
      "by_call_type": { "<调用类型>": { "…同 by_model 桶字段…" } }
    }
  },
  "recent_records": [ { "ts": 0, "model": "", "pt": 0, "ct": 0, "tt": 0, "cch": 0, "pch": 0, "type": "<调用类型>", "src": "", "ok": true } ]
}
```

- **按档取数**：`by_call_type` 的键就是档位/调用类型标签——`conversation`、`agent`、`memory_compression`（summary 档调用）、`memory_review`、`memory_refine`、`proactive` 等由调用侧 `set_call_type()` 打标（全项目 25+ 处）。做 P2-3 的「各档一周消耗」就聚合 `daily_stats[*].by_call_type`。
- **程序化取数**：`TokenTracker.get_stats(days=7)` 直接返回合并内存增量的 N 天统计（`recording.py:116`），不用自己拼文件。
- **一周汇总一行命令**：

```bash
python3 - <<'PY'
import collections, datetime, json, os
path = os.path.expanduser("~/Documents/N.E.K.O/config/token_usage.json")
if not os.path.exists(path):
    raise SystemExit(f"尚无用量文件（{path}）——服务产生 LLM 调用后由 token_tracker 自动落盘")
data = json.load(open(path))
week = [ (datetime.date.today()-datetime.timedelta(days=i)).isoformat() for i in range(7) ]
agg = collections.defaultdict(lambda: [0,0,0,0])  # prompt, completion, total, calls
for day in week:
    for ct, b in data.get("daily_stats", {}).get(day, {}).get("by_call_type", {}).items():
        a = agg[ct]; a[0]+=b["prompt_tokens"]; a[1]+=b["completion_tokens"]; a[2]+=b["total_tokens"]; a[3]+=b["call_count"]
if not agg:
    raise SystemExit("近 7 天无 by_call_type 记录")
for ct, (p,c,t,n) in sorted(agg.items(), key=lambda kv:-kv[1][2]):
    print(f"{ct:24s} prompt={p:>10,} completion={c:>10,} total={t:>11,} calls={n:>6,}")
PY
```

- **已知口径缺口（取数时核对，不阻碍 P2-3）**：①插件进程（微信/QQ 通道，48916 宿主）的调用同样经 SDK 全局 hook，但未打 `set_call_type` 标签的会落 `unknown` 桶——微信换 conversation 档（P1-1）时应顺手 `set_call_type("conversation")`；②`conversation` 档的 call_type 标签在桌面主链路已有（`_streaming.py:964`），跨端核对以 `by_model` 交叉验证。

### 4.2 a-memorix 侧：无 usage 记录，最简补法（建议，未实现）

现状（P0-1b 产出代码级查证）：

- chat 路：`adapters/openai_compat.py::generate_response` **已经捕获** usage 并返回（`LLMResponseResult.prompt_tokens/completion_tokens/total_tokens`，openai_compat.py:245-252），但**没有任何落盘/日志**——数据在上层被丢弃。
- embedding 路：`OpenAICompatEmbeddingClient.get_embedding` 只返回向量与 model_name（openai_compat.py:319-322），OpenAI 兼容 embeddings 响应自带的 `usage.prompt_tokens` 被**直接丢弃**。
- `/a_memorix/v1/stats` 端点只是转发内核 `memory_stats`（组件状态），**不是**用量统计。

**最简补法（P2-3 实施时的建议，本文不实现）**：两处都在 `adapters/openai_compat.py` 单文件内，改动面极小——

1. chat：`generate()`（openai_compat.py:255）返回前按 `task_name` 把 `prompt_tokens/completion_tokens/total_tokens` 累加到进程内计数器，进程内计数器定期（或 atexit）原子写 `config_dir/model_usage.json`，形状对齐 N.E.K.O 的 `daily_stats.by_call_type` 桶字段以便同一脚本聚合；
2. embedding：`get_embedding` 成功路径加一行 `logger.info`（model + usage.prompt_tokens）先满足周报人工汇总，要自动化再进计数器。

不建议给 a-memorix 引入 N.E.K.O 的 token_tracker 包（跨仓库依赖，违背 P0-0 分叉治理的最小面原则）。

## 5. 验证脚本 verify-tiers.sh

```bash
# 默认读本机默认路径；配置文件位置可覆盖：
export NEKO_CORE_CONFIG="$HOME/Documents/N.E.K.O/config/core_config.json"      # N.E.K.O 侧
export NEKO_AMEMORIX_CONFIG="/mnt/shared/_Projects/N.E.K.O/neko-services/a-memorix-service/config/a_memorix.toml"
/mnt/shared/_Projects/N.E.K.O/neko-services/scripts/verify-tiers.sh
```

行为（纯只读，不写任何文件、不发网络请求）：

- N.E.K.O 侧：打印 `enableCustomApi` 状态 + 12 档逐档的「实际模型 / base_url / 自定义 or 默认(回退目标)」。配置文件不存在时按上游默认逻辑报告全部 default（这正是未自定义场景的期望输出）。
- a-memorix 侧：逐任务（embedding/memory/utils）打印 model_list 解析链结果（模型名 → model_identifier → provider/base_url），未配置显示 unset + 服务降级提示。
- 判定为**静态近似**：脚本按 `get_model_api_config` 的主路径判定（enableCustomApi + ModelId + ModelUrl 双非空 = custom），不复刻 provider 联动/同源校验/区域改写等运行时细节——「显示 custom 但运行时回退」的边缘情况以运行日志为准。

## 6. 与 P2-3 验收的衔接

| P2-3 验收项（mvp-tech-design.md） | 本文支撑 |
|---|---|
| #5 模型分层生效 + 跨端主对话同档（conversation） | 第 1/2 节配档 + verify-tiers.sh 输出留档 |
| #6 一周各档 token 消耗与月成本估算、超支降档顺序 | 第 4 节取数（by_call_type 聚合）；降档顺序建议：先 emotion→最小档，再 summary/correction 换更便宜模型，最后才动人味降频（P2-1 开关）——主对话 conversation 档降级即人格突变，放最后 |
| 微信 50 字限制记为已知偏差 | 第 2.1 节 |
