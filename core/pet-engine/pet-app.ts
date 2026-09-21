/**
 * PetApp——桌宠引擎总装：把行为状态机、事件源、模型舞台、慢眨眼协议、手写字浮现接在一起。
 *
 * 数据流（单向）：
 *   真实世界（输入闲置/时钟/记忆轮询/点击/悬停）
 *     → PetEventSources / PetStage 命中
 *     → PetEvent → PetFSM.handle()
 *     → PetTransition → applyState()（motion 组优先，无 motion 用参数级动效）
 *
 * 状态 → 模型动作映射（xiaomai 的 motion 组：idle/start/tap_head/tap_body/shake/random/new_msg）：
 * | 状态        | motion 组（存在时播放）      | 无 motion 时的参数级动效                     |
 * |------------|------------------------------|----------------------------------------------|
 * | sleeping   | 无（停掉 idle 自动组）        | 呼吸 8s + 双眼闭合                            |
 * | drowsy     | 无                           | 呼吸 6s + 眼睛 0.25 半开                      |
 * | sitting    | idle（库自动循环）            | 呼吸 4.6s（DESIGN 周期）                      |
 * | watching   | new_msg                      | 头 ParamAngleX/Y 朝活跃方向缓动 + 呼吸 4s     |
 * | grooming   | random                       | 身体 ParamBodyAngleX 小幅摆动 + 呼吸 4s      |
 * | stretching | shake                        | 身体 ParamBodyAngleY 摆动 + 深呼吸 3.6s      |
 * | idle-walk  | 无                           | 模型水平游走 ±24px + 身体摆动                 |
 * 点击（头/身）| tap_head / tap_body           | —                                            |
 * 慢眨眼协议   | 叠加层，不占用状态            | 头朝指针缓动 + 眼开合 1→0→1（0.9s）           |
 *
 * 原生壳（二期 Electron 透明窗口）接口约定见 MOUNTING.md；本文件在
 * window.__nekoPet 上暴露最小 API（getState/setInteractive/onStateChange/say/getBounds）。
 */

import { PetFSM, ACTION_DURATIONS_MS, BREATH_PERIOD_S, EYE_OPEN_BASE } from './behavior';
import { PetEventSources } from './events';
import { PetStage } from './loader';
import { SlowBlinkLogic } from './slow-blink';
import { SpeechOverlay, pickLine } from './speech';
import { resolvePetConfig, type PetConfig, type PetEvent, type PetState, type PetTransition } from './types';

// Cubism 2 标准参数 ID（live2d.min.js 运行时约定）
const P = {
  ANGLE_X: 'PARAM_ANGLE_X',
  ANGLE_Y: 'PARAM_ANGLE_Y',
  EYE_L: 'PARAM_EYE_L_OPEN',
  EYE_R: 'PARAM_EYE_R_OPEN',
  EYE_BALL_X: 'PARAM_EYE_BALL_X',
  EYE_BALL_Y: 'PARAM_EYE_BALL_Y',
  BREATH: 'PARAM_BREATH',
  BODY_X: 'PARAM_BODY_ANGLE_X',
  BODY_Y: 'PARAM_BODY_ANGLE_Y',
} as const;

interface CoreModel {
  getParamIndex: (id: string) => number;
  setParamFloat: (id: string, v: number) => void;
  addToParamFloat: (id: string, v: number) => void;
}

export interface PetAppOptions {
  /** 舞台容器（会塞入透明 canvas 与手写字层；position 需非 static） */
  container: HTMLElement;
  config?: Partial<PetConfig>;
  log?: (line: string) => void;
  /** 屏蔽真实输入事件源（演示页/无头测试手动注入） */
  manualEvents?: boolean;
  /** 手写字颜色（暗底默认 #D8CDBA；亮底传 #2A2520） */
  speechColor?: string;
}

