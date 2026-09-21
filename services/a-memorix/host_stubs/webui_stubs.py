"""`src.webui.utils.toml_utils` 桩：_update_toml_doc 递归合并（WebUI 配置桥专用）。

语义按上游实现：source 非 dict 或 target 非 dict 时不动；键 'version' 跳过；
嵌套 dict 递归合并，其余直接赋值（保留 tomlkit 容器格式的方式与上游一致）。
"""

from __future__ import annotations

from typing import Any


def _update_toml_doc(target: Any, source: Any) -> None:
    """递归合并字典，将 source 的值更新到 target 中，保留 target 的注释和格式。"""

    if isinstance(source, list) or not isinstance(source, dict) or not isinstance(target, dict):
        return

    for key, value in source.items():
        if key == "version":
            continue
        if key in target:
            existing = target[key]
            if isinstance(existing, dict) and isinstance(value, dict):
                _update_toml_doc(existing, value)
                continue
        target[key] = value
