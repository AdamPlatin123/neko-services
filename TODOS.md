
## mem-client 后续 P2（代审通过后遗留，P3 优先级）
- health 探活校验指纹（空 body 200 现静默返回 {}，应校验 instance_id 键）
- 上下文复用测试改独立 client（现依赖注入客户端 no-op close 的语义不自明）
- test_contract 措辞降级为「关键锚点核对」或改为解析 routes.py 源码断言（消除双重维护）
- 异步侧补 3-4 个用例（per-call timeout/注入不 close/500/缺 results 键）