/** 原生壳（Electron 主/渲染进程）与页面的接口约定，二期 setIgnoreMouseEvents 配合用 */
export interface NekoPetGlobalAPI {
  getState(): PetState;
  /** 'all'=正常交互；'none'=页面侧也关闭命中（配合窗口级 setIgnoreMouseEvents(true)） */
  setInteractive(mode: 'all' | 'none'): void;
  onStateChange(cb: (t: PetTransition) => void): void;
  offStateChange(cb: (t: PetTransition) => void): void;
  say(text: string): void;
  /** 模型在页面坐标系的包围盒（原生壳转发鼠标命中/穿透判定用） */
  getBounds(): { x: number; y: number; width: number; height: number };
  /** 调试/遥测快照：呼吸相位、眼睛开合、头向偏移、慢眨眼相位 */
  getDebugSnapshot(): {
    state: PetState;
    breathPhase: number;
    gaze: { x: number; y: number };
    slowBlinkPhase: string;
    modelLoaded: boolean;
  };
  destroy(): void;
}

export class PetApp {
  readonly fsm = new PetFSM();
  readonly config: PetConfig;
  readonly stage: PetStage;
  readonly speech: SpeechOverlay;
  readonly events: PetEventSources;
  readonly slowBlink = new SlowBlinkLogic();

  private log: (line: string) => void;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 状态迁移监听（原生壳 onStateChange 的底座；exposeNekoPet 模块函数访问） */
  stateListeners: Array<(t: PetTransition) => void> = [];
  /** 指针最近位置（页面 px）与「活跃方向」目标（-1..1 归一化） */
  private pointer = { x: 0, y: 0 };
  private gaze = { x: 0, y: 0 }; // 平滑后的头向偏移（度）
  private lastInputPoint = { x: 0, y: 0 };
  private breathPhase = 0;
  private walkBaseX: number | null = null;
  private walkStartAt = 0;
  private interactive = true;
  private destroyed = false;
  private raf: number | null = null;

  constructor(opts: PetAppOptions) {
    this.config = resolvePetConfig(opts.config);
    this.log = opts.log ?? (() => {});
    this.stage = new PetStage({
      container: opts.container,
      modelUrl: this.config.modelUrl,
      height: this.config.height,
      x: this.config.x || undefined,
      y: this.config.y || undefined,
      onModelClick: (hits) => this.onModelClick(hits),
      onHoverChange: (inside) => {
        if (!this.interactive) return;
        inside ? this.slowBlink.enter(performance.now()) : this.slowBlink.leave(performance.now());
      },
      onDragChange: (dragging) => {
        if (dragging) this.slowBlink.press(performance.now());
      },
      onFallback: (reason) => this.log(`[loader] 模型加载失败，降级为呼吸圆点：${reason}`),
    });
    this.speech = new SpeechOverlay(opts.container, { color: opts.speechColor });
    this.events = new PetEventSources(
      (ev) => this.dispatch(ev),
      {
        memoryServer: this.config.memoryServer,
        manual: opts.manualEvents ?? false,
      },
    );
    this.trackPointer();
  }

  async mount(): Promise<void> {
    await this.stage.init();
    if (this.destroyed) return;
    if (this.stage.usingFallback) {
      this.log(`[pet] 初始状态 ${this.fsm.state}（占位模式——行为状态机照常运行）`);
    } else {
      this.log(`[pet] 模型就绪，初始状态 ${this.fsm.state}`);
      // 2026-09-21 排障：monkey-patch internal.update 在 fork v0.5 下疑似阻断渲染管线。
      // 停用参数直写，改由 FSM 状态查询（视觉差异后续经 motion 组表达）。
      // this.stage.onModelUpdate((core, dt) => this.frameDrive(core, dt));
      this.applyStateEnter(this.fsm.state, null);
    }
    this.events.start();
    // 慢眨眼协议的逐帧推进（requestAnimationFrame；与 pixi ticker 解耦，便于无模型时也跑逻辑）
    const loop = () => {
      if (this.destroyed) return;
      this.driveSlowBlink();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);

    exposeNekoPet(this);
    this.log('[pet] 桌宠引擎已挂载（window.__nekoPet 可用）');
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (this.actionTimer) clearTimeout(this.actionTimer);
    for (const fn of this.cleanupTrackers) fn();
    this.cleanupTrackers = [];
    this.events.stop();
    this.speech.destroy();
    this.stage.destroy();
  }

  // ---------- 事件分发与状态应用 ----------

