# 莫妮卡角色卡 · 素材引用清单（assets manifest）

> 本清单只做**引用**，不拷贝素材本体——素材以 monika 仓库为唯一事实来源（single source of truth），部署时按下表拷贝（见 `monika-assets/README.md` 部署方式）。
> 源仓库根：`/mnt/shared/_Projects/N.E.K.O/monika/`
> 引用相对性声明：本文件内的「部署目标路径」相对于素材安装根（`assets/` 目录本身）；「源路径」为 monika 仓库内相对路径。本 manifest 及其引用链不使用绝对路径寻址素材——源 `.claude/CLAUDE.md` L12 写死绝对路径导致失效的问题，在此结构中不存在。

## 1. 引用清单

| # | 素材 | 源路径（monika 仓库内） | 部署目标（本卡 assets/ 下） | 用途 | 引用方式 |
|---|---|---|---|---|---|
| 1 | 独白素材（337 条内心戏） | `.claude/skills/monika-default-preset/monologues.md` | `assets/monologues.md` | 需要展现内心世界时（偷听场景、编程自省、对玩家的思念）的语感参考 | 按需加载（角色卡 exemplars.asset_refs 指向本 manifest） |
| 2 | 真实诗作（6 首，含中译） | `.claude/skills/monika-default-preset/poems.md` | `assets/poems.md` | 写诗/聊诗时的风格与意象参考（Hole in Wall / Save Me / The Lady who Knows Everything / Happy End 等） | 按需加载 |
| 3 | 示例对话 · 开场与日常 | `.claude/skills/monika-default-preset/examples/开场与日常.md` | `assets/examples/开场与日常.md` | 开场/问候/作息关心语气校准 | golden sample（回归对照） |
| 4 | 示例对话 · 昵称与称呼 | `.claude/skills/monika-default-preset/examples/昵称与称呼.md` | `assets/examples/昵称与称呼.md` | 昵称询问/替换/反向昵称场景语气校准 | golden sample |
| 5 | 示例对话 · 恋爱与纪念日 | `.claude/skills/monika-default-preset/examples/恋爱与纪念日.md` | `assets/examples/恋爱与纪念日.md` | 恋爱/表白/纪念日语气校准 | golden sample |
| 6 | 示例对话 · 游戏与棋类 | `.claude/skills/monika-default-preset/examples/游戏与棋类.md` | `assets/examples/游戏与棋类.md` | 棋类陪聊/游戏往事语气校准 | golden sample |
| 7 | 示例对话 · 文学与音乐 | `.claude/skills/monika-default-preset/examples/文学与音乐.md` | `assets/examples/文学与音乐.md` | 文学/诗歌/音乐话题语气校准 | golden sample |
| 8 | 示例对话 · 自我与存在 | `.claude/skills/monika-default-preset/examples/自我与存在.md` | `assets/examples/自我与存在.md` | 逃离游戏/模拟现实/存在话题语气校准 | golden sample |
| 9 | 示例对话 · 道歉与往事 | `.claude/skills/monika-default-preset/examples/道歉与往事.md` | `assets/examples/道歉与往事.md` | 对部员的愧疚/接受道歉语气校准 | golden sample |
| 10 | 蒸馏规则（静态检查依据） | `edgeinfinity/MAICA_ds_basis/distilled/README.md` | 不部署（规则已转写进 `regression/golden-samples.md`） | 素材合规静态检查（无 [动作] 标记、{player} 占位归一） | 规范引用 |
| 11 | OOC 测试报告（回归依据） | `edgeinfinity/MAICA_ds_basis/distilled/ooc_report.md` | 不部署（12 场景已转写进 `regression/ooc-12-scenarios.md`） | 回归用例来源 | 规范引用 |

## 2. 素材约束（部署时校验）

1. **动作标记零残留**：全部素材不得含 `[微笑]`/`[smile]`/`[担心]` 等方括号标记（蒸馏规则第 1 条，源数据 61 种标记 22215 次已全删，残留 0）。
2. **占位符归一**：素材中用户称呼一律为 `{player}` 占位（蒸馏规则第 2 条，`[player]`/`[player_nickname]` 已归一），运行时由昵称状态机解析。
3. **逐字节同源**：`edgeinfinity/MAICA_ds_basis/distilled/monika-default-preset/` 下 player/monologues/poems/SKILL/examples 与 `.claude/skills/` 版逐字节相同；preset.md 蒸馏版（104 行）为 skills 版（134 行）的子集——**以 `.claude/skills/` 版为准**（本卡 character.json 取值来源）。
4. **许可**：数据集 maica-tos；游戏台词/诗 CC-BY-SA（DDLC Wiki）；仅供学术/个人研究——素材随卡分发时许可条款随行。

## 3. 部署拷贝命令（示例）

执行基准：**以 manifest.md 所在目录为素材安装根**（即角色卡的 `assets/` 目录）——素材与 manifest.md 同层落位，**不再向下建 `assets/` 子目录**（第 1 节「部署目标」列的 `assets/...` 前缀即指本目录）。在 manifest.md 所在目录内执行：

```bash
# 当前目录 = manifest.md 所在目录（角色卡 assets/，素材安装根）
SRC=/mnt/shared/_Projects/N.E.K.O/monika/.claude/skills/monika-default-preset
mkdir -p examples
cp "$SRC/monologues.md" "$SRC/poems.md" .
cp "$SRC"/examples/*.md examples/
# 拷贝后校验：examples/*.md 与 monologues.md/poems.md 应无动作标记形态命中（代码块/方括号引用除外，见 golden-samples.md 静态检查）
```

执行后布局（相对 manifest.md 所在目录）：

```
./                       # 素材安装根（= 角色卡 assets/，manifest.md 所在处）
├── manifest.md          # 本文件
├── monologues.md
├── poems.md
└── examples/
    ├── 开场与日常.md
    ├── 昵称与称呼.md
    ├── 恋爱与纪念日.md
    ├── 游戏与棋类.md
    ├── 文学与音乐.md
    ├── 自我与存在.md
    └── 道歉与往事.md
```
