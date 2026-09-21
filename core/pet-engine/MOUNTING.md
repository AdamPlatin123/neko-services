# 桌宠引擎挂载说明（src/pet/）

> fe-pet 分支只包含桌宠引擎；配置页由 fe-skeleton 分支并行开发，最终合并时拼接。
> 本文档回答两件事：**怎么把引擎挂到任意页面**（含未来的配置页壳），以及**二期 Electron
> 透明窗口需要的接口约定**（拖拽与点击穿透）。

## 1. 快速开始

```bash
# ① 模型下载（不入库；见 scripts/fetch-model.sh 头部授权说明）
cd desktop-app
bash scripts/fetch-model.sh                 # 默认 xiaomai；可传 tsumiki/unitychan 等

# ② 安装与运行
npm install
npm run dev
# 打开 http://localhost:5190/pet-demo.html
```

无模型时打开演示页不会崩：加载失败自动降级为 CSS 呼吸圆点占位（琥珀色，4.6s 呼吸周期），
行为状态机照常运行，事件注入按钮照常可用。

## 2. 文件地图

| 文件 | 职责 |
|---|---|
| `types.ts` | 共享类型（PetState/PetEvent/PetConfig）与配置解析（URL 参数 > localStorage > 默认） |
| `behavior.ts` | 行为状态机（纯逻辑）：迁移表、昼夜阈值、各状态呼吸周期/眼开合基线 |
| `events.ts` | 事件源：输入闲置（含 visibility）、时钟、memory_server `/recent_history` 轮询（15s 比对 next_seq）、手动注入 |
| `loader.ts` | pixi 应用（透明背景）+ live2d.min.js（CDN）+ `Live2DModel.from()` + 占位降级 + 拖拽/点击/悬停命中 |
| `slow-blink.ts` | 慢眨眼协议（纯逻辑时序）：悬停 2s → 对视 0.8s+0.6s → 0.9s 极慢眨眼 → 20s 冷却 |
| `speech.ts` | 手写字浮现（DOM overlay）：文楷逐字淡入、如墨迹干涸消散、无气泡框、台词库 |
| `pet-app.ts` | 总装：事件→FSM→模型动作映射（motion 组优先，无 motion 走参数级动效）；`window.__nekoPet` 原生壳 API |
| `pet-demo.ts` + `/pet-demo.html` | 独立演示页（暗底全屏、状态面板、事件注入、转换日志） |
| `pet-mount.ts` → `/vendor/pet-mount-bundle.js` | 页面挂载入口（welcome/settings 共用）：`#pet-mount` + `data-pet-height` → `PetApp.mount()` |
| `behavior.test.ts` / `slow-blink.test.ts` | vitest 纯逻辑单测（33 条） |

## 3. 挂载到任意页面（3 步）

```html
<!-- ① 一个非 static 定位的容器（fixed/absolute/relative 均可） -->
<div id="pet-stage" style="position:fixed; right:48px; bottom:36px; width:320px; height:380px;"></div>
```

```ts
// ② 初始化（TypeScript）
import { PetApp } from './pet/pet-app';

const pet = new PetApp({
  container: document.getElementById('pet-stage')!,
  log: (line) => console.info(line),   // 可选：接 UI 日志
  speechColor: '#2A2520',              // 亮底纸面用墨色；暗底默认 #D8CDBA
});
await pet.mount();
```

- 模型地址：默认 `/models/xiaomai/xiaomai.model.json`（vite publicDir 指向
  `desktop-app-assets/`）。覆盖方式（优先级从高到低）：
  1. URL 参数：`?model=/models/tsumiki/tsumiki.model.json`
  2. `localStorage['neko.pet.modelUrl']`（配置页的「模型选择」写这里）
- 记忆服务：默认 `/neko-memory`（开发期 vite 代理 → `http://127.0.0.1:48912`）。
  覆盖：`?memoryServer=http://127.0.0.1:48912` 或 `localStorage['neko.pet.memoryServer']`。
  轮询 `POST {base}/recent_history`，响应含 `next_seq`（number）；前进即发
  `TERMINAL_MESSAGE`（→ watching 8s）。服务不在/失败静默。
- ③ 卸载：`pet.destroy()`（移除 canvas、定时器、监听器）。

### 3.1 页面静态分发（welcome / settings 现行方式）

