"""neko-mem-client：N.E.K.O memory_server 统一 HTTP 客户端。

端点契约同源：docs/design/neko-access-audit.md §1（详见
:mod:`neko_mem_client.contract`）。

典型用法（同步）::

    from neko_mem_client import MemoryServerClient

    with MemoryServerClient() as mem:
        mem.cache("neko", messages)          # 每轮 turn 结束
        result = mem.query_memory("neko", query="我们聊过什么？")

异步::

    from neko_mem_client import AsyncMemoryServerClient

    async with AsyncMemoryServerClient() as mem:
        # 会话结束（0 增量）；settle 默认超时即取 SUGGESTED_TIMEOUTS 的 30s
        # （显式传参可覆盖）
        await mem.settle("neko", timeout=30.0)
"""

from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_S,
    X_REQUEST_ID_HEADER,
    AsyncMemoryServerClient,
    MemClientError,
    MemServerBadResponse,
    MemServerError,
    MemServerTimeout,
    MemServerUnreachable,
    MemoryServerClient,
)
from .contract import (
    CONTRACTS,
    READ_ENDPOINTS,
    SETTLE_RHYTHM,
    SUGGESTED_TIMEOUTS,
    WRITE_PIPELINE_ENDPOINTS,
    EndpointContract,
)

__version__ = "0.1.0"

__all__ = [
    # 客户端
    "MemoryServerClient",
    "AsyncMemoryServerClient",
    # 异常四分类 + 基类
    "MemClientError",
    "MemServerUnreachable",
    "MemServerError",
    "MemServerTimeout",
    "MemServerBadResponse",
    # 契约表
    "CONTRACTS",
    "EndpointContract",
    "WRITE_PIPELINE_ENDPOINTS",
    "READ_ENDPOINTS",
    "SETTLE_RHYTHM",
    "SUGGESTED_TIMEOUTS",
    # 常量
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT_S",
    "X_REQUEST_ID_HEADER",
]
