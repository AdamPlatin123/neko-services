/**
 * N.E.K.O opencode 接入层共享库。
 *
 * 安装位：~/.config/opencode/monika-memory/lib.ts
 * 消费方：~/.config/opencode/tools/neko-memory.ts 与
 *         ~/.config/opencode/plugins/monika-memory-sync.ts（相对导入 ../monika-memory/lib.ts，
 *         opencode 内嵌 Bun 运行时原生执行 TS，无需构建）。
 *
 * 契约依据（P1-1 定稿契约表）：
 *   - neko-services/docs/design/neko-access-audit.md §1
 *   - neko-services/mem-client/neko_mem_client/contract.py（CONTRACTS / SUGGESTED_TIMEOUTS）
 * 写入端点失败语义：HTTP 200 + {"status":"error"} 反模式 → 必须双层判定（网络/HTTP 层 + 应用层）。
 *
 * ⚠ 并发约定（PLAN §3 三审修订）：所有 state.json 读写统一经单点 withState(fn)
 *   串行化整个读-改-写——进程内用 Promise 链互斥，跨进程（工具 vs read.sh）用 mkdir
 *   原子锁（read.sh 同机制实现，见 dist/monika-memory-read.sh）；「临时文件+rename」仅防
 *   写坏文件、不承担互斥。调用方不得在 withState 回调内再次调用 withState（非重入）。
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------

/** 记忆档名（external_id 五元组 chat_id 位，跨端同档）。 */
export const MEMORY_NAME = "monika"

/** external_id 五元组 channel 位。 */
export const CHANNEL = "opencode"

/** memory_server 根地址（本机回环，无鉴权；端口变量化便于测试与多实例）。 */
export function baseUrl(): string {
  return process.env.NEKO_MEMORY_BASE_URL ?? "http://127.0.0.1:48912"
}

/**
 * 跨端统一用户标识（external_id 五元组 user_id 位）。
 * TODO(P1-1 契约定稿)：与桌面端同一 user 维度对齐后回填具体取值；先取环境变量、
 * 缺省回退系统用户名占位——保证「跨端同档」维度不漂。
 */
export function userId(): string {
  return process.env.NEKO_MEMORY_USER_ID ?? os.userInfo().username
}

/** 超时（毫秒）：按 P1-1 契约表 SUGGESTED_TIMEOUTS——cache/query/recent=5s，
 * process/renew/settle=30s（含 LLM 摘要的端点，对齐 wechat 参考实现）。 */
export const TIMEOUT_MS = {
  recent_history: 5_000,
  query_memory: 5_000,
  cache: 5_000,
  process: 30_000,
  renew: 30_000,
  settle: 30_000,
} as const

/** 本地运行时数据根（水位表/outbox/日志）。测试经 NEKO_MEMORY_DATA_DIR 重定向。 */
export function dataDir(): string {
  return (
    process.env.NEKO_MEMORY_DATA_DIR ??
    path.join(os.homedir(), ".local/share/opencode/monika-memory")
  )
}

export function statePath(): string {
  return path.join(dataDir(), "state.json")
}

export function outboxDir(): string {
  return path.join(dataDir(), "outbox")
}

export function ensureDirs(): void {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.mkdirSync(outboxDir(), { recursive: true })
}

