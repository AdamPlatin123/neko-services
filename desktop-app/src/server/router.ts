/**
 * 极小 Node 中间层——纸质配置页的「档案柜管理员」。
 * 浏览器写不了本地文件，所以经由这里：
 *
 *   GET   /api/config          读 core_config.json 的三把钥匙（agent 模型三元组）
 *   POST  /api/config          合并写回（原子写：tmp + rename，只动三个字段）
 *   POST  /api/test-llm        「试一试」——真实打一次 OpenAI 兼容 chat/completions
 *   GET   /api/status          并发探测各入口 /health（1500ms 超时）
 *   POST  /api/memory/search   代理 a-memorix /a_memorix/v1/search
 *   DELETE /api/memory/:id     记忆服务暂无删除端点 → 501（此页只读）
 *
 * 零运行时依赖：connect 风格 middleware，可挂进 Vite（dev/preview），
 * 也可由 standalone.ts 以纯 Node 直跑（Node ≥ 23 原生剥类型）。
 */
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readEnv } from "./env.ts";

export type Json = Record<string, unknown>;
export type Next = () => void;

export interface LlmConfig {
  base_url: string;
  model: string;
  api_key: string;
}

const HEALTH_TIMEOUT_MS = 1500;
const LLM_TIMEOUT_MS = 12000;

export interface IncomingMessageLike {
  method?: string;
  url?: string;
  on(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): void;
}

export interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown;
  end(chunk?: string | Uint8Array): void;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function sendJson(res: ServerResponseLike, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function readBody(req: IncomingMessageLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new TextDecoder().decode(concatBytes(chunks))));
    req.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

async function readJsonBody(req: IncomingMessageLike): Promise<Json | null> {
  try {
    const raw = await readBody(req);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* core_config.json 读写（只动三把钥匙）                                 */
/* ------------------------------------------------------------------ */

type CoreConfigRead =
  | { kind: "ok"; full: Json; path: string }
  | { kind: "missing"; path: string }
  | { kind: "bad"; message: string; path: string };

async function readCoreConfig(): Promise<CoreConfigRead> {
  const { coreConfigPath } = readEnv();
  try {
    await stat(coreConfigPath);
  } catch {
    return { kind: "missing", path: coreConfigPath };
  }
  try {
    const raw = await readFile(coreConfigPath, "utf-8");
    return { kind: "ok", full: JSON.parse(raw) as Json, path: coreConfigPath };
  } catch (e) {
    return { kind: "bad", message: `core_config.json 解析失败：${e instanceof Error ? e.message : String(e)}`, path: coreConfigPath };
  }
}

function pickLlm(full: Json): LlmConfig {
  return {
    base_url: typeof full.agentModelUrl === "string" ? full.agentModelUrl : "",
    model: typeof full.agentModelId === "string" ? full.agentModelId : "",
    api_key: typeof full.agentModelApiKey === "string" ? full.agentModelApiKey : "",
  };
}

/** 原子合并写：只覆盖 agentModelUrl / agentModelId / agentModelApiKey。 */
async function writeLlmConfig(patch: Partial<LlmConfig>): Promise<LlmConfig> {
  const { coreConfigPath } = readEnv();
  let full: Json = {};
  try {
    full = JSON.parse(await readFile(coreConfigPath, "utf-8")) as Json;
  } catch {
    full = {}; // 文件不存在或损坏 → 从三把钥匙起步（N.E.K.O 读档时会补默认值）
  }
  const next = pickLlm(full);
  if (typeof patch.base_url === "string") next.base_url = patch.base_url.trim();
  if (typeof patch.model === "string") next.model = patch.model.trim();
  if (typeof patch.api_key === "string") next.api_key = patch.api_key.trim();

  const merged: Json = { ...full, agentModelUrl: next.base_url, agentModelId: next.model, agentModelApiKey: next.api_key };
  await mkdir(dirname(coreConfigPath), { recursive: true });
  const tmp = join(dirname(coreConfigPath), `.core_config.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  await rename(tmp, coreConfigPath);
  return next;
}

/* ------------------------------------------------------------------ */
/* /api/test-llm——「试一试」                                            */
/* ------------------------------------------------------------------ */

export type LlmErrorKind = "empty" | "network" | "auth" | "model" | "http" | "unknown";

function chatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function testLlm(input: Partial<LlmConfig>): Promise<Json> {
  let cfg: LlmConfig = {
    base_url: input.base_url ?? "",
    model: input.model ?? "",
    api_key: input.api_key ?? "",
  };
  const blanks = (["base_url", "model", "api_key"] as const).filter((k) => !cfg[k]);
  if (blanks.length > 0) {
    // 表单里空着的字段，用档案柜里存的补齐
    const core = await readCoreConfig();
    if (core.kind === "ok") {
      const saved = pickLlm(core.full);
      for (const k of blanks) cfg = { ...cfg, [k]: saved[k] };
    }
  }
  if (!cfg.base_url || !cfg.model) {
    return { ok: false, error_kind: "empty", message: "地址和型号都还没填全。" };
  }
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      chatCompletionsUrl(cfg.base_url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: "（她轻轻敲了敲门）在吗？" }],
          max_tokens: 16,
          stream: false,
        }),
      },
      LLM_TIMEOUT_MS,
    );
    const latency_ms = Date.now() - started;
    if (res.ok) return { ok: true, http_status: res.status, latency_ms };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error_kind: "auth", http_status: res.status, message: `鉴权被拒（HTTP ${res.status}）。` };
    }
    if (res.status === 404) {
      return { ok: false, error_kind: "model", http_status: res.status, message: "门开了，但这个地址下没有此型号。" };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, error_kind: "http", http_status: res.status, message: `门后传来 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}` };
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
    return {
      ok: false,
      error_kind: "network",
      message: aborted ? "等太久没有回音（12 秒超时）。" : `这扇门根本没找到：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* /api/status——入口探测                                                */
/* ------------------------------------------------------------------ */

interface EntryState {
  online: boolean;
  detail: string;
}

async function probe(url: string): Promise<EntryState> {
  try {
    const res = await fetchWithTimeout(`${url.replace(/\/+$/, "")}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
    if (!res.ok) return { online: false, detail: `HTTP ${res.status}` };
    let service = "";
    try {
      const body = (await res.json()) as Json;
      const s = body.service ?? body.app;
      if (typeof s === "string") service = s;
    } catch {
      /* 非 JSON 的 health 也算在线 */
    }
    return { online: true, detail: service ? `ok · ${service}` : "ok" };
  } catch {
    return { online: false, detail: "unreachable" };
  }
}

async function getStatus(): Promise<Json> {
  const env = readEnv();
  const targets: Record<string, string | null> = {
    desktop: env.mainUrl,
    terminal: env.agentUrl,
    memory: env.memoryUrl,
    qq: env.qqHealthUrl,
    wechat: env.wechatHealthUrl,
  };
  const keys = Object.keys(targets);
  const states = await Promise.all(
    keys.map(async (k) => {
      const url = targets[k];
      if (!url) {
        return { online: false, detail: "未接线（可用 NEKO_QQ_HEALTH_URL / NEKO_WECHAT_HEALTH_URL 指定探测地址）" };
      }
      return probe(url);
    }),
  );
  const entries: Record<string, EntryState> = {};
  keys.forEach((k, i) => (entries[k] = states[i]));
  return { ok: true, entries, probed_at: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* /api/memory/search——回忆册                                           */
/* ------------------------------------------------------------------ */

async function memorySearch(query: string): Promise<{ status: number; body: Json }> {
  const { memoryUrl } = readEnv();
  try {
    const res = await fetchWithTimeout(
      `${memoryUrl.replace(/\/+$/, "")}/a_memorix/v1/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, chat_id: "neko-desktop-settings" }),
      },
      15000,
    );
    if (!res.ok) {
      return { status: 502, body: { ok: false, message: `记忆服务回了 HTTP ${res.status}。` } };
    }
    const body = (await res.json().catch(() => ({}))) as Json;
    const hits = Array.isArray(body.hits) ? body.hits : [];
    return { status: 200, body: { ok: true, hits, summary: body.summary ?? "" } };
  } catch (e) {
    return { status: 502, body: { ok: false, message: `回忆册还锁着（${e instanceof Error ? e.message : String(e)}）。` } };
  }
}

