# P2-3 体验级验收清单（MVP 收口）

> 全部开发已完成（patch 001-012 + neko-services 组件）。本清单为实机部署+人工验收操作指南。

## A. 部署（一次性，约 30-60 分钟）

1. **a-memorix 服务**：`cd a-memorix-service && uv venv --python 3.12 && uv sync`；配置 `config/a_memorix.toml` 的 `[model.*]`（LLM 与 embedding 的 base_url/api_key/model，候选见 docs/model-tiers.md）；`uv run python -m a_memorix_service.service` 冒烟（/health 200+指纹）。
2. **systemd 三 unit**：按 `systemd/INSTALL.md`（生成 NEKO_INSTANCE_ID 写入三 unit → 拷贝 → daemon-reload → enable neko.target）。
3. **N.E.K.O 打补丁**：`bash scripts/replay-patches.sh`（基线 a3c82b5a，12 补丁整组）→ 回归 `pytest -m 'plugin_unit or plugin_integration'`（预期仅 2 个已知既有失败）。
4. **模型档**：按 docs/model-tiers.md 配 core_config.json（conversation 主力+summary/correction/emotion 便宜档）；`bash scripts/verify-tiers.sh` 确认。
5. **角色卡**：monika-assets/characters/monika/ 按其 README 部署进 N.E.K.O；`python3 scripts/ooc12_regression.py --neko-src <N.E.K.O 目录>` 挂载层 23/23。
6. **opencode**：已装好（1.18.31 + monika agent）；若未刷新到最新 dist 则重跑 `bash opencode-integration/dist/install.sh`。
7. 总冒烟：`bash scripts/smoke.sh`（桌面腿自动）+ `bash scripts/doctor.sh`（核心项 3/3）。

## B. 八项验收（人工，参照 workplan P2-3）

1. **四入口同一角色**：桌面/QQ/微信/opencode 各一轮对话（QQ 需 NapCat 登录+插件配置；微信需 iLink 扫码）——称呼/口吻/人格一致
2. **跨端语境延续（双盲）**：QQ 说到一半切桌面——下一句能接上；反向桌面→微信；记录感知延迟
3. **monika 生效**：OOC 12 场景行为层（`monika-assets/regression/ooc12-pack.json` 按优先级 S05>S04/S09>S10>抽检）+ /monika 回灌断言（TUI 路径）
4. **人味 A/B**：QQ 群实测开/关对比（分段/错字/纠错引用/延迟四行为）；紧急场景负面则保持 off
5. **模型分层**：verify-tiers 全自定义生效 + 微信 conversation 档（50 字偏差已知）
6. **成本**：一周后 `token_tracker` 周聚合（docs/model-tiers.md 取数片段）+ 月估算 vs 预算
7. **纠错/遗忘**：告诉角色改一个错的事实→后续不引用旧值；遗忘→重启不复活
8. **维护者工作流**：doctor/smoke/replay 三件在真实故障时可用（可拔网线模拟 a-memorix 断连看降级）

## C. 已知偏差备忘（验收时对照，不扣分）

实时强一致的「当下=下一回合」（UC3 最强档已实现因果契约+锁重构+桌面注入；realtime 音频会话除外）；微信 50 字；空库首条 off-by-one；F2 对齐窗口竞态（TODOS 有录）。

## A 部署执行记录（2026-09-20，部署 subagent 执行）

> 执行环境：neko-services main `5e85ba6`；N.E.K.O 源基线 `a3c82b5a`（干净树起步）。
> API key 相关步骤按任务约定全部跳过，见文末「待用户」清单。

### 1. a-memorix venv 与测试 —— 通过

- `uv venv --python 3.12`（CPython 3.12.3）+ `uv sync` 成功（.venv 已生成，`ConditionPathExists` 即满足）。
- `uv run pytest -q`：**40 passed**, 4 warnings in 19.58s（warnings 均为 jieba 三方库 SyntaxWarning，无害）。全绿。
- `/health` 冒烟**跳过**：`config/a_memorix.toml` 的 `[model.*]` API key 未配置（本段不配 key），未启动服务——待用户配 key 后按 systemd/INSTALL.md「a-memorix 服务」节启动并验证（期望 `{"app":"neko-services","service":"a-memorix","status":"ok",...}`）。

### 2. N.E.K.O replay 补丁与回归 —— 通过（含一处脚本修复）

- 首跑 `replay-patches.sh` 失败：006 是墓碑空补丁（manifest README 明言「空 commit 保持序号连续使整组重放可执行」），但脚本 `git am` 未带 `--allow-empty`，文档承诺的整组重放实际不可执行。
- 排障 1：给 `git am` 加 `--allow-empty` → git 2.43 批量 am 遇空补丁直接 `fatal: Resolve operation not in progress`（该版本已知缺陷；`--empty=keep` 需 git 2.45+，本机 2.43.0）。
- 排障 2（最终方案，已修入脚本）：应用段重写为**分段处理**——非空补丁按连续段一次 `git am`（保持整组原子语义）；空补丁用 `git mailinfo` 解析补丁头（Subject/Author/Date）后 `git commit --allow-empty` 落墓碑空 commit；任一步失败回滚到重放前 HEAD，无部分残留。临时克隆验证通过后在真实仓库执行。
- 结果：12 补丁文件 → **13 个 commit**（005 内含 2 个 commit：主补丁 + 人味代审修复；006 为空墓碑 commit，subject 正确），N.E.K.O 工作树干净。
- `cd N.E.K.O && uv sync` 复用既有 venv 成功（n-e-k-o 0.9.0 重建）。
- 回归 `uv run pytest -m 'plugin_unit or plugin_integration' -q`：**1556 passed, 2 failed, 2 skipped**（275s）。2 个失败恰为预期已知既有失败，无新增：
  - `plugin/tests/unit/plugins/test_web_search_resilience.py::test_total_timeout_includes_coordinator_wait`
  - `plugin/tests/integration/test_temporary_image_upload_transport.py::test_media_backpressure_does_not_block_control_uplink`