/** best-effort 本地日志（plugin.log；不抛错、不影响主流程）。 */
export function logLine(msg: string): void {
  try {
    ensureDirs()
    fs.appendFileSync(path.join(dataDir(), "plugin.log"), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 日志失败静默 */
  }
}

// ---------------------------------------------------------------------------
// state.json：按会话隔离的水位表
// ---------------------------------------------------------------------------

export interface SessionState {
  /** 本会话 /recent_history 读取水位（新会话缺省 0 = 全量首拉，RESEARCH C4 取舍）。 */
  since_seq: number
  /** 已 /cache 成功未结算的轮数——仅 plugin 维护的存量启发式计数；只判存量，不作增量判据。 */
  pending_cache: number
  /** chat.message 钩子观察到的该会话最近 agent（session.idle 载荷无 agent，判定靠此缓存）。 */
  agent?: string
  /** 会话目录（session.created/updated 载荷的 info.directory，read.sh 定位用）。 */
  directory?: string
  /** 最近一轮已写盘（/cache 成功或已落 outbox）的 user 消息 id——同轮多次 idle 去抖。 */
  last_turn_id?: string
  last_idle_at?: number
  last_settle_at?: number
}

export interface NekoState {
  /** best-effort 指针：最近活跃的 monika 会话（read.sh 无会话上下文的回退定位，可能滞后）。 */
  active_session_id?: string
  sessions: Record<string, SessionState>
}

export function emptyState(): NekoState {
  return { sessions: {} }
}

export function ensureSession(state: NekoState, sessionID: string): SessionState {
  let s = state.sessions[sessionID]
  if (!s) {
    s = { since_seq: 0, pending_cache: 0 }
    state.sessions[sessionID] = s
  }
  return s
}

// --- 进程内互斥（Promise 链）：同一进程内所有 withState 串行 -----------------

let chain: Promise<unknown> = Promise.resolve()

/**
 * 单点串行化整个 state 读-改-写。fn 直接就地修改 state；fn 正常返回后整体落盘，
 * fn 抛错则不落盘（避免半截突变持久化）。
 */
export function withState<T>(fn: (state: NekoState) => T | Promise<T>): Promise<T> {
  const run = chain.then(() => withStateLocked(fn))
  chain = run.catch(() => {})
  return run
}

// --- 跨进程 mkdir 原子锁（与 read.sh 同机制；flock(1) 无法被 Bun 进程内持有）---

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_DIR_NAME = "state.lock.d"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockDirPath(): string {
  return path.join(dataDir(), LOCK_DIR_NAME)
}

async function acquireMkdirLock(): Promise<boolean> {
  const dir = lockDirPath()
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.mkdirSync(dir)
      try {
        fs.writeFileSync(path.join(dir, `owner-${process.pid}`), String(Date.now()))
      } catch {
        /* owner 文件仅诊断用 */
      }
      return true
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      // 陈旧锁接管（持锁进程崩溃残留 >30s）
      try {
        const st = fs.statSync(dir)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(dir, { recursive: true, force: true })
          continue
        }
      } catch {
        /* 锁目录已消失，直接重试 */
      }
      if (Date.now() > deadline) {
        // 降级继续（best-effort：人格 UX 优先，不因锁阻塞）；配合进程内互斥，
        // 降级窗口内至多本进程与其他进程交错——计数丢失风险留 WARN 追溯
        logLine(`WARN lock wait >${LOCK_WAIT_MS}ms (${dir}); proceeding degraded`)
        return false
      }
      await sleep(25)
    }
  }
}

function releaseMkdirLock(): void {
  try {
    fs.rmSync(lockDirPath(), { recursive: true, force: true })
  } catch {
    /* 释放失败：等陈旧接管 */
  }
}

function readStateRaw(): NekoState {
  try {
    const raw = fs.readFileSync(statePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && typeof parsed.sessions === "object") {
      return parsed as NekoState
    }
    throw new Error("state shape invalid")
  } catch (e) {
    // 损坏/缺失 → 备份后从空状态开始（水位重复注入幂等无害，计数重新累积）
    try {
      fs.copyFileSync(statePath(), `${statePath()}.corrupt-${Date.now()}`)
    } catch {
      /* 原文件不存在等情况 */
    }
    if (e instanceof Error && e.message !== "state shape invalid") {
      // 真正的解析异常才记日志（首次无文件属正常路径）
      try {
        fs.existsSync(statePath()) && logLine(`WARN state.json corrupt, reset: ${e}`)
      } catch {
        /* ignore */
      }
    }
    return emptyState()
  }
}

