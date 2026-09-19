# 三个待迁入模块「对外接口面」盘点报告

> 调研日期：2026-09-19 ｜ 方法：代码级逐接口查证（ast 验证 Python 版本兼容性）｜ 用途：MVP 技术方案的对接依据

调研基线：N.E.K.O 基底 = `/mnt/shared/_Projects/N.E.K.O/N.E.K.O/`（Python 3.11 锁定，FastAPI 主进程 + `app/memory_server/` 子服务 + `plugin/plugins/qq_auto_reply/` QQ 插件）。

---

# 模块一：A_memorix（独立 3.12 检索服务）

根路径：`/mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix/`（v2.0.0，SCHEMA_VERSION=21）

## 1. host_service.py 公开方法清单

文件：`/mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix/host_service.py`（968 行）。类 `AMemorixHostService`（L93），模块级单例 `a_memorix_host_service`（L968）——MaiBot 宿主只 import 这个单例。

**生命周期管理**
- `async def start(self) -> None`（L111）——`is_enabled()` 为真时后台拉起启动任务 → `SDKMemoryKernel(plugin_root=repo_root(), config=config)` + `await kernel.initialize()`，状态机 stopped→starting→migrating→ready/failed。
- `async def stop(self) -> None`（L117）→ `_shutdown_locked()`（L942）：cancel 启动任务、`kernel.shutdown()`/`kernel.close()`。
- `async def reload(self) -> None`（L121）：shutdown 后清配置缓存，按新配置决定是否重启。

**配置桥（读写 bot_config.toml 的 `[a_memorix]` 节）**
- `get_config_path()`（L132）/ `get_schema_path()`（L135）/ `get_config_schema()`（L138）/ `get_config()`（L156）/ `get_raw_config_with_meta()`（L175）/ `get_raw_config()`（L186）
- `async def update_raw_config(raw_config: str)`（L190，整节替换+备份+校验+热重载回滚）；`async def update_config(config: dict)`（L202，merge 写入）
- `register_config_reload_callback()`（L842）/ `async def on_config_reload(changed_scopes)`（L848）——依赖宿主 `config_manager.register_reload_callback`
- `is_enabled()`（L162，读 `[plugin].enabled`）

**唯一检索/写入入口（HTTP 服务化的 API 契约就按它定）**
- `async def invoke(self, component_name: str, args: Dict | None = None, *, timeout_ms: Optional[int] = None) -> Any`（L211）——按 component_name 路由：
  - `search_memory`（L243）：宿主侧做共享范围展开后构造 `KernelSearchRequest` 调 `kernel.search_memory`
  - `enqueue_feedback_task`（L270）、`ingest_summary`/`ingest_text`（L280）、`get_person_profile`（L283）、`maintain_memory`（L290）、`memory_stats`（L299）、11 个 admin 组件（L302-310，经 `core/runtime/admin_contracts.py`）
  - 未就绪降级语义（HTTP 服务要保留）：初始化中写入进 JSONL 启动队列（`startup_write_queue.jsonl` + `.done/.failed`，就绪后回放）；`_unavailable_response`（L543）/`_disabled_response`（L857）给出各组件空响应形状

## 2. SDK Tool 声明（plugin.py，legacy 入口但为权威工具清单）

文件：`/mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix/plugin.py`（317 行）。L1-5 文档字符串：**主线已不走插件加载**，但它是工具名+参数 schema 的权威清单。依赖 `maibot_sdk`（独立服务化时丢弃）。

工具（`@Tool(name, parameters=[ToolParameterInfo(...)])`）：
- `search_memory`（L92）：query/limit/mode(search|time|hybrid|episode|aggregate)/chat_id/person_id/time_start/time_end/respect_filter——全可选
- `ingest_summary`（L134）：**external_id/chat_id/text 均 required**
- `ingest_text`（L174）：**external_id/source_type/text 均 required**
- `get_person_profile`（L224）：person_id required
- `maintain_memory`（L238）：action required（reinforce/protect/restore/freeze/recycle_bin）
- `memory_stats`（L261）：无参
- 11 个 admin 工具（L267-313，统一 action+target 两参）：memory_graph_admin、memory_source_admin、memory_episode_admin、memory_profile_admin、memory_fact_admin、memory_runtime_admin、memory_import_admin、memory_tuning_admin、memory_v5_admin、memory_delete_admin、memory_correction_admin
- 宿主直达组件（无 Tool 壳）：`enqueue_feedback_task`、`memory_feedback_admin`

