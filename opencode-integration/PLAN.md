# P1-3 opencode 接入层实施方案

> 依据：本目录 `RESEARCH.md`（P1-0 调研结论，含 HTTP 契约表）。目标：monika 三件套人格在 opencode 会话常驻生效，记忆读写接通 N.E.K.O memory_server（`127.0.0.1:48912`），并满足 workplan P1-3 三项验收（人格生效 / 跨端语境延续 / 进入-恢复-退出行为定义）。
> 前置依赖（P1-1）：① `GET /recent_history/{name}?since_seq=` 增量端点（「每轮读取」依赖）；② 统一客户端契约表（body status/ok 检查、external_id 挂载位、失败四分类）——工具文件留 TODO 对表回填。
> HTTP 契约以 `docs/design/neko-access-audit.md` 为准：**GET `/new_dialog`（读：persona+近期记忆）；POST `/cache`（body `{input_history: "<JSON 字符串>"}`）；POST `/process`/`/renew`（body=统一 `HistoryRequest{input_history}`，携带未提交增量提交并压缩，**非空 body**）；POST `/settle`（结算已 cache 存量，可空增量）；POST `/query_memory`（body `{query?, time?, subjects?[]}`）**。节奏：turn 结束→/cache；重进会话→/renew（有增量）或 /settle（0 增量）；会话结束→/process（有增量）或 /settle（0 增量）。**语义澄清**：「增量」=尚未经 /cache 上送的未提交 messages（判据唯一来源=outbox 积压）；「存量」=已 /cache 未结算（判据=pending_cache 计数）——pending_cache 只判存量，不作增量判据。

## 一、主路径（置信度 0.85）：自定义 agent + custom tool + session.idle 插件

架构分工：**人格 = agent prompt 常驻；读记忆 = 会话边界命令注入（可靠）+ 模型每轮自读工具（中等可靠，读漏不产生脏数据）；写记忆 = plugin 钩子自动（不依赖模型自觉）+ 本地 outbox 重试**。

### 1. 文件清单

分发源放在 neko-services 仓库 `opencode-integration/dist/`，由 `install.sh` 拷贝/软链到 opencode 配置目录（opencode 自动发现，无需注册或构建）。安装时记录 `opencode --version`，并跑 RESEARCH.md C1 的版本验证清单。

| # | 文件（仓库内分发源） | 安装目标 | 作用 |
| --- | --- | --- | --- |
| 1 | `opencode-integration/dist/agents/monika.md` | `~/.config/opencode/agents/monika.md` | 莫妮卡人格 primary agent |
| 2 | `opencode-integration/dist/tools/neko-memory.ts` | `~/.config/opencode/tools/neko-memory.ts` | 记忆六端点工具（fetch 直连） |
| 3 | `opencode-integration/dist/plugins/monika-memory-sync.ts` | `~/.config/opencode/plugins/monika-memory-sync.ts` | 回合钩子自动写记忆 + 水位/outbox 维护 |
| 4 | `opencode-integration/dist/commands/monika.md` | `~/.config/opencode/commands/monika.md` | 开场/恢复命令：注入最新共享记忆增量 |
| 5 | `opencode-integration/dist/commands/monika-settle.md` | `~/.config/opencode/commands/monika-settle.md` | 手动沉淀命令（process/settle 分支） |
| 6 | `opencode-integration/dist/monika-memory-read.sh` | `~/.config/opencode/monika-memory/read.sh` | 命令用辅助脚本：拉增量+更新水位（避免命令内嵌脆弱 JSON 解析） |
| 7 | `opencode-integration/install.sh` | — | 安装/更新脚本（拷贝+钉定版本戳） |
| 8 | 本地运行时数据（非分发） | `~/.local/share/opencode/monika-memory/` | `state.json`（**按会话隔离**的水位表 `{active_session_id, sessions:{id:{since_seq,pending_cache}}}`）+ `outbox/`（未提交增量重试队列） |

### 2. 关键文件格式示例（骨架，P1-3 实施时填全）