/* ------------------------------------------------------------------ */
/* middleware 本体（connect 风格：非 /api 一律 next() 交给后续处理）      */
/* ------------------------------------------------------------------ */

export function createApiMiddleware() {
  return async function apiMiddleware(
    req: IncomingMessageLike,
    res: ServerResponseLike,
    next?: Next,
  ): Promise<void> {
    const url = (req.url ?? "").split("?")[0];
    const method = (req.method ?? "GET").toUpperCase();
    if (!url.startsWith("/api/")) {
      next?.();
      return;
    }

    try {
      if (method === "GET" && url === "/api/config") {
        const core = await readCoreConfig();
        if (core.kind === "ok") {
          sendJson(res, 200, { ok: true, config: pickLlm(core.full), config_path: core.path });
        } else if (core.kind === "missing") {
          sendJson(res, 200, {
            ok: false,
            code: "no_config",
            message: "档案柜里还没有 core_config.json——先写在纸上，等她启动后再誊。",
            config_path: core.path,
          });
        } else {
          sendJson(res, 200, { ok: false, code: "bad_config", message: core.message, config_path: core.path });
        }
        return;
      }

      if (method === "POST" && url === "/api/config") {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { ok: false, message: "请求体得是 JSON 对象。" });
          return;
        }
        const patch: Partial<LlmConfig> = {};
        for (const k of ["base_url", "model", "api_key"] as const) {
          if (typeof body[k] === "string") patch[k] = body[k] as string;
        }
        const saved = await writeLlmConfig(patch);
        sendJson(res, 200, { ok: true, config: saved, config_path: readEnv().coreConfigPath });
        return;
      }

      if (method === "POST" && url === "/api/test-llm") {
        const body = await readJsonBody(req);
        if (!body) {
          sendJson(res, 400, { ok: false, message: "请求体得是 JSON 对象。" });
          return;
        }
        const input: Partial<LlmConfig> = {
          base_url: typeof body.base_url === "string" ? body.base_url : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          api_key: typeof body.api_key === "string" ? body.api_key : undefined,
        };
        sendJson(res, 200, await testLlm(input));
        return;
      }

      if (method === "GET" && url === "/api/status") {
        sendJson(res, 200, await getStatus());
        return;
      }

      if (method === "POST" && url === "/api/memory/search") {
        const body = await readJsonBody(req);
        const query = body && typeof body.query === "string" ? body.query.trim() : "";
        if (!query) {
          sendJson(res, 400, { ok: false, message: "要翻回忆册，总得告诉我翻什么。" });
          return;
        }
        const r = await memorySearch(query);
        sendJson(res, r.status, r.body);
        return;
      }

      if (method === "DELETE" && url.startsWith("/api/memory/")) {
        // a-memorix 现无删除端点——明确 501，此页只读。
        sendJson(res, 501, { ok: false, message: "记忆服务还没有撕页的端点，这本册子今天只能翻看。" });
        return;
      }

      sendJson(res, 404, { ok: false, message: `没有这一页：${method} ${url}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };
}
