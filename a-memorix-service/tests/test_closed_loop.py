"""真内核闭环冒烟（P0-1b 验收）：mock embedding → ingest_text → search。

不注入假内核——SDKMemoryKernel 全真实（sqlite/faiss/双路检索），仅把
embedding/chat 出口指向本地假 OpenAI 兼容端点（确定性字符袋向量）。
"""

from __future__ import annotations

import time
from typing import Any, Dict

from fastapi.testclient import TestClient

from conftest import build_service_toml, swap_service_config
from tests.test_service_endpoints import _wait_for_health

READY_TIMEOUT_SECONDS = 180.0  # 首次初始化含 jieba 词典/faiss 建库，放宽


def _make_real_client(data_dir, api_base_url: str):
    from A_memorix.host_service import AMemorixHostService
    from a_memorix_service.service import create_app

    toml_text = build_service_toml(data_dir=data_dir, api_base_url=api_base_url)
    return (
        swap_service_config(toml_text, data_dir.parent),
        AMemorixHostService(),
        create_app,
    )


def test_ingest_then_search_closed_loop(tmp_path, fake_openai_server):
    ctx, service, create_app = _make_real_client(tmp_path / "data", fake_openai_server.base_url)
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            health = _wait_for_health(client, {"ready"}, timeout=READY_TIMEOUT_SECONDS)
            assert health["runtime_ready"] is True
            assert health["model_config"]["embedding_ready"] is True

            # 1) ingest_summary：聊天范围写入的正规入口（source=chat_summary:{chat_id}，
            #    scope 身份解析按此前缀放行——vendored 树的 _paragraph_scope_identity
            #    只认来源前缀，metadata 内嵌 chat_id 不参与身份判定，属上游现状）
            summary_body = {
                "external_id": "qq:group-1:session-abc",
                "chat_id": "group-1",
                "text": "露娜今天下午一直在宿舍窗台上晒太阳打盹，尾巴卷成一个圈",
                "time_start": 1758300000.0,
                "time_end": 1758300600.0,
            }
            ingest = client.post("/a_memorix/v1/ingest_summary", json=summary_body)
            assert ingest.status_code == 200, ingest.text
            ingest_payload = ingest.json()
            assert ingest_payload.get("stored_ids"), f"未存储任何段落: {ingest_payload}"

            # 2) 相同 external_id 重复写入 → 幂等跳过（exists 进 skipped_ids）
            again = client.post("/a_memorix/v1/ingest_summary", json=summary_body)
            assert again.status_code == 200
            assert again.json().get("skipped_ids"), f"幂等键未生效: {again.json()}"

            # 2b) ingest_text 写路径（幂等键 + 向量写入；不带聊天范围语义）
            text_body = {
                "external_id": "kb:fact:luna-sunbathing",
                "source_type": "chat_message",
                "text": "露娜最喜欢的事情是在窗台晒着太阳睡午觉",
                "chat_id": "group-1",
                "metadata": {"chat_id": "group-1"},
            }
            text_ingest = client.post("/a_memorix/v1/ingest_text", json=text_body)
            assert text_ingest.status_code == 200, text_ingest.text
            assert text_ingest.json().get("stored_ids"), f"ingest_text 未存储: {text_ingest.json()}"

            # 3) search：查询与入库文本共享字符（字符袋向量余弦相似）
            search = client.post("/a_memorix/v1/search", json={"query": "露娜在窗台上晒太阳", "chat_id": "group-1", "limit": 5})
            assert search.status_code == 200, search.text
            hits: list[dict[str, Any]] = search.json().get("hits", [])
            assert hits, f"闭环检索未召回: {search.json()}"
            contents = " ".join(str(hit.get("content", "")) for hit in hits)
            assert "晒太阳" in contents, f"召回内容不相关: {contents[:200]}"
            top_hit = hits[0]
            for key in ("content", "score", "type", "source", "hash", "metadata"):
                assert key in top_hit, f"命中缺少 MemoryHit.to_dict 键: {key}"

            # 4) stats 反映入库（内核真实键名：paragraphs/relations/episodes）
            stats = client.get("/a_memorix/v1/stats")
            assert stats.status_code == 200
            assert stats.json().get("paragraphs", 0) >= 2

            # 5) 假端点确实承接了 embedding 请求（闭环走的是 mock 出口）
            embedding_calls = [item for item in fake_openai_server.requests if item[0].endswith("/embeddings")]
            assert embedding_calls, "embedding 请求未打到假 OpenAI 端点"


def test_no_key_startup_warns_and_degrades(tmp_path, caplog):
    """未配置 key：启动 WARN + 进程/端点不崩（search 返回形状而非 500）。"""

    ctx, service, create_app = _make_real_client(tmp_path / "data", "http://127.0.0.1:9/v1")
    # 直接换成空模型配置（保持数据目录）
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url="http://127.0.0.1:9/v1")
    empty_model_toml = "\n".join(
        line for line in toml_text.splitlines() if not line.startswith(("model_list", "base_url", "api_key"))
    )
    with swap_service_config(empty_model_toml, tmp_path):
        import logging

        with caplog.at_level(logging.WARNING, logger="a_memorix_service.service"):
            with TestClient(create_app(host_service=service)) as client:
                health = _wait_for_health(client, {"ready", "failed"}, timeout=READY_TIMEOUT_SECONDS)
                # 内核照常就绪（元数据/稀疏/图谱通道不依赖模型 key）
                assert health["startup_state"] == "ready"
                assert health["model_config"]["embedding_ready"] is False

                search = client.post("/a_memorix/v1/search", json={"query": "任何查询", "chat_id": "c"})
                assert search.status_code == 200, "未配置 key 时 search 也不得 5xx"
                payload: Dict[str, Any] = search.json()
                assert "hits" in payload and "summary" in payload

        warnings = [record.message for record in caplog.records if "[model-config]" in record.message]
        assert any("api_providers" in item or "base_url" in item for item in warnings), warnings
