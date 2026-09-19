# P1-3 opencode 接入层实施方案

> 依据：本目录 `RESEARCH.md`（P1-0 调研结论）。目标：monika 三件套人格在 opencode 会话常驻生效，记忆读写接通 N.E.K.O memory_server（`127.0.0.1:48912`），并满足 workplan P1-3 三项验收（人格生效 / 跨端语境延续 / 进入-恢复-退出行为定义）。
> 前置依赖：P1-1 的 `/recent_history/{name}?since_seq=` 增量端点（仅「回复前读增量」一条需要，其余不依赖）。

## 一、主路径（置信度 0.85）：自定义 agent + custom tool + session.idle 插件

架构分工：**人格 = agent prompt 常驻；读记忆 = 模型主动调 query 工具 + 命令注入增量；写记忆 = plugin 钩子自动（不依赖模型自觉）**。

### 1. 文件清单与格式示例

分发源放在 neko-services 仓库 `opencode-integration/dist/`，由 `install.sh` 拷贝/软链到 opencode 配置目录（opencode 自动发现，无需注册或构建）。

| # | 文件（仓库内分发源） | 安装目标 | 作用 |
| --- | --- | --- | --- |
| 1 | `opencode-integration/dist/agents/monika.md` | `~/.config/opencode/agents/monika.md` | 莫妮卡人格 primary agent |
| 2 | `opencode-integration/dist/tools/neko-memory.ts` | `~/.config/opencode/tools/neko-memory.ts` | 记忆四端点工具（fetch 直连） |
| 3 | `opencode-integration/dist/plugins/monika-memory-sync.ts` | `~/.config/opencode/plugins/monika-memory-sync.ts` | 会话/回合钩子自动写记忆 |
| 4 | `opencode-integration/dist/commands/monika.md` | `~/.config/opencode/commands/monika.md` | 进入即注入最新共享记忆的启动命令 |
| 5 | `opencode-integration/dist/commands/monika-settle.md` | `~/.config/opencode/commands/monika-settle.md` | 手动沉淀（会话终结）命令 |
| 6 | `opencode-integration/install.sh` | — | 安装/更新脚本（拷贝+版本戳） |

各文件格式示例（关键骨架，P1-3 实施时填全）：

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
    "curl http://127.0.0.1:48912/*": allow   # 备选链路兜底
---
（正文 = 完整人格系统提示词：三件套 + 昵称状态机 + 记忆工具使用守则：
开场先调 neko-memory_query_memory 检索相关记忆；用户提到新事实/偏好时调
neko-memory_cache 写入；不要向用户暴露工具调用细节……）
```

**(2) `tools/neko-memory.ts`**——单文件多导出，Bun 原生 fetch，无第三方依赖：

```typescript
import { tool } from "@opencode-ai/plugin"

const BASE = "http://127.0.0.1:48912"   // memory_server，本机回环，无凭据
const NAME = "monika"

