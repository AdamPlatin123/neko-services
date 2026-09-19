"""入口：``uv run python -m a_memorix_service.service``（systemd ExecStart 同款）。

默认绑定 127.0.0.1:48921（与 scripts/lib.sh 的 NEKO_AMEMORIX_URL、
systemd/neko-a-memorix.service 注释一致）；可用 NEKO_AMEMORIX_HOST /
NEKO_AMEMORIX_PORT 覆盖。仅回环监听是部署基线（design S3 安全审查项）。
"""

from __future__ import annotations

import os

import uvicorn

from a_memorix_service.service.app import DEFAULT_HOST, DEFAULT_PORT, app


def main() -> None:
    host = os.getenv("NEKO_AMEMORIX_HOST", DEFAULT_HOST)
    port = int(os.getenv("NEKO_AMEMORIX_PORT", str(DEFAULT_PORT)))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
