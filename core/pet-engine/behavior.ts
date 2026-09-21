/**
 * 行为状态机（桌宠核心）——纯逻辑，无 DOM/pixi 依赖，可在 Node 单测中直接驱动。
 *
 * 设计来源 DESIGN.md Motion 节：
 * - 睡觉（默认，呼吸极慢）→ 浅睡 → 坐姿 → 看你工作 → 理毛/伸展（长闲置后）
 * - 迁移由真实事件驱动：终端输出流、输入闲置、系统时钟（深夜活跃正午沉睡）、用户交互
 * - 慢眨眼协议不在状态机内（见 slow-blink.ts，它是叠加在任意状态上的「对视覆盖层」）
 *
 * 迁移表（事件 → 目标状态）：
 * | 当前状态     | 事件               | 目标状态     | 说明                                   |
 * |-------------|--------------------|-------------|----------------------------------------|
 * | sleeping    | USER_INPUT         | drowsy      | 被输入声惊动，翻入浅睡                    |
 * | sleeping    | CLICK              | drowsy      | 被戳醒                                  |
 * | sleeping    | TERMINAL_MESSAGE   | drowsy      | 听到新消息动静，浅醒                     |
 * | drowsy      | USER_INPUT         | sitting     | 持续活动把她完全叫醒                     |
 * | drowsy      | IDLE ≥ 睡眠阈值+90 | sleeping    | 没人理，睡沉                            |
 * | sitting     | IDLE ≥ 600 且未伸展 | stretching  | 长闲置，伸展一次（每个闲置纪元一次）        |
 * | sitting     | IDLE ≥ 240 且未理毛 | grooming    | 闲置较久，理毛一次                       |
 * | sitting     | 深夜 && IDLE ≥ 120  | idle-walk   | 深夜陪伴：小范围游走（每个闲置纪元一次）    |
 * | sitting     | IDLE ≥ 睡眠阈值     | drowsy      | 打瞌睡（阈值随昼夜变化，见 sleepTolerance）|
 * | drowsy      | TERMINAL_MESSAGE   | watching    | 浅睡中被消息唤醒，看一眼                  |
 * | sitting     | TERMINAL_MESSAGE   | watching    | 注意到新跨端消息（8s 后回）               |
 * | grooming 等  | TERMINAL_MESSAGE   | watching    | 手头动作被打断，先看消息                  |
 * | sitting     | CLICK              | watching    | 她转向你                                |
 * | watching    | ACTION_DONE(闲够)  | drowsy      | 看完发现你还是没动，瞌睡                 |
 * | watching    | ACTION_DONE        | sitting    | 看完回到坐姿                            |
 * | watching 等  | USER_INPUT         | sitting     | 你一动，她放下手头的事                   |
 * | grooming    | ACTION_DONE        | sitting    | 理完毛                                  |
 * | stretching  | ACTION_DONE        | sitting    | 伸完腰                                  |
 * | idle-walk   | ACTION_DONE        | sitting    | 走完这几步                              |
 *
 * 睡眠阈值 sleepTolerance(hour)：正午（11-14 时）300s 最易睡；深夜（22-02 时）1800s
 * 最能熬；其余 900s。即 DESIGN 的「深夜活跃正午沉睡」。
 */

import type { PetEvent, PetEventType, PetState, PetTransition } from './types';

/** 限时状态的时长（毫秒），事件层据此调度 ACTION_DONE */
export const ACTION_DURATIONS_MS: Record<string, number> = {
  watching: 8000, // 看你工作 8s（任务规定：终端事件触发 watching 8s）
  grooming: 12000,
  stretching: 5000,
  'idle-walk': 10000,
};

/** 各状态的呼吸周期（秒）——sleeping 最慢，坐姿为 DESIGN 定义的 4.6s */
export const BREATH_PERIOD_S: Record<PetState, number> = {
  sleeping: 8,
  drowsy: 6,
  sitting: 4.6,
  watching: 4,
  grooming: 4,
  stretching: 3.6,
  'idle-walk': 4,
};

/** 各状态的眼睛开合基线（0 闭眼 1 全开；慢眨眼协议在此之上叠加包络） */
export const EYE_OPEN_BASE: Record<PetState, number> = {
  sleeping: 0,
  drowsy: 0.25,
  sitting: 1,
  watching: 1,
  grooming: 1,
  stretching: 1,
  'idle-walk': 1,
};

export const GROOM_IDLE_S = 240; // 4 分钟闲置 → 理毛
export const STRETCH_IDLE_S = 600; // 10 分钟闲置 → 伸展
export const NIGHT_WALK_IDLE_S = 120; // 深夜 2 分钟闲置 → 游走
export const DROWSY_EXTRA_S = 90; // 浅睡再闲置这么久 → 睡沉

/** 深夜活跃窗口（DESIGN：22:00-02:00） */
export function isNightWindow(hour: number): boolean {
  return hour >= 22 || hour < 2;
}

/** 正午沉睡偏好（DESIGN：正午沉睡） */
export function isNoonWindow(hour: number): boolean {
  return hour >= 11 && hour <= 14;
}

/** 睡眠阈值（秒）：正午 300 / 深夜 1800 / 默认 900 */
export function sleepTolerance(hour: number): number {
  if (isNoonWindow(hour)) return 300;
  if (isNightWindow(hour)) return 1800;
  return 900;
}