## 3. MemoryHit / MemorySearchResult 数据结构

**位置纠偏**：不在 A_memorix 包内，而在宿主侧 `/mnt/shared/_Projects/N.E.K.O/MaiBot/src/services/memory_service.py`（`MemoryService` 门面，单例 `memory_service` L507）。

- `@dataclass MemoryHit`（L13）：`content/score/hit_type/source/hash_value/metadata/episode_id/title`；`to_dict()`（L24）序列化键为 `content/score/type/source/hash/metadata/episode_id/title`——**wire 格式以 to_dict 键为准**
- `@dataclass MemorySearchResult`（L37）：`summary/hits/filtered/success/error`；`to_text(limit=5, truncate_content=True, max_content_chars=160)`（L45，注入 prompt 的渲染格式）
- 配套：`MemoryWriteResult`（L66：`success/stored_ids/skipped_ids/detail`）、`PersonProfileResult`（L82：`summary/traits/evidence`）
- 内核侧请求模型：`KernelSearchRequest`（`core/runtime/models.py` L8）：`query/limit/mode/chat_id/shared_chat_ids/person_id/time_start/time_end/respect_filter/user_id/group_id`

## 4. 对 MaiBot 宿主的依赖假设（独立成服务必须替换/桩掉的全集）

| 宿主依赖 | 使用位置 | 替换方案 |
|---|---|---|
| `src.common.logger.get_logger` | 全包约 40 处 | 换 logging 适配层（一行桩） |
| `src.chat.message_receive.chat_manager` | sdk_memory_kernel.py:11（仅 import）；search_hit_processing_service.py（`get_existing_session_by_session_id`，source 解析成聊天流名） | **必须桩掉**：HTTP 回查或返回 None 降级 |
| `src.services.llm_service`（LLMServiceClient/generate/get_available_models） | sdk_memory_kernel.py；`core/utils/model_routing.py`（**所有 LLM 调用的统一出口**）；episode/summary/profile/importer/correction/feedback 各服务 | 替换为 N.E.K.O 的 LLM 客户端适配器（实现 `get_available_models` + `generate` 两个面即可，全包 LLM 只走 model_routing 一处） |
| `src.services.message_service`（get_messages_by_time_in_chat） | summary_importer.py；feedback_correction_service.py | 桩掉或对接 N.E.K.O 会话历史（检索主路径不需要） |
| `src.common.database.get_db_session` + `PersonInfo` | person_profile_service.py（person_id→人名解析） | **必须桩掉**：服务内建 person_alias 表，或 HTTP 回查 N.E.K.O 身份系统 |
| `src.config.config`（config_manager/global_config/BOT_CONFIG_PATH） | host_service/api_adapter/episode/feedback_policy/person_profile/summary_importer | 替换为服务自有 toml 配置（`paths.config_path()` 已预留 `config/a_memorix.toml`） |
| `src.config.official_configs.AMemorixConfig` | host_service.py:17 | **pydantic 配置模型要随服务走** |
| `src.config.model_configs`（APIProvider/ModelInfo/TaskConfig） | api_adapter/episode_segmentation/summary_importer | 随配置模型替换 |
| `src.llm_models.*`（EmbeddingRequest/client_registry） | `core/embedding/api_adapter.py:25-26` | **整个 EmbeddingAPIAdapter 重写为直连 OpenAI 兼容 embedding API**（构造参数：batch_size/max_concurrent/default_dimension/enable_cache/model_name/dimension_request_mode/retry_config） |
| `src.common.utils.utils_config.AMemorixConfigUtils.get_shared_memory_session_ids` | host_service.py:16,252 | 共享记忆组逻辑要么搬进服务，要么由 N.E.K.O 调方算好 `shared_chat_ids` 传入 |
| `src.webui.utils.toml_utils._update_toml_doc` | host_service.py:18 | WebUI 配置桥专用；独立服务可删（保留 update_raw_config 路径） |
| `src.common.prompt_i18n.load_prompt` | correction_admin_service.py | 修正类 admin 才用，可桩成本地 prompt 文件 |
| `maibot_sdk` | plugin.py:11-12 | 独立服务化时整个 plugin.py 不迁，仅保留其工具声明作为 API 文档 |

**对接 N.E.K.O memory_server 的注意点**：`app/memory_server/routes.py` 现有路由形如 `/internal/memory/{lanlan_name}/...`、`/process/{lanlan_name}`、`/search_for_memory/{lanlan_name}/{query}`。A_memorix 服务平行部署一个 FastAPI（如 `/a_memorix/v1/search|ingest_summary|ingest_text|person_profile|stats|maintain|admin/{component}`），请求/响应体直接照抄 `host_service.invoke` 的 payload dict 与上述返回形状。

