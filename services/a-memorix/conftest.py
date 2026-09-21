"""pytest 根 conftest：服务根目录入 sys.path，import A_memorix 前装好宿主桩。"""

from __future__ import annotations

import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

import host_stubs  # noqa: E402

host_stubs.install()
