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
let everConnected = false; // 首连新会话；断线重连续接（保她的上下文连续）
let sessionReady = false;
let superseded = false; // 被更新窗口取代（停止重连，避免互踢战）
let busy = false; // 一个 turn 进行中（等 "turn end"）
let busyTimer: ReturnType<typeof setTimeout> | null = null; // turn-end 丢失兜底（turn end 到达必须清）

function setStatus(text: string, err = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", err);
}

/** 新建一行她的话（流式容器）：浮起 → 12s 弱墨 → 24s 消散 */
function newLine(): HTMLElement {
  const line = document.createElement("div");
  line.className = "line";
  linesEl.appendChild(line);
  while (linesEl.children.length > 8) linesEl.firstElementChild?.remove();
  setTimeout(() => line.classList.add("old"), 12_000);
  setTimeout(() => line.classList.add("gone"), 24_000);
  return line;
}

/** 桌宠同步手写（引擎可用时；说话不算交互，不打断她的状态机） */
function petSay(text: string): void {
  const pet = (window as unknown as { __nekoPet?: { say: (t: string) => void } }).__nekoPet;
  try { pet?.say(text.slice(0, 132)); } catch { /* 引擎降级态无妨 */ }
}

function logLine(kind: "u" | "a", text: string): void {
  const d = document.createElement("div");
  d.className = kind;
  d.textContent = (kind === "u" ? "你：" : "她：") + text.slice(0, 60);
  logEl.appendChild(d);
  while (logEl.children.length > 12) logEl.firstElementChild?.remove();
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/neko-ws/ws/${encodeURIComponent(char)}`);
  ws.onopen = () => {
    setStatus(`连接上了 · ${char}`);
    ws!.send(JSON.stringify({ action: "start_session", input_type: "text", new_session: !everConnected, request_id: rid() }));
    everConnected = true;
  };
  ws.onmessage = (ev) => {
    let m: { type?: string; data?: unknown; message?: unknown } = {};
    try { m = JSON.parse(ev.data as string); } catch { return; }
    switch (m.type) {
      case "session_started": sessionReady = true; setStatus(`她在 · ${char} · v2`); input.focus(); break;
      case "session_failed": // 契约审计 #3：此消息无 message 字段——固定文案，真实原因看 status 码
        setStatus("会话启动失败（text 模式）", true); break;
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
      case "gemini_response": { // 她的话：分片流（isNewMessage 分段）——实测 wire 格式
        const gm = m as unknown as { text?: string; isNewMessage?: boolean };
        const chunk = gm.text ?? "";
        if (!chunk) break;
        if (gm.isNewMessage || !curLine) { curLine = newLine(); turnText = ""; }
        curLine.textContent += chunk;
        turnText += chunk; // 流式高频 scrollIntoView 有 jank（审计 F10）——只在 newLine 时滚一次
        break;
      }
      case "text": case "subtitle": break; // 兼容其他构建的最终帧——gemini_response 已覆盖
      case "user_transcript": case "user_message": break;
      case "system": {
        const d = String(m.data ?? "");
        if (d.includes("turn end")) {
          busy = false;
          if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
          if (turnText) { logLine("a", turnText); petSay(turnText); }
          turnText = ""; curLine = null;
        }
        // 契约审计 #6："session end"/"renew session" 只进 monitor 平面不下发 app WS——删除死分支
        break;
      }
      case "session_ended_by_server": // 契约审计 #6：服务端收会话的真实通知通道
        sessionReady = false; everConnected = false; break;
      case "catgirl_switched": { // 契约审计 #11：角色不存在时服务端发此消息后 close——跟随新角色名重连，防 3s 死循环
        const nm = (m as unknown as { new_catgirl?: string }).new_catgirl;
        if (nm && nm !== char) { location.search = `?char=${encodeURIComponent(nm)}`; }
        break;
      }
      // 契约审计 #7/#12：heartbeat/user_message 均非 app WS 消息——死 case 已删
      default: break;
    }
  };
  ws.onclose = () => {
    sessionReady = false;
    // 断线清流式残留（审计 F3）：否则重连后首块续进已消散的旧行——整段不可见
    curLine = null; turnText = "";
    if (busy) { busy = false; if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; } setStatus("断了一下——再说一次？", true); }
    if (superseded) return; // 让位：不重连（重连=抢回=无限互踢）
    setStatus("连接断了 · 三秒后重试", true);
    setTimeout(connect, 3000);
  };
  ws.onerror = () => setStatus("连接出错（主进程在吗？）", true);
}

let curLine: HTMLElement | null = null; // 当前流式行
let turnText = "";        // 本 turn 她的完整话（日志/桌宠用）

function speak(): void {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN || busy) return;
  busy = true;
  // turn-end 丢失兜底（审计 F2：句柄可清，防 stale 定时器误杀下一个正常 turn）
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(() => {
    if (busy) { busy = false; setStatus("上一句她没接完——再说一次？", true); }
  }, 60_000);
  input.value = "";
  logLine("u", text);
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