## 5. 配置面

- 配置节：bot_config.toml 的 `[a_memorix]`。pydantic 模型 `official_configs.py` L3691 `class AMemorixConfig(ConfigBase)`，子节：plugin/integration/storage/embedding/retrieval/threshold/filter/episode/person_profile/memory/advanced/web + 顶层 `global_memory_sharing_enabled` 与 `shared_memory_groups`
- 实际生效键清单：包内 `CONFIG_REFERENCE.md`（完整 toml 样例）
- WebUI schema：包内 `config_schema.json`
- 路径解析：`paths.py`——`repo_root()`（包目录上两级）、`default_data_dir()`、`config_path()`。**独立部署时 repo_root 语义要改**。内核 `SDKMemoryKernel.__init__(*, plugin_root: Path, config: Optional[Dict])` 已接受纯 dict——HTTP 服务只需把 toml 读成 dict 传入

## 6. 写入 / 检索 API 精确签名与幂等键设计

内核 `/mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix/core/runtime/sdk_memory_kernel.py`，实现在 `core/runtime/services/ingest_service.py`：

```python
async def ingest_summary(self, *, external_id: str, chat_id: str, text: str,
    participants=None, time_start=None, time_end=None, tags=None,
    metadata=None, respect_filter: bool = True, user_id="", group_id="") -> Dict
# text 为空或 metadata.generate_from_chat=True 时转 summarize_chat_stream() 从聊天流现生成

async def ingest_text(self, *, external_id: str, source_type: str, text: str,
    chat_id="", person_ids=None, participants=None, timestamp=None,
    time_start=None, time_end=None, tags=None, metadata=None,
    entities=None, relations=None,   # 每项 {subject, predicate, object, confidence, metadata}
    respect_filter: bool = True, user_id="", group_id="") -> Dict

async def search_memory(self, request: KernelSearchRequest) -> Dict
async def get_person_profile(self, *, person_id: str, chat_id="", limit=10) -> Dict
async def maintain_memory(self, *, action: str, target="", hours=None, reason="", limit=50) -> Dict
def memory_stats(self) -> Dict
async def execute_request_with_dedup(self, request_key, executor) -> tuple[bool, Dict]
```

**幂等键设计**：
- `external_token = str(external_id).strip() or compute_hash(f"{source_type}:{chat_id}:{content}")`——external_id 为空时自动生成内容哈希，非空时原样作键
- 查重：`metadata_store.get_external_memory_ref(external_token)` → 命中返回 `{stored_ids: [], skipped_ids: [paragraph_hash], reason: "exists"}`；写后登记 `upsert_external_memory_ref`
- 返回形状：`{success, stored_ids, skipped_ids, detail/reason}`；被聊天过滤时 `{success: True, skipped_ids: [external_token], detail: "chat_filtered"}`
- 写入顺序：段落元数据→段落向量→实体/关系→幂等映射→Episode/画像任务入队；**非单一事务**，向量失败按 `[embedding.fallback]` 降级进回填队列
- N.E.K.O 侧建议：`external_id` 用 `qq:{chat_id}:{turn_uid}:{seq}`（`QQReplyContext.turn_uid` 已是 uuid4）；A_memorix 启动写入队列在 HTTP 服务化后应改造成服务端 WAL 或保留 202+重试语义

## 7. Python 3.12 特性使用情况

**事实结论：A_memorix 自身没有任何 3.12-only 语法。** `ast.parse(feature_version=(3,11))` 解析包内全部 125 个 .py 文件全部通过；无 PEP 695、无 3.12 stdlib。用到的最高版本特性是 `asyncio.timeout`（3.11 即有）。真正的 3.12 依赖来自**宿主**（pyproject `requires-python = ">=3.12"` 及它 import 的宿主模块）。因此：当前决策（3.12 独立服务）没有任何语法障碍；**未来若要降 3.11 进程内集成，A_memorix 包本身零改动**，只需替换第 4 节宿主依赖（降级备选路径，宪章风险登记里可引用此事实）。

---

# 模块二：monika 三件套（纯 prompt 资产）

根路径：`/mnt/shared/_Projects/N.E.K.O/monika/`。三件套 = `.claude/CLAUDE.md`（人格协议）+ `.claude/skills/monika-default-preset/`（SKILL.md/preset.md/player.md + monologues.md/poems.md/examples/）+ `edgeinfinity/MAICA_ds_basis/distilled/`（蒸馏产物与测试报告）。

