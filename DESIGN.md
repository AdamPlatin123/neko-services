---
# gstack: design-md-format=spec
name: N.E.K.O Companion Desktop
description: 旧纸与墨——她住在一张被体温焐热的道林纸上，纸质登记表负责可信与克制，Q 版小角色负责「她活着」。
colors:
  primary: "#B5452C"       # 印泥朱砂——焦点环/链接/她的署名印
  on-primary: "#FBF7EC"    # 纸白
  surface: "#FBF7EC"       # 纸白·表面（新裁的一页纸叠上来）
  text: "#2A2520"          # 松烟墨
  text-muted: "#857867"    # 褪色墨（陈年字迹）
  accent: "#C98A2E"        # 猫眼琥珀——只存在于角色眼里，UI 永不使用
  success: "#5B7A4A"       # 苔绿（入口在线状态）
  warning: "#C98A2E"       # 琥珀（与 accent 同值不同语义域）
  error: "#B5452C"         # 朱砂（错误即印章落错了地方）
typography:
  display:
    fontFamily: "LXGW WenKai, Noto Serif SC, serif"   # 霞鹜文楷——她说话
    fontWeight: 500
    fontSize: "clamp(1.875rem, 3vw, 2.75rem)"
    letterSpacing: "0em"
  body:
    fontFamily: "Noto Serif SC, serif"                 # 思源宋体——正文（像在读一本书）
    fontSize: 1rem
    lineHeight: 1.9
  label:
    fontFamily: "Noto Sans SC, sans-serif"             # 思源黑体——系统说话
    fontSize: 0.75rem
    letterSpacing: 0.06em
  mono:
    fontFamily: "Sarasa Mono SC, IBM Plex Mono, monospace"  # 技术值（key/路径/端口）
    fontFeature: tnum
rounded:
  sm: 4px    # 输入/印章元素
  md: 6px    # 色板块/小容器
  lg: 8px    # 桌宠舞台外框
  full: 9999px  # 顶栏切换按钮
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  input-blank:                  # 纸质表格填空——不是输入框卡片
    borderBottom: "1px dotted color-mix(in srgb, {colors.text} 45%, transparent)"
    fontFamily: "{typography.mono.fontFamily}"
    rounded: "0"
  input-blank-focus:
    borderBottom: "1.5px solid {colors.primary}"
  sheet:                        # 纸质登记表
    backgroundColor: "{colors.surface}"
    border: "1px solid color-mix(in srgb, {colors.text} 10%, transparent)"
    rounded: "{rounded.sm}"
  seal:                         # 朱砂署名印
    border: "2px solid {colors.primary}"
    color: "{colors.primary}"
    transform: "rotate(-3deg)"
---

# N.E.K.O Companion Desktop

## Overview

