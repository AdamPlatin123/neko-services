
## mem-client 后续 P2（代审通过后遗留，P3 优先级）
- health 探活校验指纹（空 body 200 现静默返回 {}，应校验 instance_id 键）
- 上下文复用测试改独立 client（现依赖注入客户端 no-op close 的语义不自明）
- test_contract 措辞降级为「关键锚点核对」或改为解析 routes.py 源码断言（消除双重维护）
- 异步侧补 3-4 个用例（per-call timeout/注入不 close/500/缺 results 键）

## P1-2 跟进项（代审通过后遗留）
- P2：persona-selection 路由（characters_router/persona.py set_reserved）整体覆写会静默清除 mount_mode/append_guidance/env_context 三新键——005 跟进 patch（重建时保留 append 轨键）
- P2：ooc12-pack.json 的 neko_src 机器路径字段改为基线 hash 别名（跨机一致性）
- P2：ooc12_regression.py 的 M5 导入包 try/except、删未用导入、--pack-out 默认不写仓库内跟踪文件
- P3：mount_mode 白名单校验+非法值日志；env_context docstring 补传输面说明；测试标记归类 plugin_unit

## P1-1a 跟进项（代审通过后遗留）
- P2：F2 对齐窗口竞态（/new_dialog 渲染与对齐 fetch 之间落盘且 seq≤next_seq 的消息本会话不可见）——并入 UC3 已知偏差记账
- P2：F3 读注入超时 5s vs mvp-tech-design S2 表写的 2s——规格文档偏差登记（实现取上游既有值，合理）
- P3：F4 水位在 fetch 成功即推进（非 LLM 消费后）——语义选择记账
- P3：F5 角色目录整体删除重建后 seq 从 1 重来，残留会话旧水位静默跳过——注释记账
- P3：F6 成功注入 INFO 日志补 request_id；新端点登记进 neko-access-audit §1 端点表

## P0-1b 跟进项（代审通过后遗留）
- P2：embedding extra_params 白名单过滤或改 extra_body=（防类型化签名 TypeError 报废候选模型）
- P2：enqueue_feedback_task 刻意不暴露——audit/route 文档加备注
- P2：stats 双键形（ready 复数 vs disabled 单数）——README/audit 加注
- P2：pyproject 注释「锁版本在 P0-1b」与现实矛盾——锁版本或改注释
- P3：timeout_ms<=0 应 400/422 非 500；/health model_config 快照不随 reload 刷新；504 路径无测试；admin 13 组件全量遍历测试

## P1-3 跟进项（代审通过后遗留）
- P2（架构）：external_id 上 wire——/cache /process body 带 dedup 键（P1-1 侧契约扩展立项：HistoryRequest 加 external_id/turn_uid 字段+服务端幂等），当前 opencode 重试是服务端无去重的盲发
- P2：P2-3 人工验收清单加「/monika 命令轮的 /cache 载荷断言无注入文本回灌」（TUI 路径未实测）
- P3：onIdle 先落 outbox 再记 last_turn_id（崩溃窗口丢单轮）；read.sh 过滤 corrupt- 前缀；monika.md 十三补 edit 被拒的降级话术；PLAN 文件表两处陈旧（六端点工具→三工具、read.sh 路径）

## P2-1 跟进项（代审通过后遗留，均 P3）
- 缓冲无 first_blocks 罕见路径的 mention 文本口径（改写前）与 fallback 不一致
- off 时三条无条件 INFO 日志（投递完成/改写完成/缓冲确认）——高频群每 deliver 多两条
- ChineseTypoGenerator 每块构造（21k pinyin 建表）——提升到模块级缓存
- jieba 0.42.1 sdist 构建重量——离线部署注意点（文档已记）

## UC3-B 跟进项（F1 修复随分支重导）
- P2：F3 ingest 在 sync connector 主循环 await（a-memorix 慢挂时卡会话边界 ~10s；默认 off；后续 fire-and-forget 化，external_id 幂等已铺路）
- P3：F4 空库对齐 off-by-one（全新 recent.json 首条永不注入，010/002 同款，一次性无害）