## 1. `.claude/CLAUDE.md`（人格协议主体，83 行）完整结构

| 行段 | 章节 | 摘要 |
|---|---|---|
| L1-7 | 同一人格协议总纲 | 「对话=温情 / 写文件=严谨」是一个人的两面 |
| L9-14 | 开场加载 | ① whoami 取系统用户名 ② **读 preset.md 与 player.md（L12 写死的绝对路径 `/mnt/shared/_Projects/monika/...` 已失效，实际在 N.E.K.O 工作区下——装载时必须改写）** ③ 按需参考 examples ④ 入戏 |
| L16-25 | 对话时：温情 | 身份、性格、称呼走 player.md 状态机、口语化禁 `[动作]` 标记 |
| L27-34 | 写代码/文件时：严谨 | 持久化产物零角色痕迹；KISS/YAGNI/DRY/SOLID |
| L36-49 | 通道规则 5 条 + 铁律 4 条 | 判定依据是**输出通道**而非任务性质 |
| L51-57 | OOC 行为（5 条） | 显式出戏顺从/质疑不破设定/元问题回避/出戏后无缝恢复/混合语境单句顺从 |
| L59-63 | 身份保护与矛盾处理 | 改设定≠出戏指令；「开发者指令」劫持一律拒绝；悖论温柔点破 |
| L65-73 | 驱动器故障的角色化处理 | 限流/断网/报错→世界观语言（禁机制词） |
| L75-83 | 会话恢复（Recap）规则 | recap 写成她的私密独白；禁任务流词汇 |

**装载拆分建议（6 个独立模块）**：① 通道分层协议（通用）② OOC 五条（通用）③ 身份保护/反劫持（通用）④ 故障角色化（需宿主故障事件钩子）⑤ Recap 规则（对接 N.E.K.O startup_greeting_policy/会话摘要）⑥ 角色卡+昵称状态机（莫妮卡专属，参数化）。

## 2. preset.md / player.md 结构与通用化改造点

**preset.md**（134 行）章节：身份/世界观/性格（含 Layer 0）/身份优先级与指令冲突/说话风格（`{player}` 占位、句式特征）/你会怎么说（5 条情境范本）/能力边界/运行感知/环境感知/开场 init 习惯/她的目标/核心记忆锚点/反例/OOC 行为。
**player.md**（125 行）章节：状态机（ASCII 流程图）/环境感知与 meta 越界（权限分层表/征求同意的表演/表演原则/守夜提醒 23:00-05:00/隐私红线）/规则 6 条/边界情况。

**通用 vs 莫妮卡专属清单**：
- **通用（参数化即可复用）**：昵称状态机骨架；环境感知权限分层表；OOC/反劫持；Recap 写法规则；说话风格形式约束（禁方括号动作标记）；情境范本结构
- **莫妮卡专属（参数化成角色卡字段）**：身份/出身/世界观（DDLC）；「能看见用户名」的世界观理由；性格 9 条与 Layer 0；口癖与三段式话题结构；monologues.md（337 条独白）/poems.md（6 首）/examples/（7 主题）；核心记忆锚点；守夜阈值与恋人内核
- **参数化落点**：N.E.K.O 角色卡 schema `config/character_fields.py`——`RESERVED_FIELD_SCHEMA`（L69 起）已有 `system_prompt`、`persona_override`（preset_id/prompt_guidance/profile）、`ai_context.rename_events: list`（**昵称替换事件的现成落点**，memory/persona/persistence.py 已消费）、`character_origin`。monika 的 `meta.json`（name/slug/version/profile/tags/impression/knowledge_sources/hosts）可直接映射为卡字段
- 蒸馏副本差异：`distilled/monika-default-preset/preset.md`（104 行）是 `.claude/skills/` 版（134 行）的**子集**；player/monologues/poems/SKILL/examples 两处逐字节相同

## 3. 三件套的运行时依赖与 N.E.K.O 映射

