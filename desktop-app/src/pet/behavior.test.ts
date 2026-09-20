/**
 * 行为状态机迁移表单测（纯逻辑，无 DOM/pixi）。
 * 每条断言对应 behavior.ts 迁移表的一行。
 */
import { describe, expect, it } from 'vitest';
import { PetFSM, sleepTolerance, isNightWindow, isNoonWindow } from './behavior';

/** 快速把 FSM 推到指定状态的助手 */
function fsmAt(state: ConstructorParameters<typeof PetFSM>[0]): PetFSM {
  return new PetFSM(state);
}

describe('PetFSM 迁移表（事件 → 状态断言）', () => {
  it('默认状态是 sleeping（DESIGN：睡觉是默认态）', () => {
    const f = new PetFSM();
    expect(f.state).toBe('sleeping');
  });

  it('1. sleeping + USER_INPUT → drowsy（被键鼠声惊动，翻入浅睡）', () => {
    const f = new PetFSM('sleeping');
    const t = f.handle({ type: 'USER_INPUT' });
    expect(t?.to).toBe('drowsy');
    expect(f.state).toBe('drowsy');
  });

  it('2. drowsy + USER_INPUT → sitting（持续活动把她完全叫醒）', () => {
    const f = fsmAt('drowsy');
    expect(f.handle({ type: 'USER_INPUT' })?.to).toBe('sitting');
    expect(f.state).toBe('sitting');
  });

  it('3. sleeping + TERMINAL_MESSAGE → drowsy（新消息只惊到浅睡，不吵醒）', () => {
    const f = new PetFSM('sleeping');
    expect(f.handle({ type: 'TERMINAL_MESSAGE', hour: 15 })?.to).toBe('drowsy');
  });

  it('4. sitting + TERMINAL_MESSAGE → watching（注意到新跨端消息）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'TERMINAL_MESSAGE', hour: 15 })?.to).toBe('watching');
    expect(f.state).toBe('watching');
  });

  it('5. watching + ACTION_DONE（仍在活动）→ sitting（看完 8s 回坐姿）', () => {
    const f = fsmAt('watching');
    expect(f.handle({ type: 'ACTION_DONE', seconds: 30, hour: 15 })?.to).toBe('sitting');
  });

  it('6. watching + ACTION_DONE（闲置已过阈）→ drowsy（看完发现没人理，打瞌睡）', () => {
    const f = fsmAt('watching');
    // 正午阈值 300s：带 400s 闲置的 ACTION_DONE 应转入 drowsy
    expect(f.handle({ type: 'ACTION_DONE', seconds: 400, hour: 12 })?.to).toBe('drowsy');
  });

  it('7. sitting + IDLE 600s（未伸展过）→ stretching（长闲置，伸个懒腰）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'IDLE', seconds: 600, hour: 15 })?.to).toBe('stretching');
  });

  it('8. sitting + IDLE 240s（未理毛过、未到伸展）→ grooming（闲置较久，理毛）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'IDLE', seconds: 240, hour: 15 })?.to).toBe('grooming');
  });

  it('9. grooming + ACTION_DONE → sitting（理完毛坐好）；同一闲置纪元不再重复理毛', () => {
    const f = fsmAt('sitting');
    f.handle({ type: 'IDLE', seconds: 240, hour: 15 }); // → grooming
    expect(f.handle({ type: 'ACTION_DONE', seconds: 252, hour: 15 })?.to).toBe('sitting');
    // 纪元内再次上报 240s+ 闲置：不应再进 grooming（应落到睡阈 drowsy 或维持）
    const t2 = f.handle({ type: 'IDLE', seconds: 260, hour: 15 });
    expect(t2?.to).not.toBe('grooming');
  });

  it('10. stretching + USER_INPUT → sitting（你一动，她放下手头的事）', () => {
    const f = fsmAt('stretching');
    expect(f.handle({ type: 'USER_INPUT' })?.to).toBe('sitting');
  });

  it('11. 深夜 sitting + IDLE 120s → idle-walk（深夜陪伴：踱两步）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'IDLE', seconds: 120, hour: 23 })?.to).toBe('idle-walk');
  });

  it('12. 白天 sitting + IDLE 120s 不游走（游走是深夜偏好）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'IDLE', seconds: 120, hour: 15 })).toBeNull();
  });

  it('13. idle-walk + ACTION_DONE → sitting（踱完停在手边）', () => {
    const f = fsmAt('idle-walk');
    expect(f.handle({ type: 'ACTION_DONE', seconds: 130, hour: 23 })?.to).toBe('sitting');
  });

  it('14. sitting + CLICK → watching（她转向你）', () => {
    const f = fsmAt('sitting');
    expect(f.handle({ type: 'CLICK', hour: 15 })?.to).toBe('watching');
  });

  it('15. sleeping + CLICK → drowsy（被戳醒到浅睡）', () => {
    const f = new PetFSM('sleeping');
    expect(f.handle({ type: 'CLICK', hour: 15 })?.to).toBe('drowsy');
  });

  it('16. drowsy + IDLE ≥ 睡阈+90 → sleeping（没人理，睡沉）', () => {
    const f = fsmAt('drowsy');
    const tol = sleepTolerance(15); // 默认 900
    expect(f.handle({ type: 'IDLE', seconds: tol + 90, hour: 15 })?.to).toBe('sleeping');
    // 差一秒都不行
    const f2 = fsmAt('drowsy');
    expect(f2.handle({ type: 'IDLE', seconds: tol + 89, hour: 15 })).toBeNull();
  });

  it('17. USER_INPUT 重置闲置纪元：伸展后再闲置可再次伸展', () => {
    const f = fsmAt('sitting');
    f.handle({ type: 'IDLE', seconds: 600, hour: 15 }); // → stretching
    f.handle({ type: 'USER_INPUT' }); // → sitting，新纪元
    expect(f.handle({ type: 'IDLE', seconds: 600, hour: 15 })?.to).toBe('stretching');
  });

  it('18. CLOCK 事件本身不迁移，但校准昼夜阈值（正午易睡/深夜能熬）', () => {
    const noon = fsmAt('sitting');
    noon.handle({ type: 'CLOCK', hour: 12 });
    // 正午 320s 闲置：先理毛（240s 阈值）……
    expect(noon.handle({ type: 'IDLE', seconds: 320, hour: 12 })?.to).toBe('grooming');
    noon.handle({ type: 'ACTION_DONE', seconds: 332, hour: 12 }); // 理完毛回坐姿
    // ……理过毛之后再闲置过 300s（正午睡阈）就瞌睡
    expect(noon.handle({ type: 'IDLE', seconds: 340, hour: 12 })?.to).toBe('drowsy');

    const night = fsmAt('sitting');
    night.handle({ type: 'CLOCK', hour: 23 });
    // 深夜：先游走（120s）再理毛（240s），都做过之后 320s 依然精神的
    night.handle({ type: 'IDLE', seconds: 120, hour: 23 }); // → idle-walk
    night.handle({ type: 'ACTION_DONE', seconds: 130, hour: 23 }); // → sitting
    night.handle({ type: 'IDLE', seconds: 240, hour: 23 }); // → grooming
    night.handle({ type: 'ACTION_DONE', seconds: 252, hour: 23 }); // → sitting
    expect(night.handle({ type: 'IDLE', seconds: 320, hour: 23 })).toBeNull(); // 睡阈 1800s，远没到
  });

  it('19. 完整日常弧线：睡 → 浅睡 → 坐姿 → 注意 → 回坐姿', () => {
    const f = new PetFSM();
    f.handle({ type: 'USER_INPUT', hour: 10 }); // drowsy
    f.handle({ type: 'USER_INPUT', hour: 10 }); // sitting
    f.handle({ type: 'TERMINAL_MESSAGE', hour: 10 }); // watching
    f.handle({ type: 'ACTION_DONE', seconds: 20, hour: 10 }); // sitting
    expect(f.state).toBe('sitting');
  });

  it('20. 事件缺省 hour 时用上一次校准的小时', () => {
    const f = fsmAt('sitting');
    f.handle({ type: 'CLOCK', hour: 23 });
    // 深夜 120s 游走（事件未带 hour，沿用 23）
    expect(f.handle({ type: 'IDLE', seconds: 121 })?.to).toBe('idle-walk');
  });
});

describe('昼夜阈值', () => {
  it('深夜窗口 22:00-02:00；正午窗口 11:00-14:59', () => {
    expect(isNightWindow(22)).toBe(true);
    expect(isNightWindow(1)).toBe(true);
    expect(isNightWindow(2)).toBe(false);
    expect(isNoonWindow(11)).toBe(true);
    expect(isNoonWindow(14)).toBe(true);
    expect(isNoonWindow(15)).toBe(false);
  });

  it('睡阈：正午 300s < 默认 900s < 深夜 1800s（深夜活跃正午沉睡）', () => {
    expect(sleepTolerance(12)).toBeLessThan(sleepTolerance(16));
    expect(sleepTolerance(16)).toBeLessThan(sleepTolerance(23));
  });
});
