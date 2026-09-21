/**
 * 事件源——把真实世界的信号翻译成 PetEvent 喂给行为状态机（DESIGN：迁移由真实事件驱动）。
 *
 * 四类事件源：
 * 1. 输入闲置：document 上的 mousemove/keydown/pointerdown/wheel → USER_INPUT；
 *    每 5s 上报一次 IDLE（seconds = 距上次输入秒数）；页面隐藏（visibilitychange hidden）
 *    时不重置闲置计时——你离开，她就慢慢睡着。
 * 2. 终端/对话事件：POST `${memoryServer}/recent_history`（默认 15s 轮询），
 *    比对响应里的 next_seq——前进即有新跨端消息 → TERMINAL_MESSAGE（触发 watching 8s）。
 *    首次轮询只记录基线不触发。请求失败静默（记忆服务未起时桌宠照常活着）。
 * 3. 时钟：每 60s 上报 CLOCK（hour），校准昼夜阈值（22:00-02:00 活跃 / 正午沉睡）。
 * 4. 用户交互（点击/悬停）由 loader 的命中检测发出，见 loader.ts。
 *
 * 测试支持：manual 模式屏蔽真实监听（演示页/无头测试用手动注入事件），
 * hourOverride 允许把「现在」钉在任意小时。
 */

import type { PetEvent } from './types';

export interface EventSourceOptions {
  memoryServer?: string;
  pollIntervalMs?: number; // 默认 15000
  clockIntervalMs?: number; // 默认 60000
  idleTickMs?: number; // 默认 5000
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** 屏蔽真实输入监听（演示页手动模式） */
  manual?: boolean;
  /** 覆盖「当前小时」（演示页深夜/正午切换） */
  hourOverride?: number | null;
}

const INPUT_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove',
  'keydown',
  'wheel',
  'pointerdown',
  'touchstart',
];

export interface RecentHistoryResponse {
  next_seq?: number;
  items?: unknown[];
  [key: string]: unknown;
}

export class PetEventSources {
  private emit: (ev: PetEvent) => void;
  private opts: Required<Omit<EventSourceOptions, 'hourOverride' | 'manual'>> & {
    hourOverride: number | null;
    manual: boolean;
  };
  private timers: ReturnType<typeof setInterval>[] = [];
  private inputListeners: Array<[string, EventListener]> = [];
  private visibilityListener: EventListener | null = null;
  private lastInputAt: number;
  private lastSeq: number | null = null;
  private stopped = false;

  constructor(emit: (ev: PetEvent) => void, opts: EventSourceOptions = {}) {
    this.emit = emit;
    this.opts = {
      memoryServer: opts.memoryServer ?? '/neko-memory',
      pollIntervalMs: opts.pollIntervalMs ?? 15000,
      clockIntervalMs: opts.clockIntervalMs ?? 60000,
      idleTickMs: opts.idleTickMs ?? 5000,
      now: opts.now ?? (() => Date.now()),
      fetchImpl: opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined as never),
      hourOverride: opts.hourOverride ?? null,
      manual: opts.manual ?? false,
    };
    this.lastInputAt = this.opts.now();
  }

  /** 当前小时（可被 hourOverride 钉住） */
  currentHour(): number {
    if (this.opts.hourOverride !== null && this.opts.hourOverride !== undefined) {
      return this.opts.hourOverride;
    }
    return new Date(this.opts.now()).getHours();
  }

  setHourOverride(hour: number | null): void {
    this.opts.hourOverride = hour;
    // 立即用新小时校准一次
    this.emit({ type: 'CLOCK', hour: this.currentHour() });
  }

  /** 切换手动/真实事件模式（重启监听） */
  setManual(manual: boolean): void {
    if (this.opts.manual === manual) return;
    this.stop();
    this.opts.manual = manual;
    this.start();
  }

  start(): void {
    this.stopped = false;
    if (!this.opts.manual) {
      for (const name of INPUT_EVENTS) {
        const fn: EventListener = () => this.onRealInput();
        window.addEventListener(name, fn, { passive: true });
        this.inputListeners.push([name, fn]);
      }
      const vis: EventListener = () => {
        // 页面可见性变化本身就是一次时钟校准；隐藏期间闲置继续累计
        this.emit({ type: 'CLOCK', hour: this.currentHour() });
      };
      document.addEventListener('visibilitychange', vis);
      this.visibilityListener = vis;
    }

    // 闲置上报
    this.timers.push(
      setInterval(() => {
        if (this.stopped) return;
        const seconds = (this.opts.now() - this.lastInputAt) / 1000;
        this.emit({ type: 'IDLE', seconds, hour: this.currentHour() });
      }, this.opts.idleTickMs),
    );

    // 时钟
    this.timers.push(
      setInterval(() => {
        if (this.stopped) return;
        this.emit({ type: 'CLOCK', hour: this.currentHour() });
      }, this.opts.clockIntervalMs),
    );

    // 记忆轮询（延迟 1s 再开始，避免与页面加载争抢）
    this.timers.push(setInterval(() => void this.pollMemory(), this.opts.pollIntervalMs));
    void this.pollMemory();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const [name, fn] of this.inputListeners) window.removeEventListener(name, fn);
    this.inputListeners = [];
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  private onRealInput(): void {
    this.lastInputAt = this.opts.now();
    this.emit({ type: 'USER_INPUT', hour: this.currentHour() });
  }

  /** POST /recent_history，比对 next_seq（约定接口；memory_server 默认 48912 端口） */
  private async pollMemory(): Promise<void> {
    if (this.stopped) return;
    const url = `${this.opts.memoryServer.replace(/\/$/, '')}/recent_history`;
    try {
      const res = await this.opts.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 8 }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as RecentHistoryResponse;
      const seq = typeof data.next_seq === 'number' ? data.next_seq : null;
      if (seq === null) return;
      if (this.lastSeq === null) {
        // 首次只记基线
        this.lastSeq = seq;
        return;
      }
      if (seq > this.lastSeq) {
        this.lastSeq = seq;
        this.emit({ type: 'TERMINAL_MESSAGE', hour: this.currentHour() });
      } else if (seq < this.lastSeq) {
        // 服务端重启/回绕，重置基线
        this.lastSeq = seq;
      }
    } catch {
      // 记忆服务未启动/CORS 失败：静默。桌宠不依赖它活着。
    }
  }

  // ---- 手动注入（演示页/无头测试） ----

  /** 模拟一次真实输入 */
  simulateInput(): void {
    this.lastInputAt = this.opts.now();
    this.emit({ type: 'USER_INPUT', hour: this.currentHour() });
  }

  /** 模拟已闲置 seconds 秒（会重置 lastInputAt 使后续真实计时连贯） */
  simulateIdle(seconds: number): void {
    this.lastInputAt = this.opts.now() - seconds * 1000;
    this.emit({ type: 'IDLE', seconds, hour: this.currentHour() });
  }

  /** 模拟一条新的跨端消息 */
  simulateTerminalMessage(): void {
    if (this.lastSeq !== null) this.lastSeq += 1;
    this.emit({ type: 'TERMINAL_MESSAGE', hour: this.currentHour() });
  }

  /** 当前闲置秒数（供 ACTION_DONE 携带上下文） */
  idleSeconds(): number {
    return (this.opts.now() - this.lastInputAt) / 1000;
  }

  /** 手动触发一次时钟上报 */
  emitClock(): void {
    this.emit({ type: 'CLOCK', hour: this.currentHour() });
  }
}
