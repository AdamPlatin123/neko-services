/**
 * 桌宠偏好——写在 localStorage（neko.pet.*），桌宠引擎（T2 分支）直接读。
 * 这里只负责「纸面登记」，不负责执行。
 */

export interface PetPrefs {
  /** 让她睡在桌面上（总开关） */
  enabled: boolean;
  /** 身高 px（DESIGN.md：默认 150–220px） */
  size: number;
  /** 位置偏好 */
  corner: "right-bottom" | "left-bottom" | "right-top" | "left-top";
  /** 免打扰时段（HH:MM；同值或空 = 不启用） */
  dndFrom: string;
  dndTo: string;
}

const KEY = "neko.pet.prefs";

export const DEFAULT_PET_PREFS: PetPrefs = {
  enabled: true,
  size: 180,
  corner: "right-bottom",
  dndFrom: "",
  dndTo: "",
};

export function loadPetPrefs(): PetPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PET_PREFS };
    const parsed = JSON.parse(raw) as Partial<PetPrefs>;
    return { ...DEFAULT_PET_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PET_PREFS };
  }
}

export function savePetPrefs(prefs: PetPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage 不可用时静默放弃——偏好是纸面备忘，不是账本 */
  }
}

/** 免打扰是否生效（跨午夜区间如 23:00–07:00 也支持） */
export function inDndWindow(prefs: PetPrefs, now = new Date()): boolean {
  if (!prefs.dndFrom || !prefs.dndTo || prefs.dndFrom === prefs.dndTo) return false;
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(prefs.dndFrom);
  const to = toMinutes(prefs.dndTo);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}
