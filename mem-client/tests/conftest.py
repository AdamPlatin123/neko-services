"""共享测试工具：httpx.MockTransport 驱动的内存端 memory_server 桩。

不依赖 pytest-httpserver（免端口绑定），全部场景在 MockTransport handler
内构造，包括传输层异常（ConnectError/ReadTimeout 直接从 handler raise，
httpx 会原样传播给调用方）。
"""

from __future__ import annotations

from typing import Any, Callable

import httpx
import pytest

from neko_mem_client import AsyncMemoryServerClient, MemoryServerClient

#: 各写入端点的成功 body（与 routes.py 实测一致）
WRITE_OK_BODIES: dict[str, dict[str, Any]] = {
    "cache": {"status": "cached", "count": 2},
    "process": {"status": "processed"},
    "renew": {"status": "processed"},
    "settle": {"status": "settled"},
}


class Recorded:
    """捕获全部出站请求的 handler 包装器。"""

    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self.requests: list[httpx.Request] = []
        self._handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)

    # 便捷取值 ---------------------------------------------------------

    def last(self) -> httpx.Request:
        return self.requests[-1]

    def last_json(self) -> dict[str, Any]:
        import json

        return json.loads(self.last().content.decode("utf-8"))

    def last_header(self, name: str) -> str | None:
        return self.last().headers.get(name)


def make_sync_client(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any
) -> tuple[MemoryServerClient, Recorded]:
    recorded = Recorded(handler)
    transport = httpx.MockTransport(recorded)
    client = MemoryServerClient(client=httpx.Client(transport=transport), **kwargs)
    return client, recorded


def make_async_client(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any
) -> tuple[AsyncMemoryServerClient, Recorded]:
    recorded = Recorded(handler)
    transport = httpx.MockTransport(recorded)
    client = AsyncMemoryServerClient(
        client=httpx.AsyncClient(transport=transport), **kwargs
    )
    return client, recorded


def ok_write_handler(request: httpx.Request) -> httpx.Response:
    """按路径返回对应写入端点的成功 body。"""
    for endpoint, body in WRITE_OK_BODIES.items():
        if request.url.path.startswith(f"/{endpoint}/"):
            return httpx.Response(200, json=body)
    raise AssertionError(f"unexpected path: {request.url.path}")


@pytest.fixture
def sample_messages() -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": "早上好"},
        {"role": "assistant", "content": "早上好呀，今天想做什么？"},
    ]
