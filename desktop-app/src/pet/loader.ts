/**
 * 模型加载器——pixi 应用（透明背景）+ Live2D 模型 + 降级占位 + 拖拽/点击/悬停命中。
 *
 * 加载链：live2d.min.js（Cubism 2 web 运行时，CDN）→ pixi-live2d-display/cubism2 →
 * Live2DModel.from(modelUrl)（本地模型路径由配置传入，见 scripts/fetch-model.sh）。
 * 任何一环失败 → 纯 CSS 呼吸圆点占位（保证无模型时页面不崩、行为状态机照常可测）。
 *
 * 交互约定（浏览器内）：
 * - 拖拽：在模型上按下并移动 >4px，模型跟手；松开归位为「放下」
 * - 点击：按下且未拖动、仍在模型上 → onClick(hitAreas)
 * - 悬停：指针位于模型包围盒内且未按下 → onHoverChange(inside)（慢眨眼协议的输入）
 */

import * as PIXI from 'pixi.js';

/**
 * Cubism 2 web 运行时（live2d.min.js）。
 * 本地优先（fetch-model.sh 会下载到 desktop-app-assets/vendor/），CDN 兜底。
 * 注意：广为流传的 `web-sdk/Live2D/lib/...` 路径已 404，仓库实际路径是 `webgl/Live2D/lib/`。
 */
export const LIVE2D_RUNTIME_LOCAL = '/vendor/live2d.min.js';
export const LIVE2D_RUNTIME_CDN =
  'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js';

export interface PetStageOptions {
  /** 舞台容器（position 需为 fixed/absolute/relative 之一） */
  container: HTMLElement;
  modelUrl: string;
  /** 模型显示高度 px（DESIGN：150-220） */
  height?: number;
  /** 初始位置（容器内像素，模型 anchor 为底部中心）；默认容器内右下角 */
  x?: number;
  y?: number;
  live2dRuntimeUrl?: string;
  /** 本地运行时路径（优先尝试；fetch-model.sh 下载） */
  live2dRuntimeLocalUrl?: string;
  onModelClick?: (hitAreas: string[]) => void;
  onHoverChange?: (inside: boolean) => void;
  onDragChange?: (dragging: boolean) => void;
  /** 加载失败/成功的外部通知（演示页打日志） */
  onFallback?: (reason: string) => void;
}

/** 动态注入 <script>（幂等） */
export function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-neko-src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.nekoSrc = src;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`无法加载脚本：${src}`));
    };
    document.head.appendChild(s);
  });
}

interface Cubism2Model {
  anchor: PIXI.ObservablePoint;
  position: PIXI.ObservablePoint;
  scale: PIXI.ObservablePoint;
  x: number;
  y: number;
  width: number;
  height: number;
  motion: (group: string, index?: number, priority?: number) => unknown;
  hitTest: (x: number, y: number) => string[];
  internalModel: {
    coreModel: {
      getParamIndex: (id: string) => number;
      setParamFloat: (id: string | number, value: number) => void;
      addToParamFloat: (id: string | number, value: number) => void;
      getParamFloat: (id: string | number) => number;
    };
    motionManager: { stopAllMotions: () => void; startRandomMotion?: (g: string, p: number) => unknown };
    update: (dt: number) => void;
    originalWidth: number;
  };
  on: (event: string, fn: (...args: unknown[]) => void) => unknown;
}

const PLACEHOLDER_CSS = `
.neko-pet-placeholder {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
  padding-bottom: 18px; pointer-events: none;
  font-family: "LXGW WenKai", "Noto Serif SC", serif;
}
.neko-pet-placeholder .dot {
  width: 46px; height: 46px; border-radius: 9999px;
  /* 猫眼琥珀——角色的活物色（DESIGN：琥珀只存在于角色眼里，占位圆点是角色的替身） */
  background: radial-gradient(circle at 38% 32%, #e8b263, #C98A2E 68%, #8a5c1d);
  box-shadow: 0 6px 18px color-mix(in srgb, #C98A2E 38%, transparent);
  animation: neko-pet-breathe 4.6s ease-in-out infinite; /* DESIGN：呼吸 4.6s 周期 */
}
.neko-pet-placeholder .hint {
  margin-top: 10px; font-size: 12px; letter-spacing: 0.08em;
  color: color-mix(in srgb, currentColor 55%, transparent);
}
@keyframes neko-pet-breathe {
  0%, 100% { transform: scale(1); opacity: 0.82; }
  50% { transform: scale(1.14); opacity: 1; }
}
`;