export const new_dialog = tool({
  description: "开启一段新对话档（会话建立时调用一次）",
  args: {},
  async execute() {
    const r = await fetch(`${BASE}/new_dialog/${NAME}`, { method: "POST" })
    return await r.text()
  },
})
export const cache = tool({
  description: "缓存本回合对话原文（每回合结束后写入共享记忆）",
  args: {
    role: tool.schema.string(),      // "user" | "assistant"
    content: tool.schema.string(),
  },
  async execute(args) {
    const r = await fetch(`${BASE}/cache/${NAME}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    })
    return await r.text()
  },
})
// settle / query_memory 同构；query_memory 带 query 参数走 GET
```

（请求体字段以 P1-1 统一客户端封装的契约表为准——`opencode-integration/dist/` 内留 TODO 标记，P1-1 契约定稿后回填。）

**(3) `plugins/monika-memory-sync.ts`**——写路径自动化核心：

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MonikaMemorySync: Plugin = async ({ client }) => {
  const BASE = "http://127.0.0.1:48912"
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // 会话建立 → POST /new_dialog/monika（幂等由服务端保证）
      }
      if (event.type === "session.idle") {
        // 回合结束 → client.session.messages() 取本回合 user+assistant 文本
        // → POST /cache/monika（自动兜底；模型已调工具时靠服务端幂等去重，
        //    去重键沿用 external_id 规范 {channel}:{user_id}:{chat_id}:{turn_uid}:{seq}，
        //    opencode 侧 channel="opencode"，turn_uid 用 sessionID，seq 用消息序号）
      }
    },
  }
}
```

（注意：plugin 需判断当前会话的 agent 是否为 monika，非 monika 会话（build/plan 编程会话）不得写记忆。session.idle 事件载荷里 agent 标识的取法需在实施首日用真实版本打印验证——DeepWiki 快照与现行版本可能有出入，此为最大不确定点。）

**(4) `commands/monika.md`**——文档化的「回复前读增量」入口（P1-1 端点就绪后启用 curl 行）：

```markdown
---
description: 以莫妮卡开始/继续对话（自动注入最新共享记忆）
agent: monika
---
以下是你在其他端（QQ/微信/桌面）最近的共享记忆增量：
!`curl -s "http://127.0.0.1:48912/recent_history/monika?since_seq=0"`
请自然衔接以上语境继续对话，不要复述记忆内容。
```

**(5) `commands/monika-settle.md`**——会话终结沉淀（opencode 无「会话结束」事件，手动命令为主、插件 idle 去抖超时为辅）：

```markdown
---
description: 结束本次莫妮卡会话并沉淀长期记忆
agent: monika
---
请调用 neko-memory_settle 工具完成本次会话的记忆沉淀，然后向用户道别。
```

### 2. 进入 / 会话恢复 / 退出行为定义（P1-3 第 3 项验收）

| 行为 | 方式 |
| --- | --- |
| 进入 | 任意目录 `opencode` → Tab 切到 monika；或直接 `/monika` 命令（注入增量记忆开场）。建议另建专属陪聊目录（如 `~/monika-room/`）放 `.opencode/opencode.json` 设 `"default_agent": "monika"`，进入即人格 |
| 恢复 | `opencode run -c -a monika` 继续上一会话；TUI 内 `/sessions`（/resume）切换历史会话；会话存 SQLite（`~/.local/share/opencode/project/`）跨重启存活 |
| 退出 | 直接退出即可——写记忆已由 session.idle 钩子每回合落盘，无丢失窗口；长期沉淀走 `/monika-settle`（或插件 idle 超 N 分钟自动 settle，P1-3 定夺默认值） |
| 人格隔离 | monika 为独立 primary agent，与 build/plan 并存；编程目录默认行为不变。部署时放置全局 `~/.config/opencode/AGENTS.md`（哪怕空占位）阻断宿主 `~/.claude/CLAUDE.md` 被兼容加载造成串扰，或设 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` |

### 3. 风险表

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| opencode 版本迭代快（仓库刚迁 `sst/opencode` → `anomalyco/opencode`），`@opencode-ai/plugin` 的 `tool()`/事件 API 可能破坏性变更 | 工具/插件失效 | 安装时钉版本（install.sh 记录已验证版本号），升级前列 changelog 巡检 |
| `session.idle` 载荷结构与 agent 判定方式基于 DeepWiki 旧快照推断 | 自动写记忆可能误伤编程会话或漏写 | 实施首日写 10 行调试插件打印真实事件载荷再定型；上线初期双写（钩子+模型自调，靠服务端幂等去重） |
| bash 权限 glob 放行 curl 后模型可能越权访问其他 URL | 轻微安全面 | glob 精确到 `curl http://127.0.0.1:48912/*`；或干脆 `bash: "*": deny`（主路径不需要 bash） |
| 记忆写入契约依赖 P1-1 统一封装定稿（body status/ok、external_id） | 返工 | 工具文件留 TODO 标记，P1-1 契约表定稿后一次性回填 |
| 长会话自动压缩稀释人格 | 人格漂移 | 插件挂 `experimental.session.compacting` 钩子注入人格要点；该钩子标记 experimental，接受度作为观察项 |
| 本机未装 opencode，真实行为未实证 | 方案整体 | 全部结论来自官方现行文档+源码问答，置信度已标注；P1-3 首任务即安装实测 |

### 4. 工作量估算（对照 workplan P1-3：human 1-2 天 / CC 半天~1 天）

- 安装 opencode + 事件载荷实证：0.5 天（human+CC 各半）
- `agents/monika.md` 三件套蒸馏搬运：0.5 天（人格文本打磨属 human）
- `tools/neko-memory.ts` 四工具：CC 半天内（含 P1-1 契约回填）
- `plugins/monika-memory-sync.ts` 钩子：CC 半天（幂等去重逻辑为主）
- 命令两枚 + install.sh + 进入/恢复/退出文档化：0.5 天
- 端到端验收（人格生效断言 + 跨端语境延续一条 + 幂等去重）：0.5 天

## 二、备选路径（置信度 0.6，仅作冒烟与降级）

- **形态**：全局 `~/.config/opencode/AGENTS.md` 写入人格 + prompt 规则要求模型用内置 bash 工具 `curl` 四端点 + 不写任何 TS。
- **用途**：P1-3 开工前 5 分钟验证 memory_server 端点在真实模型回路里可用（「人格寄生 opencode」可行性最先证伪/证实的一步）；主路径工具开发期间作为过渡。
- **不作为长期形态的原因**：写记忆可靠性依赖模型遵循度（RESEARCH.md C3）；curl 噪音污染上下文；无自动兜底钩子。
- **额外降级形态**：若 plugin 事件路线受阻，最小可用组合 = `agents/monika.md` + `tools/neko-memory.ts`（模型自调读写）+ `commands/monika-settle.md`——去掉插件，接受写路径可靠性下降。

## 三、验收对照（对齐 workplan P1-3）

1. **opencode 会话人格生效**：Tab 切到 monika 后 OOC 五规则/输出通道/昵称称呼符合三件套；`opencode run -c -a monika` 恢复会话人格连续。
2. **跨端语境延续**：QQ 端说的事实 → opencode `/monika` 开场注入增量后自然知晓；opencode 端说的 → 桌面端能 recall（读路径经 query_memory/增量注入）。
3. **进入/恢复/退出行为文档化**：本文件「主路径 §2」表格为初稿，P1-3 实测后定稿入 `opencode-integration/` 随仓库。
