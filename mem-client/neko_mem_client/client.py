"""N.E.K.O memory_server 统一 HTTP 客户端。

封装 ``docs/design/neko-access-audit.md`` §1 的全部核心端点
（cache/process/renew/settle 写入管线 + new_dialog/query_memory/health 读取），
与契约表 :mod:`neko_mem_client.contract` 同源。

设计要点：

1. **强制检查 body 的 status 字段**——memory_server 的写入端点失败时返回
   HTTP 200 + ``{"status": "error", "message": ...}``（200+error 反模式，
   routes.py:987/1051/1110/1165），只看 HTTP 状态码会把失败当成功。
2. **失败四分类异常**（均继承 :class:`MemClientError`，携带 request_id
   便于排障）：

   - :class:`MemServerUnreachable`——连接层失败（拒绝/DNS/传输层断开）
   - :class:`MemServerError`——服务端明确报错（body ``status:"error"`` 带
     服务端 message，或 HTTP 非 2xx）
   - :class:`MemServerTimeout`——请求超时
   - :class:`MemServerBadResponse`——响应体无法按契约解析（非 JSON/非
     dict/缺 status 字段/成功值不在契约集合内）

3. **request_id**——每个请求生成 uuid4 短形（12 hex），注入 debug 日志与
   ``X-Request-Id`` header（服务端当前忽略该 header，为未来服务端留痕
   预留）。
4. **超时可配**——默认 5s 对齐上游 ``cross_server._post_memory_server``
   的共享客户端默认；per-call 可覆盖。settle 管线中带 LLM 摘要的端点
   （process/renew/settle）建议 30s（参考 wechat_integration 实现）。
5. **settle 管线节奏**（何时调哪个端点，详见 contract.SETTLE_RHYTHM）：

   - turn 结束 → :meth:`~MemoryServerClient.cache`（增量）
   - 会话重开（热重置）→ :meth:`~MemoryServerClient.renew`（有增量）
     或 :meth:`~MemoryServerClient.settle`（0 增量）
   - 会话结束 → :meth:`~MemoryServerClient.process`（有增量）
     或 :meth:`~MemoryServerClient.settle`（0 增量）

Python 3.11 兼容（N.E.K.O 上游锁定 3.11.*），仅依赖标准 httpx。
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any
from urllib.parse import quote

import httpx

from .contract import CONTRACTS, SUGGESTED_TIMEOUTS, EndpointContract

logger = logging.getLogger("neko_mem_client")

#: 默认 base_url：config/network.py:160-168 的 MEMORY_SERVER=48912，回环无鉴权
DEFAULT_BASE_URL = "http://127.0.0.1:48912"

#: 默认超时（秒），对齐上游 cross_server._post_memory_server
DEFAULT_TIMEOUT_S = 5.0

#: request_id 注入的 header（服务端当前忽略，为未来留痕预留）
X_REQUEST_ID_HEADER = "X-Request-Id"


# ── 异常体系：失败四分类 ─────────────────────────────────────────


class MemClientError(Exception):
    """全部 memory_server 客户端异常的基类。

    携带 :attr:`request_id` / :attr:`endpoint` / :attr:`lanlan_name`，
    便于把异常和 debug 日志里的请求记录对上。
    """

    def __init__(
        self,
        message: str,
        *,
        request_id: str | None = None,
        endpoint: str | None = None,
        lanlan_name: str | None = None,
    ) -> None:
        super().__init__(message)
        self.request_id = request_id
        self.endpoint = endpoint
        self.lanlan_name = lanlan_name


class MemServerUnreachable(MemClientError):
    """连接层失败：连接拒绝 / DNS 解析失败 / 传输层断开（服务未启动或已退出）。

    兜底范围：除超时（TimeoutException→MemServerTimeout）外的全部
    httpx.HTTPError 传输异常都归此类，包括本地协议/解码类异常
    （httpx.LocalProtocolError、httpx.DecodeError 等）——这类并非
    "服务不可达"本身，但同样属传输层失败，排障时请先看异常消息里的
    原异常类型再定位。"""


class MemServerError(MemClientError):
    """服务端明确报错：HTTP 200 + body ``status:"error"``（携带服务端 message），
    或 HTTP 非 2xx（FastAPI 校验错 4xx / 维护模式 409 / 未初始化 503 等）。"""

    def __init__(
        self,
        message: str,
        *,
        server_message: str | None = None,
        status_code: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(message, **kwargs)
        self.server_message = server_message
        self.status_code = status_code


class MemServerTimeout(MemClientError):
    """请求超时（连接/读/写/池任一阶段）。"""


class MemServerBadResponse(MemClientError):
    """响应体无法按契约解析：非 JSON / 非 dict / 写入端点缺 status 字段 /
    status 成功值不在契约集合内（契约漂移，fail loud）。"""


# ── 共享基类：URL/body 构造与响应校验 ────────────────────────────


class _MemoryServerClientBase:
    """同步/异步客户端共享的 URL 构造、body 构造与响应校验逻辑。"""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_timeout = timeout

    # -- request_id -------------------------------------------------

    @staticmethod
    def _new_request_id() -> str:
        """uuid4 短形（12 hex）：足以区分同秒内并发请求，日志友好。"""
        return uuid.uuid4().hex[:12]

    @staticmethod
    def _headers(request_id: str) -> dict[str, str]:
        return {X_REQUEST_ID_HEADER: request_id}

    # -- URL / body -------------------------------------------------

    def _url(self, contract: EndpointContract, lanlan_name: str | None) -> str:
        # lanlan_name 段经 quote(safe="") 编码，对齐 cross_server._post_memory_server
        # （角色名可含非 ASCII 字符与点号）
        if "{name}" in contract.path_template:
            if not lanlan_name:
                raise ValueError(f"endpoint {contract.endpoint!r} requires lanlan_name")
            path = contract.path_template.format(name=quote(lanlan_name, safe=""))
        else:
            path = contract.path_template
        return f"{self.base_url}{path}"

    @staticmethod
    def build_history_payload(
        messages: list[dict[str, Any]] | None,
        *,
        language: str | None = None,
        render_language: str | None = None,
    ) -> dict[str, Any]:
        """构造 HistoryRequest body（cache/process/renew/settle 共用）。

        ``input_history`` 是 **JSON 序列化的 messages 数组字符串**（不是
        嵌套数组），对齐上游 wire 格式；省略/空 messages 序列化为 ``"[]"``
        （settle 空增量的标准形态）。

        ``language`` 与 ``render_language`` 互斥、仅发其一（对齐
        cross_server._post_memory_server 的 wire 规则：language 是持久
        偏好证据，render_language 仅是本次渲染回退；两者同时发会让
        下游把 UI 证据误当用户偏好）。语言码支持性校验留给服务端。
        """
        payload: dict[str, Any] = {
            "input_history": json.dumps(list(messages or []), ensure_ascii=False),
        }
        if language:
            payload["language"] = language
        elif render_language:
            payload["render_language"] = render_language
        return payload

    # -- 响应校验 ----------------------------------------------------

    @staticmethod
    def _decode_json_body(
        response: httpx.Response,
        *,
        request_id: str,
        contract: EndpointContract,
        lanlan_name: str | None,
    ) -> dict[str, Any]:
        """解析 body 为 dict；非 JSON / 非 dict → MemServerBadResponse。"""
        raw = response.text
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise MemServerBadResponse(
                f"{contract.endpoint}: non-JSON response (body_len={len(raw)})",
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            ) from exc
        if not isinstance(body, dict):
            raise MemServerBadResponse(
                f"{contract.endpoint}: unexpected response type "
                f"{type(body).__name__} (expected JSON object)",
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            )
        return body

    @classmethod
    def _check_http_status(
        cls,
        response: httpx.Response,
        *,
        request_id: str,
        contract: EndpointContract,
        lanlan_name: str | None,
    ) -> None:
        """非 2xx → MemServerError（HTTP 层失败，与 200+error 区分但同类）。"""
        if not (200 <= response.status_code < 300):
            snippet = response.text[:200].replace("\n", " ")
            raise MemServerError(
                f"{contract.endpoint}: HTTP {response.status_code} "
                f"(body={snippet!r})",
                server_message=snippet or None,
                status_code=response.status_code,
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            )

    @classmethod
    def _check_write_response(
        cls,
        response: httpx.Response,
        *,
        request_id: str,
        contract: EndpointContract,
        lanlan_name: str | None,
    ) -> dict[str, Any]:
        """写入管线端点响应校验：HTTP 2xx → 解析 body → 检查 status 字段。

        - body ``status == "error"`` → :class:`MemServerError`（携带服务端
          message）——**200+error 反模式拦截点**
        - ``status`` 缺失 / 不在契约成功集合 → :class:`MemServerBadResponse`
          （契约漂移 fail loud，宁可有错报也不能静默吞掉）
        """
        cls._check_http_status(
            response, request_id=request_id, contract=contract, lanlan_name=lanlan_name
        )
        body = cls._decode_json_body(
            response, request_id=request_id, contract=contract, lanlan_name=lanlan_name
        )
        status = body.get("status")
        if status == "error":
            server_message = str(body.get("message", "unknown_error"))
            raise MemServerError(
                f"{contract.endpoint}: server returned status=error: {server_message}",
                server_message=server_message,
                status_code=response.status_code,
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            )
        if status not in contract.success_statuses:
            raise MemServerBadResponse(
                f"{contract.endpoint}: body status {status!r} not in expected "
                f"{contract.success_statuses} (contract drift?)",
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            )
        return body

    @classmethod
    def _check_query_response(
        cls,
        response: httpx.Response,
        *,
        request_id: str,
        lanlan_name: str | None,
    ) -> dict[str, Any]:
        """query_memory 响应校验：2xx + dict + 含 results 键。

        服务端承诺「失败永返空」，但客户端仍防御 status:"error" 与契约
        漂移（缺 results 键）。
        """
        contract = CONTRACTS["query_memory"]
        cls._check_http_status(
            response, request_id=request_id, contract=contract, lanlan_name=lanlan_name
        )
        body = cls._decode_json_body(
            response, request_id=request_id, contract=contract, lanlan_name=lanlan_name
        )
        if body.get("status") == "error":
            server_message = str(body.get("message", "unknown_error"))
            raise MemServerError(
                f"query_memory: server returned status=error: {server_message}",
                server_message=server_message,
                status_code=response.status_code,
                request_id=request_id,
                endpoint="query_memory",
                lanlan_name=lanlan_name,
            )
        if "results" not in body:
            raise MemServerBadResponse(
                "query_memory: body missing 'results' key (contract drift?)",
                request_id=request_id,
                endpoint="query_memory",
                lanlan_name=lanlan_name,
            )
        return body

    @staticmethod
    def _log_call(
        *,
        request_id: str,
        contract: EndpointContract,
        lanlan_name: str | None,
        outcome: str,
        elapsed_s: float,
        extra: str = "",
    ) -> None:
        logger.debug(
            "memory_server %s%s rid=%s %s %.1fms%s",
            contract.endpoint,
            f"/{lanlan_name}" if lanlan_name else "",
            request_id,
            outcome,
            elapsed_s * 1000.0,
            f" {extra}" if extra else "",
        )

    # -- 异常映射（传输层） -------------------------------------------

    @classmethod
    def _wrap_transport_error(
        cls,
        exc: httpx.HTTPError,
        *,
        request_id: str,
        contract: EndpointContract,
        lanlan_name: str | None,
    ) -> MemClientError:
        if isinstance(exc, httpx.TimeoutException):
            return MemServerTimeout(
                f"{contract.endpoint}: request timed out ({exc.__class__.__name__})",
                request_id=request_id,
                endpoint=contract.endpoint,
                lanlan_name=lanlan_name,
            )
        return MemServerUnreachable(
            f"{contract.endpoint}: connection-layer failure: "
            f"{exc.__class__.__name__}: {exc}",
            request_id=request_id,
            endpoint=contract.endpoint,
            lanlan_name=lanlan_name,
        )


# ── 同步客户端 ────────────────────────────────────────────────────


class MemoryServerClient(_MemoryServerClientBase):
    """同步客户端（httpx.Client）。线程安全性与 httpx.Client 相同：
    可跨线程共享，但 close() 之后不可再用。

    :param base_url: 默认 ``http://127.0.0.1:48912``（MEMORY_SERVER）
    :param timeout:  默认 5s，对齐上游 _post_memory_server；建议按
        contract.SUGGESTED_TIMEOUTS 对 LLM 端点放宽
    :param client:   可选注入已配置好的 httpx.Client（测试 MockTransport /
        复用进程级连接池）；注入时生命周期归调用方管理
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(base_url, timeout=timeout)
        self._client = client if client is not None else httpx.Client(timeout=timeout)
        self._owns_client = client is None

    # -- 生命周期 ----------------------------------------------------

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "MemoryServerClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- 内部统一请求入口 ----------------------------------------------

    def _write_pipeline(
        self,
        endpoint: str,
        lanlan_name: str,
        messages: list[dict[str, Any]] | None,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        contract = CONTRACTS[endpoint]
        request_id_holder: dict[str, str] = {}
        response = self._request_with_rid(
            contract,
            lanlan_name,
            json_body=self.build_history_payload(
                messages, language=language, render_language=render_language
            ),
            # 未显式传 timeout 时按契约建议表取（cache=5s，process/renew/
            # settle=30s——LLM 摘要端点），显式传参仍可覆盖
            timeout=timeout if timeout is not None else SUGGESTED_TIMEOUTS.get(
                endpoint, self.default_timeout
            ),
            rid_out=request_id_holder,
        )
        return self._check_write_response(
            response,
            request_id=request_id_holder["rid"],
            contract=contract,
            lanlan_name=lanlan_name,
        )

    def _request_with_rid(
        self,
        contract: EndpointContract,
        lanlan_name: str | None = None,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        timeout: float | None = None,
        rid_out: dict[str, str],
    ) -> httpx.Response:
        """发请求并把生成的 request_id 写回 rid_out（供后续 body 校验异常
        携带同一 id）。"""
        request_id = self._new_request_id()
        rid_out["rid"] = request_id
        url = self._url(contract, lanlan_name)
        started = time.monotonic()
        try:
            response = self._client.request(
                contract.method,
                url,
                json=json_body,
                params=params,
                headers=self._headers(request_id),
                timeout=timeout if timeout is not None else self.default_timeout,
            )
        except httpx.HTTPError as exc:
            wrapped = self._wrap_transport_error(
                exc, request_id=request_id, contract=contract, lanlan_name=lanlan_name
            )
            self._log_call(
                request_id=request_id,
                contract=contract,
                lanlan_name=lanlan_name,
                outcome=wrapped.__class__.__name__,
                elapsed_s=time.monotonic() - started,
            )
            raise wrapped from exc
        self._log_call(
            request_id=request_id,
            contract=contract,
            lanlan_name=lanlan_name,
            outcome=f"HTTP {response.status_code}",
            elapsed_s=time.monotonic() - started,
        )
        return response

    # -- 写入管线（settle 管线）四端点 --------------------------------

    def cache(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /cache/{name}——每轮 turn 结束的轻量持久化（无前台 LLM）。

        :returns: 服务端 body，成功形如 ``{"status": "cached", "count": N}``
        """
        return self._write_pipeline(
            "cache", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    def process(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /process/{name}——会话结束【有增量】时的 LLM 摘要压缩结算。

        :returns: 服务端 body，成功形如 ``{"status": "processed"}``
        """
        return self._write_pipeline(
            "process", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    def renew(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /renew/{name}——会话重开（热重置）【有增量】时；持 settle_lock
        （阻塞 /new_dialog 直到摘要落盘）。

        :returns: 服务端 body，成功形如 ``{"status": "processed"}``
        """
        return self._write_pipeline(
            "renew", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    def settle(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]] | None = None,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /settle/{name}——热重置/会话结束【增量=0】时；wechat 会话
        清理前同款。``messages`` 省略或空列表即空增量（input_history="[]"）。

        :returns: 服务端 body，成功形如 ``{"status": "settled"}``
        """
        return self._write_pipeline(
            "settle", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    # -- 读取端点 ------------------------------------------------------

    def new_dialog(
        self,
        lanlan_name: str,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> str:
        """GET /new_dialog/{name}——persona 记忆层纯文本（会话开台时拼进
        system prompt）。

        可选查询参数 ``language`` / ``render_language``（服务端
        routes.py:3615-3620：language 优先、无效则回退 render_language）；
        两者都省略时服务端恢复该角色持久的 locale。对齐
        memory_bridge.fetch_bootstrap_memory 的现签名用法。

        注意非纯读（写 prompt-locale、持 settle_lock）。响应为
        PlainTextResponse，直接返回 strip 后的文本（无 body status 检查）。
        """
        contract = CONTRACTS["new_dialog"]
        params = {
            key: value
            for key, value in (
                ("language", language),
                ("render_language", render_language),
            )
            if value
        }
        rid_out: dict[str, str] = {}
        response = self._request_with_rid(
            contract, lanlan_name, params=params or None,
            timeout=timeout, rid_out=rid_out,
        )
        self._check_http_status(
            response,
            request_id=rid_out["rid"],
            contract=contract,
            lanlan_name=lanlan_name,
        )
        return response.text.strip()

    def query_memory(
        self,
        lanlan_name: str,
        *,
        query: str | None = None,
        time: str | None = None,
        subjects: list[dict[str, Any]] | None = None,
        language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /query_memory/{name}——混合检索（BM25+向量+RRF）。

        ``query``/``time`` 至少给一个；``subjects`` 显式空列表=服务端 422
        拒绝（fail-closed：无授权主体不允许回退 legacy 语料，客户端将其
        映射为 MemServerError(status_code=422)），省略(None)=legacy 私话
        语料，1..8 条。``language`` 透传给服务端渲染 tier/entity 标签
        （对齐 memory_bridge.query_relevant_memory）。

        :returns: ``{"results": [...], "query": str, "candidates_total": int,
            "elapsed_ms": float}``
        """
        body: dict[str, Any] = {"query": query or ""}
        if time:
            body["time"] = time
        if subjects is not None:
            body["subjects"] = subjects
        if language:
            body["language"] = language
        rid_out: dict[str, str] = {}
        response = self._request_with_rid(
            CONTRACTS["query_memory"], lanlan_name, json_body=body,
            timeout=timeout, rid_out=rid_out,
        )
        return self._check_query_response(
            response, request_id=rid_out["rid"], lanlan_name=lanlan_name
        )

    def health(self, *, timeout: float | None = None) -> dict[str, Any]:
        """GET /health——探活（JSON 带 INSTANCE_ID 指纹）。"""
        contract = CONTRACTS["health"]
        rid_out: dict[str, str] = {}
        response = self._request_with_rid(contract, None, timeout=timeout, rid_out=rid_out)
        self._check_http_status(
            response, request_id=rid_out["rid"], contract=contract, lanlan_name=None
        )
        return self._decode_json_body(
            response, request_id=rid_out["rid"], contract=contract, lanlan_name=None
        )


# ── 异步客户端 ────────────────────────────────────────────────────


class AsyncMemoryServerClient(_MemoryServerClientBase):
    """异步客户端（httpx.AsyncClient），API 与同步版一一对应。

    注入 ``client`` 复用进程级 AsyncClient 时（对齐 memory_bridge 用
    get_internal_http_client 的模式），生命周期归调用方管理。
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url, timeout=timeout)
        self._client = client if client is not None else httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "AsyncMemoryServerClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def _request_with_rid(
        self,
        contract: EndpointContract,
        lanlan_name: str | None = None,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        timeout: float | None = None,
        rid_out: dict[str, str],
    ) -> httpx.Response:
        request_id = self._new_request_id()
        rid_out["rid"] = request_id
        url = self._url(contract, lanlan_name)
        started = time.monotonic()
        try:
            response = await self._client.request(
                contract.method,
                url,
                json=json_body,
                params=params,
                headers=self._headers(request_id),
                timeout=timeout if timeout is not None else self.default_timeout,
            )
        except httpx.HTTPError as exc:
            wrapped = self._wrap_transport_error(
                exc, request_id=request_id, contract=contract, lanlan_name=lanlan_name
            )
            self._log_call(
                request_id=request_id,
                contract=contract,
                lanlan_name=lanlan_name,
                outcome=wrapped.__class__.__name__,
                elapsed_s=time.monotonic() - started,
            )
            raise wrapped from exc
        self._log_call(
            request_id=request_id,
            contract=contract,
            lanlan_name=lanlan_name,
            outcome=f"HTTP {response.status_code}",
            elapsed_s=time.monotonic() - started,
        )
        return response

    async def _write_pipeline(
        self,
        endpoint: str,
        lanlan_name: str,
        messages: list[dict[str, Any]] | None,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        contract = CONTRACTS[endpoint]
        rid_out: dict[str, str] = {}
        response = await self._request_with_rid(
            contract,
            lanlan_name,
            json_body=self.build_history_payload(
                messages, language=language, render_language=render_language
            ),
            # 未显式传 timeout 时按契约建议表取（cache=5s，process/renew/
            # settle=30s——LLM 摘要端点），显式传参仍可覆盖
            timeout=timeout if timeout is not None else SUGGESTED_TIMEOUTS.get(
                endpoint, self.default_timeout
            ),
            rid_out=rid_out,
        )
        return self._check_write_response(
            response,
            request_id=rid_out["rid"],
            contract=contract,
            lanlan_name=lanlan_name,
        )

    async def cache(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /cache/{name}（语义见同步版 docstring 与 contract.SETTLE_RHYTHM）。"""
        return await self._write_pipeline(
            "cache", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    async def process(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /process/{name}——会话结束【有增量】时。"""
        return await self._write_pipeline(
            "process", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    async def renew(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]],
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /renew/{name}——热重置【有增量】时（持 settle_lock）。"""
        return await self._write_pipeline(
            "renew", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    async def settle(
        self,
        lanlan_name: str,
        messages: list[dict[str, Any]] | None = None,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /settle/{name}——热重置/会话结束【增量=0】时。"""
        return await self._write_pipeline(
            "settle", lanlan_name, messages,
            language=language, render_language=render_language, timeout=timeout,
        )

    async def new_dialog(
        self,
        lanlan_name: str,
        *,
        language: str | None = None,
        render_language: str | None = None,
        timeout: float | None = None,
    ) -> str:
        """GET /new_dialog/{name}——persona 记忆层纯文本。

        可选查询参数 ``language`` / ``render_language``（服务端 language
        优先、无效则回退 render_language）；都省略时服务端恢复角色持久
        locale。语义详见同步版 docstring。
        """
        contract = CONTRACTS["new_dialog"]
        params = {
            key: value
            for key, value in (
                ("language", language),
                ("render_language", render_language),
            )
            if value
        }
        rid_out: dict[str, str] = {}
        response = await self._request_with_rid(
            contract, lanlan_name, params=params or None,
            timeout=timeout, rid_out=rid_out,
        )
        self._check_http_status(
            response, request_id=rid_out["rid"], contract=contract, lanlan_name=lanlan_name
        )
        return response.text.strip()

    async def query_memory(
        self,
        lanlan_name: str,
        *,
        query: str | None = None,
        time: str | None = None,
        subjects: list[dict[str, Any]] | None = None,
        language: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST /query_memory/{name}——混合检索（subjects 语义与超时默认
        详见同步版 docstring 与 contract 表）。"""
        body: dict[str, Any] = {"query": query or ""}
        if time:
            body["time"] = time
        if subjects is not None:
            body["subjects"] = subjects
        if language:
            body["language"] = language
        rid_out: dict[str, str] = {}
        response = await self._request_with_rid(
            CONTRACTS["query_memory"], lanlan_name, json_body=body,
            timeout=timeout, rid_out=rid_out,
        )
        return self._check_query_response(
            response, request_id=rid_out["rid"], lanlan_name=lanlan_name
        )

    async def health(self, *, timeout: float | None = None) -> dict[str, Any]:
        """GET /health——探活。"""
        contract = CONTRACTS["health"]
        rid_out: dict[str, str] = {}
        response = await self._request_with_rid(contract, None, timeout=timeout, rid_out=rid_out)
        self._check_http_status(
            response, request_id=rid_out["rid"], contract=contract, lanlan_name=None
        )
        return self._decode_json_body(
            response, request_id=rid_out["rid"], contract=contract, lanlan_name=None
        )
