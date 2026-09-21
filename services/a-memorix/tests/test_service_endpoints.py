"""FastAPI 壳端点契约测试（P0-1b #4）：指纹 / 降级 / WAL / admin / 禁用。

内核注入策略：用可阻塞的假 SDKMemoryKernel 替换（monkeypatch 模块属性——
host_service 在 _startup_kernel_task 内函数级 import，补丁即时生效），
从而确定性地构造「starting/failed」窗口，替代真实 kill -9：
- 未就绪窗口内写入 → 202 + queued + startup_write_queue.jsonl 落盘；
- 释放后 → 状态 ready → WAL 回放 → .done.jsonl → 后续调用直达内核。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

from conftest import build_service_toml, swap_service_config

READY_TIMEOUT_SECONDS = 60.0


class FakeKernel:
    """可阻塞/可失败的假内核（host_service 只依赖下面这些面）。"""

    def __init__(self, *, plugin_root: Any, config: Optional[Dict[str, Any]] = None) -> None:
        self.plugin_root = plugin_root
        self.config = config or {}
        self.initialized = False
        self.shutdown_called = False
        self.ingest_calls: List[Dict[str, Any]] = []
        self.search_calls: List[Any] = []
        self.release_event = threading.Event()
        self.init_error: Optional[Exception] = None
        FakeKernel.instances.append(self)

    instances: List["FakeKernel"] = []

    async def initialize(self) -> None:
        # init_error 支持运行中注入（复刻内核初始化中途失败的窗口）
        while not self.release_event.is_set():
            if self.init_error is not None:
                raise self.init_error
            await asyncio.sleep(0.02)
        if self.init_error is not None:
            raise self.init_error
        self.initialized = True

    async def shutdown(self) -> None:
        self.shutdown_called = True

    def close(self) -> None:
        self.shutdown_called = True

    # ---- host_service.invoke 消费面 ----
    async def search_memory(self, request: Any) -> Dict[str, Any]:
        self.search_calls.append(request)
        return {
            "summary": "fake summary",
            "hits": [
                {
                    "content": "露娜在窗台上晒太阳",
                    "score": 0.98,
                    "type": "paragraph",
                    "source": "fake",
                    "hash": "hash-1",
                    "metadata": {},
                    "episode_id": "",
                    "title": "",
                }
            ],
            "filtered": False,
        }

    async def ingest_text(self, **kwargs: Any) -> Dict[str, Any]:
        self.ingest_calls.append({"kind": "ingest_text", **kwargs})
        return {"success": True, "stored_ids": ["para-1"], "skipped_ids": []}

    async def ingest_summary(self, **kwargs: Any) -> Dict[str, Any]:
        self.ingest_calls.append({"kind": "ingest_summary", **kwargs})
        return {"success": True, "stored_ids": ["sum-1"], "skipped_ids": []}

    async def get_person_profile(self, **kwargs: Any) -> Dict[str, Any]:
        return {"summary": "", "traits": [], "evidence": []}

    async def maintain_memory(self, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True, "action": kwargs.get("action", "")}

    def memory_stats(self) -> Dict[str, Any]:
        return {"paragraph_count": 1, "relation_count": 2, "episode_count": 3}

    async def memory_runtime_admin(self, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True, "action": kwargs.get("action", "")}

    async def memory_source_admin(self, **kwargs: Any) -> Dict[str, Any]:
        return {"success": True, "action": kwargs.get("action", "")}

    def _runtime_capability_status(self) -> Dict[str, Any]:
        return {
            "memory_enabled": True,
            "runtime_ready": self.initialized,
            "retrieval_ready": self.initialized,
            "degraded": False,
            "retrieval_mode": "vector" if self.initialized else "unavailable",
            "available_channels": ["metadata", "vector_read"] if self.initialized else [],
            "unavailable_channels": [] if self.initialized else ["metadata", "vector_read"],
            "capabilities": {},
            "vector_health": {},
        }


@pytest.fixture
def fake_kernel_cls():
    FakeKernel.instances.clear()
    from A_memorix.core.runtime import sdk_memory_kernel

    original = sdk_memory_kernel.SDKMemoryKernel
    sdk_memory_kernel.SDKMemoryKernel = FakeKernel  # type: ignore[assignment,misc]
    try:
        yield FakeKernel
    finally:
        sdk_memory_kernel.SDKMemoryKernel = original  # type: ignore[assignment,misc]
        FakeKernel.instances.clear()


def _wait_for_health(client: TestClient, expected_states: set[str], timeout: float = READY_TIMEOUT_SECONDS) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last: Dict[str, Any] = {}
    while time.time() < deadline:
        last = client.get("/health").json()
        if last.get("startup_state") in expected_states:
            return last
        time.sleep(0.05)
    raise AssertionError(f"等待状态 {expected_states} 超时，最后: {last}")


def _make_client(data_dir: Path, *, api_base_url: str = "http://127.0.0.1:9/v1", enabled: bool = True):
    from A_memorix.host_service import AMemorixHostService
    from a_memorix_service.service import create_app

    toml_text = build_service_toml(data_dir=data_dir, api_base_url=api_base_url, enabled=enabled)
    config_dir = data_dir.parent
    config_dir.mkdir(parents=True, exist_ok=True)
    return swap_service_config(toml_text, config_dir), AMemorixHostService(), create_app


# ---------------------------------------------------------------------------
# /health 指纹
# ---------------------------------------------------------------------------


def test_health_fingerprint(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            kernel = fake_kernel_cls.instances[0]
            kernel.release_event.set()
            health = _wait_for_health(client, {"ready"})
            assert health["app"] == "neko-services"
            assert health["service"] == "a-memorix"
            assert health["status"] == "ok"
            assert health["instance_id"]
            assert health["startup_state"] == "ready"
            # instance_id 与 NEKO_INSTANCE_ID 对齐（systemd 三 unit 同源模式）
            import os

            if os.getenv("NEKO_INSTANCE_ID"):
                assert health["instance_id"] == os.environ["NEKO_INSTANCE_ID"]


# ---------------------------------------------------------------------------
# 未就绪降级：search 202 空形状；写入 202 + WAL
# ---------------------------------------------------------------------------


def test_search_not_ready_returns_202_empty_shape(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            _wait_for_health(client, {"starting", "migrating"})
            response = client.post("/a_memorix/v1/search", json={"query": "露娜晒太阳", "chat_id": "c1"})
            assert response.status_code == 202
            payload = response.json()
            assert payload["success"] is True
            assert payload["hits"] == []
            assert payload["summary"] == ""
            assert payload["filtered"] is False
            assert payload["reason"] == "a_memorix_initializing"

            # 释放 → ready → search 直达内核（200 + MemoryHit.to_dict 键）
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})
            response = client.post("/a_memorix/v1/search", json={"query": "露娜晒太阳", "chat_id": "c1"})
            assert response.status_code == 200
            hit = response.json()["hits"][0]
            for key in ("content", "score", "type", "source", "hash", "metadata"):
                assert key in hit, f"命中缺少 MemoryHit.to_dict 键: {key}"


def test_ingest_not_ready_queues_wal_then_replays(tmp_path, fake_kernel_cls):
    """启动队列 WAL 语义（kill 模拟 = 未就绪窗口注入）：202 落盘 → ready 后回放。"""

    data_dir = tmp_path / "data"
    ctx, service, create_app = _make_client(data_dir)
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            _wait_for_health(client, {"starting", "migrating"})

            ingest_body = {
                "external_id": "qq:c1:turn-1:0",
                "source_type": "chat_message",
                "text": "露娜在窗台上晒太阳打盹",
                "chat_id": "c1",
            }
            response = client.post("/a_memorix/v1/ingest_text", json=ingest_body)
            assert response.status_code == 202
            payload = response.json()
            assert payload["queued"] is True
            assert payload["reason"] == "a_memorix_initializing_queued"
            assert payload["record_id"]

            # WAL 落盘（startup_write_queue.jsonl）
            queue_file = data_dir / "startup_write_queue.jsonl"
            assert queue_file.exists()
            record = json.loads(queue_file.read_text(encoding="utf-8").strip().splitlines()[-1])
            assert record["component_name"] == "ingest_text"
            assert record["payload"] == ingest_body
            assert record["record_id"] == payload["record_id"]

            # 就绪 → 自动回放 → .done.jsonl + 内核收到写入
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})
            deadline = time.time() + READY_TIMEOUT_SECONDS
            done_file = data_dir / "startup_write_queue.done.jsonl"
            while time.time() < deadline:
                if done_file.exists() and done_file.stat().st_size > 0:
                    break
                time.sleep(0.05)
            done_rows = [json.loads(line) for line in done_file.read_text(encoding="utf-8").splitlines() if line.strip()]
            assert any(row["record_id"] == payload["record_id"] for row in done_rows)

            kernel = fake_kernel_cls.instances[0]
            replayed = [call for call in kernel.ingest_calls if call.get("external_id") == "qq:c1:turn-1:0"]
            assert replayed, f"WAL 回放未触达内核: {kernel.ingest_calls}"

            # 回放后 health 的 pending 归零
            health = client.get("/health").json()
            assert health["startup_queue_pending"] == 0

            # shutdown 传播到内核（lifespan stop → host_service.stop → kernel.shutdown）
        assert fake_kernel_cls.instances[0].shutdown_called is True


def test_wal_replays_preexisting_records_on_restart(tmp_path, fake_kernel_cls):
    """跨重启回放：上一进程（模拟 kill）留下的队列记录在本次启动就绪后回放。"""

    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    queue_file = data_dir / "startup_write_queue.jsonl"
    stale_record = {
        "record_id": "stale-record-0001",
        "component_name": "ingest_text",
        "payload": {"external_id": "qq:c1:turn-0:0", "source_type": "chat_message", "text": "重启前的写入", "chat_id": "c1"},
        "created_at": 1000000.0,
    }
    queue_file.write_text(json.dumps(stale_record, ensure_ascii=False) + "\n", encoding="utf-8")

    ctx, service, create_app = _make_client(data_dir)
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})
            kernel = fake_kernel_cls.instances[0]
            deadline = time.time() + READY_TIMEOUT_SECONDS
            while time.time() < deadline and not any(
                call.get("external_id") == "qq:c1:turn-0:0" for call in kernel.ingest_calls
            ):
                time.sleep(0.05)
            assert any(call.get("external_id") == "qq:c1:turn-0:0" for call in kernel.ingest_calls), "重启后未回放遗留 WAL 记录"
            done_file = data_dir / "startup_write_queue.done.jsonl"
            done_rows = [json.loads(line) for line in done_file.read_text(encoding="utf-8").splitlines() if line.strip()]
            assert any(row["record_id"] == "stale-record-0001" for row in done_rows)


# ---------------------------------------------------------------------------
# 初始化失败 / 禁用 / admin / 请求体
# ---------------------------------------------------------------------------


def test_failed_state_returns_503(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            kernel = fake_kernel_cls.instances[0]
            kernel.init_error = RuntimeError("embedding 初始化炸了（测试注入）")
            deadline = time.time() + READY_TIMEOUT_SECONDS
            while time.time() < deadline:
                if client.get("/health").json().get("startup_state") == "failed":
                    break
                time.sleep(0.05)
            response = client.post("/a_memorix/v1/search", json={"query": "x"})
            assert response.status_code == 503
            payload = response.json()
            assert payload["reason"] == "a_memorix_initialization_failed"
            assert payload["hits"] == []
            assert "embedding 初始化炸了" in payload["message"]


def test_disabled_config_returns_disabled_shape(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data", enabled=False)
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            response = client.post("/a_memorix/v1/search", json={"query": "x"})
            assert response.status_code == 200
            payload = response.json()
            assert payload["disabled"] is True
            assert payload["reason"] == "a_memorix_disabled"
            assert payload["hits"] == []
            ingest = client.post("/a_memorix/v1/ingest_text", json={"external_id": "e", "source_type": "s", "text": "t"})
            assert ingest.status_code == 200
            assert ingest.json()["reason"] == "a_memorix_disabled"
            assert fake_kernel_cls.instances == [], "禁用态不应构造内核"


def test_admin_routing_and_404(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})

            unknown = client.post("/a_memorix/v1/admin/never_exists_admin", json={"action": "list"})
            assert unknown.status_code == 404

            bad_action = client.post("/a_memorix/v1/admin/memory_source_admin", json={"action": "not_an_action"})
            assert bad_action.status_code == 200  # AdminContractError.to_response 形状（success=False）
            assert bad_action.json()["success"] is False

            ok = client.post("/a_memorix/v1/admin/memory_source_admin", json={"action": "list"})
            assert ok.status_code == 200
            assert ok.json()["success"] is True

            # memory_runtime_admin 响应合并启动状态（host_service 特例，透传保留）
            runtime = client.post("/a_memorix/v1/admin/memory_runtime_admin", json={"action": "get_config"})
            assert runtime.status_code == 200
            assert "startup_state" in runtime.json()


def test_stats_and_maintain_and_person_profile(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})

            stats = client.get("/a_memorix/v1/stats")
            assert stats.status_code == 200
            assert stats.json()["paragraph_count"] == 1

            maintain = client.post("/a_memorix/v1/maintain", json={"action": "recycle_bin"})
            assert maintain.status_code == 200
            assert maintain.json()["success"] is True

            profile = client.post("/a_memorix/v1/person_profile", json={"person_id": "p1"})
            assert profile.status_code == 200
            assert profile.json() == {"summary": "", "traits": [], "evidence": []}


def test_bad_request_body_returns_400(tmp_path, fake_kernel_cls):
    ctx, service, create_app = _make_client(tmp_path / "data")
    with ctx:
        with TestClient(create_app(host_service=service)) as client:
            fake_kernel_cls.instances[0].release_event.set()
            _wait_for_health(client, {"ready"})
            response = client.post(
                "/a_memorix/v1/search",
                content="not-json",
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 400
            array_body = client.post("/a_memorix/v1/search", json=[1, 2, 3])
            assert array_body.status_code == 400
