
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