/** 限时状态集合（进入时事件层需要起计时器） */
export function isTimedState(s: PetState): boolean {
  return s === 'watching' || s === 'grooming' || s === 'stretching' || s === 'idle-walk';
}

/**
 * 行为状态机。初始 sleeping（DESIGN：睡觉是默认态）。
 * 「闲置纪元」：从上一次 USER_INPUT 起算的一段连续闲置；理毛/伸展/游走每个纪元只触发一次。
 */
export class PetFSM {
  state: PetState = 'sleeping';
  /** 最近一次事件携带的小时（决定昼夜阈值）；null 时用保守默认 12 */
  private hour: number | null = null;
  private groomedThisEpoch = false;
  private stretchedThisEpoch = false;
  private walkedThisEpoch = false;
  /** 最近一次迁移（供日志） */
  lastTransition: PetTransition | null = null;

  constructor(initial?: PetState) {
    if (initial) this.state = initial;
  }

  private h(): number {
    return this.hour ?? 12;
  }

  /** 处理一个事件；发生迁移时返回迁移记录，否则返回 null */
  handle(ev: PetEvent): PetTransition | null {
    if (ev.hour !== undefined) this.hour = ev.hour;
    const from = this.state;
    let to: PetState | null = null;
    let reason = '';

    switch (ev.type) {
      case 'USER_INPUT':
      case 'CLICK': {
        // 任何真实输入开启新的闲置纪元
        this.groomedThisEpoch = false;
        this.stretchedThisEpoch = false;
        this.walkedThisEpoch = false;
        if (ev.type === 'CLICK') {
          // 点击：睡→浅醒；清醒时她转向你
          if (this.state === 'sleeping') {
            to = 'drowsy';
            reason = '你戳了她一下，她眯着眼动了动';
          } else if (this.state !== 'watching') {
            to = 'watching';
            reason = '她转向你';
          }
        } else {
          if (this.state === 'sleeping') {
            to = 'drowsy';
            reason = '听到键鼠声，翻入浅睡';
          } else if (this.state === 'drowsy') {
            to = 'sitting';
            reason = '持续的活动把她完全叫醒';
          } else if (isTimedState(this.state)) {
            to = 'sitting';
            reason = '你一动，她放下手头的事';
          }
        }
        break;
      }

      case 'IDLE': {
        const s = ev.seconds ?? 0;
        const hour = this.h();
        if (this.state === 'drowsy') {
          if (s >= sleepTolerance(hour) + DROWSY_EXTRA_S) {
            to = 'sleeping';
            reason = `闲置 ${Math.round(s)}s（阈值 ${sleepTolerance(hour) + DROWSY_EXTRA_S}s），睡沉了`;
          }
        } else if (this.state === 'sitting') {
          if (s >= STRETCH_IDLE_S && !this.stretchedThisEpoch) {
            this.stretchedThisEpoch = true;
            to = 'stretching';
            reason = `闲置 ${Math.round(s)}s，起来伸个懒腰`;
          } else if (s >= GROOM_IDLE_S && !this.groomedThisEpoch) {
            this.groomedThisEpoch = true;
            to = 'grooming';
            reason = `闲置 ${Math.round(s)}s，开始理毛`;
          } else if (isNightWindow(hour) && s >= NIGHT_WALK_IDLE_S && !this.walkedThisEpoch) {
            this.walkedThisEpoch = true;
            to = 'idle-walk';
            reason = `深夜闲置 ${Math.round(s)}s，她在你身边踱了两步`;
          } else if (s >= sleepTolerance(hour)) {
            to = 'drowsy';
            reason = `闲置 ${Math.round(s)}s（阈值 ${sleepTolerance(hour)}s），开始打瞌睡`;
          }
        }
        break;
      }

      case 'TERMINAL_MESSAGE': {
        if (this.state === 'sleeping') {
          to = 'drowsy';
          reason = '新消息的动静把她惊到浅睡';
        } else if (this.state !== 'watching') {
          to = 'watching';
          reason = '收到新的跨端消息，看了一眼';
        }
        break;
      }

      case 'CLOCK': {
        // 时钟本身不直接迁移；它通过 hour 校准昼夜阈值，
        // 并在深夜窗口内提示「可以陪你熬夜」的游走偏好（配合下一次 IDLE 上报生效）。
        break;
      }

      case 'ACTION_DONE':
      case 'WANDER_DONE': {
        if (this.state === 'watching') {
          const s = ev.seconds ?? 0;
          if (s >= sleepTolerance(this.h())) {
            to = 'drowsy';
            reason = '看完消息，发现你还是没动静，打起瞌睡';
          } else {
            to = 'sitting';
            reason = '看完消息，回到坐姿';
          }
        } else if (isTimedState(this.state)) {
          to = 'sitting';
          reason =
            this.state === 'grooming'
              ? '理完毛，坐好了'
              : this.state === 'stretching'
                ? '伸完懒腰，坐好了'
                : '踱完步，停在你手边';
        }
        break;
      }
    }

    if (!to || to === from) {
      return null;
    }
    const t: PetTransition = { from, to, event: ev.type as PetEventType, reason };
    this.state = to;
    this.lastTransition = t;
    return t;
  }
}