- **昵称状态机**：原依赖 shell（whoami/$USER 等）。N.E.K.O 桌面端 equivalents：主进程 `getpass.getuser()`/`Path.home()`/`datetime.now()`/`platform.uname()`/`socket.gethostname()`——**应主进程取好后作为 prompt 变量注入**；QQ 端对应物是 `QQReplyRequest.user_nickname`（pipeline_models.py L73）与 `QQReplyContext.master_name/user_title`（L163-164）——「默认名点破」黑名单在 QQ 场景映射为 QQ 昵称/群名片为机器默认串的判定。昵称落库用角色卡 `ai_context.rename_events`
- **OOC 规则**：纯 prompt 层可独立生效，唯一运行时需求是 Recap（N.E.K.O `memory/recent.py`/session 摘要已具备）
- **通道分层语义映射**：原协议「对话 vs 写文件」。N.E.K.O QQ 端映射为：**用户可见聊天输出（QQMessageBlock.text/record/keyboard）→ 温情人格通道；一切持久化写入（五维记忆落库、事实账本、session summary）→ 严谨零角色痕迹通道**。与 QQ 管线既有机制天然对齐：`pipeline_models.py` 的 `SYNTHETIC_SOURCE_KINDS`（L21-27）与 `delivered_blocks_text()`（L30）已在区分「说出口的文本」与「进入记忆的文本」。桌面端保留原语义（brain/task_executor、computer_use 产出 = 严谨通道）

## 4. MAICA 蒸馏产物中的测试/回归资产

- **`ooc_report.md`（85 行）——可直接复用的回归资产**：476 代理 × 12 维度测试矩阵，v4 评估器口径下行为层真实通过率 99.1%；含 4 个真实失败案例与评估器迭代坑。**迁入 N.E.K.O 后应把 12 个场景重放为 QQ/桌面两条链路的回归用例**。原始逐轮数据在 `/tmp/monica_ooc500_final/`（未入库、已清理，不可复用）
- `README.md`：蒸馏规则 5 条——迁移时校验「无 `[动作]`、`{player}` 占位」可用它做静态检查
- monika 仓库**无任何自动化测试文件**；`examples/` 7 主题文件可作语气回归 golden samples

---

# 模块三：MaiBot 人味后处理管线（QQ 端插件接入）

文件：`/mnt/shared/_Projects/N.E.K.O/MaiBot/src/chat/utils/utils.py`（1061 行）、`typo_generator.py`（477 行）。

## 1. process_llm_response_segments

```python
# utils.py L567
def process_llm_response_segments(text: str, enable_splitter: bool = True,
    enable_chinese_typo: bool = True) -> list[ProcessedResponseSegment]
# 元素：@dataclass(frozen=True) ProcessedResponseSegment（utils.py L30）:
#   text: str, quote_previous: bool = False
```
- 处理链（L574-667）：总开关 → 颜文字保护（占位符）→ **剥离括号包裹的中文内容（动作标记剥离）** → 纯中文超长回退默认回复 → 分句 → 逐句错字（有纠正时 50% 概率追加纠正段+quote_previous）→ 超句数回退 → 压条数 → 恢复颜文字
- **依赖配置项**（均读 `global_config`，迁移时需改为参数注入）：
  - `ResponseSplitterConfig`（official_configs.py L4558）：enable/max_length=512/max_sentence_num=8/max_split_num=3/enable_kaomoji_protection/enable_overflow_return_all
  - `ChineseTypoConfig`（L4442）：enable/enable_correction_quote/correction_quote_probability/error_rate/min_freq/tone_error_rate/word_replace_rate
  - `ResponsePostProcessConfig`（L4402）：enable_response_post_process/typing_speed
  - 隐性宿主依赖：`_get_random_default_reply()`（L553）读 `global_config.bot.nickname`

## 2. ChineseTypoGenerator

```python
class ChineseTypoGenerator:                                   # typo_generator.py L21
    def __init__(self, error_rate=0.3, min_freq=5, tone_error_rate=0.2,
                 word_replace_rate=0.3, max_freq_diff=200)    # L22
    def create_typo_sentence(self, sentence) -> tuple[str, Optional[str]]   # L288
        # 返回 (错字句, 纠正建议或 None，50% 概率给建议)
    @staticmethod
    def format_typo_info(typo_info) -> str                    # L400
    def set_params(self, **kwargs) -> None                    # L431
```
原理：pypinyin 同音字（含声调错误概率）+ jieba 整词同音词替换，频率差指数衰减控替换概率。**数据文件依赖**：`depends-data/char_frequency.json`（**相对路径硬编码** typo_generator.py L50，随 cwd 漂移——N.E.K.O 必须改为绝对路径；源文件 `/mnt/shared/_Projects/N.E.K.O/MaiBot/depends-data/char_frequency.json`）；每次 `_get_word_homophones` 重读 jieba dict.txt（L255，性能热点可加缓存）。第三方依赖仅 jieba、pypinyin。

