/**
 * 迷利主题探测（pet-engine 自包含版）——与 desktop-app 的 lib/night 同键（neko.theme）
 * 只读不写：引擎不需要切换 UI，只跟随后续页面/用户已存偏好。
 */
const KEY = "neko.theme";
export type Theme = "day" | "night";
export function initTheme(): Theme {
  let t: Theme | null = null;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "day" || saved === "night") t = saved;
  } catch { /* localStorage 不可用时跟随系统 */ }
  const theme: Theme = t ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day");
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = theme;
  return theme;
}
