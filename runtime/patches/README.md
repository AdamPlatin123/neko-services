
## 契约治理（2026-09-22 立）

触碰 memory 端点的补丁（新增/修改端点、改 body 形状、改 status 语义），
**同一 commit** 必须更新 `core/memory-client/neko_mem_client/contract.py`
与 `core/memory-client/tests/test_contract.py`。违反此规则的补丁不予合并。
