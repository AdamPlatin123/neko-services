/**
 * read.sh 集成单测（bun test）：以 Bun.serve 起 mock memory_server，走完
 * 「定位水位 → 重进结算分支（outbox→/renew；空→/settle）→ /recent_history → 回写水位」
 * 全链路；另测服务不可达时的降级文案。脚本用真实 bash 执行（非 mock）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const SCRIPT = path.join(import.meta.dir, "..", "dist", "monika-memory", "read.sh")

let dataDir: string
let server: ReturnType<typeof Bun.serve> | null = null
const calls: Array<{ method: string; path: string; body: any }> = []
let recentBody: unknown = {
  seq: 42,
  messages: [
    { name: "adam", text: "今天跑了三公里" },
    { name: "莫妮卡", text: "好厉害~ 记得拉伸哦" },
  ],
}

function startServer(handler: (req: Request) => Response | unknown) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => null) : null
      calls.push({ method: req.method, path: url.pathname + url.search, body })
      const out = handler(req)
      if (out instanceof Response) return out
      return Response.json(out)
    },
  })
}

async function runReadSh(env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      ...process.env,
      NEKO_MEMORY_DATA_DIR: dataDir,
      NEKO_MEMORY_SESSION_ID: "ses_test",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out: out.trim(), code }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-readsh-test-"))
  fs.mkdirSync(path.join(dataDir, "outbox"), { recursive: true })
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    active_session_id: "ses_test",
    sessions: { ses_test: { since_seq: 10, pending_cache: 1 } },
  }))
  calls.length = 0
  recentBody = {
    seq: 42,
    messages: [
      { name: "adam", text: "今天跑了三公里" },
      { name: "莫妮卡", text: "好厉害~ 记得拉伸哦" },
    ],
  }
})

afterEach(() => {
  server?.stop(true)
  server = null
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("read.sh 全链路（mock memory_server）", () => {
  test("0 增量：/settle（空增量）→ /recent_history(since_seq=10) → 回写水位 42 → 输出行文本", async () => {
    startServer((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/settle/monika") return { status: "settled" }
      if (url.pathname === "/recent_history/monika") return recentBody
      return { status: "error", message: "no route" }
    })
    const { out, code } = await runReadSh({ NEKO_MEMORY_BASE_URL: `http://127.0.0.1:${server!.port}` })
    expect(code).toBe(0)
    expect(out).toContain("adam | 今天跑了三公里")
    expect(out).toContain("莫妮卡 | 好厉害~ 记得拉伸哦")

    const settle = calls.find((c) => c.path === "/settle/monika")
    expect(settle?.body.input_history).toBe("[]")

    const recent = calls.find((c) => c.path.startsWith("/recent_history/monika"))
    expect(recent?.path).toContain("since_seq=10")

    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"))
    expect(state.sessions.ses_test.since_seq).toBe(42)
  })

  test("outbox 非空：/renew 携带合并增量（双层 JSON）→ 成功清空 outbox", async () => {
    fs.writeFileSync(
      path.join(dataDir, "outbox", "000000000000900-opencode_testuser_monika_msg_a_0.json"),
      JSON.stringify({
        external_ids: ["opencode:testuser:monika:msg_a:0"],
        messages: [{ role: "user", content: "早" }],
        turn_id: "msg_a",
        ts: 900,
      }),
    )
    fs.writeFileSync(
      path.join(dataDir, "outbox", "000000000001000-opencode_testuser_monika_msg_b_0.json"),
      JSON.stringify({
        external_ids: ["opencode:testuser:monika:msg_b:0"],
        messages: [{ role: "user", content: "晚" }],
        turn_id: "msg_b",
        ts: 1000,
      }),
    )
    startServer((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/renew/monika") return { status: "processed" }
      if (url.pathname === "/recent_history/monika") return recentBody
      return { status: "error", message: "no route" }
    })
    const { out } = await runReadSh({ NEKO_MEMORY_BASE_URL: `http://127.0.0.1:${server!.port}` })

    const renew = calls.find((c) => c.path === "/renew/monika")
    expect(renew).toBeDefined()
    // 合并增量按时间升序 + input_history 双层 JSON
    expect(JSON.parse(renew!.body.input_history)).toEqual([
      { role: "user", content: "早" },
      { role: "user", content: "晚" },
    ])
    // renew 提交成功后 outbox 清空
    expect(fs.readdirSync(path.join(dataDir, "outbox"))).toHaveLength(0)
    expect(out).toContain("adam | 今天跑了三公里")
  })

  test("outbox 非空但 /renew 失败（200+error 反模式）：outbox 保留", async () => {
    fs.writeFileSync(
      path.join(dataDir, "outbox", "000000000000900-opencode_testuser_monika_msg_a_0.json"),
      JSON.stringify({
        external_ids: ["opencode:testuser:monika:msg_a:0"],
        messages: [{ role: "user", content: "早" }],
        turn_id: "msg_a",
        ts: 900,
      }),
    )
    startServer((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/renew/monika") return { status: "error", message: "server busy" }
      if (url.pathname === "/recent_history/monika") return recentBody
      return { status: "error", message: "no route" }
    })
    await runReadSh({ NEKO_MEMORY_BASE_URL: `http://127.0.0.1:${server!.port}` })
    expect(fs.readdirSync(path.join(dataDir, "outbox"))).toHaveLength(1)
  })

  test("服务不可达：输出降级文案、exit 0、水位不动", async () => {
    const { out, code } = await runReadSh({ NEKO_MEMORY_BASE_URL: "http://127.0.0.1:1" })
    expect(code).toBe(0)
    expect(out).toBe("（共享记忆暂不可达，照常对话）")
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"))
    expect(state.sessions.ses_test.since_seq).toBe(10)
  })

  test("水位不回退：recent_history 返回更小游标时保持 10", async () => {
    startServer((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/settle/monika") return { status: "settled" }
      if (url.pathname === "/recent_history/monika") return { seq: 3, messages: [] }
      return { status: "error", message: "no route" }
    })
    const { out } = await runReadSh({ NEKO_MEMORY_BASE_URL: `http://127.0.0.1:${server!.port}` })
    expect(out).toBe("（自上次读取以来没有新的共享记忆增量）")
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"))
    expect(state.sessions.ses_test.since_seq).toBe(10)
  })
})
