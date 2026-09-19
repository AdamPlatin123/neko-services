# N.E.K.O 子项目「接入面」盘点报告

> 调研日期：2026-09-19 ｜ 方法：代码级逐接口查证 ｜ 用途：MVP 技术方案的对接依据

项目根：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O`（下文路径均省略此前缀）。
进程端口全景（`config/network.py:160-168`）：MAIN_SERVER=48911、MEMORY_SERVER=48912、MONITOR=48913、TOOL_SERVER=48915、USER_PLUGIN_SERVER=48916；消息面 ZMQ：RPC=38865、PUB=38866、INGEST=38867（`plugin/settings.py:518-601`）。

---

## 1. memory_server 全部 HTTP 端点

服务本体：`app/memory_server/runtime.py`（FastAPI app），路由主体 `app/memory_server/routes.py`。路径段 `{lanlan_name}` 经 `validate_lanlan_name()` 校验。

### 1.1 会话写入流水线（settle 管线）

请求体统一 `HistoryRequest`（routes.py:75）：`{input_history: str(JSON序列化的messages数组), language?, render_language?}`；响应 `{"status": "cached|processed|settled|error"}`。

| Method/Path | 函数 | 做什么 | 调用方与时机 |
|---|---|---|---|
| POST `/cache/{name}` | cache_conversation（routes.py:912） | 轻量持久化：update_history(compress=False) + time store + outbox 事后信号。**无 LLM** | cross_server.py `run_sync_connector` 每**轮 turn 结束**；wechat_integration:763（每轮回复后） |
| POST `/process/{name}` | process_conversation（routes.py:990） | 带 LLM 摘要压缩 + store + outbox + review | cross_server **session end** 有增量时 |
| POST `/renew/{name}` | process_conversation_for_renew（routes.py:1053） | 同 process 但持 settle_lock（阻塞 /new_dialog 直到摘要落盘） | cross_server **热重置**有增量时 |
| POST `/settle/{name}` | settle_conversation（routes.py:1113） | 结算已 cache 增量：摘要+时间戳 | 热重置/会话结束**增量=0**时；wechat 会话清理前 |

**确切节奏（照抄）**：turn 结束 → `/cache`（增量）；会话重开（热重置）→ `/renew`（有增量）或 `/settle`（0 增量）；会话结束 → `/process`（有增量）或 `/settle`（0 增量）。封装函数：`main_logic/cross_server.py:642 _post_memory_server(endpoint, lanlan_name, payload, *, timeout_s, ...)`，用共享 httpx 客户端（verify=False，5s 默认超时）。

### 1.2 读取端点（节选关键的）

| Method/Path | 契约 | 调用方 |
|---|---|---|
| GET `/new_dialog/{name}` | **PlainTextResponse**：persona markdown + 内心活动 + recent history（`名 \| 文本` 行）+ gap 提示 + 节假日。写 prompt-locale、持 settle_lock | lifecycle.py:1519（每次 start_session）；wechat_integration:740 |
| POST `/query_memory/{name}` | `QueryMemoryRequest{query?, time?, subjects?[]}` → hybrid_recall/recall_by_time 结构化结果 `{results:[], query, candidates_total, elapsed_ms}`。失败永返空 | tool_calling.py:292（recall_memory 工具） |
| GET `/last_conversation_gap/{name}` | `{"gap_seconds": float\|-1}` | 主动搭话判定 |
| GET/POST `/followup_topics/{name}`、POST `/record_surfaced/{name}` | 后续话题候选/冷却刷新 | greeting.py（主动问候） |
| POST `/reflect/{name}` | 反思合成 + auto_promote；**当前无活跃外部调用方**（反思由内部周期循环驱动） | — |

### 1.3 `/internal/*`（scoped 记忆，QQ 插件专用但协议通用）

请求模型 routes.py:1223-1340：`MemorySubjectRequest{subject_kind: "group_chat"|"participant"|"group_participant", subject_id, scope?}`、`ScopedFactInput{text, importance 1-10, source}`。

| Path | 要点 |
|---|---|
| POST `/internal/memory/{name}/scoped_context` | `{subjects:[...1..8], language?}`；**subjects 顺序=预算优先级**（总额 16000 token、单 subject 有下限，config/memory_settings.py:119-140）→ PlainText persona。群 subject 必须排第一 |
| POST `.../scoped_facts` | 低成本写入（1..32 条），免 LLM |
| POST `.../scoped_history` | 批量提取：legacy 或分段 segments（含 speaker_tier/speaker_base_trust/speaker_is_owner 信任字段） |
| `.../scoped_mentions`、`.../scoped_forget`、`.../repetition_insights`、`.../import_external_markdown`、`/internal/trust/*`、`/internal/identity/*`（bind/unbind/merge）、`/reload`、`/release_character/{name}`（需 claim token）、`/shutdown`、`/health`（带 INSTANCE_ID 指纹） | |

**可用性：直接可用。** 中心记忆服务核心契约（cache/process/renew/settle + query_memory + new_dialog）已是独立 HTTP 进程、无鉴权、127.0.0.1 直连；新通道桥照 `wechat_integration` 写法即可。**需小改**：subject_kind 枚举目前面向群聊，新通道（terminal）要么走 legacy 私聊语料要么扩展枚举。

---

## 2. ZMQ message_plane 协议

代码：`plugin/message_plane/`（`main.py::run_message_plane(*, rpc_endpoint, pub_endpoint, ingest_endpoint, auth_token)` 独立入口；宿主内由 plugin/server/lifecycle.py:350 启动）。

### 2.1 三个 socket

| Socket | 端点 | 模式 | 鉴权 |
|---|---|---|---|
| RPC | tcp://127.0.0.1:38865 | ROUTER（multipart） | **无**（loopback 即信任） |
| PUB | tcp://127.0.0.1:38866 | PUB，topic=`"{store}.{topic}"`，body=JSON | 无（任何人可 SUB） |
| INGEST | tcp://127.0.0.1:38867 | PULL（单帧 ormsgpack） | **必须**：payload `_auth` == 进程内 token（fork 子进程强制换 token） |

### 2.2 RPC ops（protocol.py，PROTOCOL_VERSION=1）

`RpcEnvelope{v, op, req_id, args, from_plugin?}`，op ∈ `ping|health|bus.list_topics|bus.publish|bus.get_recent|bus.query`。`bus.query` 过滤字段：plugin_id/source/kind/type/conversation_id/priority_min/since_ts/until_ts/light/limit。

### 2.3 store/topic 清单（stores.py:336-368）

- stores：`messages`（topic 固定 all）、`events`、`lifecycle`、`runs`、`export`、`memory`、`conversations`（all）、`frames`（all，容量独立）
- **HOST_OWNED_STORES = {messages, frames, conversations}——RPC bus.publish 一律拒绝**（rpc_server.py:161-169），只有带 token 的 ingest 能写
- event 封装（TopicStore.publish）：`{seq, ts, store, topic, payload, index}`；index 从 payload 投影 `{plugin_id, source, priority, kind, type, timestamp, id, generation, conversation_id}`
- ingest 批格式：`{"v":1,"kind":"delta_batch","from":"control_plane","ts","batch_id","items":[{store,topic,payload}]}` 或 snapshot。payload 上限 512KB

### 2.4 宿主侧读写入口

- 写：`plugin/server/messaging/plane_bridge.py` 的 `publish_record(*, store, record, topic="all")`/`publish_snapshot`/`publish_frame`
- 读：`plugin/core/message_plane_transport.py::MessagePlaneRpcClient`；插件门面 `plugin/sdk/shared/transport/message_plane.py::MessagePlaneTransport`（publish/request/notify/subscribe/unsubscribe）；typed 客户端 plugin/core/bus/
- 订阅范例：`plugin/server/messaging/proactive_bridge.py:193-265`——SUB 连 38866、SUBSCRIBE "messages."、json.loads、PUSH 给 main_server

### 2.5 外部进程能否直接接入？

**能，但分权限**：
- **读**：外部进程可直接 zmq.SUB 连 38866 订阅任意 store 前缀，或 RPC 38865 做 bus.query/get_recent（无鉴权）——**直接可用**
- **写 events/lifecycle/runs/export/memory**：RPC bus.publish 可写——直接可用
- **写 messages/frames/conversations（真正驱动角色）**：RPC 拒绝 + ingest 需进程内 token（安全设计明确排除外部进程）。**终端桥要么做成 SDK 插件走宿主 uplink（推荐），要么大改 plane_bridge 安全模型**

---

## 3. 桌面聊天 WS 协议（main_routers/websocket_router.py）

端点：`/ws/{lanlan_name}`（行485）。**无鉴权**：accept 后校验 lanlan_name 存在，否则发 catgirl_switched 并 close。newest-socket-wins（新连接互踢旧连接）。

**会话建立**：accept → 分配 session_id（uuid4）→ 语音平面延迟认领（首条 voice-path 消息触发 MicLease 租约）。

### 3.1 客户端→服务端（JSON `{"action":...}`，节选）

`start_session`（input_type∈{audio,screen,camera,text,avatar_drop_image,user_image}, new_session, request_id）、`stream_data`（input_type, data: PCM int list 或文本）、**二进制帧 NEKO 魔数**（`<4sI` = b"NEKO"+sample_rate(16000|48000)+PCM16 LE，≤120ms）、`end_session`/`pause_session`、`voice_input_control`、`avatar_interaction`、`greeting_check`、`ping`、`screenshot_response` 等。

### 3.2 服务端→客户端（节选）

`session_preparing/started/failed/ended_by_server`、`status`（状态码机）、`subtitle`、`text`、`chat_blocks`、`audio_chunk/audio_done`、`user_transcript(_preview)`、`system`（"turn end"|"renew session"|"session end"）、`focus_state/focus_charge/focus_thinking`、`request_screenshot`、`heartbeat`、`catgirl_switched` 等。

**可用性：需小改。** 协议纯 JSON+简单二进制头，终端桥可按 `start_session{text}`/`stream_data{text}`/`end_session` 子集直连；但单角色单连接、无 token 鉴权、newest-socket-wins 互踢——跨端共用一个角色需加会话票证。

---

## 4. 人格 / system prompt 组装链路

### 4.1 角色卡字段（config/character_fields.py）

- `RESERVED_FIELD_SCHEMA`（L69，v2 `_reserved` 分层）：`voice_id`、`system_prompt`、`field_order`、`persona_override{preset_id,selected_at,source,prompt_guidance,profile}`、`ai_context{rename_events}`、`character_origin`、`avatar{...}`
- **非保留字段（角色卡自由字段）即用户自定义人设字段，运行时被当作"角色卡额外设定"渲染**

### 4.2 角色 prompt 解析（utils/config_manager/）

- `characters.py:240 aget_character_data()` 返回 9 元组；`lanlan_prompt_map[name] = _append_persona_guidance_to_prompt(_resolve_effective_character_prompt(raw), raw)`
- `_resolve_effective_character_prompt`（persona_payload.py:426）：默认 prompt → 用户 system_prompt
- `_append_persona_guidance_to_prompt`（persona_payload.py:280）：叠加 `persona_override.preset_id` 的 prompt_guidance（**preset 是完整人设时整体替换，否则 append**）
- 占位符：`main_logic/core/__init__.py::apply_role_placeholders`（{LANLAN_NAME}/{MASTER_NAME}）

### 4.3 主对话 system prompt 组装（**注入点 A**）

`main_logic/core/notify.py:142 _build_initial_prompt()`：
```
_loc(SESSION_INIT_PROMPT[|_AGENT]).format(name)      # config/prompts/prompts_sys.py:159/170
  + self.lanlan_prompt                                # 4.2 的角色 prompt
  + active_tasks_prompt
  + memory.user_directives.render_prompt_block()      # 用户禁提词块
  + prompts_directives.render_recent_topics_block()   # 防复读软提示
```
调用点：lifecycle.py:1624/2133/2594。之后追加 `/new_dialog` 响应（**persona 记忆层**）。

### 4.4 persona 记忆层渲染与 token 裁剪（**注入点 B = /new_dialog 内容**）

- `memory/persona/rendering.py::arender_persona_markdown(name, pending_reflections, confirmed_reflections, subjects=None, ...)`；裁剪 `_score_trim_entries`/`_split_persona_for_render`/`_cap_protected_entries`（protected 卡片行免预算）
- 预算（config/memory_settings.py:119-140）：`PERSONA_RENDER_MAX_TOKENS=2000`/subject、`REFLECTION_RENDER_MAX_TOKENS=2000`、encoding o200k_base；scoped 总额 16000
- `/new_dialog` 分段顺序（routes.py:3872-3947）：persona → 内心活动 → recent history → gap → holiday（注释明确为 prefix cache 优化）

### 4.5 其他 prompt 消费点（monika 三件套要覆盖的面）

- QQ：`session_instruction_service.py:749 _build_core_memory_section`、prompting.py/prompt_builder.py/scene_prompt_templates.py
- 微信：`wechat_integration/__init__.py:554 _generate_wechat_reply`（自拼 system）
- 主动搭话：`proactive_chat/break_reminders.py:81`、`generation.py:330 Phase2PromptContext.render`（Phase 2 不走 _build_initial_prompt 自己拼）

**monika 三件套最合适注入点**：
1. `notify.py::_build_initial_prompt`（追加在 lanlan_prompt 后，主对话全路径覆盖）
2. **`persona_override.preset_id` 机制随角色卡走（推荐：被所有消费点继承，包括 proactive/QQ/微信）**
3. 输出格式分层需挂 streaming.py（桌面）对应 QQ 侧 _parse_blocks 的缝隙
4. 昵称状态机运行时读写 → `ai_context.rename_events`（已有改名事件渲染链）

**可用性：注入点 A/B 直接可用（纯文本追加）；跨端共享状态需小改（persona 层新增 section 或独立 state 文件）。**

---

## 5. qq_auto_reply 回复管线节点顺序

入口：`message_dispatcher.py:426 process_messages()`（循环 qq_client.receive_message）→ handle_message（508）→ handle_private/group_message。

1. **decision**：reply_decision_node.decide(request)（权限/注意力/疲劳/ignore/relay）
2. **relay**（可选）：reply_relay_node
3. **context**：reply_context_node.build（scoped 记忆段；内部调 memory_bridge → memory_server `/internal/.../scoped_context`）
4. **model（LLM 调用点）**：reply_model_node.generate → reply_generation_service.run_primary_session_call（XML `<msg>` 输出；失败 fallback）
5. **postprocess（XML 解析）**：reply_postprocess_node.finalize（L251）：_sanitize → 剥离独立标签 → _split_dynamic_xml → ET.fromstring 校验 → `_parse_blocks`（L44，`<msg><text|emoji|sticker|poke|record|keyboard>` 块解析，失败→_parse_legacy_tags 或 _repair_xml LLM 修复 30s）→ 抽取 `<wait>` 到 outcome
6. **delivery_plan**：build_delivery_plan（reply_pipeline.py:197）
7. **delivery（人味后处理插入缝隙）**：`reply_pipeline.py::_run_delivery`（L264）：
   - `<wait>` 秒数提取（reply_buffer_service.py:242），默认值 ±40% 抖动（L315-319）
   - **有缓冲语义** → reply_buffer_service.schedule_reply（动态等待 6-20s 正态、10-16 条触发 ack 短回复、17+ 条强制总结——`_generate_ack`/`_summarize_buffered` 是现成的"合并后二次 LLM"调用点）→ 到点 deliver
   - **直投** → reply_delivery_node.deliver：逐 block `_compose_text`（CQ 码）→ `_send_text`（L156）

**人味后处理插入结论**：现有代码**没有**独立错别字/分段服务（分段由 `<msg>` 块自带、延迟由 `<wait>`+buffer 自带）。最干净缝隙：**(a) `reply_pipeline.py::_run_delivery` 内、schedule_reply/deliver 之前**（对 delivery_plan.blocks 做改写），或 **(b) `reply_delivery_node._send_text` 逐块发送处**。两处都不碰记忆/审计（record_pipeline_outcome 在外层）。

---

## 6. wechat_integration 消息流（「第二通道」参照实现）

代码：`plugin/plugins/wechat_integration/__init__.py` + `wechat_client.py`（OpenClaw HTTP API 封装）。

- **登录状态机**：start_login（qrcode）→ poll_login_status（wait/confirmed/expired/error；expired 自动换码 ≤3 次）→ confirmed 持久化 bot_token → logout
- **收**：`_run_message_loop`（1s 轮询 get_updates）→ `_handle_inbound_message` → `_generate_wechat_reply`（L554）：`config_manager.get_character_data()` 取 lanlan_prompt_map + 角色卡额外字段 + apply_role_placeholders 拼 system（**微信=主人专用通道**身份块）→ 首次会话 GET `/new_dialog/{her_name}` → `create_chat_llm_async(model="agent"档, max_completion_tokens=300)` → 滑窗 → POST `/cache`
- **发**：`_send_text_message`（需要每 user 的 context_token，ilink payload）
- **结算**：5 分钟无活动 `_cleanup_wechat_sessions` → POST `/settle`（空增量）
- **UI**：`[plugin.ui.panel]` + ui.action/plugin_entry 装饰器

**可用性：直接可用（第二通道参照实现）**——示范了外部通道接入记忆与人格的完整最小闭环（new_dialog 取人格 → 直连 LLM → /cache → /settle），终端桥可照抄此模式而不必进主对话 session_manager。

---

## 7. LLM 调用分层现状

- **统一工厂**：`utils/llm_client/factory.py:29 create_chat_llm(model, base_url, api_key, *, temperature, streaming, max_retries, max_completion_tokens, timeout, extra_body, tools, ...)` → ChatOpenAI | ChatAnthropic；异步桥 create_chat_llm_async（L143）
- **模型分档已存在**：`utils/config_manager/core_config.py:1643 get_model_api_config(model_type)`。`model_type_mapping`（L1703-1781）档位：`conversation`/`summary`/`correction`/`emotion`/`vision`/`agent`/`game_main`/`game_summary`/`realtime`/`tts_default`/`tts_custom`/`image`。每档支持自定义覆盖（ENABLE_CUSTOM_API）+ fallback_type
- memory_server 内 LLM 分档：事实提取/review/reflection 各自走 gates 选择（如 `_ais_powerful_memory_enabled` 切 promote 策略），同样走 get_model_api_config('summary'|'correction')
- **扩展点**：新增档位 = model_type_mapping 加一项 + prefix_by_type（L1798）+ DEFAULT_* 常量 + UI 配置页；调用方 `await config_manager.aget_model_api_config('<tier>')` 后 create_chat_llm_async(**cfg)。**没有中央 router**，每处调用点各自选档

**可用性：直接可用（加档位是小改）。**

---

## 8. 主动系统 proactive 入口结构

- **HTTP 入口**：`main_routers/system_router/proactive_chat_flow.py:135 POST /proactive_chat` → `proactive_service.handle_proactive_chat`（service.py:495，依赖注入的宿主回调）；`/proactive/music_played_through`；设置 `/mode`、`/settings`。ZMQ 触发旁路：messages. 前缀 → proactive_bridge → PUSH main_server
- **contracts**（framework-independent dataclass）：ProactiveChatCommand{voice_mode, is_playing_music, enabled_modes, screenshot_data, window_title, language...}、ProactiveChatResult{body, status_code, reason_code 体系}
- **sources**（sources.py:458 collect_proactive_sources 并发采集）→ **decisions**（decisions.py 纯函数门控：entry guards/activity schedule/probabilistic gate/source selection+权重）→ **generation**（generation.py 两阶段：phase1 web 筛选+关键词一次 LLM → phase2 生成，含流式与输出护栏）→ **delivery**（delivery.py DeliveryCommit 原子提交 → ProactiveMixin/ProactiveDeliveryManager 投递）

**可用性：需小改**——handle_proactive_chat 是纯函数化入口（依赖注入无 FastAPI 耦合）可直接被整合层调用；但投递端深度绑定桌面 WS/TTS，跨端主动搭话需换 delivery 实现 + 接 last_conversation_gap。

---

## 9. 插件体系对外能力

### 9.1 插件能注册 HTTP 路由/WS 吗？

**不能直接注册 FastAPI 路由/WS。** SDK "router" 是自有抽象：`PluginRouter.add_entry`/`@plugin_entry(id, ...)`，handler `async (payload) -> Result[JsonObject, SdkError]`，经 `include_router` 挂到插件实例，成为**宿主插件服务器（48916）的 action/entry**：
- HTTP：`plugin/server/http_app.py` 挂 plugins_router（/plugins、/plugin/{id}/start|stop|reload）、plugin_ui_router、llm_tools_router、runs_router、messages_router
- WS：仅平台级 /ws/run、/ws/admin，**不是**插件自定义 WS
- 主服务器侧触发：`app/agent_server/api_runtime.py:974 POST /plugin/execute`（body {plugin_id, entry_id?, args?, lanlan_name?}，agent 开关 403 门控）
- UI 面：register_static_ui/register_list_action/register_dynamic_entry（可声明 LLM 可调用工具）

### 9.2 plugin.toml manifest 字段（plugin/config/schema.py）

- `[plugin]`：必填 id（=目录名）/name/entry（module.path:ClassName）；可选 type/description/version/author/sdk 版本约束/store/config_profiles/safety/install/dependencies/short_description/keywords/passive/i18n/`[[plugin.ui.panel]]`/`[[plugin.ui.guide]]`
- `[plugin_runtime]`：enabled/auto_start/priority/timeout(≤300)/startup_failure
- 顶层允许额外段。CLI 脚手架：`plugin/neko_plugin_cli/`（init/build/install/publish）

### 9.3 terminal-bridge 桥接插件的生长路径

**做成 SDK 插件是唯一不需要改平台层的路径**（CLAUDE.md 注明平台层改动需 Escalation）：
1. `plugin/plugins/terminal_bridge/plugin.toml`（auto_start=true）
2. entry 继承 `NekoPluginBase`（plugin/sdk/plugin/base.py:43），startup 起终端 REPL（stdin 线程或 PTY）
3. **收发照抄 wechat 模式**：aget_character_data() + prompt 拼装（或直接 GET /new_dialog）+ create_chat_llm_async + POST /cache /settle；或更深度走 `ctx.push_message(**kwargs)`（base.py:185，PushMessageResult，role-aware）把终端输入注入主对话通道，回复经 message plane SUB messages. 或 bus.query 拉取回显
4. 记忆/信任：绑定 master 身份（/internal/identity/accounts/bind）或 subject_kind=participant scoped 通道
5. 若要终端直接驱动桌面主会话（同角色同 session），必须走桌面 WS 或加平台级接入点——「需大改/需 Escalation」

---

## 附：整合 MVP 关键结论速览

| 需求 | 依赖接入面 | 判断 |
|---|---|---|
| 中心记忆服务 | memory_server HTTP | **直接可用**：进程独立、契约稳定 |
| 单角色跨 QQ/微信/终端 | 轻通道自拼 prompt（wechat 范式）或主会话 WS | 轻通道直接可用；共主会话需小改（WS 鉴权+多通道并发） |
| 检索服务外挂 | message_plane SUB/RPC 读 | **直接可用**；写宿主 store 需大改（ingest token 进程私有） |
| monika 三件套进 prompt | _build_initial_prompt / persona_payload / persona_override.preset_id | 直接可用（文本注入）；跨端状态需小改 |
| MaiBot 人味后处理 | reply_pipeline._run_delivery 前缘 / reply_delivery_node._send_text | 需小改（新增 block 改写器） |
| 模型分档扩展 | core_config.model_type_mapping + create_chat_llm | 需小改（加档位） |
| 主动搭话跨端 | handle_proactive_chat（可注入）+ 换 delivery | 需小改~大改（投递层绑定桌面） |