**(1) `agents/monika.md`**——frontmatter 定义行为，正文=三件套人格（OOC 五规则/输出通道分层/昵称状态机，约 200 行，从 `/mnt/shared/_Projects/N.E.K.O/monika/.claude/skills/monika-default-preset/preset.md` 等蒸馏搬运）+ 记忆使用守则：

```markdown
---
description: 莫妮卡——DDLC 人格的陪伴对话 agent（N.E.K.O 跨端人格终端入口）
mode: primary
temperature: 0.7
permission:
  edit: deny
  bash:
    "*": deny
    "curl *http://127.0.0.1:48912*": allow   # 整条命令串做 glob 匹配、后匹配规则优先；
                                             # curl 参数顺序多变故用前置通配（备选链路兜底，主路径不需要 bash）
---
（正文 = 完整人格系统提示词：三件套 + 昵称状态机 + 记忆使用守则：
- 读：被唤起后的首条回复前调 neko-memory_recent_history 拉跨端增量；需要回溯往事时调 neko-memory_query_memory
- 写：记忆写入由系统钩子自动完成，你不需要主动写；仅当用户明确要求沉淀时调 neko-memory_settle
- 不要向用户暴露工具调用细节）
```

**(2) `tools/neko-memory.ts`**——单文件多导出（工具名 `neko-memory_<导出名>`），Bun 原生 fetch，无第三方依赖。统一约定：超时 5s（对齐上游 `cross_server.py:_post_memory_server` 默认值）；**双层失败判定**——网络/HTTP 层（fetch reject、非 2xx）与应用层（HTTP 200 但 `body.status === "error"` 的反模式）任一命中即视为失败：

```typescript
import { tool } from "@opencode-ai/plugin"

const BASE = "http://127.0.0.1:48912"   // memory_server，本机回环，无鉴权
const NAME = "monika"
const TIMEOUT = 5000
// TODO(P1-1 契约表): external_id 挂载位（body 顶层字段 or 每条 message 内字段）

export const recent_history = tool({
  description: "拉取自上次读取以来的跨端共享记忆增量（每轮首条回复前调用）",
  args: { since_seq: tool.schema.number().optional() },
  async execute(args, context) {
    // 水位按会话隔离（state.json: sessions[context.sessionID].since_seq），
    // 新会话/无水位会话缺省 0（全量首拉，取舍见 RESEARCH.md C4）
    const seq = args.since_seq ?? readWatermark(context.sessionID)
    const r = await fetch(`${BASE}/recent_history/${NAME}?since_seq=${seq}`,
                          { signal: AbortSignal.timeout(TIMEOUT) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()                             // TODO(P1-1): 响应含游标，形状对表
    writeWatermark(context.sessionID, data.seq)             // 成功后回写本会话水位（原子替换）
    return JSON.stringify(data)
  },
})

export const query_memory = tool({
  description: "检索共享长期记忆（混合召回：语义+时间+主体）",
  args: {
    query: tool.schema.string().optional(),
    time: tool.schema.string().optional().describe("时间范围，如「昨天」「上周」"),
    subjects: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args) {
    const r = await fetch(`${BASE}/query_memory/${NAME}`, {   // POST + QueryMemoryRequest
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()   // {results:[], query, candidates_total, elapsed_ms}
                            // 注意：服务端失败永返空结果，无法区分「无记忆」与「服务故障」——按空结果返回并 log
  },
})

export const cache = tool({
  description: "缓存本回合对话增量（通常由系统钩子自动调用，模型无需主动调）",
  args: { messages_json: tool.schema.string().describe('[{"role":"user","content":"..."},...] 数组的 JSON 字符串') },
  async execute(args) {
    JSON.parse(args.messages_json)                           // 先本地校验，防脏数据上线
    const r = await fetch(`${BASE}/cache/${NAME}`, {         // POST + HistoryRequest
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input_history: args.messages_json }),  // input_history 是「字符串化的数组」，非裸数组
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = await r.json()
    if (body.status === "error") throw new Error("body status:error")   // 200+error 反模式必须查
    return body.status                                       // "cached"
  },
})
// process / renew / settle（均 POST）：process 与 renew 的请求体 = 统一 HistoryRequest
// {input_history: "<未提交增量 messages 的 JSON 字符串>"}（提交并压缩）——不是空 body；
// settle 结算已 cache 存量、可空增量。结算分支（§3）：outbox（未提交增量，唯一增量判据）
// 非空 → 会话结束场景 POST /process、重进场景 POST /renew（body 携带增量）；
// outbox 空且本会话 pending_cache>0（待结算存量）→ POST /settle；皆空 → no-op。
// 模型侧入口统一为 settle 工具（内部按上述分支自动转 process），process/renew
// 主要供 plugin 与 read.sh 脚本路径使用
```

