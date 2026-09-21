/**
 * 挂载入口（welcome / settings 共用）——把桌宠引擎接到页面的 #pet-mount 挂载点。
 *
 * 分发方式与 pet-demo.html 完全一致（静态五 script，绕开 vite ESM——渲染栈排障
 * 结论见 loader.ts 头注）：页面以经典 <script> 标签注入 /vendor/ 四件套
 * （pixi7 / pixi-sound / live2d / cubism2 fork）+ 本文件打出的
 * /vendor/pet-mount-bundle.js（esbuild IIFE，package.json `build:pet`）。
 * script 标签在 vite 下原样保留，与页面的 ESM 模块并行不冲突——loader 对全局
 * PIXI 做幂等检查，页面模块不引 pixi，双方各走各的。
 *
 * 页面约定：
 * - 挂载点：`<div id="pet-mount" data-pet-height="150">`（非 static 定位，
 *   尺寸给足模型 + 头顶手写字；缺 data-pet-height 时用引擎默认 220）。
 * - welcome 页挂载点内的静态墨猫 SVG 是「无 JS」时的降级——本入口启动时
 *   整体移除（JS 已可用，引擎接管）；引擎自身加载失败再降级为呼吸圆点
 *   （loader 内置），即三级降级链：静态猫 → Live2D 模型 → 呼吸圆点。
 * - 手写字墨色随昼夜主题（昼=墨 #2A2520 / 夜=#D8CDBA）。主题本属页面 ESM
 *   模块（deferred，晚于本 bundle），故此处先自行 initTheme()——幂等，
 *   页面模块随后再调一次结果相同。
 */

import { PetApp } from './pet-app';
import { initTheme } from './lib-night';

function mountPet(): void {
  const container = document.getElementById('pet-mount');
  if (!container) return; // 页面没留挂载点：静默跳过（bundle 可全局引入）

  // 移除无 JS 降级的静态占位（welcome 的墨猫 SVG）——引擎接管角色区
  container.replaceChildren();

  const heightAttr = Number.parseInt(container.dataset.petHeight ?? '', 10);
  const config = Number.isFinite(heightAttr) ? { height: heightAttr } : undefined;
  const night = initTheme() === 'night';

  const app = new PetApp({
    container,
    config,
    speechColor: night ? '#D8CDBA' : '#2A2520', // 夜=反转墨字；昼=墨字（MOUNTING.md）
  });
  void app.mount(); // 成功后 window.__nekoPet 可用（PetApp.mount 内暴露）
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountPet, { once: true });
} else {
  mountPet();
}
