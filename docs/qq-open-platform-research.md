# N.E.K.O QQ 官方开放平台 bot 接入路径调研报告

> 调研对象：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/`（下称插件目录）
> 用户决策背景：弃 NapCat 转官方接口。本报告评估 open_platform 模式的功能完整度、官方限制、配置步骤、混合可行性与遗留风险，并给出切换建议。
> 官方文档核对时间：2026-09-20（bot.q.qq.com 文档更新至 2026-07/09）。

---

## 0. 架构总览（代码事实）

- 三种连接模式由 `qq_connection_mode` 单值控制：`"napcat" | "napcat_forward" | "open_platform"`（`config_store.py:99`）。
- 统一抽象基类 `QQConnectionBase`（`qq_connection.py:9-142`）定义了内部消息格式与能力属性（`needs_attention` / `supports_voice` / `supports_poke` / `receives_all_messages` / `supports_ark_cards` / `is_group_muted`）。
- NapCat 实现 `QQClient`（`qq_client.py`，2106 行，OneBot v11 正/反向 WS）；官方实现 `QQOpenPlatformConnection`（`qq_open_plat.py`，1052 行，WS gateway + `api.sgroup.qq.com` REST + `bots.qq.com/app/getAppAccessToken`）。
- 连接工厂按全局模式二选一（`__init__.py:208-236` `_make_qq_connection`）；运行时检测模式不匹配自动断开重建（`runtime_ops_service.py:42-60`）。
- open_platform 模式不启动本地 NapCat 进程（`__init__.py:740-746` `_ensure_napcat_started` 直接 return）。

---

## 1. 功能完整度：open_platform vs napcat 能力对照

### 1.1 接收侧

| 能力 | napcat (QQClient) | open_platform (QQOpenPlatformConnection) | 证据 |
| --- | --- | --- | --- |
| 私聊收消息 | 支持 | 支持（C2C_MESSAGE_CREATE） | `qq_open_plat.py:382,843-861` |
| 群聊收消息 | **全量群消息** | **仅 @bot 的消息**（GROUP_AT_MESSAGE_CREATE）；`receives_all_messages=False` | `qq_open_plat.py:207-208,382`；`qq_connection.py:116-118` |
| @bot 检测 | OneBot at 段分析 | 官方事件天然是 @ 消息，`is_at_bot` 恒 True | `qq_open_plat.py:852,896` |
| @他人解析 | 支持 | 支持（content 中 `<@!id>` 正则解析并剥离） | `qq_open_plat.py:875-886` |
| 引用 bot 的检测（is_reply_to_bot） | 支持（`_fetch_reply_content` 回查引用链） | **不支持**：`quoted_message_id: ""` 注释「暂不支持引用回复检测」 | `qq_open_plat.py:899`；`qq_client.py:956` |
| 语音转文字（收语音） | 支持（voice_transcriber + `_fetch_record_content`） | **不支持**：整段后台内容拉取被 `needs_attention` 门跳过；附件只认 `image/*` | `message_dispatcher.py:596-635`；`qq_open_plat.py:909-919` |
| 图片输入 | 支持 + VLM 描述注入 | 支持 URL 附件（`attachments` type=image）但无 VLM 注入路径 | `qq_open_plat.py:909-919`；`message_dispatcher.py:634-635` |
| 转发/合并消息展开 | 支持（`_expand_forward_segments`） | 不支持（无对应处理） | `qq_client.py:670` |
| 戳一戳/入群/禁言等 notice | 支持（poke 风暴、欢迎注入、禁言跟踪） | **全部不收**（只订阅两类消息事件） | `qq_open_plat.py:382`；`message_dispatcher.py:509-583`（notice 管线仅 napcat 生效） |
| 说话人身份 | 真实 QQ 号（跨群同 ID） | **openid**：私聊 `user_openid`、每个群一个 `member_openid`、群 `group_openid` | `qq_open_plat.py:120-139,843-905`；`settings_service.py:811-838` |
| 昵称 | sender.nickname | author 无 username，`display_name_service` 兜底 | `qq_open_plat.py:839-841` |
| 禁言状态跟踪 | 支持（OneBot notice） | **不跟踪**（基类默认 False，bot 被禁言时发送会得到 40054002 错误） | `qq_connection.py:125-131` |

### 1.2 发送侧

| 能力 | napcat | open_platform | 证据 |
| --- | --- | --- | --- |
| 群文本 | 支持 | 支持（msg_type=0） | `qq_open_plat.py:465-572` |
| 群 Markdown | 不支持（协议无） | **支持**：自动检测 MD 标记 → msg_type=2 + markdown.content | `qq_open_plat.py:512-519` |
| 群图片 | 支持 | 支持：两步上传 `/v2/groups/{gid}/files`（file_type=1）→ msg_type=7；失败降级「[图片]」文本 | `qq_open_plat.py:496-510,760-809` |
| 群语音 | 支持（`send_group_record`） | **不支持**：空实现让上层回退文本；`supports_voice=False` | `qq_open_plat.py:199-200,675-678` |
| 私聊文本 | 支持 | 支持（`/v2/users/{openid}/messages`） | `qq_open_plat.py:589-653` |
| 私聊图片 | 支持 | **不支持**：body 只发 `{"content"}`，image 段被丢弃/转「[图片]」占位（官方 C2C 其实支持 msg_type=7） | `qq_open_plat.py:632-643` |
| 私聊 Markdown | 不支持 | **未实现**（只发 content，不带 markdown 字段；官方 C2C 支持 msg_type=2） | `qq_open_plat.py:638-643` |
| 群 @ | 支持 | 支持（`[CQ:at]` → `<@!openid>`） | `qq_open_plat.py:479-481` |
| 引用回复（被动 msg_id） | 支持（[CQ:reply]） | 支持（`[CQ:reply,id]` → `body.msg_id`），**但从不带 msg_seq** | `qq_open_plat.py:477,522-523`；全文件无 msg_seq |
| message_reference（REFIDX 引用展示） | N/A | 未使用 | `qq_open_plat.py`（无该字段） |
| 表情回应（set_msg_emoji_like） | 支持 | **空桩**（返回 {}） | `qq_open_plat.py:926` |
| 戳一戳 | 支持（收发） | **不支持**：降级为文本「 (戳了戳 id)」；`supports_poke=False` | `qq_open_plat.py:203-204,655-662` |
| QQ 小表情 face | 支持 | 降级文本「[表情id]」 | `qq_open_plat.py:486-488` |
| Ark 卡片 | 不支持（基类 False） | **声明支持但无投递实现**：`supports_ark_cards=True`，提示词鼓励 `<ark>`，投递节点明确「Ark 卡片目前没有投递实现（_send_ark 无调用方）」，按未投递处理 | `qq_open_plat.py:210-212`；`reply_delivery_node.py:172-181` |
| keyboard 按钮 | 不支持（收 kwarg 不读，降级文案） | **支持**：最多 4 个 type=2 指令按钮、permission=所有人；富媒体载荷挂按钮时降级为可读文案 | `qq_open_plat.py:525-556`；`reply_delivery_node.py:143-170,283-291,335-341` |
| 主动消息 | 无限制（协议层面） | 支持（无 msg_id 即主动），受官方频控（见 §2） | `runtime_ops_service.py:216-329`（proactive 服务） |
| 输入中状态（input_notify） | OneBot set_input_status | 官方支持 msg_type=6，**未实现**（桩） | `qq_open_plat.py:1021` |
| C2C 互动召回（is_wakeup） | N/A | **未实现** | `qq_open_plat.py`（无该字段） |
| 群管理/好友/文件类 API | 大量实现 | **全部空桩**（约 130 个方法返回空 dict/[]，`get_friend_list/get_group_list` 恒空 → UI「实际联系人」页在 open_platform 下不可用） | `qq_open_plat.py:214-221,925-1052` |

### 1.3 管线行为差异（连接能力驱动）

- 注意力/心流系统整体旁路：`needs_attention=False` 使注意力门控直接放行（`attention_gate_service.py:198-200`）、私聊决策「全部回复」（`reply_decision_node.py:50-53`）、注意力衰减循环不启动（`runtime_ops_service.py:72-73`）。整个「数字生命式群聊围观」模型在 open_platform 下事实上关闭——这是设计使然（只收 @，没有可竞争的注意力）。
- 提示词切换：open_platform 用专属输出格式段（鼓励 Markdown/keyboard/ark/sticker，`prompt_fragment_templates.py:104-139`；选择逻辑 `session_instruction_service.py:368-380`）。
- 投递确认：open_platform 失败吞异常返回 None，投递节点按「未确认=未投递」严格处理（`reply_delivery_node.py:193-208,343-352`）。
- 管理员引导：第一条私聊自动成为管理员（`message_dispatcher.py:36-75`）；群内认人走「群内 ID 认领」池 + 信任账本合并 UI（`message_dispatcher.py:112-232`；`open_platform.html:193-198,275-290`）。

---

## 2. 官方接口限制（官方文档核实 + 代码佐证）

以下数字来自 bot.q.qq.com 官方文档（群消息发送页更新 2026-09-03、C2C 发送页更新 2026-08-12、事件订阅页）：

### 2.1 消息频控

| 维度 | 群聊 | 私聊 (C2C) |
| --- | --- | --- |
| 被动回复有效期 | msg_id **5 分钟**内有效 | 页首写 **60 分钟**（字段表写 5 分钟，官方文档自相矛盾，建议按 5 分钟保守设计） |
| 被动回复次数 | 每条消息最多 **5 次** | 每条消息最多 **4 次** |
| msg_seq | 不填默认 1；**相同 msg_id+msg_seq 重复发送失败**（错误码 40054005 消息被去重） | 同左 |
| 主动消息（bot 维度） | 认证 60/qpm；未认证 30/qpm | 认证 10/qps；未认证 5/qps 且 30/qpm |
| 主动消息（单关系） | 20/qpm，**每群每天 1000 条** | 20/qpm，每好友每天 1000 条 |
| 互动召回 | — | 用户互动后 30 天内 4 个周期（当天/1-3 天/3-7 天/7-30 天）各 1 条（is_wakeup 字段） |

**代码影响**：
- N.E.K.O 的普通回复块不带 msg_id（走 `send_group_message` 纯文本，`reply_delivery_node.py:293`）→ **全部按主动消息计费**。个人/小群规模（每群 1000 条/天）完全够用，但 20/qpm 单关系限制意味着人味多块连发（块间 2-5 秒）在快节奏对话中可能触发 40034100。
- 带 `[CQ:reply]` 的块（人味 quote_previous 纠正段、LLM `<reply>` 标签）会携带 msg_id → 被动回复；**代码从不发 msg_seq**（`qq_open_plat.py` 无该字段）→ 对同一条用户消息的第二次引用回复必被去重拒绝（40054005）。这是确定性 bug，只是触发面窄（仅引用块）。

### 2.2 内容能力权限

- **Markdown**：模板字段（template_id）已废弃、可直发 markdown.content；但错误码表仍保留 304036/40034127「无 Markdown 模板权限，请先申请」→ 部分机器人（按类目/资质）无 markdown 权限，整条消息会失败。代码的「自动检测 MD 标记切 msg_type=2」（`qq_open_plat.py:512-519`）意味着 LLM 偶发输出 `*`/`#`/`~~` 就会踩这个权限——**中等风险，建议加开关或申请权限**。
- **Keyboard**：自定义 rows 官方支持；按钮 label **最多 10 字符**（render_data.label），行/列超限报 40034029。代码限制 4 按钮（`reply_postprocess_node.py:160-170`）但**不截断 label 长度** → 选项文案超 10 字会整条失败。
- **富媒体**：群/私聊均支持 msg_type=7（file_info 来自 files 上传接口）；代码只实现了群图片上传。
- **消息内容**：URL 可能被拒（40054010 不允许发送 URL）、内容违规 40034006、机器人被禁言 40054002、用户拒收 40054013（C2C）。

### 2.3 入驻与事件订阅

- 注册：q.qq.com（QQ 开放平台）创建机器人，拿 AppID + AppSecret（官方「启动接入」页，Token 鉴权已废弃，走 getAppAccessToken——与代码一致 `qq_open_plat.py:153,737-754`）。个人身份证或企业认证决定主动消息频控档位。
- 群聊能力需**审核上线**；审核期用**沙箱**（后台配测试群/测试人）。插件 UI 引导文案与此一致（`open_platform.html:108-110,137-138`）。
- 事件订阅有权限控制：基础事件（GUILDS/PUBLIC_GUILD_MESSAGES/GUILD_MEMBERS）外都需申请，「传递了无权限的 intents，websocket 会报错并直接关闭连接」（官方事件订阅页「权限」节）。
- **代码隐患**：握手 intents 为 `(1 << 25) | (1 << 12)`（`qq_open_plat.py:278`）。官方定义 `GROUP_AND_C2C_EVENT (1 << 25)` 覆盖 C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE（**正确**）；但 `1 << 12` 是 **DIRECT_MESSAGE（频道私信）**——本连接器根本不处理 DIRECT_MESSAGE_CREATE 事件（`_receive_loop` 只认两类，`qq_open_plat.py:382`），而未申请频道私信权限的机器人订阅该位**可能导致 WS 鉴权被拒断连**。建议去掉 `| (1 << 12)`。
- **身份语义**（官方「唯一身份机制」）：同一用户在不同群 member_openid 不同、私聊又是 user_openid。代码已在模块头注释中完整论证并实现了降级方案（`qq_open_plat.py:18-54`）：身份作用域登记 `("open", "per_conversation", "global")`（`settings_service.py:825-838`）、认领池、信任账本人工合并/撤销、作用域告警。这是整个 open_platform 路径工程质量最高的部分。

### 2.4 对「AI 伴侣群聊/私聊」场景的实际影响

1. **群聊形态质变**：只收 @bot 消息 → 旁听、注意力争夺、心流、回溯补回、冰场破冰、群成员记忆触发（全部依赖全量消息流的子系统）失效或空转。bot 从「群里的猫娘」退化为「@ 才应答的官方助手」。对 N.E.K.O 的核心卖点（数字生命式陪伴）是最大伤害。
2. **主动陪伴受限但够用**：主动插话/私聊主动消息走主动配额（每群/每好友 1000 条/天、20/qpm 单关系）——个人伴侣场景数量级完全够；但「未认证 30/qpm」的 bot 维度限流在多群并发时需注意。
3. **语音全链路不可用**：收语音不能转文字、发语音无实现 → reply_mode=voice/both 退化为纯文本（`voice_reply_service.py` 的 fallback 路径已接好，`reply_delivery_node.py:354-386`）。
4. **人味交互件缺失**：戳一戳、表情回应、QQ 小表情、戳一戳风暴——全部降级或消失。
5. **身份碎片化**：主人在每个群要单独认领一次 ID；跨群信任/记忆不连续（有合并 UI 缓解，但纯手工）。私聊与群里的「同一个人」在系统内是三个不同 ID。
6. **被动回复窗口**：群 5 分钟——LLM 生成 + 人味缓冲（reply_buffer 可能延迟投递）超 5 分钟后引用回复失效（错误 40034005），但普通块是主动消息不受影响。

---

## 3. 配置步骤（完整清单）

### 3.1 平台侧（q.qq.com）

1. 注册 QQ 开放平台账号（个人身份证认证可解锁 60qpm 群主动档位；未认证 30/qpm）。
2. 创建机器人应用 → 「开发设置」获取 **AppID** 和 **ClientSecret**。
3. 沙箱配置：添加测试群 + 测试人员（审核通过前仅沙箱可用群聊）。
4. （正式使用群聊）提交上架审核。

### 3.2 插件侧

UI 路径（推荐）：插件首页选「QQ 开放平台」卡片 → `open_platform.html`：
1. 「配置 → 连接」页填 AppID / ClientSecret（`open_platform.html:154-159`）。
2. 「保存设置」（doSave 提交 `qq_connection_mode=open_platform` + 两个凭证，`open_platform.html:294`；页面 bootstrap 时也会自动 save 一次 mode，`open_platform.html:326`）。
3. 侧边栏「启动」（doStart：先 save_settings 再 start_auto_reply，`open_platform.html:295`）。
4. 验证：私聊 bot 一句（首个私聊者自动成为管理员，`message_dispatcher.py:36-75`）；沙箱群里 @bot。
5. 群内认人：成员在群里 @bot 发言 → 「配置 → 用户 → 群内 ID 认领」刷新 → 「加入名册」或「合并到已有身份」（`open_platform.html:193-198,275-290`）。找不到 ID 时勾选 identity_probe 开关到日志页翻（200 行上限自动停）。

RPC 路径（等效）：`save_settings` entry，schema 已含 `qq_connection_mode`（enum 三值）、`qq_open_app_id`、`qq_open_client_secret`、`qq_open_identity_probe_enabled`（`__init__.py:1165`；落盘 `settings_service.py:928-944`）。

### 3.3 business_config.json 涉及键（`config_store.py:99-108`）

| 键 | 值 | 说明 |
| --- | --- | --- |
| `qq_connection_mode` | `"open_platform"` | 全局单选 |
| `qq_open_app_id` | AppID 字符串 | 必填，缺失时 connect() 抛 RuntimeError（`qq_open_plat.py:228-229`） |
| `qq_open_client_secret` | 密钥字符串 | 必填，同上 |
| `qq_open_identity_probe_enabled` | bool，默认 false | R11 取证开关，排障才开 |

`onebot_url` / `token` / `napcat_directory` 等键保留在配置中但该模式不消费；无需本地 NapCat、无需扫码登录。

---

## 4. 混合模式可行性

**结论：当前是全局单选，不支持按群/按场景混用。**

证据：
- `qq_connection_mode` 是 `business_config.json` 顶层单值（`config_store.py:99`），无 per-group / per-conversation 结构。
- 一个插件实例只持有一个 `qq_client`，`_make_qq_connection` 按全局模式二选一（`__init__.py:208-236`）。
- 启动时按全局 expected mode 对比现有 client 的 `mode` 属性，不匹配则断开重建（`runtime_ops_service.py:42-60`）——不存在双连接并存。
- 消息管线（dispatcher/pipeline/memory）全部面向单一 `plugin.qq_client`。

变通方式与代价：
1. **时间切换**（零开发）：UI 顶栏「切换到 NapCat / 切换到 QQ 开放平台」按钮即时换模式（`open_platform.html:87`、`napcat.html:103`），保存后重启自动回复生效；会话缓冲跨切换保留（通道观测戳设计，`qq_client.py:33-39`）。适合「白天官方、夜里个人号」这类时间维度混用，不能同时在线。
2. **双插件实例**：插件按 plugin_id 安装，同 id 只能装一份；装两份需改 plugin_id 重打包，且记忆/信任体系不共享——不现实。
3. **真·按群路由混合**：需新开发（消息维度路由到两个连接实例 + openid/QQ 号两套身份缝合）。身份体系不一致（`settings_service.py:825-831` 明确两行作用域语义不同）导致记忆 scoped key 无法自然对齐，工程量大、语义风险高——**不建议做**。

---

## 5. 遗留风险与完成度评估

### 5.1 测试覆盖（对比）

| 路径 | 测试 | 规模 |
| --- | --- | --- |
| open_platform 事件转换 | `tests/unit/test_qq_open_plat_convert_event.py` | 87 行（group_openid 回落、私聊 group_id 空） |
| open_platform 身份/作用域/认领/合并/告警/取证 | `test_qq_open_platform_actor_identity.py` + `test_qq_open_platform_identity_scope.py` | 1018 + 953 行，非常扎实 |
| **open_platform 发送路径**（segments 转换、keyboard、markdown、图片上传、token/握手/重连） | **无** | 0 |
| napcat 路径 | forward_client / onebot_segments / napcat_shortcircuit / image_content / humanize 等 | 多文件 |

结论：open_platform 的**接收-身份-记忆缝合层是生产级**（约 2000 行针对性测试）；**发送层与连接生命周期层没有测试**，成熟度明显低于 napcat。

### 5.2 已确认的缺陷/缺口（按严重度）

1. **Ark 卡片「鼓励但发不出」**：提示词主动鼓励 LLM 输出 `<ark>`（`prompt_fragment_templates.py:122,138`），投递层却无实现、按未投递记账（`reply_delivery_node.py:172-181`）。用户会看到 bot「想说卡片」却什么都没收到（未投递块还会影响记忆侧 mention 记录）。
2. **无 msg_seq**：同一 msg_id 的第二条被动回复必被平台去重拒绝（40054005）。触发面：人味 quote_previous 多段纠正、voice 路径 reply_message_id。修复简单（per-msg_id 计数器递增）。
3. **intents 多订 `1<<12`（频道私信）**：连接器不处理该事件；官方明示订阅无权限 intents 会被断连（`qq_open_plat.py:278`）。对没申请频道私信权限的机器人是连接期隐患。
4. **私聊富媒体缺失**：官方 C2C 支持 msg_type=7，代码只发 content；表情包在私聊发不出（`qq_open_plat.py:632-643`）。
5. **markdown 自动检测 + 权限风险**：LLM 偶发 markdown 标记即切 msg_type=2；无权限的机器人整条失败（304036），且失败被吞成 None（`qq_open_plat.py:512-519,569-572`），排障只能翻日志。
6. **按钮 label 无长度校验**：官方上限 10 字符（40034029/305007），代码不截断（`qq_open_plat.py:536-556`）。
7. **错误码全部吞掉**：频控（40034100）/违规（40034006）/去重（40054005）/禁言（40054002）在日志里都是同一条「发送群消息失败」，无差异化处理（无退避、无降级、无用户提示）。
8. **联系人体系空桩**：`get_friend_list/get_group_list` 恒空（`qq_open_plat.py:217-221`），UI「实际联系人」页在该模式下无数据（dashboard `actual` 恒空列表，`dashboard_service.py:105-110`）。
9. 小问题：事件 `timestamp` 用本地 `time.time()` 而非事件内时间（`qq_open_plat.py:851,895`）；`_handshake` Identify 后只等一条消息，若服务端先推非 READY 事件会误判鉴权失败（低概率）；`mentions_all` 恒 False（该通道下无实际影响）。

### 5.3 它是不是和 napcat 一样的生产级路径？

**不是。** 定性：接收/身份/记忆缝合层生产级（甚至超过 napcat 的语义严谨度）；发送层是「主干可用、边角未磨」：文本/图片/按钮/主动消息可用，引用回复有去重 bug，ark 只有声明没有实现，私聊富媒体缺失，连接层（intents、错误处理）有两处隐患，且全无发送测试。napcat 路径 2106 行实现 + 多年实战打磨；open_platform 1052 行中约 130 行是空桩。

---

## 6. 结论与建议

### 结论

**不建议现在直接整体切换 open_platform。** 决定性理由不是代码完成度，而是产品形态：

- N.E.K.O 的核心体验（旁听群聊 + 注意力心流 + 主动插话 + 语音 + 表情/戳一戳互动）在官方 bot 模型下**结构性缺失**——官方 bot 只能是被 @ 的助手，收不到全量群消息，发不了语音，做不了表情互动。
- 官方通道的真实收益是：合规零风控风险、无需本地 NapCat 进程与扫码、部署简单（AppID+Secret 即接）、群/私聊身份体系有完整工程化支撑。
- 官方频控（每群/每好友 1000 条/天主动消息）对个人伴侣场景完全够用，不是阻碍。

### 建议路线（按优先级）

1. **保留 napcat 为主通道**（若 AI 伴侣体验不可让步），open_platform 作为「合规备胎」随时可切（配置切换即生效，见 §3/§4）。
2. **若决意弃 NapCat**：接受产品形态从「群友」变「群助手」，按 §3 步骤迁移，并在切换前修掉 §5.2 的 1/2/3 三项（ark 提示词收敛或补实现、msg_seq 递增、intents 去掉 1<<12）——三者都是小改动。
3. **混合模式不做**：全局单选 + 时间切换已覆盖「按需合规」诉求；真按群路由的双通道改造成本高且身份缝合风险大。

### 迁移步骤清单（若执行切换）

1. q.qq.com 注册（建议完成个人身份证认证，解锁 60/qpm）→ 创建机器人 → 记录 AppID/Secret。
2. 后台沙箱配测试群 + 测试人。
3. 插件 UI 切「QQ 开放平台」→ 填凭证 → 保存 → 启动；确认日志出现「token 已获取 / 已就绪」。
4. 私聊 bot 一句（自动成为管理员）→ 沙箱群 @bot 验证收发。
5. 逐群认领：成员 @bot 发言后到「群内 ID 认领」页加名册/合并身份。
6. 把 `reply_mode` 设为 `text`（语音路径在该模式必回退，避免日志刷警告）。
7. 观察日志：出现 304036（无 markdown 权限）→ 改 `format_prompt_section_open_platform` 提示词禁 markdown 或向平台申请权限。
8. 提交上架审核（开放平台后台）。
9. 切换后首周盯：40034100（主动频控）、40054005（msg_seq 去重）、40054013（用户拒收）。

### 切换前建议的代码修复（小改动清单）

| 修复 | 位置 | 说明 |
| --- | --- | --- |
| intents 去掉 `(1 << 12)` | `qq_open_plat.py:278` | 防无频道私信权限时断连 |
| msg_seq 递增 | `qq_open_plat.py:522-523` 附近 | per-msg_id 计数，规避 40054005 |
| ark：从提示词删 `<ark>` 段或补投递 | `prompt_fragment_templates.py:104-139` / `reply_delivery_node.py:172` | 消除「鼓励输出但发不出」 |
| keyboard label 截 10 字符 | `qq_open_plat.py:536-556` | 规避 40034029 |
| markdown 自动检测加开关 | `qq_open_plat.py:512-519` | 无权限机器人保底纯文本 |
| 发送失败日志带错误码/HTTP status | `qq_open_plat.py:569-572,650-653` | 排障必需 |

---

## 附：关键文件绝对路径

- 连接抽象基类：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/qq_connection.py`
- 官方平台连接器：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/qq_open_plat.py`
- NapCat/OneBot 客户端：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/qq_client.py`
- 配置存储：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/config_store.py`
- 连接工厂/模式切换：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/__init__.py`（208-236、740-746、1165）
- 运行时启停与模式重建：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/runtime_ops_service.py`（16-100、216-329）
- 投递节点（能力降级逻辑）：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/reply_delivery_node.py`
- 身份作用域声明：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/settings_service.py`（811-894）
- 消息分发/认领/告警：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/message_dispatcher.py`
- open_platform UI：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/static/open_platform.html`
- 测试：`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/tests/unit/test_qq_open_plat_convert_event.py`、`test_qq_open_platform_actor_identity.py`、`test_qq_open_platform_identity_scope.py`

## 附：官方文档来源

- 事件订阅与通知（intents 定义与权限）：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- 发送群聊消息（频控/msg_seq/错误码）：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
- 发送单聊消息（C2C 频控/互动召回）：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
- 启动接入（注册/AppID/AppSecret）：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_openid_messages.post.html
