/**
 * N.E.K.O opencode 接入层单测（bun test）——纯逻辑层（lib.ts）：
 * 水位按会话隔离 / external_id 构造 / outbox 重放 / 状态串行化 / 双层失败判定 /
 * HistoryRequest 形状。tools 与 plugins 是薄适配层（依赖 @opencode-ai/plugin 运行时，
 * 由 P1-3 实测项覆盖，不在单测范围）；memory_server 不在本机运行——HTTP 一律 mock。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as lib from "../dist/monika-memory/lib.ts"

let dataDir: string
const realFetch = globalThis.fetch

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-lib-test-"))
  process.env.NEKO_MEMORY_DATA_DIR = dataDir
  process.env.NEKO_MEMORY_BASE_URL = "http://127.0.0.1:48999"
  process.env.NEKO_MEMORY_USER_ID = "testuser"
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dataDir, { recursive: true, force: true })
  delete process.env.NEKO_MEMORY_DATA_DIR
  delete process.env.NEKO_MEMORY_BASE_URL
  delete process.env.NEKO_MEMORY_USER_ID
})

/** 构造 mock fetch：按 path 前缀路由（默认 200 JSON）。 */
function mockFetch(
  routes: Record<string, { status?: number; body: unknown }>,
  log: { calls: Array<{ path: string; body: any }> } = { calls: [] },
) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    const pathName = url.replace("http://127.0.0.1:48999", "")
    log.calls.push({
      path: pathName,
      body: init?.body ? JSON.parse(init.body) : null,
    })
    const key = Object.keys(routes)
      .filter((k) => pathName.startsWith(k))
      .sort((a, b) => b.length - a.length)[0]
    const route = key ? routes[key] : { status: 404, body: { error: "no route" } }
    return new Response(route.body === undefined ? "{}" : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
}

describe("水位（按会话隔离）", () => {
  test("新会话缺省 0；各会话独立推进", async () => {
    expect(await lib.readWatermark("ses_a")).toBe(0)
    await lib.writeWatermark("ses_a", 5)
    await lib.writeWatermark("ses_b", 9)
    expect(await lib.readWatermark("ses_a")).toBe(5)
    expect(await lib.readWatermark("ses_b")).toBe(9)
  })

  test("水位只前进不回退", async () => {
    await lib.writeWatermark("ses_a", 7)
    await lib.writeWatermark("ses_a", 3)
    expect(await lib.readWatermark("ses_a")).toBe(7)
  })

  test("state.json 损坏后重置为空态并备份", async () => {
    await lib.writeWatermark("ses_a", 5)
    fsSync.writeFileSync(path.join(dataDir, "state.json"), "{broken json")
    expect(await lib.readWatermark("ses_a")).toBe(0)
    const backups = fsSync.readdirSync(dataDir).filter((f) => f.startsWith("state.json.corrupt-"))
    expect(backups.length).toBe(1)
  })
})

describe("withState 串行化", () => {
  test("并发 50 个读-改-写无丢失更新（计数器最终=50）", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) =>
      lib.withState((s) => {
        lib.ensureSession(s, `ses_${i % 5}`).pending_cache += 1
      }),
    )
    await Promise.all(jobs)
    const total = await lib.withState((s) =>
      Object.values(s.sessions).reduce((acc, x) => acc + x.pending_cache, 0),
    )
    expect(total).toBe(50)
  })
})

describe("external_id 五元组", () => {
  test("opencode:{user_id}:{chat_id}:{turn_uid}:{seq}", () => {
    expect(lib.buildExternalId("msg_123", 0)).toBe("opencode:testuser:monika:msg_123:0")
    expect(lib.buildExternalId("msg_123", 2)).toBe("opencode:testuser:monika:msg_123:2")
  })
})

describe("HistoryRequest 形状", () => {
  test("input_history 是字符串化的数组（双层 JSON）；空增量 = \"[]\"", () => {
    const p = lib.buildHistoryPayload([
      { role: "user", content: "早" },
      { role: "assistant", content: "早呀~" },
    ])
    expect(typeof p.input_history).toBe("string")
    expect(JSON.parse(p.input_history as string)).toEqual([
      { role: "user", content: "早" },
      { role: "assistant", content: "早呀~" },
    ])
    expect(lib.buildHistoryPayload([]).input_history).toBe("[]")
  })
})

