/**
 * companion 页——与她的最小对话闭环（agy 审查 #4 的落地）。
 *
 * 链路：输入 → WS（经 vite /neko-ws 代理 → N.E.K.O 主进程 /ws/{角色}）
 *   → start_session(text) → stream_data(text) → 她的回复。
 * 呈现遵守 DESIGN.md：无气泡框——她说的话以文楷手写行浮起（her-lines），
 * 桌宠引擎（pet-mount-bundle 挂载的 xiaomai）同时经 __nekoPet.say() 写字。
 * 协议依据：docs/design/neko-access-audit.md 第 3 节（桌面 WS 契约）。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status"), linesEl = $("her-lines"), logEl = $("log");
const input = $("say") as HTMLInputElement, sendBtn = $("send");

const char = new URLSearchParams(location.search).get("char") || "YUI";
const rid = () => Math.random().toString(36).slice(2, 10);

let ws: WebSocket | null = null;
let sessionReady = false;
let superseded = false; // 被更新窗口取代（停止重连，避免互踢战）
let busy = false; // 一个 turn 进行中（等 "turn end"）

function setStatus(text: string, err = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", err);
}

/** 她的一行话：浮起 → 12s 后转弱墨 → 24s 后消散 */
function herSay(text: string): void {
  if (!text.trim()) return;
  const line = document.createElement("div");
  line.className = "line";
  line.textContent = text;
  linesEl.appendChild(line);
  while (linesEl.children.length > 4) linesEl.firstElementChild?.remove();
  setTimeout(() => line.classList.add("old"), 12_000);
  setTimeout(() => line.classList.add("gone"), 24_000);
  // 桌宠同步手写（引擎可用时；说话不算交互，不打断她的状态机）
  const pet = (window as unknown as { __nekoPet?: { say: (t: string) => void } }).__nekoPet;
  try { pet?.say(text.slice(0, 40)); } catch { /* 引擎降级态无妨 */ }
}

function logLine(kind: "u" | "a", text: string): void {
  const d = document.createElement("div");
  d.className = kind;
  d.textContent = (kind === "u" ? "你：" : "她：") + text.slice(0, 60);
  logEl.appendChild(d);
  while (logEl.children.length > 8) logEl.firstElementChild?.remove();
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/neko-ws/ws/${encodeURIComponent(char)}`);
  ws.onopen = () => {
    setStatus(`连接上了 · ${char}`);
    ws!.send(JSON.stringify({ action: "start_session", input_type: "text", new_session: true, request_id: rid() }));
  };
  ws.onmessage = (ev) => {
    let m: { type?: string; data?: unknown; message?: unknown } = {};
    try { m = JSON.parse(ev.data as string); } catch { return; }
    switch (m.type) {
      case "session_started": sessionReady = true; setStatus(`她在 · ${char}`); input.focus(); break;
      case "session_failed":
        setStatus(`会话未能开始：${String(m.message ?? "").slice(0, 60)}`, true); break;
      case "status": { // 状态码机（含 VOICE_INPUT_LEASE_REQUIRED / SERVER_ERROR 等）
        let detail = ""; try { detail = JSON.parse(String(m.message)).code ?? ""; } catch { /* 非 JSON */ }
        if (detail === "CHARACTER_SWITCHING_TERMINAL") {
          // newest-socket-wins：另一窗口（多半是 48911 旧页）持有着她。
          // 停止重连参战——两边各 3s 重连会无限互踢。
          superseded = true;
          setStatus("另一个窗口正陪着她（48911 旧页？）——关掉那个标签，刷新这里", true);
        } else if (detail) setStatus(detail, true);
        break;
      }
      case "text": { // 她的话（最终文本；streaming 累积或整段）
        const t = typeof m.data === "string" ? m.data : "";
        if (t && t !== lastText) { lastText = t; pendingFinal = t; }
        break;
      }
      case "subtitle": break; // 流式字幕：轻页不做逐字镜像，最终 text 足够
      case "user_transcript": case "user_message": break;
      case "system": {
        const d = String(m.data ?? "");
        if (d.includes("turn end")) { busy = false; if (pendingFinal) { herSay(pendingFinal); logLine("a", pendingFinal); pendingFinal = ""; lastText = ""; } }
        else if (d.includes("session end") || d.includes("renew")) { sessionReady = false; }
        break;
      }
      case "heartbeat": break;
      default: break;
    }
  };
  ws.onclose = () => {
    sessionReady = false;
    if (superseded) return; // 让位：不重连（重连=抢回=无限互踢）
    setStatus("连接断了 · 三秒后重试", true);
    setTimeout(connect, 3000);
  };
  ws.onerror = () => setStatus("连接出错（主进程在吗？）", true);
}

let lastText = "";        // 同一 turn 内 streaming 去重
let pendingFinal = "";    // turn 结束时呈现

function speak(): void {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN || busy) return;
  busy = true;
  input.value = "";
  logLine("u", text);
  herSay("…"); // 轻回应占位（她在想）——turn end 会被真实回复替换语义
  setStatus("她在听…");
  ws.send(JSON.stringify({ action: "stream_data", input_type: "text", data: text }));
}

sendBtn.addEventListener("click", speak);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") speak(); });

// 昼夜（与 settings 同键，只切纸色不换朱砂）
const KEY = "neko.theme";
const apply = (t: string) => { document.body.classList.toggle("day", t === "day"); };
let theme = localStorage.getItem(KEY) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day");
apply(theme);
$("mode").addEventListener("click", () => {
  theme = theme === "night" ? "day" : "night";
  localStorage.setItem(KEY, theme); apply(theme);
});

connect();
