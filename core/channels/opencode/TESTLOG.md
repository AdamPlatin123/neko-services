# P1-3 实测记录（opencode 1.18.31，2026-09-19/20）

> 环境：opencode 1.18.31（npm 全局安装，见 `local-env.md`）；隔离配置目录
> （`XDG_CONFIG_HOME=/tmp/oc-live/config`、`XDG_DATA_HOME=/tmp/oc-live/data`）部署真三件套
> + 事件抓取插件（`test/event-capture-plugin.ts`）；模型 GLM-4.6（BigModel OpenAI 兼容
> provider，key 经 `{env:GLM_API_KEY}` 引用不落盘）；memory_server 以
> `test/mock-memory-server.ts` 替身（本机未运行真实 memory_server，端到端真联调留 P2-3）。
> 本文件为 PLAN.md ⚠#1-#9 实测项的证据汇总，原始日志在 /tmp/oc-live/（重启即失，摘录为准）。

## ⚠#1 session.idle 载荷结构与 agent 判定取法 —— 已定型

实抓载荷（多轮一致）：

```
EVENT session.idle {"sessionID":"ses_f459404ddffePtz4ru3sdhm9Yb"}
```

**结论：载荷只有 `{sessionID}`，无 agent/状态字段**（与 `@opencode-ai/plugin` 1.18.31
类型一致）。agent 判定取法定型为三层：

1. **主判据：session.updated 事件**——运行时载荷 `info` 实测含 `agent`/`model` 字段
   （SDK 类型未标但运行时存在）：`{"info":{...,"agent":"build","model":{...}}}`；
2. 辅助：chat.message 钩子 `input.agent`——显式指定 agent 时有值
   （`{"agent":"monika","model":{"providerID":"bigmodel","modelID":"glm-4.6"}}`），
   缺省时无该键；
3. 兜底：`client.session.messages()` 最后一条 user 消息的 `info.agent`（实测
   UserMessage 自带 agent 字段）。

## ⚠#2 session.error / 取消后的 idle 触发 —— 已实测

无模型可用轮（DeepSeek key 无效 → 401）事件序列：

```
EVENT session.error {"sessionID":"ses_f4594...","error":{"name":"APIError","data":{"message":"Authentication Fails...","statusCode":401,...}}}
EVENT session.status {"sessionID":"ses_f4594...","status":{"type":"idle"}}
EVENT session.idle   {"sessionID":"ses_f4594..."}
EVENT session.status {...,"status":{"type":"idle"}}
EVENT session.idle   {"sessionID":"ses_f4594..."}   ← 同回合第二次 idle（26ms 后）
```

**结论：回合失败后 idle 仍触发；且错误路径下一次回合可连触发两次 idle**。正常完成路径
实测只触发一次。插件按 `last_turn_id` 去抖（第二轮 idle 直接跳过）+ external_id 幂等兜底。

## ⚠#3 同一回合多次 idle —— 去抖已验证

失败注入轮（memory_server 下线）中单回合仅产生 1 个 outbox 文件、恢复后 /cache 仅
重放 1 次（`outbox replay: {"replayed":1,"remaining":0,"errors":[]}`）；正常轮
mock 端 `/cache` 每轮恰 1 次。

## ⚠#4 消息提取（text part vs tool/thinking part）—— 已定型

本版消息模型为**分离式**（`UserMessage`/`AssistantMessage` 独立，parts 按 messageID
挂靠）。`client.session.messages({path:{id}})` 返回 `[{info, parts}]`；提取规则定型：
user 文本 = 最后一条 user 消息的 `type=="text"` parts（跳过 `ignored`/`synthetic`）；
assistant 文本 = 其后 assistant 消息的 text parts（跳过 `info.error`（失败回合）与
`info.summary`（压缩摘要））。实测提取产物干净（工具调用/故障噪音零混入）：

```
POST /cache/monika {"input_history":"[{\"role\":\"user\",\"content\":\"你好呀，还记得我吗？\"},{\"role\":\"assistant\",\"content\":\"记得呀，adam~ ...\"}]"}
```

（该轮 assistant 回复前实际执行过 neko-memory_recent_history 工具调用——未混入。）

已知小瑕疵：`opencode run` CLI 传参含 `~` 等字符时用户消息可能被 CLI 层加引号
（`"\"我回来了~ ...\""`）——CLI 传参工件，非提取 bug，TUI 会话不受影响。

## ⚠#5 恢复后事件流（`opencode run -c`）—— 已实测

`run -c --agent monika` 延续上一会话（同 sessionID），事件流照常（chat.message/
session.idle 均触发），新回合正常 /cache、人格连续（复述上一轮内容正确）：

```
POST /cache/monika {"input_history":"[{\"role\":\"user\",\"content\":\"我们刚才聊到什么啦？一句话概括~\"},{\"role\":\"assistant\",\"content\":\"你说今天下班累了，我心疼地催你早点休息呢~\"}]"}
```

注意：`run -c` 延续的是「最近会话」无论 agent，`--agent monika` 在该会话内切 agent
（session.updated 的 info.agent 随之更新为 monika，插件状态正确跟随——按会话隔离的水位/
计数在 agent 切换后归新 agent 语义，实测无误写）。