### 3. systemd 三 unit —— 通过（只装不启）

- `NEKO_INSTANCE_ID=22969934912e489c9ab5aeea623ae389`（uuidgen 去横线；sed 进 memory/main/agent 三 unit 副本且三处一致；a-memorix unit 的该行为注释行，按设计不动）。
- 5 个文件（三 service + a-memorix + neko.target）拷贝到 `~/.config/systemd/user/`；sed 在副本上执行，仓库源文件保持干净占位（迁移他机时按 INSTALL.md 路径说明重做）。
- `systemctl --user daemon-reload` 完成；五 unit 均为 **disabled**（按要求未 enable/start——N.E.K.O 首次运行需用户完成初始化配置）。
- `systemd-analyze verify` 五 unit 全部通过（唯一 warning 来自系统里无关的 `/etc/systemd/system/genexis.service`，非本项目）。

### 4. monika 角色卡部署 —— 完成（预置位 + 首启导入步骤）

角色存储调研结论：N.E.K.O 角色存于**运行时生成**的单一 `~/Documents/N.E.K.O/config/characters.json`（当前仅有 `logs/`，config 尚未生成），无预置角色目录；且 `/import-card` 端点按安全设计剥离 `_reserved`（persona_override 不随卡导入），persona 需首启后注入。已按预案落预置位：

- **素材本体**：按 manifest 第 3 节命令从 monika 仓库拷入 `monika-assets/characters/monika/assets/`（monologues.md、poems.md、examples/ 7 主题件，共 9 文件）。静态校验通过：动作标记残留 0、`[player]` 旧占位残留 0、`{player}` 占位 69 处。
- **部署产物** `deploy/monika-neko/` 三件：
  - `monika-character-card.zip`：符合 `/import-card` 格式（character.json 顶层「档案名」等自由字段 + metadata.json），首启后在角色管理界面直接导入；
  - `monika-persona-override.json`：persona_override 全量 payload（`mount_mode=replace` 完整人设 + `env_context=true` 桌面环境注入 + 原卡 profile）+ ai_context + character_origin；
  - `apply-persona-override.py`：注入脚本——把上述 `_reserved` 三件套写进 characters.json 的「莫妮卡」角色，`append_guidance` 由脚本现场读取 monika-assets/modules/ 五件运行模块文本填充（单一事实来源），改前自动备份。
- **ooc12 挂载层回归 23/23 全过**（挂载分轨 M1-M5、QQ 端接线 M6、12 场景规则装载 S01-S12）。注意：须用 N.E.K.O venv 解释器执行（`N.E.K.O/.venv/bin/python scripts/ooc12_regression.py --neko-src ...`）——系统 python3 缺 ormsgpack 会在 M6 报 ModuleNotFoundError。`ooc12-pack.json` 的 neko_src 已随运行更新为主 checkout 路径。

**首次启动后的导入步骤**（待用户）：
1. `systemctl --user start neko.target` 首启，完成初始化（生成 characters.json）；
2. N.E.K.O 界面角色管理导入 `deploy/monika-neko/monika-character-card.zip`（角色「莫妮卡」建立）；
3. 停服务（`systemctl --user stop neko.target`）后 `python3 deploy/monika-neko/apply-persona-override.py` 注入人格，再 start。

### 5. 冒烟（服务未起，预期 FAIL）—— 行为正确

- `scripts/smoke.sh`：桌面腿 2 项自动断言 FAIL（memory/main /health 均不可达）+「先启动：systemctl --user start neko.target」提示，exit 1；QQ/微信/终端/opencode/切端四腿按设计打印人工清单（MANUAL）。服务未起时此为正确行为。
- `scripts/doctor.sh`：核心 3 项 FAIL（memory_server /health、主进程 /health、ZMQ PUB 38866 TCP 不可达）+「先启动」提示，exit 1 = 正确；a-memorix 第 6 项 SKIP（未部署）、LLM key 第 5 项 SKIP（转人工）、NapCat 目录不存在 WARN（从未安装，正常）、日志目录 `~/Documents/N.E.K.O/logs` OK。

### 遗留待用户清单

1. **API key 配置**（本段跳过的全部 key 相关步骤）：
   - a-memorix：`a-memorix-service/config/a_memorix.toml` 的 `[model.*]`（LLM 与 embedding 的 base_url/api_key/model，候选见 docs/model-tiers.md）→ 启动 `neko-a-memorix.service` → /health 冒烟（app 指纹 neko-services）；
   - N.E.K.O 模型档：core_config.json 按 docs/model-tiers.md 配 conversation 主力 + summary/correction/emotion 便宜档 → `bash scripts/verify-tiers.sh` 确认。
2. **首次启动**：`systemctl --user enable --now neko.target`（与桌面 launcher 二选一，勿同时——INSTALL.md 互斥警告）。
3. **monika 角色导入**：按上文「首次启动后的导入步骤」三步执行。
4. **QQ 腿**：NapCat 登录 + qq_auto_reply 插件配置（当前 NapCat 未安装）。
5. **微信腿**：iLink 扫码授权（wechat_integration 插件）。
6. **B 段八项人工验收**：按本清单 B 节执行（四入口同一角色、跨端双盲、OOC 12 行为层、人味 A/B、模型分层、成本、纠错/遗忘、维护者工作流）。
