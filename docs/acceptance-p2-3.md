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
