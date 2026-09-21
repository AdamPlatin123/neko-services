/**
 * 慢眨眼协议触发条件单测（纯逻辑，注入时钟）。
 * DESIGN.md：「鼠标悬停 2 秒不点击，她抬眼对视，然后极慢地眨一次眼（0.9s）。
 * 这是整个产品最重要的一帧。」
 */
import { describe, expect, it } from 'vitest';
import {
  SlowBlinkLogic,
  HOVER_TRIGGER_MS,
  BLINK_MS,
  GAZE_EASE_MS,
  GAZE_HOLD_MS,
} from './slow-blink';

describe('慢眨眼协议', () => {
  it('悬停不满 2s 不触发（1.999s 仍在 idle）', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    expect(sb.tick(HOVER_TRIGGER_MS - 1).phase).toBe('idle');
  });

  it('悬停满 2s 触发：进入 gazing（抬眼对视）', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    const snap = sb.tick(HOVER_TRIGGER_MS);
    expect(snap.phase).toBe('gazing');
    expect(snap.changed).toBe(true);
  });

  it('gazing 阶段 gazeProgress 随时间缓动上升（0.8s 到位）', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    sb.tick(HOVER_TRIGGER_MS);
    const mid = sb.tick(HOVER_TRIGGER_MS + GAZE_EASE_MS / 2);
    expect(mid.phase).toBe('gazing');
    expect(mid.gazeProgress).toBeGreaterThan(0);
    expect(mid.gazeProgress).toBeLessThan(1);
    const done = sb.tick(HOVER_TRIGGER_MS + GAZE_EASE_MS + 10);
    expect(done.gazeProgress).toBeCloseTo(1, 5);
  });

  it('对视 0.8s+0.6s 后进入 blinking：0.9s 极慢眨眼，包络 1→0→1', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    sb.tick(HOVER_TRIGGER_MS);
    const blinkStart = HOVER_TRIGGER_MS + GAZE_EASE_MS + GAZE_HOLD_MS;
    const snap = sb.tick(blinkStart);
    expect(snap.phase).toBe('blinking');
    // 半正弦：起点 0（眼全开），中点 1（眼闭合），终点回 0
    expect(sb.tick(blinkStart + 1).blinkEnvelope).toBeCloseTo(0, 2);
    expect(sb.tick(blinkStart + BLINK_MS / 2).blinkEnvelope).toBeCloseTo(1, 2);
    const end = sb.tick(blinkStart + BLINK_MS);
    expect(end.phase).toBe('cooldown');
    expect(end.blinkEnvelope).toBe(0);
  });

  it('触发前点击/按下 → 取消（不点击不拖动是硬条件）', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    sb.press(1000); // 悬停第 1s 按下
    expect(sb.tick(HOVER_TRIGGER_MS + 10).phase).toBe('idle');
  });

  it('触发前指针离开 → 重置悬停计时', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    sb.leave(500);
    sb.tick(2000); // 离开后即使时间流逝也不该触发
    sb.enter(2000); // 重新进入，从 2000 重新计 2s
    expect(sb.tick(3999).phase).toBe('idle');
    expect(sb.tick(4000).phase).toBe('gazing');
  });

  it('gazing 中按下（点击/拖拽）→ 协议中止', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    sb.tick(HOVER_TRIGGER_MS); // gazing
    sb.press(HOVER_TRIGGER_MS + 100);
    expect(sb.tick(HOVER_TRIGGER_MS + 200).phase).toBe('idle');
  });

  it('blinking 中离开 → 协议中止（她收回目光）', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    const t = HOVER_TRIGGER_MS + GAZE_EASE_MS + GAZE_HOLD_MS;
    sb.tick(t); // blinking
    sb.leave(t + 50);
    expect(sb.tick(t + 100).phase).toBe('idle');
  });

  it('一次协议后 20s 冷却：冷却期内再悬停不触发，期满可再触发', () => {
    const sb = new SlowBlinkLogic();
    sb.enter(0);
    const protocolEnd = HOVER_TRIGGER_MS + GAZE_EASE_MS + GAZE_HOLD_MS + BLINK_MS;
    for (let now = 0; now <= protocolEnd; now += 50) {
      sb.tick(now);
    }
    sb.tick(protocolEnd); // 确保最后一相已结算
    expect(sb.currentPhase).toBe('cooldown');

    // 冷却期内悬停 2s：不触发
    sb.enter(protocolEnd + 1000);
    expect(sb.tick(protocolEnd + 1000 + HOVER_TRIGGER_MS + 10).phase).toBe('cooldown');

    // 推进到冷却期满（phase 归回 idle）
    let t = protocolEnd + 1000 + HOVER_TRIGGER_MS + 10;
    while (sb.currentPhase === 'cooldown') {
      t += 500;
      sb.tick(t);
    }
    expect(sb.currentPhase).toBe('idle');

    // 期满后重新悬停 2s：再次进入 gazing
    sb.enter(t);
    expect(sb.tick(t + HOVER_TRIGGER_MS - 1).phase).toBe('idle');
    expect(sb.tick(t + HOVER_TRIGGER_MS).phase).toBe('gazing');
  });

  it('完整时间线符合 DESIGN 规定（2s 悬停 / 0.9s 眨眼）', () => {
    expect(HOVER_TRIGGER_MS).toBe(2000);
    expect(BLINK_MS).toBe(900);
  });
});