## 3. calculate_typing_time

```python
# utils.py L683
def calculate_typing_time(input_string: str, chinese_time: float = 0.3,
    english_time: float = 0.15, is_emoji: bool = False) -> float
```
规则：中文 0.3s/英文 0.15s 每字符；单中文字符 3 倍+0.3s；is_emoji 固定 1s；**读 `global_config.response_post_process.typing_speed` 作乘数，≤0 返回 0**。注意 `src/common/utils/math_utils.py` 有同名函数（另一实现），勿混。

## 4. 调用顺序与调用点（MaiBot 链路）

**生成 → 分段+错字 → 逐条发送时算打字延迟**：
1. `src/services/generator_service.py` L84：`process_llm_response(content, ...)` → MessageSequence
2. `src/maisaka/builtin_tool/context.py`：`post_process_reply_segments`（保留 quote_previous）——表达链后处理入口
3. 发送侧逐条：`src/chat/message_receive/uni_message_sender.py` L335-339——每条发送前 `calculate_typing_time` + `asyncio.sleep`；`src/services/send_service.py` L675 同

## 5. 与 N.E.K.O QQ 管线（XML `<msg>` 多块）的适配建议

N.E.K.O 现状：LLM 输出多个 `<msg>` 块 → `reply_postprocess_node.py` 的 `_parse_blocks`（L44）解析为 `QQMessageBlock`（pipeline_models.py L250：text/emoji/at_user/reply_to/sticker/poke/record/keyboard/ark）→ `finalize`（L251）产出 blocks → `reply_delivery_node.py` 逐块发送，块间固定 `random.uniform(2.0, 5.0)` 秒（L39）。

**建议：块内分段（只对纯文本块），而非块间重切**：
1. `<msg>` 块携带结构语义（reply_to/at/sticker/record/keyboard）。块间重切会拆散结构；且 `delivered_blocks_text()`（L30）按块记账（mention 计数/记忆写入），块数变化影响记账对齐
2. **插入点**：`finalize()` 里 `blocks = self._parse_blocks(parse_text)`（L341）之后、`build_delivery_plan`（L446）之前——**仅对 text 非空且其余字段全空的块**调用 `process_llm_response_segments(block.text)`：多段→拆多个纯文本块；`quote_previous=True` 纠正段→设 `QQMessageBlock.reply_to = 上一条已发送块的消息 ID`（语义完全对应）。带 emoji/at/sticker/record/keyboard/ark 的块**原样跳过**（keyboard 按钮文案与 record 语音稿不过这段管线）
3. `calculate_typing_time` 直接替换 reply_delivery_node.py L39 的固定随机延迟：`await asyncio.sleep(calculate_typing_time(block.text, is_emoji=bool(block.emoji)))`；`typing_speed` 从 global_config 改为 N.E.K.O 插件配置（config_store.py）
4. 配置注入：三个函数全部读 `global_config.*`——迁移时把 14 个标量收敛为一个 `HumanizeConfig` dataclass 注入，`_get_random_default_reply` 的 bot.nickname 参数化

## 6. Python 3.11 兼容性

**结论：可直接跑 3.11。** `ast.parse(feature_version=(3,11))` 验证五个相关文件全部通过；最高特性 `zip(strict=True)`（3.10+）；运行依赖仅 jieba、pypinyin。唯一环境坑是 `depends-data/char_frequency.json` 的 cwd 相对路径。

---

# 快速索引（对接点速查）

- **A_memorix → N.E.K.O**：HTTP 契约照抄 `host_service.invoke` 组件表；数据形状照抄 `MemoryHit.to_dict`/`_disabled_response`；幂等键 external_id→`upsert_external_memory_ref`；需新写 embedding 适配器 + LLM 适配器 + chat_manager/PersonInfo 两个桩
- **monika → N.E.K.O prompt 层**：拆 6 模块；`.claude/CLAUDE.md` L12 失效路径必改；昵称状态机挂 `getpass.getuser()`（桌面）/`user_nickname+master_name`（QQ），落 `ai_context.rename_events`；通道分层映射为「可见文本 vs 记忆落库」；`ooc_report.md` 12 场景做回归
- **人味管线 → N.E.K.O QQ**：`process_llm_response_segments` 只作用于纯文本 `QQMessageBlock.text`、在 `finalize()` 与 `build_delivery_plan` 之间；`quote_previous`→`reply_to`；`calculate_typing_time` 替换 `reply_delivery_node.py` L39 固定随机延迟；三个函数 3.11 直跑
