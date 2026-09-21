/**
 * 插件级集成单测（bun test）：MonikaMemorySync 经假 client + mock fetch 驱动
 * session.idle 全流程（插件仅 `import type` @opencode-ai/plugin，运行时零依赖可直测）。
 * 重点断言（代审 P2-1 修复）：/process 成功后追加空增量 /settle 一步结算存量；
 * /settle 失败保留 pending_cache；正常路径 /cache 成功不触发 /process。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as lib from "../dist/monika-memory/lib.ts"
import { MonikaMemorySync } from "../dist/plugins/monika-memory-sync.ts"

let dataDir: string
const realFetch = globalThis.fetch
const calls: Array<{ path: string; body: any }> = []

/** mock fetch：按 path 前缀路由（routes 值 null = fetch reject）。 */
function mockFetch(routes: Record<string, { status?: number; body: unknown } | null>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const pathName = String(input).replace("http://127.0.0.1:48999", "")
    calls.push({ path: pathName, body: init?.body ? JSON.parse(init.body) : null })
    const key = Object.keys(routes)
      .filter((k) => pathName.startsWith(k))
      .sort((a, b) => b.length - a.length)[0]
    const route = key ? routes[key] : { status: 404, body: { detail: "no route" } }
    if (route === null) throw new TypeError("fetch failed")
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
}

/** 假 opencode client：session.messages 返回一轮 user+assistant 消息。 */
function fakeClient(userText = "早呀", assistantText = "早~") {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "user", id: "msg_turn1", agent: "monika" },
            parts: [{ type: "text", text: userText }],
          },
          {
            info: { role: "assistant", id: "msg_asst1" },
            parts: [{ type: "text", text: assistantText }],
          },
        ],
      }),
    },
  }
}

async function fireIdle(client: any): Promise<void> {
  // PluginInput 形状：{ client, project, directory, ... }——client 是其字段（而非整体）
  const hooks = (await MonikaMemorySync({ client } as any)) as any
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } })
}

async function seedMonikaSession(pending: number): Promise<void> {
  await lib.withState((s) => {
    const sess = lib.ensureSession(s, "ses_x")
    sess.agent = "monika"
    sess.pending_cache = pending
  })
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-plugin-test-"))
  process.env.NEKO_MEMORY_DATA_DIR = dataDir
  process.env.NEKO_MEMORY_BASE_URL = "http://127.0.0.1:48999"
  process.env.NEKO_MEMORY_USER_ID = "testuser"
  calls.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dataDir, { recursive: true, force: true })
  delete process.env.NEKO_MEMORY_DATA_DIR
  delete process.env.NEKO_MEMORY_BASE_URL
  delete process.env.NEKO_MEMORY_USER_ID
})

describe("idle 去抖结算分支（/process→/settle 语义）", () => {
  test("混合状态：outbox 积压 + pending>0 → /process 携增量成功后追加空增量 /settle，计数清零", async () => {
    // 预置：outbox 1 条积压 + pending_cache=2（已 /cache 未结算的存量）
    lib.outboxPush({
      external_ids: [lib.buildExternalId("msg_old", 0)],
      messages: [{ role: "user", content: "旧轮增量" }],
      turn_id: "msg_old",
      ts: 900,
    })
    await seedMonikaSession(2)

    // /cache 全程失败（200+error 反模式，重放与本轮写入都失败）；
    // /process、/settle 成功
    mockFetch({
      "/cache/monika": { status: 200, body: { status: "error", message: "cache busy" } },
      "/process/monika": { body: { status: "processed" } },
      "/settle/monika": { body: { status: "settled" } },
    })

    await fireIdle(fakeClient())

    const procIdx = calls.findIndex((c) => c.path === "/process/monika")
    const settleIdx = calls.findIndex((c) => c.path === "/settle/monika")
    expect(procIdx).toBeGreaterThanOrEqual(0)
    expect(settleIdx).toBeGreaterThan(procIdx) // settle 在 process 之后（P2-1 修复语义）

    // /process 携带合并增量（旧积压 + 本轮新落 outbox 的两条）
    const procCall = calls[procIdx]
    const contents = JSON.parse(procCall.body.input_history).map((m: any) => m.content)
    expect(contents).toContain("旧轮增量")
    expect(contents).toContain("早呀")
    // /settle 为空增量标准形态
    expect(calls[settleIdx].body.input_history).toBe("[]")

    // outbox 清空；计数仅在 settle 成功后清零
    expect(lib.outboxList()).toHaveLength(0)
    const pending = await lib.withState((s) => lib.ensureSession(s, "ses_x").pending_cache)
    expect(pending).toBe(0)
  })

  test("/settle after /process 失败（200+error）→ pending_cache 保留，下次去抖收口", async () => {
    lib.outboxPush({
      external_ids: [lib.buildExternalId("msg_old", 0)],
      messages: [{ role: "user", content: "旧轮增量" }],
      turn_id: "msg_old",
      ts: 900,
    })
    await seedMonikaSession(2)

    mockFetch({
      "/cache/monika": { status: 200, body: { status: "error", message: "cache busy" } },
      "/process/monika": { body: { status: "processed" } },
      "/settle/monika": { status: 200, body: { status: "error", message: "settle busy" } },
    })

    await fireIdle(fakeClient())

    const pending = await lib.withState((s) => lib.ensureSession(s, "ses_x").pending_cache)
    expect(pending).toBe(2) // 保留（不清零、不误删）
    expect(lib.outboxList()).toHaveLength(0) // process 已成功，outbox 正常清空
  })

  test("正常路径：本轮 /cache 成功 → 不触发 /process，去抖到期 /settle 空增量结算", async () => {
    await seedMonikaSession(0)
    mockFetch({
      "/cache/monika": { body: { status: "cached", count: 2 } },
      "/settle/monika": { body: { status: "settled" } },
    })

    await fireIdle(fakeClient())

    expect(calls.some((c) => c.path === "/process/monika")).toBe(false)
    const settleCalls = calls.filter((c) => c.path === "/settle/monika")
    expect(settleCalls).toHaveLength(1)
    expect(settleCalls[0].body.input_history).toBe("[]")

    const state = await lib.withState((s) => s.sessions["ses_x"])
    expect(state.pending_cache).toBe(0) // 1（本轮 cache）→ settle 成功清零
    expect(state.last_turn_id).toBe("msg_turn1") // 去抖标记（同轮多次 idle 跳过）
  })

  test("非 monika 会话（agent=build）：不发生任何 HTTP 写入", async () => {
    await lib.withState((s) => {
      lib.ensureSession(s, "ses_x").agent = "build"
    })
    mockFetch({ "/cache/monika": { body: { status: "cached" } } })

    await fireIdle(fakeClient())
    expect(calls).toHaveLength(0)
  })
})