export class PetStage {
  readonly app: PIXI.Application;
  readonly container: HTMLElement;
  model: Cubism2Model | null = null;
  private isFallback = false;
  private opts: PetStageOptions;
  private destroyed = false;
  private dragState: {
    pointerId: number; startX: number; startY: number; modelX: number; modelY: number; moved: boolean;
  } | null = null;
  private hoverInside = false;
  private cleanupFns: Array<() => void> = [];

  constructor(opts: PetStageOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.app = new PIXI.Application({
      backgroundAlpha: 0, // 透明背景：桌宠浮在桌面上
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      width: opts.container.clientWidth || 320,
      height: opts.container.clientHeight || 360,
    });
    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.container.appendChild(canvas);
    // pixi-live2d-display 的自动更新依赖全局 PIXI.Ticker
    (window as unknown as { PIXI: unknown }).PIXI = PIXI;
    this.bindPointerEvents();
  }

  /** 初始化：加载运行时与模型；失败则降级为呼吸圆点占位。运行时本地优先、CDN 兜底。 */
  async init(): Promise<void> {
    const localUrl = this.opts.live2dRuntimeLocalUrl ?? LIVE2D_RUNTIME_LOCAL;
    const cdnUrl = this.opts.live2dRuntimeUrl ?? LIVE2D_RUNTIME_CDN;
    try {
      try {
        await loadScript(localUrl);
      } catch {
        // 本地运行时缺失（未跑 fetch-model.sh）→ CDN 兜底
        await loadScript(cdnUrl);
      }
      if (!(window as unknown as { Live2D?: unknown }).Live2D) {
        throw new Error('live2d.min.js 加载完成但 window.Live2D 缺失');
      }
      // 静音：DESIGN「桌宠默认安静」；模型 voice 缺失时也避免加载报错噪音
      const { Live2DModel, SoundManager } = await import('pixi-live2d-display/cubism2');
      SoundManager.volume = 0;
      const model = (await Live2DModel.from(this.opts.modelUrl, {
        autoInteract: false, // 交互由本引擎自己调度（FSM + 慢眨眼），不用库的默认 focus/tap
        autoUpdate: true,
      })) as unknown as Cubism2Model;

      if (this.destroyed) return;
      this.model = model;
      this.app.stage.addChild(model as unknown as PIXI.DisplayObject);

      // 缩放到目标高度，anchor 底部中心
      const targetH = this.opts.height ?? 220;
      const scale = targetH / model.height;
      model.scale.set(scale);
      model.anchor.set(0.5, 1);
      const w = this.app.renderer.width / (this.app.renderer.resolution || 1);
      const h = this.app.renderer.height / (this.app.renderer.resolution || 1);
      model.x = this.opts.x ?? w - targetH * 0.45;
      model.y = this.opts.y ?? h;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!this.destroyed) this.mountPlaceholder(reason);
      this.opts.onFallback?.(reason);
    }
  }

  /** 无模型时的呼吸圆点占位（CSS 动画，不崩页面） */
  private mountPlaceholder(reason: string): void {
    this.isFallback = true;
    const style = document.createElement('style');
    style.textContent = PLACEHOLDER_CSS;
    document.head.appendChild(style);
    this.cleanupFns.push(() => style.remove());

    const el = document.createElement('div');
    el.className = 'neko-pet-placeholder';
    el.innerHTML = `<div class="dot"></div><div class="hint">模型未就绪，她先化作一盏呼吸<br>${escapeHtml(reason).slice(0, 60)}</div>`;
    this.container.appendChild(el);
    this.cleanupFns.push(() => el.remove());
  }

  get usingFallback(): boolean {
    return this.isFallback;
  }

  // ---------- 指针交互：拖拽 / 点击 / 悬停 ----------

  private bindPointerEvents(): void {
    const canvas = this.app.view as HTMLCanvasElement;
    const rectOf = () => canvas.getBoundingClientRect();

    const onDown = (e: PointerEvent) => {
      if (!this.model) return;
      const r = rectOf();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      if (!this.pointOnModel(lx, ly)) return;
      this.dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        modelX: this.model.x,
        modelY: this.model.y,
        moved: false,
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件/触摸板场景可能无捕获句柄；不影响拖拽逻辑 */
      }
    };

    const onMove = (e: PointerEvent) => {
      const r = rectOf();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      // 悬停命中（拖拽中不算悬停）
      const inside = !this.dragState && !!this.model && this.pointOnModel(lx, ly);
      if (inside !== this.hoverInside) {
        this.hoverInside = inside;
        this.opts.onHoverChange?.(inside);
      }
      if (!this.dragState || !this.model) return;
      const dx = e.clientX - this.dragState.startX;
      const dy = e.clientY - this.dragState.startY;
      if (!this.dragState.moved && Math.hypot(dx, dy) > 4) {
        this.dragState.moved = true;
        this.opts.onDragChange?.(true);
      }
      if (this.dragState.moved) {
        this.model.x = this.dragState.modelX + dx;
        this.model.y = this.dragState.modelY + dy;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!this.dragState || !this.model) return;
      const wasDrag = this.dragState.moved;
      const r = rectOf();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      const st = this.dragState;
      this.dragState = null;
      if (wasDrag) {
        this.opts.onDragChange?.(false);
        return;
      }
      if (this.pointOnModel(lx, ly) && Math.hypot(e.clientX - st.startX, e.clientY - st.startY) <= 4) {
        const hits = this.model.hitTest(lx, ly);
        this.opts.onModelClick?.(hits);
      }
    };

    const onLeaveWindow = () => {
      if (this.hoverInside) {
        this.hoverInside = false;
        this.opts.onHoverChange?.(false);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    document.addEventListener('pointerleave', onLeaveWindow);
    this.cleanupFns.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      document.removeEventListener('pointerleave', onLeaveWindow);
    });
  }

  private pointOnModel(lx: number, ly: number): boolean {
    if (!this.model) return false;
    const b = (this.model as unknown as PIXI.DisplayObject).getBounds();
    return lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height;
  }

  /** 模型头顶的页面坐标（speech overlay 定位用；占位模式下取容器顶部中心） */
  headScreenPos(): { x: number; y: number } {
    const r = (this.app.view as HTMLCanvasElement).getBoundingClientRect();
    if (!this.model) return { x: r.left + r.width / 2, y: r.top + 24 };
    const h = this.model.height;
    return { x: r.left + this.model.x, y: r.top + this.model.y - h - 12 };
  }

  /** 每帧参数覆盖钩子：包住 internalModel.update，在其后写入我们的参数（呼吸/眼/头向） */
  onModelUpdate(cb: (coreModel: Cubism2Model['internalModel']['coreModel'], dt: number) => void): void {
    if (!this.model) return;
    const internal = this.model.internalModel;
    const orig = internal.update.bind(internal);
    internal.update = (dt: number) => {
      orig(dt);
      cb(internal.coreModel, dt);
    };
  }

  /** 当前是否正在被拖拽（慢眨眼协议的打断条件之一） */
  get dragging(): boolean {
    return this.dragState?.moved ?? false;
  }

  /** 播放 motion 组（存在时）；返回是否真的播放了 */
  playMotion(group: string, priority = 3): boolean {
    if (!this.model) return false;
    try {
      this.model.motion(group, undefined, priority);
      return true;
    } catch {
      return false;
    }
  }

  stopMotions(): void {
    try {
      this.model?.internalModel.motionManager.stopAllMotions();
    } catch {
      /* 忽略 */
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    try {
      this.app.destroy(true, { children: true });
    } catch {
      /* 忽略 */
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
