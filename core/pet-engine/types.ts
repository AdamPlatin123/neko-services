/**
 * 桌宠引擎共享类型。
 *
 * 权威设计：/DESIGN.md Motion 节
 * （睡觉→浅睡→坐姿→看你工作→理毛/伸展；事件驱动迁移；慢眨眼协议）。
 *
 * 本文件不依赖 DOM / pixi —— behavior.ts 与其单测在纯 Node 环境运行。
 */

/** 行为状态机的全部状态（DESIGN.md：静音观察一分钟能分辨她在陪伴/注意/思考/睡觉） */
export type PetState =
  | 'sleeping' // 睡觉（默认，呼吸极慢 8s 周期，双眼闭合）
  | 'drowsy' // 浅睡（呼吸 6s，眼睛半开 0.25）
  | 'sitting' // 坐姿（清醒基线，呼吸 4.6s——DESIGN.md 定义的呼吸周期）
  | 'watching' // 看你工作（注意力朝向活跃窗口/指针，8s 限时）
  | 'grooming' // 理毛（长闲置后，12s 限时）
  | 'stretching' // 伸展（更长闲置后，5s 限时）
  | 'idle-walk'; // 深夜陪伴时的小范围游走（10s 限时）

/** 事件类型（事件源见 events.ts；语义见 behavior.ts 迁移表） */
export type PetEventType =
  | 'USER_INPUT' // 任意鼠标/键盘活动
  | 'IDLE' // 周期性闲置上报（seconds = 距上次输入秒数）
  | 'TERMINAL_MESSAGE' // memory_server /recent_history 出现新跨端消息（next_seq 前进）
  | 'CLOCK' // 时钟上报（hour 0-23，昼夜阈值由此决定）
  | 'CLICK' // 桌宠被点击
  | 'ACTION_DONE' // 限时状态（watching/grooming/stretching/idle-walk）计时结束
  | 'WANDER_DONE'; // 兼容别名：idle-walk 计时结束（与 ACTION_DONE 等价）

export interface PetEvent {
  type: PetEventType;
  /** IDLE 事件：距上次真实输入的秒数 */
  seconds?: number;
  /** 携带当前小时（0-23）。IDLE/CLOCK/ACTION_DONE 均会带上；缺省用上一已知小时 */
  hour?: number;
}

/** 一次状态迁移的记录（供日志/演示页/单测断言） */
export interface PetTransition {
  from: PetState;
  to: PetState;
  event: PetEventType;
  reason: string;
}

/** 桌宠运行配置（loader / pet-app 消费） */
export interface PetConfig {
  /** Live2D 模型 settings json 的 URL（本地路径优先；见 scripts/fetch-model.sh） */
  modelUrl: string;
  /** memory_server 基地址；轮询 POST `${memoryServer}/recent_history` 比对 next_seq */
  memoryServer: string;
  /** 模型显示高度（px）。DESIGN.md：桌宠默认 150-220px 高 */
  height: number;
  /** 初始位置（舞台内像素；默认右下角偏好） */
  x: number;
  y: number;
}

/** 默认配置：模型走 vite publicDir（desktop-app-assets），memory 走 dev 代理 */
export const DEFAULT_PET_CONFIG: PetConfig = {
  modelUrl: '/models/xiaomai/xiaomai.model.json',
  memoryServer: '/neko-memory', // vite dev 代理 → http://127.0.0.1:48912；Electron 壳内改绝对地址
  height: 220,
  x: 0,
  y: 0,
};

/** 从 URL 参数与 localStorage 解析配置（modelUrl 优先级：URL > localStorage > 默认） */
export function resolvePetConfig(overrides?: Partial<PetConfig>): PetConfig {
  const cfg = { ...DEFAULT_PET_CONFIG, ...overrides };
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    const modelParam = url.searchParams.get('model');
    const memParam = url.searchParams.get('memoryServer');
    if (modelParam) cfg.modelUrl = modelParam;
    if (memParam) cfg.memoryServer = memParam;
    try {
      const stored = window.localStorage.getItem('neko.pet.modelUrl');
      if (!modelParam && stored) cfg.modelUrl = stored;
      const storedMem = window.localStorage.getItem('neko.pet.memoryServer');
      if (!memParam && storedMem) cfg.memoryServer = storedMem;
    } catch {
      /* localStorage 不可用（隐私模式等）时静默降级 */
    }
  }
  return cfg;
}

/** cubism2 UMD 暴露的模型构造器（window.PIXI.live2d.Live2DModel）的最小形状。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare type Cubism2ModelCtor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (url: string, opts?: Record<string, unknown>) => Promise<any>;
};