describe("双层失败判定（postWrite）", () => {
  test("HTTP 非常非 2xx → 失败", async () => {
    mockFetch({ "/cache/monika": { status: 500, body: { error: "boom" } } })
    const r = await lib.postWrite("cache", [{ role: "user", content: "x" }])
    expect(r.ok).toBe(false)
    expect(r.error).toContain("HTTP 500")
  })

  test("HTTP 200 + body status:error 反模式 → 失败（携带服务端 message）", async () => {
    mockFetch({ "/cache/monika": { status: 200, body: { status: "error", message: "name not found" } } })
    const r = await lib.postWrite("cache", [{ role: "user", content: "x" }])
    expect(r.ok).toBe(false)
    expect(r.error).toContain("name not found")
  })

  test("200 + 契约成功值（cached/processed/settled）→ 成功", async () => {
    const log = { calls: [] as any[] }
    mockFetch(
      {
        "/cache/monika": { body: { status: "cached", count: 2 } },
        "/settle/monika": { body: { status: "settled" } },
        "/renew/monika": { body: { status: "processed" } },
      },
      log,
    )
    expect((await lib.postWrite("cache", [{ role: "user", content: "x" }])).ok).toBe(true)
    expect((await lib.postWrite("settle", [])).ok).toBe(true)
    expect((await lib.postWrite("renew", [{ role: "user", content: "x" }])).ok).toBe(true)
    // settle 空增量的标准形态：input_history == "[]"
    const settleCall = log.calls.find((c) => c.path === "/settle/monika")
    expect(settleCall.body.input_history).toBe("[]")
  })

  test("200 + 意外 status（契约漂移）→ fail-loud 失败", async () => {
    mockFetch({ "/cache/monika": { body: { status: "weird" } } })
    const r = await lib.postWrite("cache", [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain("weird")
  })

  test("网络不可达 → 失败且不抛出", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as any
    const r = await lib.postWrite("cache", [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain("network")
  })
})

describe("recent_history（P1-1 待交付端点，防御式解析）", () => {
  test("seq/next_seq/last_seq/cursor.seq 逐一可解析并回传游标", async () => {
    for (const body of [
      { seq: 12, messages: [] },
      { next_seq: 13 },
      { last_seq: 14 },
      { cursor: { seq: 15 } },
      { no_cursor_here: true },
    ]) {
      mockFetch({ "/recent_history/monika": { body } })
      const r = await lib.fetchRecentHistory(3)
      expect(r.ok).toBe(true)
      const expected = (body as any).seq ?? (body as any).next_seq ?? (body as any).last_seq ?? (body as any).cursor?.seq ?? 3
      expect(r.seq).toBe(expected)
    }
  })

  test("非 2xx → 失败，游标保持原值", async () => {
    mockFetch({ "/recent_history/monika": { status: 404, body: { detail: "not found" } } })
    const r = await lib.fetchRecentHistory(7)
    expect(r.ok).toBe(false)
    expect(r.seq).toBe(7)
  })
})

describe("outbox（/cache 失败兜底）", () => {
  const entry = (ts: number, turn: string): lib.OutboxEntry => ({
    external_ids: [lib.buildExternalId(turn, 0), lib.buildExternalId(turn, 1)],
    messages: [
      { role: "user", content: `u-${turn}` },
      { role: "assistant", content: `a-${turn}` },
    ],
    turn_id: turn,
    ts,
  })

  test("文件名内嵌时间戳与五元组；列表按文件名（时间）升序", () => {
    lib.outboxPush(entry(1000, "msg_b"))
    lib.outboxPush(entry(900, "msg_a"))
    const files = lib.outboxList()
    expect(files).toHaveLength(2)
    expect(files[0]).toContain("msg_a")
    expect(files[1]).toContain("msg_b")
    expect(files[0]).toMatch(/^000000000000900-opencode_testuser_monika_msg_a_0\.json$/)
  })

  test("重放：成功即删、失败保留；脏文件隔离", async () => {
    lib.outboxPush(entry(900, "msg_a"))
    lib.outboxPush(entry(1000, "msg_b"))
    fsSync.writeFileSync(path.join(dataDir, "outbox", "000000000000950-dirty.json"), "not-json")

    let failFirst = true
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.includes("/cache/monika")) {
        const body = JSON.parse(init.body)
        if (failFirst && body.input_history.includes("u-msg_a")) {
          return new Response(JSON.stringify({ status: "error", message: "flaky" }), { status: 200 })
        }
        return new Response(JSON.stringify({ status: "cached", count: 2 }), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }) as any

    const r1 = await lib.replayOutbox()
    expect(r1.replayed).toBe(1) // msg_b 成功
    expect(r1.remaining).toBe(1) // msg_a 失败保留
    expect(fsSync.readdirSync(path.join(dataDir, "outbox")).some((f) => f.includes("corrupt-"))).toBe(true)

    failFirst = false
    const r2 = await lib.replayOutbox()
    expect(r2.replayed).toBe(1)
    expect(r2.remaining).toBe(0)
    expect(lib.outboxList()).toHaveLength(0) // 脏文件已隔离（corrupt- 前缀不计入积压）
  })

  test("combineOutboxEntries 按序拼接增量", () => {
    const merged = lib.combineOutboxEntries([entry(900, "msg_a"), entry(1000, "msg_b")])
    expect(merged.map((m) => m.content)).toEqual(["u-msg_a", "a-msg_a", "u-msg_b", "a-msg_b"])
  })
})
