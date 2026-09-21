"""a-memorix FastAPI 服务壳（P0-1b workplan #4）。

HTTP 契约照抄 A_memorix host_service.invoke 组件表（docs/design/
module-interface-audit.md 模块一 §1）：请求体 = invoke 的 payload dict，
响应体 = invoke 返回形状（MemoryHit.to_dict 键的 hits / _disabled_response
空形状 / 启动队列 queued 语义）。

运行时复用决策（WAL/状态机不重写）：vendored ``AMemorixHostService`` 自带
invoke 组件表全部分发逻辑 + starting→migrating→ready/failed 状态机 +
startup_write_queue.jsonl/.done/.failed WAL 与回放——服务壳只做三件事：
1. lifespan 里 start()/stop() 托管其生命周期；
2. 端点→component 的映射与 JSON 序列化；
3. host 语义 → HTTP 语义的翻译（initializing/queued→202，failed→503，
   disabled→200 空形状，超时→504）。

/health 指纹对齐 N.E.K.O 模式（utils/port_utils.build_health_response 的键集：
app/service/status/instance_id），但 app 签名用自有值 ``neko-services``
（不冒充 N.E.K.O 本体签名，避免 launcher 三口探测误 attach）。
instance_id 读 NEKO_INSTANCE_ID（与 neko 三 unit 同源），未设则进程内随机
——与 config/network.py:212 的上游行为一致。
"""

from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# 宿主桩必须先于一切 A_memorix 导入安装（conftest.py 在测试侧做同一件事）
# ---------------------------------------------------------------------------
_SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

import host_stubs  # noqa: E402

host_stubs.install()

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from A_memorix.core.runtime.admin_contracts import is_admin_component  # noqa: E402
from A_memorix.host_service import AMemorixHostService, a_memorix_host_service  # noqa: E402

logger = logging.getLogger("a_memorix_service.service")

SERVICE_NAME = "a-memorix"
SERVICE_APP_SIGNATURE = "neko-services"
VERSION = "0.1.0"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 48921  # 与 scripts/lib.sh 的 NEKO_AMEMORIX_URL 默认一致

INSTANCE_ID = os.getenv("NEKO_INSTANCE_ID", "") or uuid.uuid4().hex

_REASON_INITIALIZING = "a_memorix_initializing"
_REASON_INIT_FAILED = "a_memorix_initialization_failed"


def _http_status_for_result(result: Any) -> int:
    """host_service 降级语义 → HTTP 状态码（其余一律 200 携形状返回）。"""

    if not isinstance(result, dict):
        return 200
    if result.get("queued") is True:
        return 202
    reason = str(result.get("reason", "") or "")
    if reason == _REASON_INITIALIZING:
        return 202
    if reason == _REASON_INIT_FAILED:
        return 503
    return 200


async def _invoke_and_respond(
    service: AMemorixHostService,
    component: str,
    payload: Dict[str, Any],
    timeout_ms: Optional[int],
) -> JSONResponse:
    try:
        result = await service.invoke(component, payload, timeout_ms=timeout_ms)
    except TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"success": False, "error": f"A_Memorix 调用超时: component={component}, timeout_ms={timeout_ms}"},
        )
    except Exception as exc:  # noqa: BLE001（端点不因内核异常 5xx 裸崩，带形状返回）
        logger.exception(f"invoke 分发异常: component={component}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(exc)})
    return JSONResponse(status_code=_http_status_for_result(result), content=result)


async def _read_payload_dict(request: Request) -> Optional[Dict[str, Any]]:
    """请求体 = invoke 的 payload dict；空 body / 非 object → 400（None 表示非法）。"""

    body = await request.body()
    if not body:
        return {}
    try:
        payload = json.loads(body)
    except Exception:
        return None
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        return None
    return payload


def _warn_model_config() -> Dict[str, Any]:
    """未配置 LLM/embedding key 时启动 WARN（不阻断启动，相关组件运行期降级）。"""

    try:
        from adapters.openai_compat import model_config_status

        status = model_config_status()
    except Exception as exc:  # noqa: BLE001（自检自身失败不阻断服务）
        logger.warning(f"模型配置自检失败: {exc}")
        return {"chat_ready": False, "embedding_ready": False, "warnings": [str(exc)]}
    for warning in status.get("warnings", []):
        logger.warning(f"[model-config] {warning}")
    return status


def create_app(*, host_service: Optional[AMemorixHostService] = None) -> FastAPI:
    """构造 FastAPI 应用；host_service 可注入（测试用独立实例），默认用模块单例。"""

    service = host_service if host_service is not None else a_memorix_host_service

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        model_status = _warn_model_config()
        app.state.model_config_status = model_status
        if service.is_enabled():
            await service.start()
        else:
            logger.info("A_Memorix 配置为未启用（[a_memorix.plugin] enabled=false），端点返回 disabled 空形状")
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(
        title="a-memorix-service",
        version=VERSION,
        description="A_memorix 独立记忆检索服务（HTTP 契约照抄 host_service.invoke 组件表）",
        lifespan=lifespan,
    )
    app.state.host_service = service

    @app.get("/health")
    async def health() -> Dict[str, Any]:
        # 进程存活即 ok；内核启动进度放 startup_state / runtime_ready 附加字段
        status = service._startup_status_payload()  # noqa: SLF001（同仓 vendored 类，稳定私有面）
        model_status: Dict[str, Any] = getattr(app.state, "model_config_status", {})
        return {
            "app": SERVICE_APP_SIGNATURE,
            "service": SERVICE_NAME,
            "status": "ok",
            "instance_id": INSTANCE_ID,
            "version": VERSION,
            "startup_state": status.get("startup_state", "stopped"),
            "runtime_ready": bool(status.get("runtime_ready", False)),
            "startup_queue_pending": int(status.get("startup_queue_pending", 0) or 0),
            "model_config": {
                "chat_ready": bool(model_status.get("chat_ready", False)),
                "embedding_ready": bool(model_status.get("embedding_ready", False)),
            },
        }

    @app.post("/a_memorix/v1/search")
    async def search(request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, "search_memory", payload, timeout_ms)

    @app.post("/a_memorix/v1/ingest_summary")
    async def ingest_summary(request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, "ingest_summary", payload, timeout_ms)

    @app.post("/a_memorix/v1/ingest_text")
    async def ingest_text(request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, "ingest_text", payload, timeout_ms)

    @app.post("/a_memorix/v1/person_profile")
    async def person_profile(request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, "get_person_profile", payload, timeout_ms)

    @app.get("/a_memorix/v1/stats")
    async def stats(timeout_ms: Optional[int] = None) -> JSONResponse:
        return await _invoke_and_respond(service, "memory_stats", {}, timeout_ms)

    @app.post("/a_memorix/v1/maintain")
    async def maintain(request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, "maintain_memory", payload, timeout_ms)

    @app.post("/a_memorix/v1/admin/{component}")
    async def admin(component: str, request: Request, timeout_ms: Optional[int] = None) -> JSONResponse:
        if not is_admin_component(component):
            return JSONResponse(status_code=404, content={"success": False, "error": f"不支持的 admin component: {component}"})
        payload = await _read_payload_dict(request)
        if payload is None:
            return JSONResponse(status_code=400, content={"success": False, "error": "请求体必须是 JSON 对象"})
        return await _invoke_and_respond(service, component, payload, timeout_ms)

    return app


app = create_app()
