/**
 * P1-3 实测用 mock memory_server（非部署件）。
 * 按契约（mem-client/neko_mem_client/contract.py）实现六端点最小行为，供
 * opencode 插件/工具端到端联调（真实 memory_server 未在本机运行；端到端真联调留 P2-3）。
 * 用法：bun mock-memory-server.ts <port> [请求日志文件]
 * 特性：/cache 收到的 messages 全程留痕（供断言 external_id/input_history 形状）；
 *       /recent_history 返回固定增量与递增游标；200+error 反模式可经 ?flaky=1 触发。
 */
import * as fs from "node:fs"

const port = Number(process.argv[2] ?? 48912)
const reqLog = process.argv[3] ?? "/tmp/mock-memory-requests.log"
const state = { seq: 5, cached: [] as any[] }

function logReq(line: string) {
  fs.appendFileSync(reqLog, `${new Date().toISOString()} ${line}\n`)
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === "POST" ? await req.text() : ""
    logReq(`${req.method} ${url.pathname}${url.search} ${body}`)
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })

    if (url.pathname === "/health") return json({ status: "ok", INSTANCE_ID: "mock-p13" })

    if (url.pathname.startsWith("/cache/")) {
      if (url.searchParams.get("flaky") === "1") return json({ status: "error", message: "mock flaky" })
      const parsed = JSON.parse(body || "{}")
      const messages = JSON.parse(parsed.input_history ?? "[]")
      state.cached.push(...messages)
      return json({ status: "cached", count: messages.length })
    }
    if (url.pathname.startsWith("/process/")) return json({ status: "processed" })
    if (url.pathname.startsWith("/renew/")) return json({ status: "processed" })
    if (url.pathname.startsWith("/settle/")) return json({ status: "settled" })

    if (url.pathname.startsWith("/query_memory/")) {
      return json({ results: [{ text: "（mock）用户上周说过在攒新电脑的预算", score: 0.9 }], query: body, candidates_total: 1, elapsed_ms: 3 })
    }
    if (url.pathname.startsWith("/recent_history/")) {
      const since = Number(url.searchParams.get("since_seq") ?? 0)
      const messages = [
        { name: "adam", text: "(mock 增量) 今天下班好累啊" },
        { name: "莫妮卡", text: "(mock 增量) 辛苦啦，早点休息哦~" },
      ]
      return json({ seq: Math.max(state.seq, since) + 2, since_seq: since, messages })
    }
    return json({ detail: "not found" }, 404)
  },
})
console.log(`mock memory_server listening on ${port} (log: ${reqLog})`)
