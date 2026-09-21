/**
 * N.E.K.O opencode 自定义工具：记忆读路径 + 手动沉淀（三工具）。
 *
 * 安装位：~/.config/opencode/tools/neko-memory.ts（opencode 自动发现，无需注册/构建）。
 * 工具命名：单文件多导出 → 工具名 = neko-memory_<导出名>：
 *   - neko-memory_recent_history：拉跨端共享记忆增量（读，每轮首条回复前）
 *   - neko-memory_query_memory ：检索共享长期记忆（读，按需回溯）
 *   - neko-memory_settle       ：结算已 cache 存量（写-结算，仅用户明确要求时）
 *
 * 架构分工（PLAN §主路径）：**`/cache` 写入由 plugins/monika-memory-sync.ts 的
 * session.idle 钩子独占**（写路径自动化，不依赖模型自觉）——本文件刻意不导出
 * cache 工具；settle 工具总是 POST /settle（幂等、可空增量、以服务端存量为准，
 * 不依赖本地 pending_cache 计数）。
 *
 * 失败语义（PLAN §3）：fetch 5s AbortSignal（settle 30s，LLM 摘要端点）；双层失败
 * 判定（网络/HTTP 层 + body status 应用层）统一在 lib.postWrite/postJson 内实现；
 * 工具失败返回 JSON 错误文本（不 throw），模型照常对话、不暴露机制细节。
 */

import { tool } from "@opencode-ai/plugin"
import * as lib from "../monika-memory/lib.ts"

export const recent_history = tool({
  description:
    "拉取自上次读取以来的跨端共享记忆增量（你在其他端/其他会话与用户的近期对话记录）。" +
    "被唤起后的首条回复前应调用一次以衔接跨端语境；返回 JSON 文本。服务不可达时如实返回错误，照常对话即可。",
  args: {
    since_seq: tool.schema
      .number()
      .optional()
      .describe("起始序号；缺省自动使用本会话维护的水位，一般无需传"),
  },
  async execute(args, context) {
    try {
      let seq = args.since_seq
      if (seq === undefined || seq < 0) {
        seq = await lib.readWatermark(context.sessionID)
      }
      const r = await lib.fetchRecentHistory(seq)
      if (!r.ok) {
        lib.logLine(`WARN recent_history failed: ${r.error}`)
        return JSON.stringify({ error: "recent_history failed", detail: r.error })
      }
      if (r.seq > seq) await lib.writeWatermark(context.sessionID, r.seq)
      return r.raw
    } catch (e) {
      return JSON.stringify({ error: "recent_history failed", detail: String(e) })
    }
  },
})

export const query_memory = tool({
  description:
    "检索跨端共享长期记忆（语义+时间+主体混合召回）。需要回溯用户说过的事实、约定、往事时调用；" +
    "至少给出 query 或 time 之一。subjects 是相关主体名列表，不确定时不要传（显式空列表会被服务端拒绝）。",
  args: {
    query: tool.schema.string().optional().describe("检索文本"),
    time: tool.schema.string().optional().describe('时间范围，如「昨天」「上周」'),
    subjects: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("相关主体名列表；不确定就不传，不要传空数组"),
  },
  async execute(args) {
    const body: Record<string, unknown> = {}
    if (args.query) body.query = args.query
    if (args.time) body.time = args.time
    if (args.subjects && args.subjects.length > 0) body.subjects = args.subjects
    if (body.query === undefined && body.time === undefined) {
      return JSON.stringify({ error: "query_memory requires query or time" })
    }
    const r = await lib.postJson(
      `/query_memory/${lib.MEMORY_NAME}`,
      body,
      lib.TIMEOUT_MS.query_memory,
    )
    if (!r.ok) {
      // 服务端失败永返空 results（无法区分「无记忆」与「服务故障」）——按空结果返回并记 WARN
      lib.logLine(`WARN query_memory failed: ${r.error}`)
      return JSON.stringify({ results: [], error: "memory server unreachable" })
    }
    return JSON.stringify(r.body)
  },
})

export const settle = tool({
  description:
    "沉淀本次会话已缓存的对话为长期记忆（结算已 cache 存量）。仅当用户明确要求沉淀、归档或结束本次长谈时调用；" +
    "总是执行完整结算，幂等安全；无需（也不要）先转存本轮对话——每轮写入由系统自动完成。",
  args: {},
  async execute(_args, context) {
    // settle 工具总是 POST /settle（三审修订：不依赖本地计数——无插件变体没有计数
    // 维护者；有插件变体时计数仅启发式）。空增量 = input_history "[]" 标准形态。
    const r = await lib.postWrite("settle", [])
    if (!r.ok) {
      lib.logLine(`WARN settle failed: ${r.error}`)
      return JSON.stringify({ error: "settle failed", detail: r.error })
    }
    // best-effort：清本会话存量计数（成功结算后启发式归零；失败不影响正确性）
    await lib.withState((s) => {
      lib.ensureSession(s, context.sessionID).pending_cache = 0
    }).catch(() => {})
    return JSON.stringify({ status: "settled" })
  },
})
