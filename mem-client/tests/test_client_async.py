"""AsyncMemoryServerClient 场景测试（与同步版同一套桩，核心场景全覆盖）。

pytest-asyncio asyncio_mode=auto：async def 测试自动收集。
"""

from __future__ import annotations

import json

import httpx
import pytest

from neko_mem_client import (
    MemServerBadResponse,
    MemServerError,
    MemServerTimeout,
    MemServerUnreachable,
)
from conftest import make_async_client, ok_write_handler


@pytest.mark.parametrize("endpoint", ["cache", "process", "renew", "settle"])
async def test_write_pipeline_happy_path_async(
    endpoint: str, sample_messages: list[dict]
) -> None:
    client, recorded = make_async_client(ok_write_handler)
    async with client:
        result = await getattr(client, endpoint)("neko", sample_messages)
    sent = json.loads(recorded.last().content.decode("utf-8"))
    assert json.loads(sent["input_history"]) == sample_messages
    assert result["status"] in ("cached", "processed", "settled")


async def test_new_dialog_and_query_memory_and_health_async() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.startswith("/new_dialog/"):
            return httpx.Response(200, text="persona layer\n")
        if req.url.path.startswith("/query_memory/"):
            return httpx.Response(
                200,
                json={
                    "results": [],
                    "query": "hi",
                    "candidates_total": 0,
                    "elapsed_ms": 1.0,
                },
            )
        return httpx.Response(200, json={"service": "memory", "instance_id": "x"})

    client, recorded = make_async_client(handler)
    async with client:
        assert await client.new_dialog("neko") == "persona layer"
        assert (await client.query_memory("neko", query="hi"))["results"] == []
        assert (await client.health())["service"] == "memory"


async def test_new_dialog_language_query_params_async() -> None:
    client, recorded = make_async_client(
        lambda req: httpx.Response(200, text="persona")
    )
    async with client:
        await client.new_dialog("neko", language="zh-CN")
    assert recorded.last().url.params.get("language") == "zh-CN"


async def test_write_pipeline_default_timeout_follows_suggestions_async() -> None:
    """异步侧同样按 SUGGESTED_TIMEOUTS 取默认（cache=5 / settle=30）。"""
    client, recorded = make_async_client(ok_write_handler, timeout=5.0)
    async with client:
        await client.cache("neko", [])
        await client.settle("neko")
    exts = [r.extensions.get("timeout") for r in recorded.requests]
    assert exts[0] is not None and exts[0]["read"] == 5.0
    assert exts[1] is not None and exts[1]["read"] == 30.0


# ── 失败四分类（异步形态） ────────────────────────────────────────


async def test_error_body_200_async() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "message": "boom"})

    client, _ = make_async_client(handler)
    async with client:
        with pytest.raises(MemServerError) as excinfo:
            await client.process("neko", [])
    assert excinfo.value.server_message == "boom"


async def test_unreachable_async() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    client, _ = make_async_client(handler)
    async with client:
        with pytest.raises(MemServerUnreachable):
            await client.cache("neko", [])


async def test_timeout_async() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connect timed out", request=req)

    client, _ = make_async_client(handler)
    async with client:
        with pytest.raises(MemServerTimeout):
            await client.renew("neko", [])


async def test_bad_response_async() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>502 page</html>")

    client, _ = make_async_client(handler)
    async with client:
        with pytest.raises(MemServerBadResponse):
            await client.settle("neko")


# ── request_id（异步形态） ────────────────────────────────────────


async def test_request_id_header_and_uniqueness_async() -> None:
    client, recorded = make_async_client(ok_write_handler)
    async with client:
        await client.cache("neko", [])
        await client.settle("neko")
    rids = [r.headers.get("X-Request-Id") for r in recorded.requests]
    assert all(r is not None and len(r) == 12 for r in rids)
    assert rids[0] != rids[1]


async def test_request_id_on_exception_async() -> None:
    seen: list[str | None] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.headers.get("X-Request-Id"))
        return httpx.Response(200, json={"status": "error", "message": "x"})

    client, _ = make_async_client(handler)
    async with client:
        with pytest.raises(MemServerError) as excinfo:
            await client.cache("neko", [])
    assert excinfo.value.request_id == seen[-1]
