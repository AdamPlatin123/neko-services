/**
 * 配置页的 API 客户端——所有请求都做优雅降级：
 * 后端没起 / 网络断开时返回 degraded，页面显示「未连接」，不抛异常。
 */

export interface LlmConfig {
  base_url: string;
  model: string;
  api_key: string;
}

export type ConfigResult =
  | { ok: true; config: LlmConfig; config_path: string }
  | { ok: false; degraded: boolean; code?: string; message?: string; config_path?: string };

export type SaveResult =
  | { ok: true; config: LlmConfig; config_path: string }
  | { ok: false; degraded: boolean; message?: string };

export type TestResult =
  | { ok: true; http_status: number; latency_ms: number }
  | { ok: false; degraded: boolean; error_kind: string; http_status?: number; message?: string };

export interface EntryState {
  online: boolean;
  detail: string;
}

export type StatusResult =
  | { ok: true; entries: Record<string, EntryState>; probed_at: string }
  | { ok: false; degraded: true };

export interface MemoryHit {
  content?: string;
  score?: number;
  type?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export type MemorySearchResult =
  | { ok: true; hits: MemoryHit[]; summary: string }
  | { ok: false; degraded: boolean; message?: string };

async function call<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: controller.signal });
    return (await res.json()) as T;
  } catch {
    return null; // 断网 / 后端未启动 / 非 JSON —— 一律降级
  } finally {
    clearTimeout(timer);
  }
}

export function getConfig(): Promise<ConfigResult> {
  return call<ConfigResult>("/api/config").then((r) => r ?? { ok: false, degraded: true });
}

export function saveConfig(patch: Partial<LlmConfig>): Promise<SaveResult> {
  return call<SaveResult>("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r ?? { ok: false, degraded: true });
}

export function testLlm(input: Partial<LlmConfig>): Promise<TestResult> {
  return call<TestResult>(
    "/api/test-llm",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    15000,
  ).then((r) => r ?? ({ ok: false, degraded: true, error_kind: "network" } as TestResult));
}

export function getStatus(): Promise<StatusResult> {
  return call<StatusResult>("/api/status", undefined, 4000).then(
    (r) => r ?? { ok: false, degraded: true },
  );
}

export function searchMemory(query: string): Promise<MemorySearchResult> {
  return call<MemorySearchResult>(
    "/api/memory/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    },
    20000,
  ).then((r) => r ?? { ok: false, degraded: true });
}
