/**
 * 演示页入口（/pet-demo.html）——全屏暗底 + 模型 + 行为状态机完整跑起来。
 *
 * 可交互测试：
 * - 悬停模型 2s（不点击不拖动）→ 慢眨眼协议
 * - 点击模型 → tap motion + 她说一句话（手写浮现）
 * - 「模拟终端消息」→ watching 8s
 * - 「闲置 4/10 分钟」→ 理毛/伸展 → 打瞌睡 → 睡着
 * - 「深夜/正午」→ 昼夜阈值切换（深夜熬夜、正午易睡）
 * - 拖动模型 → 移动位置
 *
 * 页面自带状态面板与转换日志（无头环境下以日志代替截图验收）。
 */

import { PetApp } from './pet-app';
import { BREATH_PERIOD_S, sleepTolerance } from './behavior';

const stage = document.getElementById('pet-stage')!;
const logEl = document.getElementById('log')!;

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function log(line: string, cls = 'sys'): void {
  const div = document.createElement('div');
  div.className = cls;
  const t = document.createElement('time');
  t.textContent = ts();
  div.appendChild(t);
  div.appendChild(document.createTextNode(line));
  logEl.appendChild(div);
  while (logEl.childElementCount > 120) logEl.firstElementChild?.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// 分类着色：fsm 迁移 / 慢眨眼协议 / 系统消息 / 她说话
const petLog = (line: string) => {
  const cls = line.startsWith('[fsm]')
    ? 'fsm'
    : line.startsWith('[slow-blink]')
      ? 'slow-blink'
      : 'sys';
  log(line, cls);
};

const app = new PetApp({
  container: stage,
  log: petLog,
  manualEvents: true, // 演示页默认手动模式：真实键鼠不干扰事件注入（可切换）
  speechColor: '#D8CDBA',
});

// 她说话 → 日志留痕
const origSay = app.say.bind(app);
(app as unknown as { say: (t: string) => void }).say = (t: string) => {
  log(`她写下一行字：「${t}」`, 'speech');
  origSay(t);
};

void app.mount().then(() => {
  log('演示页就绪。静音观察一分钟，看她在睡觉/浅睡/坐姿/注意之间流转。', 'sys');
});

// ---- 状态面板刷新 ----
const badge = document.getElementById('state-badge')!;
const breathEl = document.getElementById('breath')!;
const eyeEl = document.getElementById('eye')!;
const idleEl = document.getElementById('idle')!;
const hourEl = document.getElementById('hour')!;
const seqEl = document.getElementById('seq')!;

const EYE_TEXT: Record<string, string> = {
  sleeping: '闭合（呼吸 8s）',
  drowsy: '半开 0.25',
  sitting: '自然眨眼',
  watching: '睁大，看向你工作的地方',
  grooming: '正常（理毛中）',
  stretching: '正常（伸展中）',
  'idle-walk': '正常（踱步中）',
};

setInterval(() => {
  const s = app.fsm.state;
  badge.textContent = s;
  breathEl.textContent = `${BREATH_PERIOD_S[s].toFixed(1)}s`;
  eyeEl.textContent = EYE_TEXT[s] ?? '—';
  idleEl.textContent = `${Math.round(app.events.idleSeconds())}s（睡阈值 ${sleepTolerance(app.events.currentHour())}s）`;
  const h = app.events.currentHour();
  hourEl.textContent = `${String(h).padStart(2, '0')}:00${h >= 22 || h < 2 ? '（深夜窗口）' : h >= 11 && h <= 14 ? '（正午窗口）' : ''}`;
}, 500);

// ---- 事件注入按钮 ----
function on(id: string, fn: () => void): void {
  document.getElementById(id)!.addEventListener('click', fn);
}

on('btn-input', () => {
  log('[demo] 注入：USER_INPUT', 'sys');
  app.events.simulateInput();
});
on('btn-msg', () => {
  log('[demo] 注入：TERMINAL_MESSAGE（模拟 next_seq 前进）', 'sys');
  seqEl.textContent = `+1（模拟）`;
  app.events.simulateTerminalMessage();
});
on('btn-idle-4m', () => {
  log('[demo] 注入：IDLE 240s', 'sys');
  app.events.simulateIdle(240);
});
on('btn-idle-10m', () => {
  log('[demo] 注入：IDLE 600s', 'sys');
  app.events.simulateIdle(600);
});
on('btn-night', () => {
  log('[demo] 时辰钉在 23 时（深夜活跃窗口，睡阈值 1800s）', 'sys');
  app.events.setHourOverride(23);
});
on('btn-noon', () => {
  log('[demo] 时辰钉在 12 时（正午沉睡窗口，睡阈值 300s）', 'sys');
  app.events.setHourOverride(12);
});
on('btn-realtime', () => {
  log('[demo] 恢复真实时钟', 'sys');
  app.events.setHourOverride(null);
});
on('btn-say', () => {
  app.say('我在这里，一直都在。你写你的，我看着。');
});
on('btn-sleep-now', () => {
  // 连续注入：闲置过阈 → 浅睡 → 再闲置 → 睡沉
  log('[demo] 注入：立即入睡序列', 'sys');
  app.events.simulateIdle(sleepTolerance(app.events.currentHour()) + 1);
  setTimeout(() => app.events.simulateIdle(sleepTolerance(app.events.currentHour()) + 91), 50);
});

// 手动/真实事件模式切换
document.getElementById('chk-manual')!.addEventListener('change', (e) => {
  const manual = (e.target as HTMLInputElement).checked;
  app.events.setManual(manual);
  log(`[demo] 事件源切换为${manual ? '手动注入' : '真实键鼠'}`, 'sys');
});

// 演示：页面隐藏时她继续计时（visibility 不重置闲置）
log('提示：先跑 bash scripts/fetch-model.sh 下载 xiaomai 模型；未下载时显示呼吸圆点占位。', 'sys');