function writeStateRaw(state: NekoState): void {
  const tmp = `${statePath()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, statePath())
}

async function withStateLocked<T>(fn: (state: NekoState) => T | Promise<T>): Promise<T> {
  ensureDirs()
  const acquired = await acquireMkdirLock()
  try {
    const state = readStateRaw()
    const out = await fn(state)
    writeStateRaw(state)
    return out
  } finally {
    if (acquired) releaseMkdirLock()
  }
}

// ---------------------------------------------------------------------------
// 水位（按会话隔离；模型工具路径经 context.sessionID 精确定位，不经全局指针）
// ---------------------------------------------------------------------------

export async function readWatermark(sessionID: string): Promise<number> {
  return withState((s) => ensureSession(s, sessionID).since_seq)
}

export async function writeWatermark(sessionID: string, seq: number): Promise<void> {
  await withState((s) => {
    const sess = ensureSession(s, sessionID)
    if (seq > sess.since_seq) sess.since_seq = seq
  })
}

// ---------------------------------------------------------------------------
// external_id（幂等去重键五元组 {channel}:{user_id}:{chat_id}:{turn_uid}:{seq}）
// ---------------------------------------------------------------------------

/**
 * opencode 通道生成规则（PLAN §3）：channel="opencode"；user_id=跨端统一用户标识；
 * chat_id=记忆档名 "monika"；turn_uid=该轮用户消息的 opencode messageID（一条用户消息=一轮）；
 * seq=轮内序号（user 消息=0，assistant 文本段=1..n）。
 * TODO(P1-1 契约定稿)：external_id 随 /cache 请求的挂载位（body 顶层 or 每条 message
 * 内字段）定稿后上 wire；当前仅内嵌 outbox 文件名与文件内容，保证重放顺序。
 */
export function buildExternalId(turnUid: string, seq: number): string {
  return [CHANNEL, userId(), MEMORY_NAME, turnUid, String(seq)].join(":")
}

// ---------------------------------------------------------------------------
// HTTP（fetch 直连；双层失败判定）
// ---------------------------------------------------------------------------

export interface HttpResult<T = unknown> {
  ok: boolean
  httpStatus: number
  body: T | null
  error?: string
}

function errString(e: unknown): string {
  if (e instanceof Error) {
    // AbortSignal.timeout → TimeoutError；fetch 连接失败 → TypeError
    return `${e.name}: ${e.message}`
  }
  return String(e)
}

async function interpretResponse<T>(res: Response, pathName: string): Promise<HttpResult<T>> {
  const text = await res.text().catch(() => "")
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  // ① 网络/HTTP 层：非 2xx
  if (!res.ok) {
    return { ok: false, httpStatus: res.status, body, error: `HTTP ${res.status} ${pathName}` }
  }
  // ② 应用层：memory_server 写入端点存在 200 + {"status":"error"} 反模式，必须解析 body
  if (body && typeof body === "object" && (body as any).status === "error") {
    return {
      ok: false,
      httpStatus: res.status,
      body,
      error: `body status:error: ${String((body as any).message ?? "")}`,
    }
  }
  return { ok: true, httpStatus: res.status, body }
}

export async function postJson<T = any>(
  pathName: string,
  payload: unknown,
  timeoutMs: number,
): Promise<HttpResult<T>> {
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${pathName}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, httpStatus: 0, body: null, error: `network: ${errString(e)}` }
  }
  return interpretResponse<T>(res, pathName)
}

export async function getJson<T = any>(pathName: string, timeoutMs: number): Promise<HttpResult<T>> {
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${pathName}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return { ok: false, httpStatus: 0, body: null, error: `network: ${errString(e)}` }
  }
  return interpretResponse<T>(res, pathName)
}

// ---------------------------------------------------------------------------
// 写入管线（settle 管线四端点）
// ---------------------------------------------------------------------------

export interface MemoryMessage {
  role: "user" | "assistant"
  content: string
}

export type WriteEndpoint = "cache" | "process" | "renew" | "settle"

/** 契约成功值（contract.py 逐端点核实：cache→cached；process/renew→processed；settle→settled）。 */
const WRITE_SUCCESS: Record<WriteEndpoint, string> = {
  cache: "cached",
  process: "processed",
  renew: "processed",
  settle: "settled",
}

/**
 * HistoryRequest body：input_history 是「JSON 序列化的 messages 数组**字符串**」
 * （不是裸数组）；空增量 = "[]"（settle 空增量的标准形态）。language/render_language
 * 互斥仅发其一——接入层不发送（留给服务端持久 locale）。
 */
export function buildHistoryPayload(messages: MemoryMessage[]): Record<string, unknown> {
  const wire = messages.map(({ role, content }) => ({ role, content }))
  return { input_history: JSON.stringify(wire) }
}

export interface WriteResult {
  ok: boolean
  status?: string
  error?: string
}

/** 写入端点统一入口：双层失败判定 + 契约成功值校验（漂移 fail-loud，对齐 P1-1 客户端）。 */
export async function postWrite(
  endpoint: WriteEndpoint,
  messages: MemoryMessage[],
  timeoutMs: number = TIMEOUT_MS[endpoint],
): Promise<WriteResult> {
  const r = await postJson(`/${endpoint}/${MEMORY_NAME}`, buildHistoryPayload(messages), timeoutMs)
  if (!r.ok) return { ok: false, error: r.error }
  const status = (r.body as any)?.status
  if (status !== WRITE_SUCCESS[endpoint]) {
    return { ok: false, error: `body status ${JSON.stringify(status)} != "${WRITE_SUCCESS[endpoint]}"` }
  }
  return { ok: true, status }
}

// ---------------------------------------------------------------------------
// /recent_history 读取（P1-1 待交付端点）
// ---------------------------------------------------------------------------

export interface RecentHistoryResult {
  ok: boolean
  /** 解析出的新游标；解析不出时 = 入参 sinceSeq（保持水位，宁可重复注入不漏读）。 */
  seq: number
  raw: string
  error?: string
}

/**
 * GET /recent_history/{name}?since_seq=N —— 增量读取（「每轮读取」依赖，P1-1 交付项①）。
 * TODO(P1-1)：响应确切形状（游标字段名 / 行结构）定稿后对表回填。当前防御式解析游标：
 * body.seq ?? body.next_seq ?? body.last_seq ?? body.cursor?.seq（取首个非负整数）；
 * 行内容以原始 JSON 文本返回，由调用方（模型/命令注入）自行阅读。
 */
export async function fetchRecentHistory(sinceSeq: number): Promise<RecentHistoryResult> {
  const r = await getJson(`/recent_history/${MEMORY_NAME}?since_seq=${sinceSeq}`, TIMEOUT_MS.recent_history)
  if (!r.ok) {
    return { ok: false, seq: sinceSeq, raw: "", error: r.error ?? `HTTP ${r.httpStatus}` }
  }
  let body: any = r.body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return { ok: true, seq: sinceSeq, raw: body }
    }
  }
  const candidates = [body?.seq, body?.next_seq, body?.last_seq, body?.cursor?.seq]
  const next = candidates.find((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
  return { ok: true, seq: next ?? sinceSeq, raw: JSON.stringify(body) }
}

// ---------------------------------------------------------------------------
// outbox（/cache 失败兜底：本地持久重试队列）
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  /** 该次失败 /cache payload 的逐条幂等键（挂载位定稿后随重放上 wire）。 */
  external_ids: string[]
  messages: MemoryMessage[]
  turn_id: string
  ts: number
}

/**
 * 文件名 = <15位补零毫秒时间戳>-<external_ids[0] 冒号转下划线>.json
 * （按文件名升序重放 = 跨轮按时间升序；PLAN §3：定稿前文件名内嵌五元组信息。
 * 粒度说明：按「失败请求」落盘——一次 /cache 覆盖整轮 messages，轮内逐条 seq
 * 信息保留在 external_ids 数组中。）
 */
export function outboxFileName(entry: OutboxEntry): string {
  const first = entry.external_ids[0] ?? `${CHANNEL}_${userId()}_${MEMORY_NAME}_unknown_0`
  return `${String(entry.ts).padStart(15, "0")}-${first.replaceAll(":", "_")}.json`
}

export function outboxPush(entry: OutboxEntry): string {
  ensureDirs()
  const file = outboxFileName(entry)
  fs.writeFileSync(path.join(outboxDir(), file), JSON.stringify(entry, null, 2))
  return file
}

/** 未提交增量列表（按文件名升序 = 时间升序）；outbox 积压是「增量」的唯一判据（文件系统事实）。
 * corrupt- 前缀是重放时隔离的脏文件（见 replayOutbox），不计入积压、不重试。 */
export function outboxList(): string[] {
  try {
    return fs
      .readdirSync(outboxDir())
      .filter((f) => f.endsWith(".json") && !f.startsWith("corrupt-"))
      .sort()
  } catch {
    return []
  }
}

export function outboxRead(file: string): OutboxEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(outboxDir(), file), "utf8"))
    if (Array.isArray(parsed?.messages) && typeof parsed?.turn_id === "string") {
      return parsed as OutboxEntry
    }
    return null
  } catch {
    return null
  }
}

export function outboxRemove(file: string): void {
  try {
    fs.rmSync(path.join(outboxDir(), file))
  } catch {
    /* 重放成功后的删除失败：下次重放会再删（服务端 external_id 幂等兜底） */
  }
}

/** 合并多条 outbox 条目的 messages（按传入顺序），供 /process、/renew 携带增量。 */
export function combineOutboxEntries(entries: OutboxEntry[]): MemoryMessage[] {
  return entries.flatMap((e) => e.messages)
}

export interface ReplayReport {
  replayed: number
  remaining: number
  errors: string[]
}

/** 重放 outbox（升序逐条 POST /cache，成功即删，失败保留）。下次 session.idle 前置调用。 */
export async function replayOutbox(): Promise<ReplayReport> {
  const files = outboxList()
  let replayed = 0
  const errors: string[] = []
  for (const f of files) {
    const entry = outboxRead(f)
    if (!entry) {
      // 不可解析的脏文件：移到 corrupt 前缀防卡死重放循环，计数保留
      try {
        fs.renameSync(path.join(outboxDir(), f), path.join(outboxDir(), `corrupt-${f}`))
      } catch {
        /* ignore */
      }
      errors.push(`${f}: unparseable`)
      continue
    }
    const r = await postWrite("cache", entry.messages, TIMEOUT_MS.cache)
    if (r.ok) {
      outboxRemove(f)
      replayed++
    } else {
      errors.push(`${f}: ${r.error}`)
    }
  }
  return { replayed, remaining: outboxList().length, errors }
}
