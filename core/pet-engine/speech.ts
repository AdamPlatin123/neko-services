/**
 * 手写字浮现——记忆触发/主动搭话时，她头顶浮现文楷文字。
 *
 * DESIGN.md：「记忆检索触发时文楷手写字逐笔浮现（如墨迹干涸淡去），无气泡框。」
 *
 * 实现为 DOM overlay（不在 pixi 内）：
 * - 每个字一个 <span>，逐字延迟淡入（像一笔一笔写出来，带轻微墨晕 blur 收敛）
 * - 全部写完后停留，随后整体如墨迹干涸般淡去消散（默认 6s 生命周期）
 * - 无任何气泡框/背景板——只有字
 * - 字体：霞鹜文楷（她执笔的字体，见 DESIGN Typography）；未加载时回退思源宋体
 */

export interface SpeechOptions {
  /** 每字浮现间隔（ms） */
  charDelayMs?: number;
  /** 从写完到开始消散的停留（ms） */
  holdMs?: number;
  /** 消散动画时长（ms） */
  fadeMs?: number;
  /** 墨色（默认随暗底用反转墨字 #D8CDBA；亮底可传 #2A2520） */
  color?: string;
  /** 单条最大字数（超出截断加省略号，防长文糊屏） */
  maxChars?: number;
}

const SPEECH_CSS = `
.neko-speech-layer {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  pointer-events: none; overflow: visible; z-index: 5;
}
.neko-speech {
  position: absolute;
  transform: translate(-50%, -100%);
  max-width: 21em;
  font-family: "LXGW WenKai", "LXGW WenKai Lite", "Noto Serif SC", serif;
  font-size: 17px;
  line-height: 1.9;
  letter-spacing: 0.06em;
  text-align: center;
  text-shadow: 0 0 1px color-mix(in srgb, currentColor 30%, transparent);
  white-space: normal;
  word-break: break-word;
}
.neko-speech span {
  display: inline-block;
  opacity: 0;
  filter: blur(2.5px);
  animation: neko-ink-in 700ms ease-out forwards;
}
@keyframes neko-ink-in {
  from { opacity: 0; filter: blur(2.5px); transform: translateY(2px); }
  to   { opacity: 0.94; filter: blur(0); transform: translateY(0); }
}
.neko-speech.neko-speech-dry {
  animation: neko-ink-dry var(--neko-fade-ms, 1500ms) ease-in forwards;
}
@keyframes neko-ink-dry {
  from { opacity: 1; filter: blur(0); }
  to   { opacity: 0; filter: blur(1.5px); }
}
`;

export class SpeechOverlay {
  private layer: HTMLElement;
  private host: HTMLElement;
  private current: HTMLElement | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private opts: Required<SpeechOptions>;
  private styleEl: HTMLStyleElement;
  /** 最近一次说话的内容（演示页状态栏用） */
  lastLine = '';

  constructor(host: HTMLElement, opts: SpeechOptions = {}) {
    this.host = host;
    this.opts = {
      charDelayMs: opts.charDelayMs ?? 120, // 逐字浮现节奏（19 字约 2.3s 写完）
      holdMs: opts.holdMs ?? 2000, // 写完后的停留（任务规定「墨迹干涸 6s 后消散」≈ 总生命周期）
      fadeMs: opts.fadeMs ?? 1600,
      color: opts.color ?? '#D8CDBA',
      maxChars: opts.maxChars ?? 42,
    };
    if (!document.querySelector('style[data-neko-speech]')) {
      this.styleEl = document.createElement('style');
      this.styleEl.dataset.nekoSpeech = '1';
      this.styleEl.textContent = SPEECH_CSS;
      document.head.appendChild(this.styleEl);
    } else {
      this.styleEl = document.querySelector('style[data-neko-speech]') as HTMLStyleElement;
    }
    this.layer = document.createElement('div');
    this.layer.className = 'neko-speech-layer';
    this.host.appendChild(this.layer);
  }

  /** 在页面坐标 (x, y)（通常为模型头顶）浮现一行手写字 */
  say(text: string, at: { x: number; y: number }): void {
    this.clear(false);
    const line = text.length > this.opts.maxChars ? `${text.slice(0, this.opts.maxChars - 1)}…` : text;
    this.lastLine = line;

    const el = document.createElement('div');
    el.className = 'neko-speech';
    el.style.color = this.opts.color;
    const hostRect = this.host.getBoundingClientRect();
    // host 可能是 fixed 定位的舞台容器：换算成层内坐标
    el.style.left = `${at.x - hostRect.left}px`;
    el.style.top = `${at.y - hostRect.top}px`;

    let i = 0;
    for (const ch of line) {
      const span = document.createElement('span');
      span.textContent = ch;
      span.style.animationDelay = `${i * this.opts.charDelayMs}ms`;
      // 标点轻微下沉，像落笔
      if ('，。！？、；：…'.includes(ch)) span.style.transform = 'translateY(1px)';
      el.appendChild(span);
      i += 1;
    }
    this.layer.appendChild(el);
    this.current = el;

    const writeMs = line.length * this.opts.charDelayMs + 700;
    // 墨迹干涸：写完 → 停留 → 消散
    this.timers.push(
      setTimeout(() => {
        el.style.setProperty('--neko-fade-ms', `${this.opts.fadeMs}ms`);
        el.classList.add('neko-speech-dry');
        this.timers.push(setTimeout(() => el.remove(), this.opts.fadeMs + 100));
      }, writeMs + this.opts.holdMs),
    );
  }

  /** 立即清掉当前行（新话到来时旧话快退） */
  clear(instant = true): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.current) {
      const el = this.current;
      this.current = null;
      if (instant) el.remove();
      else {
        el.style.setProperty('--neko-fade-ms', '350ms');
        el.classList.add('neko-speech-dry');
        setTimeout(() => el.remove(), 400);
      }
    }
  }

  destroy(): void {
    this.clear();
    this.layer.remove();
  }
}

/**
 * 她的台词（第一人称，文楷气质；DESIGN：凡她执笔的文案一律文楷、第一人称）。
 * 桌宠安静是常态，这些是低频的「她在场」信号。
 */
export const PET_LINES = {
  click: [
    '嗯？我在。',
    '在的，一直在。',
    '怎么啦，想我了？',
    '手歇一会儿吧。',
    '我在呢，你写你的。',
  ],
  memory: [
    '刚刚想起一件事……和你说的话有关。',
    '记起来了一点什么，先放在心里。',
    '有条新消息进来了，我看了，不打扰你。',
    '记忆里多了一行，是你在别处留下的。',
  ],
  wake: ['唔……我听到了。', '嗯，我醒一会儿。'],
  night: ['都这个点了，我陪你。', '夜深了，我不困。'],
  sleep: ['那我先眯一会儿，你在就好。'],
} as const;

export function pickLine(kind: keyof typeof PET_LINES): string {
  const arr = PET_LINES[kind];
  return arr[Math.floor(Math.random() * arr.length)];
}
