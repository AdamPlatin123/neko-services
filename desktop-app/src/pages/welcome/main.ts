/**
 * 首启海报——只做三件事：铺纸（主题）、留位（#pet-mount 挂载点）、指路（去登记表）。
 * 跳转用普通链接（<a href="../settings/">），无 JS 也能走。
 */
import { initTheme } from "../../lib/night.ts";
import "./welcome.css";

initTheme();

// T2 分支将在此 import 桌宠引擎，并挂载到 #pet-mount：
//   const mount = document.getElementById("pet-mount");
// 骨架阶段不做任何事，保持首屏零动画以外的安静。
export {};
