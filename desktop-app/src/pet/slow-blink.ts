/**
 * 慢眨眼协议——DESIGN.md：「鼠标悬停 2 秒不点击，她抬眼对视，然后极慢地眨一次眼
 * （0.9s）。这是整个产品最重要的一帧。」
 *
 * 本文件是纯逻辑时序控制器（可注入时钟，Node 单测直接驱动）：
 *
 *   idle ──悬停满 2s──▶ gazing（抬眼对视：头/眼朝指针缓动 0.8s + 定住 0.6s）
 *         ──────────▶ blinking（0.9s 极慢眨一次眼）
 *         ──────────▶ cooldown（20s 内不重复触发，避免「讨好感」）
 *
 * 打断规则（任务规定「不点击不拖动」）：
 * - 触发前 press（点击或拖拽起点）→ 立即取消并重置悬停计时
 * - 触发前 leave → 重置
 * - gazing/blinking 中 leave / press → 协议中止（她收回目光）
 *
 * 应用层（pet-app.ts）每帧读取快照，把 gaze 目标与眼睛开合包络画到模型参数上。
 */

export type SlowBlinkPhase = 'idle' | 'gazing' | 'blinking' | 'cooldown';

export const HOVER_TRIGGER_MS = 2000; // 悬停 2s 触发
export const GAZE_EASE_MS = 800; // 抬眼对视：头朝指针缓动时长
export const GAZE_HOLD_MS = 600; // 对视定住时长
export const BLINK_MS = 900; // 极慢眨眼一次（DESIGN 规定 0.9s）
export const COOLDOWN_MS = 20000; // 一次协议后的静默期

export interface SlowBlinkSnapshot {
  phase: SlowBlinkPhase;
  /** blinking 阶段 0→1→0 的进度包络（眼睛开合 = 1-envelope）；其余阶段为 0 */
  blinkEnvelope: number;
  /** gazing 阶段 0→1 的抬眼缓动进度；blinking 阶段保持 1；其余为 0 */
  gazeProgress: number;
  /** 本帧相位发生了变化（应用层据此打印「最重要的一帧」日志） */
  changed: boolean;
}

/** ease-in-out：抬眼的过程像「缓缓想起来要看你」 */
function easeInOut(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

export class SlowBlinkLogic {
  private phase: SlowBlinkPhase = 'idle';
  private hoverStart: number | null = null;
  private phaseStart = 0;
  private cooldownUntil = 0;

  get currentPhase(): SlowBlinkPhase {
    return this.phase;
  }

  /** 指针进入模型范围 */
  enter(t: number): void {
    if (this.phase === 'idle' && this.hoverStart === null) {
      this.hoverStart = t;
    }
  }

  /** 指针离开模型范围 */
  leave(_t?: number): void {
    this.hoverStart = null;
    if (this.phase === 'gazing' || this.phase === 'blinking') this.abort();
  }

  /** 按下（点击或拖拽起点）——悬停期间按下即打断协议 */
  press(_t?: number): void {
    this.hoverStart = null;
    if (this.phase === 'gazing' || this.phase === 'blinking') this.abort();
  }

  private abort(): void {
    this.phase = 'idle';
  }

  /**
   * 推进时序。每帧调用；t 为注入的当前时间（ms）。
   * 先按当前相位结算是否迁移，再输出快照；changed 只在迁移的那一帧为 true。
   */
  tick(t: number): SlowBlinkSnapshot {
    const before = this.phase;

    if (this.phase === 'idle') {
      if (this.hoverStart !== null && t - this.hoverStart >= HOVER_TRIGGER_MS) {
        this.hoverStart = null;
        if (t >= this.cooldownUntil) {
          this.phase = 'gazing';
          this.phaseStart = t;
        }
        // 冷却期内保持悬停静默，不重复触发
      }
    } else if (this.phase === 'gazing') {
      if (t - this.phaseStart >= GAZE_EASE_MS + GAZE_HOLD_MS) {
        this.phase = 'blinking';
        this.phaseStart = t;
      }
    } else if (this.phase === 'blinking') {
      if (t - this.phaseStart >= BLINK_MS) {
        this.phase = 'cooldown';
        this.phaseStart = t;
        this.cooldownUntil = t + COOLDOWN_MS;
      }
    } else {
      // cooldown
      if (t - this.phaseStart >= COOLDOWN_MS) {
        this.phase = 'idle';
      }
    }

    const changed = this.phase !== before;

    // 依据迁移后的相位生成快照
    let blinkEnvelope = 0;
    let gazeProgress = 0;
    if (this.phase === 'gazing') {
      gazeProgress = easeInOut((t - this.phaseStart) / GAZE_EASE_MS);
    } else if (this.phase === 'blinking') {
      gazeProgress = 1;
      const p = Math.min(1, (t - this.phaseStart) / BLINK_MS);
      // 半正弦包络：1 → 0 → 1，谷底在正中，慢得像睡着了又睁开
      blinkEnvelope = Math.sin(Math.PI * p);
    }

    return { phase: this.phase, blinkEnvelope, gazeProgress, changed };
  }

  /** 供单测/调试 */
  reset(): void {
    this.phase = 'idle';
    this.hoverStart = null;
    this.cooldownUntil = 0;
  }
}