**Creative North Star:** 旧纸与墨——配置页是她亲手填写的一张纸质登记表（配完即合上），桌宠是住在桌面上的 Q 版小角色（行为驱动的活物）。「她活着，而不是她被展示」驱动每一个决策。
**Product context:** 个人自用+开源的 AI 伴侣系统（中文），四入口（桌面/QQ/微信/opencode 终端）共享同一人格与记忆；用户是开发者；人格为温暖文学系女友型（monika 式）。
**Mode per surface:** 配置页 = Operate（安静仪器）；首启海报 = Persuade（一次相遇的仪式）；桌宠 = Experience（长期同居）。
**Reference sites:** [imuncle/live2d 模型库](https://imuncle.github.io/live2d/)、[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)。
**Key characteristics:**
- 第一眼是纸，不是软件界面
- 她执笔的第一人称文案（含报错）
- 桌宠大部分时间安静，注意力是稀缺资源
- 朱砂只出现在三处：焦点、链接、署名印

## Colors

**Strategy:** Restrained——朱砂是全系统唯一交互色，琥珀是只属于角色的「活物色」。
**Light or dark:** 双模式由使用场景决定：昼=道林纸 `#F3ECDD`，夜（灯下读书）= 墨色纸 `#241E17`，墨字反转为 `#D8CDBA`，**朱砂不变——纸变深了，印章还是那枚印章**。
朱砂信号交互（焦点环/链接/错误）；成功态用苔绿（克制、不与朱砂争）；角色配色（焦糖奶茶系）与 UI 同族不冲突。夜间表面 `#2E2820` 保持层级（表面略浮于底），不是简单反色。

## Typography

霞鹜文楷（她说话：章节标题/报错/手写浮现）↔ 思源黑体（系统说话：标签/状态/按钮）的切换本身就是「人格在场/机器在场」的交互。思源宋体承载正文（阅读感）。Sarasa Mono SC 是中文等宽唯一解，用于 API key/端口/路径——技术值自带「钥匙实体感」。
**规则：凡她执笔的文案一律文楷；凡系统状态一律思源黑。** 加载策略：文楷按使用范围分包（subset），配置页不背完整展示字重。
（字体可用性以本地/CDN 实测为准；本文件选定均为主流开源字体。）

## Layout

配置页：880px 单列流式纸质表格，无侧边栏无图标导航，章节以汉字数字「一、二、三」+ 细墨线分隔，配完即关。首启海报：960×640，左 60% 安静文字（「以后，在这里见。」）+ 右下角色，不对称构图。窄屏（<720px）单列堆叠。桌宠：自由浮层，默认 150-220px 高，右下偏好。

## Elevation & Depth

纸的深度靠「新纸叠旧纸」：表面色微浮（`#FBF7EC` on `#F3ECDD`）+ 1px 墨线描边，不用投影堆叠。桌宠舞台（演示/mockup 场景）用深色底 + 角色自投影（椭圆阴影 opacity .32）。夜间模式表面 `#2E2820`。禁零偏移辉光。

## Shapes

半径极小（4-8px）——纸制品的圆润而非 App 的圆润。输入「框」不存在：填空是点线下划线，不是圆角矩形。朱砂印是手工感的不规则元素（rotate -3deg）。桌宠轮廓由模型自带，不裁切。

## Components

**input-blank**：点线下划线填空；focus 态点线变朱砂实线；错误态下方文楷人格化报错（「这把钥匙打不开这扇门，再检查一下好吗？」）。
**sheet**：纸质登记表容器（唯一卡片级容器，不嵌套）。
**seal**：页脚右下朱砂小印（她的署名），hover 微微洇开（opacity 1 + scale 1.06）。
**entry-row**：入口列表行（桌面/QQ/微信/终端），点线分隔，在线态苔绿圆点。
**hero-btn**：唯一实心按钮（朱砂底纸白字），文案用文楷。
**桌宠**：Q 版 Live2D 模型 × pixi-live2d-display 运行时 × 行为状态机（见 Motion）。

## Do's and Don'ts

- Do：朱砂只用在焦点/链接/署名印三处；她的文案全部第一人称；夜间模式只换纸色不换朱砂
- Do：桌宠默认安静（呼吸/眨眼/物理摆动），动作由事件触发不循环播放
- Do：技术值（key/端口/路径）一律等宽字体
- Don't：紫色渐变、三栏网格、全居中、装饰 blob、嵌套卡片、kicker 标签、暗色辉光、侧边栏导航
- Don't：把琥珀色用于任何 UI 元素（它是角色的活物色）
- Don't：用卡片框做输入域——纸上是填空线，不是盒子

## Motion

- **Approach:** 桌宠 expressive（行为驱动）；UI minimal-functional（仅理解性过渡）
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) UI 用；桌宠动作走自然节奏（呼吸 4.6s 周期）
- **The one authored moment:** **慢眨眼协议**——鼠标悬停 2 秒不点击，她抬眼对视，然后极慢地眨一次眼（0.9s）。这是整个产品最重要的一帧。
- **行为状态机**（桌宠核心，Live2D motion/expression 由它调度而非循环播放）：睡觉（默认，呼吸极慢）→ 浅睡 → 坐姿 → 看你工作（注意力朝向活跃窗口）→ 理毛/伸展（长闲置后）；迁移由真实事件驱动：终端输出流、git 事件、输入闲置、系统时钟（深夜活跃正午沉睡）。记忆检索触发时文楷手写字逐笔浮现（如墨迹干涸淡去），无气泡框。
- **验收标准**：静音观察一分钟，能分辨她在陪伴/注意/思考/睡觉。

## 桌宠模型选型

**默认推荐模型：xiaomai（小麦）**——2 头身焦糖奶茶色团子型 Q 版（《干物妹小埋》umaru 衍生），气质判定「温暖贪吃的文学系女友」，宅家道具（薯片/可乐/小凳）+ 海量表情差分（脸红/冒汗/泪滴）。
- 资源路径：imuncle/live2d 仓库 `model/xiaomai/xiaomai.model.json`（Cubism 2 格式）
- **运行时**：pixi-live2d-display（Cubism 2+4 双支持，视线跟随/点击交互内置）；需口型同步时切 lipsyncpatch 分支（Open-LLM-VTuber 同款）
- **授权红线**：umaru 为动漫衍生角色——**个人自用可以，模型文件不进本仓库**（用户侧自选下载）；开源分发场景换 unitychan（官方角色授权最干净）或 tsumiki
- 备选链：tsumiki（文艺感最强）→ unitychan（授权最干净+动作最全）→ Pio（30+ 换装玩法）

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-20 | 初始设计系统创建 | /design-consultation 三声部（Codex「桌边的她」+ Claude「旧纸与墨猫」+ 编排综合），用户裁决：Q 版小角色形态、xiaomai 模型、纸质配置页、暖纸色板 |
| 2026-09-20 | 桌宠形态：Q 版 Live2D 小角色 × 行为状态机 | 用户修正（弃重型立绘展示，不弃 Live2D 技术）；灵动来自行为层调度，不来自循环动画 |
| 2026-09-20 | 模型：现成资源不手搓（xiaomai） | 用户明确要求；设计系统与具体模型解耦（可插拔） |
