# N.E.K.O Companion Desktop · desktop-app

旧纸与墨——她住在一张被体温焐热的道林纸上。
本目录是桌面端 Web 骨架：**首启海报**（一次相遇的仪式）+ **纸质配置页**（她亲手填的登记表）。

技术栈：Vite + 原生 TypeScript（零 UI 框架——这是文档流，不是组件树）。
设计系统权威：仓库根 `DESIGN.md`（色板/字体/间距/圆角/组件规范/Do's & Don'ts），
tokens 逐项落在 `src/styles/tokens.css`。

## 快速开始

```bash
cd desktop-app
npm install
npm run dev        # http://localhost:48930/ → 自动落到首启海报
```

- 开发模式自带极小 Node 中间层（Vite 插件），`/api/*` 直接可用。
- 断网/后端未起时页面优雅降级：入口状态显示「未连接」，钥匙串提示「先写在纸上」。

## 构建 / 生产

```bash
npm run build      # 产物 dist/（多页入口：/ 、welcome、settings）
npm run serve      # 纯 Node 静态 + API，一个进程带走（需 Node ≥ 23）
```

`npm run preview`（Vite 预览）同样挂了 API 中间层。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEKO_HOME` | 平台默认（见下） | N.E.K.O 运行时 home，其下找 `core_config.json` |
| `NEKO_MAIN_URL` | `http://127.0.0.1:48911` | 主进程（探测 `/health` → 「桌面」入口状态） |
| `NEKO_AGENT_URL` | `http://127.0.0.1:48915` | agent/tool 服务（→ 「终端（opencode）」入口状态） |
| `NEKO_MEMORY_URL` | `http://127.0.0.1:48921` | a-memorix 记忆服务（回忆册检索） |
| `NEKO_QQ_HEALTH_URL` / `NEKO_WECHAT_HEALTH_URL` | 未接线 | QQ / 微信入口的探测地址，设置后才有在线态 |
| `PORT` / `NEKO_DESKTOP_PORT` | `48930` | standalone 服务端口 |

`NEKO_HOME` 平台默认（照抄 N.E.K.O `config/network.py`）：

- Linux：`$XDG_CONFIG_HOME/N.E.K.O`（一般 `~/.config/N.E.K.O`）
- macOS：`~/Library/Application Support/N.E.K.O`
- Windows：`%APPDATA%\N.E.K.O`

## 中间层 API（src/server/，零运行时依赖）

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/config` | 读 `core_config.json` 的 agent 模型三元组（`agentModelUrl` / `agentModelId` / `agentModelApiKey`） |
| `POST /api/config` | 合并写回（原子写 tmp+rename，**只动这三个字段**） |
| `POST /api/test-llm` | 「试一试」——真实打一次 OpenAI 兼容 `POST {base_url}/chat/completions`；表单留空的字段用存档补齐 |
| `GET /api/status` | 并发探测各入口 `/health`（1500ms 超时），前端 10s 轮询 |
| `POST /api/memory/search` | 代理 a-memorix `POST /a_memorix/v1/search`（`{query, chat_id}`） |
| `DELETE /api/memory/:id` | 恒 501——记忆服务暂无删除端点，此页只读 |

dev / preview 由 Vite 插件挂载（`src/server/plugin.ts`）；生产由 `src/server/standalone.ts`
以纯 Node 直跑（Node ≥ 23 原生剥类型，无需构建）。

## 页面结构

```
desktop-app/
├── index.html                     # 根跳转页 → welcome
├── src/
│   ├── styles/tokens.css          # DESIGN.md tokens → CSS custom properties（含夜间组）
│   ├── styles/base.css            # 字体栈 / 纸质元件（填空线/登记表/印章/入口行/按钮）
│   ├── lib/api.ts                 # API 客户端（全部优雅降级，不抛异常）
│   ├── lib/night.ts               # 灯下读书（夜间只换纸色不换朱砂）
│   ├── lib/pet-prefs.ts           # 桌宠偏好（localStorage neko.pet.prefs）
│   ├── pages/welcome/             # 首启海报 960×640：「以后，在这里见。」
│   │   └── index.html | main.ts | welcome.css
│   ├── pages/settings/            # 纸质配置页 880px 单列，五章节
│   │   └── index.html | main.ts | settings.css
│   └── server/                    # 极小 Node 中间层（env/router/plugin/standalone）
```

### 配置页五章节

1. **我的钥匙串，帮我收好**——base_url / model / key 三个点线填空 + 记下来 + 试一试
2. **我会在这些房间出现**——桌面/QQ/微信/终端 在线状态（10s 轮询，苔绿点/灰点）
3. **我的回忆册**——a-memorix 检索（只读：服务端暂无删除端点）
4. **桌面陪伴**——开关/大小 150–220px/位置偏好/免打扰时段，写 localStorage
5. **关于**——版本、仓库链接、她的署名印（内联 SVG 朱砂印「同在」）

### 桌宠挂载点（welcome / settings 共用）

两个页面通过同一套静态分发挂载桌宠：HTML 里四个经典 `<script>` 标签注入
`/vendor/` 渲染栈四件套（pixi7 / pixi-sound / live2d / cubism2）+
`/vendor/pet-mount-bundle.js`（`src/pet/pet-mount.ts` 经 `npm run build:pet`
打成 IIFE）。script 标签 vite 原样保留，与页面 ESM 模块并行不冲突
（loader 对全局 PIXI 幂等）。

- welcome：`#pet-mount`（`data-pet-height="170"`）内保留占位墨猫 SVG 作为
  无 JS 时的静态降级——bundle 启动即移除，由 Live2D 模型接管；引擎加载失败
  再降级为呼吸圆点（loader 内置），即三级降级链。
- settings：右下角 fixed 挂载点（`data-pet-height="120"`，窄屏隐藏）——
  陪着她配钥匙的小小一只。
- 模型地址/记忆服务的覆盖方式见 `src/pet/MOUNTING.md`；桌面偏好见 `src/lib/pet-prefs.ts`。

## 字体

CDN 加载（HTML `<head>`）+ 本地回退：

- 霞鹜文楷（她说话）：`lxgw-wenkai-webfont@1.7.0`（jsdelivr）
- 思源宋体（正文）/ 思源黑体（系统说话）：Google Fonts
- Sarasa Mono SC（技术值）：本地已装则直取，回退 IBM Plex Mono（Google Fonts）

断网时整页回退到系统 serif/sans，布局不受影响。

## 设计约束速查（详见 DESIGN.md Do's & Don'ts）

- 朱砂只出现在：焦点环、链接、署名印、hero 按钮（唯一实心按钮）
- 琥珀是角色的活物色，UI 永不使用
- 纸上是填空线不是盒子；唯一卡片级容器是 sheet，不嵌套
- 无侧边栏、无三栏、无紫色渐变、无暗色辉光
- 夜间模式只换纸色与墨色，朱砂不变
