/**
 * 夜间模式（灯下读书）——只换纸色不换朱砂。
 * 记在 localStorage（neko.theme），首次访问跟随系统偏好。
 */

const KEY = "neko.theme";

export type Theme = "day" | "night";

export function initTheme(): Theme {
  let theme: Theme | null = null;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "day" || saved === "night") theme = saved;
  } catch {
    /* 隐身模式下 localStorage 可能不可用 */
  }
  if (!theme) {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
  }
  applyTheme(theme);
  return theme;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function toggleTheme(): Theme {
  const next: Theme = document.documentElement.dataset.theme === "night" ? "day" : "night";
  applyTheme(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 同上 */
  }
  return next;
}
