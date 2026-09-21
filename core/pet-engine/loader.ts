/** 模型变换点的最小形状（PIXI.ObservablePoint 替身）。 */
interface ObsPoint { set(x?: number, y?: number): void; x: number; y: number; }
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
    // 幂等：识别本函数注入过的（data-neko-src）与页面静态存在的（src 完全相等）
    if (
      document.querySelector(`script[data-neko-src="${src}"]`) ||
      document.querySelector(`script[src="${src}"]`)
    ) {
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
  anchor: ObsPoint;
  position: ObsPoint;
  scale: ObsPoint;
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

/** script 注入的全局 PIXI（与模型同实例）的最小形状。 */
interface GlobalPIXI {
  Application: new (opts: Record<string, unknown>) => unknown;
  live2d: {
    Live2DModel: Cubism2ModelCtor;
    SoundManager: { volume: number };
  };
}

/** PetStage.app 的最小形状（全局 PIXI.Application 实例）。 */
interface PIXIApplication {
  ticker: { add: (fn: (t: { deltaMS: number }) => void) => unknown };
  renderer: { width: number; height: number; resolution: number };
  view: HTMLCanvasElement;
  stage: { addChild: (m: unknown) => void };
  destroy: (a?: boolean, o?: Record<string, unknown>) => void;
}

/** window.PIXI.live2d.Live2DModel 构造器（cubism2 UMD）的最小形状。 */
type Cubism2ModelCtor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (url: string, opts?: Record<string, unknown>) => Promise<any>;
};

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
  /** 全局（script 注入的）PIXI 实例上的 Application；init() 前为 null。 */
  app: PIXIApplication | null = null;
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
    // 注意：不在此创建 PIXI.Application——运行时是 init() 里 script 注入的全局
    // PIXI，构造期它可能尚不存在。ESM import 的 pixi 与全局 pixi 是两个实例，
    // 混用导致模型挂不上 stage（2026-09-21 排障实锤）。
    // 指针绑定移至 init()（canvas 需等 app 创建）。
  }

  /** 初始化：加载运行时与模型；失败则降级为呼吸圆点占位。
   *
   * 三件全走本地 /vendor/（fetch-model.sh / npm postinstall 复制）：
   * pixi.min.js → live2d.min.js → cubism2.min.js，共享同一全局 PIXI 实例。
   * 不用 ESM import pixi-live2d-display——vite 会解析出第二份 pixi 实例，
   * 渲染器与模型分离导致碎片渲染（2026-09-20 排障实锤）。CDN 兜底仅限直连环境。
   */
  async init(): Promise<void> {
    const localUrl = this.opts.live2dRuntimeLocalUrl ?? LIVE2D_RUNTIME_LOCAL;
    const cdnUrl = this.opts.live2dRuntimeUrl ?? LIVE2D_RUNTIME_CDN;
    const V = '/vendor';
    try {
      if (!(window as unknown as { PIXI?: unknown }).PIXI) {
        try { await loadScript(`${V}/pixi7.min.js`); }
        catch { await loadScript('https://cdn.jsdelivr.net/npm/pixi.js@7.4.3/dist/pixi.min.js'); }
        // fork cubism2 的 UMD 依赖 @pixi/sound（全局 PIXI 上补挂）
        try { await loadScript(`${V}/pixi-sound.min.js`); } catch { /* 声音已静音，缺失可容 */ }
      }
      try {
        await loadScript(localUrl);
      } catch {
        // 本地运行时缺失（未跑 fetch-model.sh）→ CDN 兜底
        await loadScript(cdnUrl);
      }
      if (!(window as unknown as { Live2D?: unknown }).Live2D) {
        throw new Error('live2d.min.js 加载完成但 window.Live2D 缺失');
      }
      if (!(window as unknown as { PIXI?: { live2d?: unknown } }).PIXI?.live2d) {
        try { await loadScript(`${V}/cubism2.min.js`); }
        catch { await loadScript('https://cdn.jsdelivr.net/npm/pixi-live2d-display-advanced@1.1.0/dist/cubism2.min.js'); }
        if (!(window as unknown as { PIXI?: { live2d?: unknown } }).PIXI?.live2d) {
          throw new Error('cubism2.min.js 加载完成但 PIXI.live2d 缺失');
        }
      }
      // 静音：DESIGN「桌宠默认安静」；模型 voice 缺失时也避免加载报错噪音
      const g = (window as unknown as { PIXI: GlobalPIXI }).PIXI;
      const { Live2DModel, SoundManager } = g.live2d;
      SoundManager.volume = 0;
      const model = (await Live2DModel.from(this.opts.modelUrl, {
        autoHitTest: false, // 交互由本引擎自己调度（FSM + 慢眨眼）；fork v0.5 以 autoHitTest 取代 autoInteract
        autoUpdate: true,
      })) as unknown as Cubism2Model;

      if (this.destroyed) {
        (model as unknown as { destroy?: () => void }).destroy?.(); // in-flight 泄漏（审计 F11）
        return;
      }
      // 全局 PIXI 上创建 Application（与模型同一实例——双实例即碎片根因）
      const cw = this.container.clientWidth || 320;
      const ch = this.container.clientHeight || 360;
      // 与 min-test-fork 完全一致：预先创建 canvas 传入 view（pixi 自建 canvas 在
      // fork+v7 组合下渲染不显示——2026-09-21 用户浏览器对照实锤）
      const viewEl = document.createElement('canvas');
      // HiDPI：resolution=dpr + autoDensity 让 pixi 接管 canvas style（审计 F4/F6）——
      // 手写 style 与 renderer.resize 不同步会造成缩窗变形
      this.app = new g.Application({
        view: viewEl,
        backgroundAlpha: 0, // v7 透明写法（transparent 是 v6 API——排障实锤）
        width: cw,
        height: ch,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
      }) as PIXIApplication;
      const canvas = viewEl;
      canvas.style.touchAction = 'none';
      this.container.appendChild(canvas);
      this.bindPointerEvents(); // canvas 就绪，绑定指针（原在构造函数，app 尚未创建）

      // 窗口/容器尺寸变化：画布跟随（全屏挂载场景必需——否则缩窗后模型出界消失）
      const onResize = () => {
        if (!this.app || this.destroyed) return;
        const rw = this.container.clientWidth || 320;
        const rh = this.container.clientHeight || 360;
        (this.app.renderer as unknown as { resize: (w: number, h: number) => void }).resize(rw, rh);
        this.clampModelIntoView();
      };
      window.addEventListener("resize", onResize);
      this.cleanupFns.push(() => window.removeEventListener("resize", onResize));

      // 后台不空转（审计 F7）：hidden 停 ticker；可见时限 30fps（呼吸动画足够）
      const tk = (this.app as unknown as { ticker: { stop: () => void; start: () => void; maxFPS: number } }).ticker;
      tk.maxFPS = 30;
      const onVis = () => { document.hidden ? tk.stop() : tk.start(); };
      document.addEventListener("visibilitychange", onVis);
      this.cleanupFns.push(() => document.removeEventListener("visibilitychange", onVis));

      this.model = model;
      (this.app!.stage as unknown as { addChild: (m: unknown) => void }).addChild(model);

      // 缩放到目标高度，anchor 底部中心
      const targetH = this.opts.height ?? 220;
      const scale = targetH / model.height;
      model.scale.set(scale);
      model.anchor.set(0.5, 1);
      const w = (this.app?.renderer.width ?? this.container.clientWidth) / (this.app?.renderer.resolution || 1);
      const h = (this.app?.renderer.height ?? this.container.clientHeight) / (this.app?.renderer.resolution || 1);
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
    const canvas = this.app!.view;
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
        this.clampModelIntoView(); // 松手夹回视口（审计 F5）
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
    const b = (this.model as unknown as { getBounds: () => { x: number; y: number; width: number; height: number } }).getBounds();
    return lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height;
  }

  /** 模型头顶的页面坐标（speech overlay 定位用；占位模式下取容器顶部中心） */
  headScreenPos(): { x: number; y: number } {
    // 占位模式（app 为 null，模型/vendor 加载失败）下用容器几何——
    // 否则 TypeError 被 events 的 try/catch 静默吞掉，watching 因
    // scheduleActionDone 被跳过而永久卡死（审计 F1）
    if (!this.app || !this.model) {
      const cr = this.container.getBoundingClientRect();
      return { x: cr.left + cr.width / 2, y: cr.top + 24 };
    }
    const r = this.app!.view.getBoundingClientRect();
    if (!this.model) return { x: r.left + r.width / 2, y: r.top + 24 };
    const h = this.model.height;
    return { x: r.left + this.model.x, y: r.top + this.model.y - h - 12 };
  }

  /** 每帧参数写入钩子——挂 PIXI ticker 默认优先级：
   * 在模型自身 update（fork 经 ticker 驱动）之后、Application render（LOW 优先级）
   * 之前执行。这是写 BREATH/EYE_OPEN/ANGLE 参数的正统槽位——
   * 不包 internal.update（monkey-patch 会断 fork 渲染管线，2026-09-21 实锤）。
   * dt 单位 ms（ticker deltaMS）。 */
  onTickerFrame(cb: (coreModel: Cubism2Model['internalModel']['coreModel'], dtMs: number) => void): void {
    if (!this.model || !this.app) return;
    const core = this.model.internalModel.coreModel;
    // PIXI ticker 监听器签名是 (deltaTime 帧数)——deltaMS 要从 ticker 实例取
    const ticker = (this.app as unknown as { ticker: { deltaMS: number; add: (fn: () => void) => unknown } }).ticker;
    ticker.add(() => cb(core, ticker.deltaMS));
  }

  /** 模型位置夹回视口内（拖出屏幕找不回——审计 F5；resize 后也调用） */
  clampModelIntoView(): void {
    if (!this.model) return;
    const w = (this.app as unknown as { screen?: { width: number } })?.screen?.width
      ?? this.container.clientWidth ?? 320;
    const h = (this.app as unknown as { screen?: { height: number } })?.screen?.height
      ?? this.container.clientHeight ?? 360;
    const mw = this.model.width || 100;
    const mh = this.model.height || 100;
    // 至少留 20% 在视口内（anchor 底部中心）
    const minX = -mw * 0.3, maxX = w + mw * 0.3;
    const minY = mh * 0.3, maxY = h + mh * 0.3;
    this.model.x = Math.min(maxX, Math.max(minX, this.model.x));
    this.model.y = Math.min(maxY, Math.max(minY, this.model.y));
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
      this.app?.destroy(true, { children: true });
    } catch {
      /* 忽略 */
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