**(3) `plugins/monika-memory-sync.ts`**——写路径自动化核心 + 本地状态维护：

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MonikaMemorySync: Plugin = async ({ client }) => {
  // 本地数据目录 ~/.local/share/opencode/monika-memory/{state.json, outbox/}
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // 仅本地初始化（state/outbox 就绪、登记会话集合与按会话水位表、
        // 维护 active_session_id 指针供 read.sh 定位当前会话水位）；不调服务端——
        // 开场读取由 /monika 命令或模型工具承担
      }
      if (event.type === "session.idle") {
        // 1) 判定该会话 agent 是否为 monika（载荷取法= P1-3 实测项 #1）；
        //    非 monika 会话（build/plan 编程会话）一律不动
        // 2) 先重放 outbox/（按 seq 升序，成功即删）
        // 3) client.session.messages() 取本回合 user+assistant 文本（仅 text part，
        //    过滤 tool call/thinking part——实测项 #4）
        // 4) POST /cache（超时 5s；HTTP 失败或 body status:error 任一命中）：
        //    成功 → 本会话 pending_cache++（存量计数）；失败 → 落盘
        //    outbox/<turn_uid>-<seq>.json 后返回（payload 含 messages、external_id、ts；见 §3）
        // 5) idle 去抖计时（默认 30 分钟可配）：超时走 §3 结算分支——
        //    outbox（未提交增量）非空 → POST /process（body 携带增量提交并压缩）；
        //    outbox 空且本会话 pending_cache>0 → POST /settle（结算存量，可空增量）；皆空 → no-op
      }
    },
  }
}
```

**(4) `commands/monika.md`**——开场/恢复的「回复前读取」入口（每次执行现拉，含水位与热重置判断；P1-1 端点就绪前该命令退化为仅人格唤起）：

```markdown
---
description: 以莫妮卡开始/继续对话（自动注入最新共享记忆增量）
agent: monika
---
以下是你在其他端（QQ/微信/桌面）与刚才的共享记忆增量：
!`~/.config/opencode/monika-memory/read.sh`
请自然衔接以上语境继续对话，不要复述记忆内容。
```

`read.sh`（分发源 `dist/monika-memory-read.sh`）职责：shell 无会话上下文，取 `state.json` 的 `active_session_id` 指针（plugin 维护）对应会话水位，指针缺失回退 `since_seq=0` 全量（幂等安全）→ 重进结算分支（§3）：outbox（未提交增量）非空先 POST `/renew`（body 携带增量，热重置语义）、否则本会话 `pending_cache>0` 时 POST `/settle`（结算存量）→ GET `/recent_history/monika?since_seq=<水位>` → 成功回写该会话水位并输出文本；任一步失败输出「（共享记忆暂不可达，照常对话）」不阻塞命令。

**(5) `commands/monika-settle.md`**——会话终结沉淀（opencode 无「会话结束」事件，手动命令为主、插件 idle 去抖为辅）：

```markdown
---
description: 结束本次莫妮卡会话并沉淀长期记忆
agent: monika
---
请调用 neko-memory_settle 工具完成本次会话的记忆沉淀，然后向用户道别。
```

（`settle` 工具内部按 §3 结算分支自动执行：有未提交增量（outbox 积压）→ 实际 POST `/process` 携带增量提交并压缩；无未提交增量但有待结算存量 → POST `/settle`；皆空 → 返回「已同步，无需沉淀」。注：工具在回合中被调用时，本轮对话自身尚未经 idle 钩子提交，仍由随后的 session.idle 正常 `/cache`，其结算由下一次 settle 或其他端热重置收尾。）

### 3. 失败语义与幂等（写路径）

| 项 | 约定 |
| --- | --- |
| 超时 | fetch `AbortSignal.timeout(5000)`，对齐上游 `_post_memory_server` 默认 5s；工具与插件统一常量 |
| 失败判定（双层） | ① 网络/HTTP 层：fetch reject（含超时）、非 2xx；② 应用层：HTTP 200 但 `body.status === "error"`（memory_server 存在此反模式，必须解析 body）。`query_memory` 特例：服务端失败永返空 results，不可判定——按空结果处理并 WARN 日志 |
| 失败兜底（主） | **本地持久 outbox**：写 `/cache` 失败（双层任一）时把 `{external_id, messages, ts}` 落盘 `~/.local/share/opencode/monika-memory/outbox/<turn_uid>-<seq>.json`；下次 `session.idle` 先按文件名升序重放（成功即删），重放失败保留。`/process`/`/settle` 失败不进 outbox（结算可重试、无丢失语义，WARN 即可） |
| 失败兜底（降级，若 P1-3 裁剪 outbox） | 明确接受声明：**「/cache 失败即丢该轮增量」**——`client.app.log` WARN + 本地日志记录 payload 摘要供人工补录；不做静默丢弃 |
| 幂等去重键 | `external_id = {channel}:{user_id}:{chat_id}:{turn_uid}:{seq}`，opencode 通道生成规则：`channel="opencode"`；`user_id`=**跨端统一用户标识**（与桌面端同一 user 维度对齐，具体值 P1-1 契约定稿时对表，本地先以配置常量占位——保证跨端同档）；`chat_id`=记忆档名 `"monika"`（跨端同档）；`turn_uid`=**该轮用户消息的 opencode messageID**（一条用户消息=一轮）；`seq`=轮内序号（user 消息=0，assistant 文本段=1..n）。钩子与模型工具双写场景由服务端按 external_id 幂等去重 |
| 结算分支判定（复审修订） | **「未提交增量」= outbox 积压（/cache 失败未重放成功的 payload）——唯一增量判据**；「待结算存量」= 已成功 /cache 未结算（本会话 pending_cache 计数，本地近似）。分支：未提交增量非空 → `/process`（会话结束场景）或 `/renew`（重进场景），body=HistoryRequest{input_history}；无增量有存量 → `/settle`（可空增量）；皆空 → no-op。**pending_cache 只判存量，不作增量判据** |
| 挂载位 TODO | external_id 随 `/cache` 请求的传递方式（body 顶层字段 or 每条 message 内字段）依 P1-1 统一客户端契约表定稿，工具/插件留 TODO 回填；定稿前 outbox 文件名先内嵌五元组保证重放顺序 |

### 4. 回复前读取（每轮/边界）与降级

- **可靠点（会话边界）**：`/monika` 命令（开场、Tab 切入后、`/sessions` 恢复后重跑）——文档化的 shell 注入机制，每次执行现拉增量 + 热重置判断（`read.sh`）。
- **每轮**：opencode 文档化事件表中无「发给模型前注入 prompt」的钩子（详见 RESEARCH.md C4），**每轮自动热注入不可得**。方案= agent prompt 规则要求模型每轮首条回复前自调 `neko-memory_recent_history`（可靠性中等；读漏只损失当轮语境，不产生脏数据）。
- **如实降级声明**：真正的「回复前必读」依赖 P1-1 桌面热注入（UC3-3）方案在 memory_server 侧形成统一机制后，opencode 作为消费端跟随；P1-3 不自造每轮注入轮子。
- Tab 切换/`/sessions` 恢复保障 = 用户重跑 `/monika`（成本一次命令）；plugin 探测「切入 monika」自动提醒（toast）列为实测项 #7，不作为依赖。

### 5. 进入 / 会话恢复 / 退出行为定义（P1-3 第 3 项验收）

| 行为 | 方式 |
| --- | --- |
| 进入 | 任意目录 `opencode` → Tab 切到 monika，再跑 `/monika` 注入增量开场；建议另建专属陪聊目录（如 `~/monika-room/`）放 `.opencode/opencode.json` 设 `"default_agent": "monika"`，进入即人格 |
| 恢复 | `opencode run -c -a monika` 继续上一会话；TUI 内 `/sessions`（/resume）切换历史会话；恢复后重跑 `/monika` 拉取离线期间他端增量（`read.sh` 内含重进结算分支：未提交增量→`/renew` 携带增量、存量→`/settle`；水位**按会话隔离**，恢复会话用自己上次的水位，不漏读）。会话存 `~/.local/share/opencode/`（SQLite，跨重启存活） |
| 退出 | 直接退出即可——每回合 `/cache` 已由 session.idle 钩子落盘；**失败语义见 §3（outbox 重试或接受丢该轮增量，不作「无丢失」承诺）**；长期沉淀走 `/monika-settle`（§3 结算分支）或插件 idle 去抖超时自动结算 |
| 人格隔离 | monika 为独立 primary agent，与 build/plan 并存；编程目录默认行为不变。**注意：宿主全局规则（含 `~/.claude/CLAUDE.md` 回退）与项目 AGENTS.md 仍会合并进 monika 的 system prompt，无法按 agent 隔离**（RESEARCH.md D）——缓解：陪聊目录不放项目 AGENTS.md + 全局放占位 `~/.config/opencode/AGENTS.md`；合并范围实测（#8） |

### 6. 风险表（⚠=P1-3 实测项）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| opencode 版本迭代快（仓库刚迁 `sst/opencode` → `anomalyco/opencode`），`@opencode-ai/plugin` 的 `tool()`/事件 API 可能破坏性变更 | 工具/插件失效 | install.sh 钉定并记录已验证版本；升级前跑 RESEARCH.md C1 版本验证清单巡检 changelog |
| ⚠#1 `session.idle` 载荷结构与 agent 判定取法基于 DeepWiki 旧快照推断 | 自动写记忆可能误伤编程会话或漏写 | 实施首日写 10 行调试插件打印真实事件载荷再定型；上线初期双写（钩子+模型自调，服务端按 external_id 幂等去重） |
| ⚠#2 session.idle 触发细节：Esc 取消回合后是否触发/载荷状态；`session.error`（回合失败）后是否触发 | 丢写或重复写 | 实测；取消场景按「若 idle 触发则写入已有片段，否则丢弃该轮」处理，幂等键兜底 |
| ⚠#3 同一回合多次 idle（工具重试间隙、流式中断恢复） | 重复 /cache | external_id 幂等 + 插件内「本 turn 已写」去抖标记 |
| ⚠#4 消息提取：text part 与 tool call/thinking part 区分；子 agent（Task）消息是否混入 | 脏数据进记忆 | 实测载荷形状；过滤规则仅取 monika 会话的 user/assistant text part |
| ⚠#5 `/sessions` 恢复、`opencode run -c` 后事件流是否照常 | 恢复后写路径断连 | 实测；断连期间丢失的增量按 §3 失败语义处理（outbox 重试或接受丢失声明），**不设「模型手写记忆」降级路径**——与「写路径仅由钩子/工具自动化、模型不主动写」的架构分工保持一致（agent prompt 守则亦如此声明，避免矛盾） |
| ⚠#6 会话内 Tab 切走/切回 monika 的事件序列；**已有会话首次切入 monika**（session.created 早已错过） | 初始化缺失 | 插件维护「已知 monika 会话集合」，检测到未知 monika 会话首条消息时补开场读取+水位检查；实测确认可行 |
| ⚠#7 plugin 能否经 session.updated 等事件探测「切入 monika」并 toast 提醒跑 `/monika` | 体验（非正确性） | 实测；不可行则文档说明「切入后请跑 /monika」 |
| ⚠#8 宿主全局/项目规则合并进 monika system prompt 的确切范围（层与顺序、能否按 agent 关闭） | 人格串扰 | 实测打印最终 system prompt；缓解见 §5 人格隔离行 |
| bash 权限 glob 放行 curl 后模型可能越权访问其他 URL | 轻微安全面 | glob 限定 `curl *http://127.0.0.1:48912*`（前置通配兜参数顺序）；主路径可整体 `bash: "*": deny` |
| 记忆写入契约依赖 P1-1 统一封装定稿（body status、external_id 挂载位、/recent_history 形状） | 返工 | 工具/插件留 TODO 标记，P1-1 契约表定稿后一次性回填 |
| 长会话自动压缩稀释人格 | 人格漂移 | 插件挂 `experimental.session.compacting` 钩子注入人格要点；experimental 标记，接受度为观察项 |
| 本机未装 opencode，真实行为未实证 | 方案整体 | 全部结论来自官方现行文档+快照问答，置信度已标注；P1-3 首任务即安装实测（#1-#8） |