配置页与首启海报走共享通道，不引 ESM：页面加 5 个经典 script 标签
（`/vendor/` 四件套 + `pet-mount-bundle.js`），入口 `src/pet/pet-mount.ts`
（DOM ready → `#pet-mount` → `PetApp.mount()`；模型高度读挂载点
`data-pet-height`，手写字墨色随昼夜主题）。构建：`npm run build:pet`
（esbuild 双入口：pet-demo 与 pet-mount 同参数打成 IIFE，`build` 依赖它）。
无 JS 降级：welcome 挂载点内的静态墨猫 SVG 在 bundle 启动时才移除。

## 4. 状态 → 动作映射（摘）

| 状态 | motion 组（xiaomai 有则播） | 参数级动效（无 motion 时） |
|---|---|---|
| sleeping（默认） | 停掉 idle 自动组 | 呼吸 8s、双眼闭合 |
| drowsy | 同上 | 呼吸 6s、眼 0.25 |
| sitting | `idle`（库自动循环） | 呼吸 4.6s |
| watching | `new_msg` | 头 ParamAngleX/Y 朝活跃方向缓动、呼吸 4s、8s 限时 |
| grooming | `random` | ParamBodyAngleX 摆动、12s |
| stretching | `shake` | ParamBodyAngleY 摆动、5s |
| idle-walk | — | 模型水平游走 ±24px、10s（深夜偏好） |
| 点击头/身 | `tap_head` / `tap_body` | 手写字一句 |

慢眨眼协议叠加在任意状态之上，不占用 FSM 状态。

## 5. 二期 Electron 原生壳接口约定（拖拽 + 点击穿透）

浏览器内的拖拽已由 `loader.ts` 实现（pointerdown + 移动 >4px 判定拖拽，模型跟手）。
桌面浮窗（透明、无边框、always-on-top）需要原生壳配合，约定如下：

### 5.1 页面侧已就绪的 API（`window.__nekoPet`）

```ts
interface NekoPetGlobalAPI {
  getState(): PetState;                                   // 当前行为状态
  setInteractive(mode: 'all' | 'none'): void;             // 'none' 时页面关闭命中（配合全窗穿透）
  onStateChange(cb: (t: PetTransition) => void): void;    // 状态迁移订阅（原生壳可做托盘角标等）
  offStateChange(cb): void;
  say(text: string): void;                                // 触发手写浮现
  getBounds(): { x, y, width, height };                   // 模型在页面坐标系的包围盒
  destroy(): void;
}
```

### 5.2 主进程需要实现的协议（setIgnoreMouseEvents 的动态穿透）

Electron 的 `setIgnoreMouseEvents(true)` 是整窗穿透，`{ forward: true }` 只转发
mouse-move（不含点击）。推荐三段式：

1. **默认（模型外全穿透）**：`win.setIgnoreMouseEvents(true, { forward: true })`。
   渲染进程监听 `mousemove`（forward 模式下仍能收到），用 `__nekoPet.getBounds()`
   判断指针是否在模型上：
   - 进入模型 → `win.setIgnoreMouseEvents(false)`（交还交互：慢眨眼/点击/拖拽）
   - 离开模型 → 恢复 `setIgnoreMouseEvents(true, { forward: true })`
2. **拖拽**：页面内拖拽已实现（模型跟手）；若需要**移动窗口本身**，在
   `onDragChange(true)` 时调用 `win.setPosition(winX + dx, winY + dy)`
   （把页面拖拽增量换算到窗口坐标），或改用 `-webkit-app-region: drag` 方案
   （注意它和 `forward: true` 的冲突，二选一）。
3. **点击穿透与点击她**：`setIgnoreMouseEvents(false)` 期间页面的
   pointerdown/up 自带命中（头/身 hit_areas），无需原生参与。

> 最小实现清单：主进程 ~40 行（动态 setIgnoreMouseEvents + IPC），
> 渲染进程已全部就绪。透明窗口参数：`transparent: true, frame: false,
> hasShadow: false, alwaysOnTop: true, resizable: false`。

### 5.3 生命周期

- 窗口隐藏/最小化时建议 `__nekoPet.setInteractive('none')`（省命中计算）；
  引擎内置的闲置计时不受 visibility 影响——你离开，她就慢慢睡着（DESIGN 语义）。

## 6. 验收（DESIGN Motion 节）

> 静音观察一分钟，能分辨她在陪伴/注意/思考/睡觉。

演示页右侧日志即观测口。无头环境下以状态转换日志代替截图（见 pet-demo 的
`[fsm]`/`[slow-blink]` 行）。单测：`npm test`（33 条：迁移表 23 + 慢眨眼 10）。
