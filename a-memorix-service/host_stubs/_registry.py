"""sys.modules 预注册工具：构造桩模块并注册到 import 系统。

上游 A_memorix 树（../A_memorix/）零修改，全部宿主依赖
（MaiBot 的 src.* 与 maibot_sdk）通过本包在 import A_memorix 之前
注入到 sys.modules 完成（依据 docs/design/module-interface-audit.md 第 4 节）。
"""

from __future__ import annotations

import sys
import types
from typing import Any


def ensure_package(name: str) -> types.ModuleType:
    """确保给定包名存在于 sys.modules（递归创建空包，已存在则原样返回）。"""

    existing = sys.modules.get(name)
    if existing is not None and hasattr(existing, "__path__"):
        return existing
    module = types.ModuleType(name)
    module.__package__ = name
    module.__path__ = []  # type: ignore[attr-defined]
    sys.modules[name] = module
    parent_name = name.rpartition(".")[0]
    if parent_name:
        parent = ensure_package(parent_name)
        setattr(parent, name.rpartition(".")[2], module)
    return module


def register(name: str, **attrs: Any) -> types.ModuleType:
    """创建一个带属性的模块并注册进 sys.modules（父包递归补齐；幂等可覆盖）。"""

    module = types.ModuleType(name)
    module.__package__ = name.rpartition(".")[0] or name
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    parent_name = name.rpartition(".")[0]
    if parent_name:
        parent = sys.modules.get(parent_name)
        if parent is None or not hasattr(parent, "__path__"):
            parent = ensure_package(parent_name)
        setattr(parent, name.rpartition(".")[2], module)
    return module