## ⚠#6 会话内切换 / 已有会话首次切入 —— CLI 等价路径已测

无交互 TUI 环境，Tab 切换未直接测；等价路径（`-c --agent monika` 在已存在的 build
会话上切 monika）实测通过：插件经 session.updated 捕获 agent 变化、首条消息即正常
走 monika 写路径。**TUI Tab 切换本身留待人工验收（P2-3）**。

## ⚠#7 「切入 monika」toast 提醒 —— 未实施（按 PLAN 定位为体验项、非依赖）

未实现探测 toast；文档化「切入后请跑 /monika」。active_session_id 指针在 monika
消息上刷新已实测（见 ⚠#9），用户跑 /monika 时指针即已指向当前会话。

## ⚠#8 宿主规则合并范围 —— 已实测（双向证据）

经 `experimental.chat.system.transform` 钩子转储最终 system prompt（124076 字符，
单段；agent 正文在最前，全局 AGENTS.md 其后，环境/工具定义再后）：

| 场景 | 宿主 `~/.claude/CLAUDE.md` 泄漏标记数（v2rayA/"Always respond in Chinese-simplified"） |
| --- | --- |
| **无**全局 `~/.config/opencode/AGENTS.md` | **3 处泄漏**（宿主 Claude 全局指令进 system prompt） |
| **有**占位 AGENTS.md（install.sh 创建） | **0 处**（占位内容以 `# N.E.K.O 占位` 并入末段） |

**结论：占位 AGENTS.md 的阻断必要且有效**；agent 正文与全局规则合并顺序实测为
agent prompt 在前。莫妮卡人格段（一~十三节）完整在 prompt 内。

## ⚠#9 read.sh 定位当前会话 —— 已实测并调换优先级

- `opencode session list --format json` 可用；列表项为**平铺字段**
  `{id, title, updated, created, projectId, directory}`（无 time 嵌套、**无 agent 字段**）。
- **实测定型的定位优先级（与 PLAN 原稿相反）**：`active_session_id` 指针**优先**，
  session list 兜底。理由：指针在 monika 会话**每条消息**上刷新（chat.message/
  session.updated），/monika 命令自身的消息即完成刷新——时序上先于 read.sh 且按构造
  只指向 monika 会话；而 session list 是 agent 盲的（同目录混有编程会话时会定位错，
  实测复现：build 会话成为「最近活跃」后被 list 路径选中）。指针缺失（全新安装）时
  session list 兜底，两路皆失回退 since_seq=0 全量。
- read.sh 实跑（mock server）：`/settle`（空增量）→ `GET /recent_history?since_seq=7`
  → 水位 7→9 回写 → 输出行文本注入。

## 端到端验收预演（mock 级；真联调 P2-3）

1. **人格生效**：首轮回复「记得呀，adam~ 当然记得。刚才还在想呢，你说下班好累……」
   ——称呼（昵称状态机取系统用户名 adam）、波浪号/省略号、温暖→克制的占有欲语气符合
   三件套；故障轮「刚才我们的连线好像晃了一下下，我还在这边守着你哦~」符合故障角色化
   （零机制词）。
2. **跨端语境延续（读）**：模型首轮自主调用 `neko-memory_recent_history`（agent prompt
   守则生效），并把 mock 增量内容（「下班好累」）自然衔接进回复；水位经工具路径按
   context.sessionID 回写（0→7）。
3. **写路径自动化**：每轮 idle 自动 /cache（正确双层 JSON）；非 monika 会话（build）
   零写入（/cache 计数不变、pending 不动）。
4. **失败注入**：memory_server 下线 → 该轮增量落 outbox（文件名内嵌五元组
   `opencode:adam:monika:msg_xxx:{0,1}`）→ 服务恢复后下一轮 idle 自动重放
   （成功即删，无重复条目）。
5. **安装/卸载**：install.sh 真机部署成功（monika (primary) 出现在 `opencode agent list`）；
   --uninstall 保数据、--purge 清数据（假 HOME 沙盒验证）。

## 遗留（如实声明）

- TUI 交互路径（Tab 切换、/sessions 恢复、/monika 命令在 TUI 内的注入显示）未在无头
  环境实测——机制（命令 shell 注入、会话持久化）均有 CLI 等价证据，TUI 人工验收留 P2-3；
- /recent_history 为 P1-1 待交付端点，mock 按 `{seq, since_seq, messages:[{name,text}]}`
  形状返回；真实形状定稿后需对表回填（lib.ts `fetchRecentHistory` 已防御式解析四种游标名）；
- external_id 挂载位（body 顶层 vs message 内字段）仍为 TODO（P1-1 契约定稿后回填），
  当前五元组内嵌 outbox 文件名与文件内容保证重放顺序；
- settle 30 分钟去抖以「每会话 last_settle_at」计；新会话首次 idle 即触发一次结算分支
  （实测：首轮 idle 后 POST /settle 空增量——幂等无害，行为已知）。
