"""同步 MemoryServerClient 全场景测试（httpx.MockTransport，无真实网络）。

覆盖：正常体 / 200+status:error / 连接拒绝 / 超时 / body 不可解析 /
四写入端点 body 形状（契约表驱动）/ request_id 生成与传递 / 超时配置。
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from neko_mem_client import (
    CONTRACTS,
    MemServerBadResponse,
    MemServerError,
    MemServerTimeout,
    MemServerUnreachable,
    MemoryServerClient,
)
from conftest import WRITE_OK_BODIES, make_sync_client, ok_write_handler


# ── 正常体：四写入端点 + 三读取端点 ──────────────────────────────


@pytest.mark.parametrize("endpoint", ["cache", "process", "renew", "settle"])
def test_write_pipeline_happy_path(endpoint: str, sample_messages: list[dict]) -> None:
    """契约表驱动：每端点请求形状（method/path/body）与成功返回值断言。"""
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        result = getattr(client, endpoint)("neko", sample_messages)

    contract = CONTRACTS[endpoint]
    req = recorded.last()
    assert req.method == contract.method
    assert req.url.path == contract.path_template.replace("{name}", "neko")
    # body 形状：input_history 是 JSON 序列化的 messages 数组字符串
    sent = json.loads(req.content.decode("utf-8"))
    assert set(sent) == {"input_history"}
    assert json.loads(sent["input_history"]) == sample_messages
    # 成功返回服务端 body（status 已过契约校验）
    assert result == WRITE_OK_BODIES[endpoint]


def test_cache_empty_messages_settles_to_empty_array(sample_messages: list) -> None:
    """settle 默认空增量：input_history 序列化为 "[]"（wechat 同款）。"""
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        client.settle("neko")
        client.settle("neko", [])
    sent = json.loads(recorded.last().content.decode("utf-8"))
    assert sent["input_history"] == "[]"


def test_language_render_language_mutex_on_wire() -> None:
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        client.cache("neko", [{"role": "user", "content": "hi"}], language="zh-CN")
    assert recorded.last_json()["language"] == "zh-CN"
    with client:
        client.cache(
            "neko", [{"role": "user", "content": "hi"}], render_language="en"
        )
    assert recorded.last_json()["render_language"] == "en"


def test_new_dialog_returns_plain_text() -> None:
    client, recorded = make_sync_client(
        lambda req: httpx.Response(200, text="  persona markdown...\n")
    )
    with client:
        text = client.new_dialog("neko")
    assert text == "persona markdown..."
    req = recorded.last()
    assert req.method == "GET"
    assert req.url.path == "/new_dialog/neko"
    assert req.content == b""
    # 未传 language/render_language 时不发查询参数（服务端恢复持久 locale）
    assert req.url.params.get("language") is None
    assert req.url.params.get("render_language") is None


def test_new_dialog_language_query_params() -> None:
    """对齐 fetch_bootstrap_memory 现签名：可选 language/render_language
    查询参数（服务端 routes.py:3615-3620，language 优先）。"""
    client, recorded = make_sync_client(
        lambda req: httpx.Response(200, text="persona")
    )
    with client:
        client.new_dialog("neko", language="zh-CN")
        client.new_dialog("neko", render_language="en")
        client.new_dialog("neko", language="ja", render_language="en")
    first, second, third = recorded.requests
    assert first.url.params.get("language") == "zh-CN"
    assert first.url.params.get("render_language") is None
    assert second.url.params.get("render_language") == "en"
    assert second.url.params.get("language") is None
    # 两者都传时原样透传（优先级由服务端裁决）
    assert third.url.params.get("language") == "ja"
    assert third.url.params.get("render_language") == "en"


def test_query_memory_happy_path() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [{"text": "memory row"}],
                "query": "我们聊过什么",
                "candidates_total": 7,
                "elapsed_ms": 3.2,
            },
        )

    client, recorded = make_sync_client(handler)
    with client:
        result = client.query_memory(
            "neko",
            query="我们聊过什么",
            time="2026-09-01",
            subjects=[{"subject_kind": "group_chat", "subject_id": "123"}],
        )
    assert result["results"] == [{"text": "memory row"}]
    assert result["candidates_total"] == 7
    sent = recorded.last_json()
    assert sent["query"] == "我们聊过什么"
    assert sent["time"] == "2026-09-01"
    assert sent["subjects"] == [
        {"subject_kind": "group_chat", "subject_id": "123"}
    ]


def test_query_memory_explicit_empty_subjects_is_422() -> None:
    """契约事实：subjects 显式空列表=服务端 422 硬拒（fail-closed，
    不允许回退 legacy 私话语料），客户端映射为 MemServerError。"""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={
                "detail": "subjects must be omitted (legacy private) "
                "or contain 1..8 items"
            },
        )

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerError) as excinfo:
            client.query_memory("neko", query="hi", subjects=[])
    assert excinfo.value.status_code == 422


def test_health_returns_fingerprint_json() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/health"
        return httpx.Response(200, json={"service": "memory", "instance_id": "abc"})

    client, _ = make_sync_client(handler)
    with client:
        body = client.health()
    assert body == {"service": "memory", "instance_id": "abc"}


def test_lanlan_name_is_url_encoded() -> None:
    """角色名含非 ASCII 时 path 段经 quote(safe="")（对齐 cross_server）。

    注意 httpx 的 url.path 返回解码形，wire 上的编码形在 raw_path。
    """
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        client.cache("小猫.", [])
    assert recorded.last().url.raw_path == b"/cache/%E5%B0%8F%E7%8C%AB."


# ── 失败四分类 ────────────────────────────────────────────────────


@pytest.mark.parametrize("endpoint", ["cache", "process", "renew", "settle"])
def test_error_body_with_http_200_raises_mem_server_error(endpoint: str) -> None:
    """核心反模式拦截：HTTP 200 + body status:"error" → MemServerError
    （携带服务端 message）。"""
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "error", "message": "db locked"}
        )

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerError) as excinfo:
            getattr(client, endpoint)("neko", [])
    err = excinfo.value
    assert err.server_message == "db locked"
    assert err.status_code == 200
    assert err.endpoint == endpoint
    assert err.lanlan_name == "neko"
    assert err.request_id  # 异常携带 request_id，可与 debug 日志对上


def test_connection_refused_raises_unreachable() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=req)

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerUnreachable):
            client.cache("neko", [])


def test_timeout_raises_mem_server_timeout() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=req)

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerTimeout):
            client.query_memory("neko", query="hi")


@pytest.mark.parametrize(
    "body,label",
    [
        (b"not json at all", "non-JSON"),
        (b"[1, 2, 3]", "JSON array"),
        (b'{"count": 1}', "dict without status"),
        (b'{"status": "weird"}', "status outside contract"),
    ],
)
def test_unparseable_body_raises_bad_response(body: bytes, label: str) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerBadResponse):
            client.cache("neko", [])


def test_bad_response_on_missing_results_key_for_query_memory() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"query": "hi"})

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerBadResponse):
            client.query_memory("neko", query="hi")


def test_http_500_raises_mem_server_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerError) as excinfo:
            client.cache("neko", [])
    assert excinfo.value.status_code == 500
    # 超时/不可达类异常都不是这里
    assert not isinstance(excinfo.value, (MemServerTimeout, MemServerUnreachable))


# ── request_id：生成与传递 ────────────────────────────────────────


def test_request_id_sent_as_header_12hex() -> None:
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        client.cache("neko", [])
    rid = recorded.last_header("X-Request-Id")
    assert rid is not None
    assert len(rid) == 12
    int(rid, 16)  # 合法 hex


def test_request_id_unique_across_requests() -> None:
    client, recorded = make_sync_client(ok_write_handler)
    with client:
        client.cache("neko", [])
        client.cache("neko", [])
    rids = [r.headers.get("X-Request-Id") for r in recorded.requests]
    assert len(rids) == 2 and rids[0] != rids[1]


def test_request_id_propagated_to_exceptions() -> None:
    seen_rids: list[str | None] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen_rids.append(req.headers.get("X-Request-Id"))
        return httpx.Response(200, json={"status": "error", "message": "x"})

    client, _ = make_sync_client(handler)
    with client:
        with pytest.raises(MemServerError) as excinfo:
            client.cache("neko", [])
    assert excinfo.value.request_id == seen_rids[-1]


def test_request_id_logged_via_debug_logger(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import logging

    client, _ = make_sync_client(ok_write_handler)
    with caplog.at_level(logging.DEBUG, logger="neko_mem_client"):
        with client:
            client.cache("neko", [])
    joined = caplog.text
    assert "rid=" in joined
    assert "cache" in joined


# ── 超时配置 ──────────────────────────────────────────────────────


def _timeout_extension(request: httpx.Request) -> Any:
    # httpx 把生效 timeout 写进 request.extensions["timeout"]
    return request.extensions.get("timeout")


def test_default_timeout_applies() -> None:
    """构造器 timeout 对读取端点生效（写入端点默认走 SUGGESTED_TIMEOUTS，
    见下方专项测试）。"""
    client, recorded = make_sync_client(
        lambda req: httpx.Response(200, text="persona"), timeout=7.0
    )
    with client:
        client.new_dialog("neko")
    ext = _timeout_extension(recorded.last())
    assert ext is not None and ext["read"] == 7.0


def test_write_pipeline_default_timeouts_follow_suggestions() -> None:
    """未显式传 timeout 时写入管线按 SUGGESTED_TIMEOUTS 取默认：
    cache=5s（无前台 LLM），settle/process/renew=30s（LLM 摘要端点）。"""
    client, recorded = make_sync_client(ok_write_handler, timeout=5.0)
    with client:
        client.cache("neko", [])
        client.settle("neko")
        client.process("neko", [])
        client.renew("neko", [])
    for request, expected in zip(recorded.requests, (5.0, 30.0, 30.0, 30.0)):
        ext = _timeout_extension(request)
        assert ext is not None and ext["read"] == expected, (
            f"{request.url.path}: expected read timeout {expected}, got {ext}"
        )


def test_per_call_timeout_override() -> None:
    client, recorded = make_sync_client(ok_write_handler, timeout=5.0)
    with client:
        client.settle("neko", timeout=30.0)
    ext = _timeout_extension(recorded.last())
    assert ext is not None and ext["read"] == 30.0


# ── 防御性细节 ────────────────────────────────────────────────────


def test_injected_client_not_closed_on_exit() -> None:
    """注入外部 httpx.Client 时生命周期归调用方（close 不传染）。"""
    transport = httpx.MockTransport(ok_write_handler)
    injected = httpx.Client(transport=transport)
    client = MemoryServerClient(client=injected)
    with client:
        client.cache("neko", [])
    assert injected.is_closed is False
    injected.close()


def test_missing_lanlan_name_rejected() -> None:
    client, _ = make_sync_client(ok_write_handler)
    with client:
        with pytest.raises(ValueError):
            client.cache("", [])
    client.close()
