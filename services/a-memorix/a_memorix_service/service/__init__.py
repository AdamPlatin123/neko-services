"""FastAPI 服务壳（P0-1b #4）。

用法：
    uv run python -m a_memorix_service.service        # 默认 127.0.0.1:48921
    NEKO_AMEMORIX_PORT=48930 uv run python -m a_memorix_service.service

或编程接入：``from a_memorix_service.service import create_app``。
"""

from a_memorix_service.service.app import SERVICE_APP_SIGNATURE, SERVICE_NAME, VERSION, app, create_app

__all__ = ["SERVICE_APP_SIGNATURE", "SERVICE_NAME", "VERSION", "app", "create_app"]