  private dispatch(ev: PetEvent): void {
    // 手动记录指针位置作为「活跃方向」
    if (ev.type === 'USER_INPUT') this.lastInputPoint = { ...this.pointer };
    const t = this.fsm.handle(ev);
    if (!t) return;
    this.log(`[fsm] ${t.from} → ${t.to}（${t.event}）${t.reason ?`：${t.reason}` : ''}`);
    for (const cb of this.stateListeners) {
      try {
        cb(t);
      } catch {
        /* 监听器异常不拖垮引擎 */
      }
    }
    this.applyStateEnter(t.to, t);
  }

  private onModelClick(hits: string[]): void {
    if (!this.interactive) return;
    this.slowBlink.press(performance.now());
    const hitHead = hits.includes('head');
    this.log(`[pet] 被点击（命中：${hits.join('/') || '模型'}）`);
    if (this.stage.model) {
      this.stage.playMotion(hitHead ? 'tap_head' : 'tap_body');
    }
    this.speech.say(pickLine('click'), this.stage.headScreenPos());
    this.dispatch({ type: 'CLICK', hour: this.events.currentHour() });
  }

  private applyStateEnter(state: PetState, t: PetTransition | null): void {
    // 限时状态的计时器（被打断时由 FSM 的 no-op 自然作废）
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;

    switch (state) {
      case 'sleeping':
        this.setLibraryIdle(false);
        this.stage.stopMotions();
        if (t && Math.random() < 0.5) this.speech.say(pickLine('sleep'), this.stage.headScreenPos());
        break;
      case 'drowsy':
        this.setLibraryIdle(false);
        this.stage.stopMotions();
        if (t?.from === 'sleeping' && Math.random() < 0.3) this.speech.say(pickLine('wake'), this.stage.headScreenPos());
        break;
      case 'sitting':
        this.setLibraryIdle(true); // 恢复库的 idle 自动组（呼吸/小动作交给模型）
        break;
      case 'watching':
        // 终端事件 → 看你工作：优先 motion 组 new_msg，否则纯参数注视
        if (!this.stage.playMotion('new_msg')) this.setLibraryIdle(false);
        if (t?.event === 'TERMINAL_MESSAGE') this.speech.say(pickLine('memory'), this.stage.headScreenPos());
        this.scheduleActionDone(state);
        break;
      case 'grooming':
        if (!this.stage.playMotion('random')) this.setLibraryIdle(false);
        this.scheduleActionDone(state);
        break;
      case 'stretching':
        if (!this.stage.playMotion('shake')) this.setLibraryIdle(false);
        this.scheduleActionDone(state);
        break;
      case 'idle-walk': {
        this.setLibraryIdle(false);
        this.walkBaseX = this.stage.model?.x ?? null;
        this.walkStartAt = performance.now();
        if (this.events.currentHour() >= 22 || this.events.currentHour() < 2) {
          if (Math.random() < 0.4) this.speech.say(pickLine('night'), this.stage.headScreenPos());
        }
        this.scheduleActionDone(state);
        break;
      }
    }
  }

  private scheduleActionDone(state: PetState): void {
    const dur = ACTION_DURATIONS_MS[state];
    if (!dur) return;
    this.actionTimer = setTimeout(() => {
      this.dispatch({
        type: 'ACTION_DONE',
        seconds: this.events.idleSeconds(),
        hour: this.events.currentHour(),
      });
    }, dur);
  }

  /** 库的 idle motion 自动组开关（睡觉/浅睡/参数驱动状态时关掉，避免动作打架） */
  private setLibraryIdle(enable: boolean): void {
    const mm = this.stage.model?.internalModel?.motionManager as
      | { groups?: { idle?: string } }
      | undefined;
    if (!mm) return;
    try {
      if (!mm.groups) return;
      mm.groups.idle = enable ? 'idle' : '';
    } catch {
      /* 忽略 */
    }
  }

  // ---------- 每帧参数驱动 ----------

