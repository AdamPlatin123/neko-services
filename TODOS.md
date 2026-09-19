
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