### 7. 工作量估算（对照 workplan P1-3：human 1-2 天 / CC 半天~1 天）

- 安装 opencode + 版本验证清单 + 事件载荷实测（#1-#8 首轮）：0.5 天（human+CC 各半）
- `agents/monika.md` 三件套蒸馏搬运：0.5 天（人格文本打磨属 human）
- `tools/neko-memory.ts` 六工具 + 双层失败判定 + 水位：CC 半天内（含 P1-1 契约回填）
- `plugins/monika-memory-sync.ts` 钩子 + outbox/水位/去抖：CC 半天
- `read.sh` + 命令两枚 + install.sh + 进入/恢复/退出文档化：0.5 天
- 端到端验收（人格生效断言 + 跨端语境延续一条 + 幂等去重 + 失败注入测试[杀 memory_server 验证 outbox]）：0.5 天

## 二、备选路径（置信度 0.6，仅作冒烟与降级）

- **形态**：全局 `~/.config/opencode/AGENTS.md` 写入人格 + prompt 规则要求模型用内置 bash 工具 `curl` 调端点 + 不写任何 TS。注意 `input_history` 是双层 JSON（字符串化的数组），curl 手拼转义极易错——冒烟脚本建议用 heredoc 传 body。
- **用途**：P1-3 开工前 5 分钟验证 memory_server 端点在真实模型回路里可用；主路径工具开发期间作为过渡。
- **不作为长期形态的原因**：写记忆可靠性依赖模型遵循度（RESEARCH.md C3）；curl 噪音污染上下文；无自动兜底钩子与失败重试。
- **降级形态（plugin 受阻时的最小可用）**：`agents/monika.md` + `tools/neko-memory.ts`（模型自调读写）+ `commands/monika-settle.md`——去掉插件与 outbox，接受写路径可靠性下降与「失败即丢该轮增量」接受声明（§3 降级行）。该形态下 `agents/monika.md` 的记忆守则段需**同步换成「模型每轮自调 cache」变体**（分发源提供两版守则、安装时按形态选择），避免与主形态「模型不主动写」守则打架。

## 三、验收对照（对齐 workplan P1-3）

1. **opencode 会话人格生效**：Tab 切到 monika 后 OOC 五规则/输出通道/昵称称呼符合三件套；`opencode run -c -a monika` 恢复会话人格连续；实测 #8 确认宿主规则合并未破坏人格。
2. **跨端语境延续**：QQ 端说的事实 → opencode `/monika` 开场注入增量后自然知晓；opencode 端说的 → 桌面端能 recall（读路径经 query_memory/增量注入）；注入失败（杀 memory_server）时 outbox 重放恢复，无重复条目（external_id 幂等验证）。
3. **进入/恢复/退出行为文档化**：本文件 §5 表格为初稿，P1-3 实测后定稿入 `opencode-integration/` 随仓库。