  private trackPointer(): void {
    const fn = (e: PointerEvent) => {
      this.pointer = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', fn, { passive: true });
    this.cleanupTrackers.push(() => window.removeEventListener('pointermove', fn));
  }
  private cleanupTrackers: Array<() => void> = [];

  /**
   * 参数级动效（在库的 motion 更新之后写入，因此对呼吸/眼/头向拥有最终决定权）：
   * 呼吸速率（状态周期）→ 眼睛开合（状态基线 × 慢眨眼包络）→ 头部朝向（注视缓动）。
   */
  /** 每帧参数直写（呼吸/眼/头向）——fork v0.5 下经 monkey-patch 注入会断渲染，
   * 停用待后续改道 motion 组。保留实现供迁移参考。 */
  // 公开以避免 unused（将来经 motion 组恢复参数动效时复用）
  frameDrive(core: CoreModel, dtMs: number): void {
    if (this.destroyed) return;
    const state = this.fsm.state;
    const now = performance.now();

    // 呼吸：状态决定周期；sin 包络 0..1
    const period = BREATH_PERIOD_S[state];
    this.breathPhase += (dtMs / 1000 / period) * Math.PI * 2;
    const breath = (Math.sin(this.breathPhase) + 1) / 2;
    if (hasParam(core, P.BREATH)) {
      core.setParamFloat(P.BREATH, breath);
    } else if (hasParam(core, P.BODY_Y)) {
      core.addToParamFloat(P.BODY_Y, Math.sin(this.breathPhase) * 1.2);
    }

    // 眼睛：慢眨眼协议优先，其次状态基线（sitting 等交给模型自身的自然眨眼）
    const sb = this.slowBlink.currentPhase;
    if (sb === 'blinking') {
      const env = this.blinkEnv;
      setEye(core, 1 - env);
    } else if (sb === 'gazing') {
      setEye(core, Math.max(EYE_OPEN_BASE[state], this.gazeProg));
    } else if (state === 'sleeping' || state === 'drowsy') {
      setEye(core, EYE_OPEN_BASE[state]);
    }

    // 头向：注视目标（慢眨眼=指针；watching=最近输入位置），指数缓动
    let targetX = 0;
    let targetY = 0;
    if (sb === 'gazing' || sb === 'blinking') {
      const d = this.directionTo(this.pointer);
      targetX = d.x * 26 * (sb === 'gazing' ? Math.max(0.2, this.gazeProg) : 1);
      targetY = d.y * 18;
    } else if (state === 'watching') {
      const d = this.directionTo(this.lastInputPoint);
      targetX = d.x * 18;
      targetY = d.y * 12;
    }
    const k = 1 - Math.exp(-dtMs / 280); // 时间常数 280ms 的缓动
    this.gaze.x += (targetX - this.gaze.x) * k;
    this.gaze.y += (targetY - this.gaze.y) * k;
    if (hasParam(core, P.ANGLE_X)) {
      core.addToParamFloat(P.ANGLE_X, this.gaze.x);
      core.addToParamFloat(P.ANGLE_Y, this.gaze.y);
      core.addToParamFloat(P.EYE_BALL_X, this.gaze.x / 26);
      core.addToParamFloat(P.EYE_BALL_Y, -this.gaze.y / 18 / 2);
    }

    // 状态补充动效（模型无对应 motion 组时也能看出差别）
    if (state === 'grooming' && hasParam(core, P.BODY_X)) {
      core.addToParamFloat(P.BODY_X, Math.sin(now / 420) * 4);
    }
    if (state === 'stretching' && hasParam(core, P.BODY_Y)) {
      core.addToParamFloat(P.BODY_Y, Math.sin(now / 600) * 5);
    }
    if (state === 'idle-walk' && this.stage.model) {
      // 深夜游走：水平 ±24px 的缓慢往返
      const p = (now - this.walkStartAt) / ACTION_DURATIONS_MS['idle-walk'];
      if (this.walkBaseX !== null) {
        this.stage.model.x = this.walkBaseX + Math.sin(p * Math.PI * 2) * 24;
      }
      if (hasParam(core, P.BODY_X)) core.addToParamFloat(P.BODY_X, Math.sin(now / 300) * 3);
    }
  }

  /** 指针方向 → 归一化 (-1..1)，以模型中心为原点 */
  private directionTo(pt: { x: number; y: number }): { x: number; y: number } {
    const model = this.stage.model;
    if (!model) return { x: 0, y: 0 };
    const r = this.stage!.app!.view.getBoundingClientRect();
    const cx = r.left + model.x;
    const cy = r.top + model.y - this.config.height / 2;
    const half = Math.max(1, r.width / 2);
    return {
      x: clamp((pt.x - cx) / half, -1, 1),
      y: clamp(-(pt.y - cy) / half, -1, 1),
    };
  }

  // ---------- 慢眨眼协议应用 ----------

  private gazeProg = 0;
  private blinkEnv = 0;

  private driveSlowBlink(): void {
    const snap = this.slowBlink.tick(performance.now());
    this.gazeProg = snap.gazeProgress;
    this.blinkEnv = snap.blinkEnvelope;
    if (!snap.changed) return;
    if (snap.phase === 'gazing') {
      this.log('[slow-blink] 她抬起眼看向你（对视中……）');
    } else if (snap.phase === 'blinking') {
      this.log('[slow-blink] ——她极慢地眨了一次眼（0.9s）。整个产品最重要的一帧。');
    } else if (snap.phase === 'cooldown') {
      this.log('[slow-blink] 对视结束，她收回目光（20s 内不会重复）');
    }
  }

  // ---------- 对外接口（演示页 / 原生壳） ----------

  say(text: string): void {
    this.speech.say(text, this.stage.headScreenPos());
  }

  /** 调试/遥测：呼吸相位（弧度，每周期 2π） */
  get debugBreathPhase(): number {
    return this.breathPhase;
  }

  /** 调试/遥测：当前头向偏移（度） */
  get debugGaze(): { x: number; y: number } {
    return { ...this.gaze };
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    const m = this.stage.model as unknown as { getBounds?: () => { x: number; y: number; width: number; height: number } } | null;
    const r = this.stage!.app!.view.getBoundingClientRect();
    if (m?.getBounds) {
      try {
        const b = m.getBounds();
        return { x: r.left + b.x, y: r.top + b.y, width: b.width, height: b.height };
      } catch {
        /* 走容器兜底 */
      }
    }
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  setInteractive(mode: 'all' | 'none'): void {
    this.interactive = mode === 'all';
    const canvas = this.stage!.app!.view;
    canvas.style.pointerEvents = mode === 'all' ? 'auto' : 'none';
    if (mode === 'none') this.slowBlink.leave(performance.now());
    this.log(`[pet] interactive=${mode}（原生壳 setIgnoreMouseEvents 的页面侧配合）`);
  }
}

// ---------- 工具 ----------

function hasParam(core: CoreModel, id: string): boolean {
  try {
    return core.getParamIndex(id) >= 0;
  } catch {
    return false;
  }
}

function setEye(core: CoreModel, v: number): void {
  const clamped = clamp(v, 0, 1);
  if (hasParam(core, P.EYE_L)) core.setParamFloat(P.EYE_L, clamped);
  if (hasParam(core, P.EYE_R)) core.setParamFloat(P.EYE_R, clamped);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// window.__nekoPet 暴露（原生壳契约，见 MOUNTING.md）
function exposeNekoPet(app: PetApp): void {
  const api: NekoPetGlobalAPI = {
    getState: () => app.fsm.state,
    setInteractive: (m) => app.setInteractive(m),
    onStateChange: (cb) => app.stateListeners.push(cb),
    offStateChange: (cb) => {
      const i = app.stateListeners.indexOf(cb);
      if (i >= 0) app.stateListeners.splice(i, 1);
    },
    say: (text) => app.say(text),
    getBounds: () => app.getBounds(),
    getDebugSnapshot: () => ({
      state: app.fsm.state,
      breathPhase: Number(app.debugBreathPhase.toFixed(3)),
      gaze: { x: Math.round(app.debugGaze.x * 10) / 10, y: Math.round(app.debugGaze.y * 10) / 10 },
      slowBlinkPhase: app.slowBlink.currentPhase,
      modelLoaded: !app.stage.usingFallback,
    }),
    destroy: () => app.destroy(),
  };
  (window as unknown as { __nekoPet?: NekoPetGlobalAPI }).__nekoPet = api;
}

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
void 0;
