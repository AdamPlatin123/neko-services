"""`maibot_sdk` 桩：plugin.py（legacy 入口，工具声明权威清单）的 import 面。

主线不走插件加载（plugin.py 文档字符串自述），独立服务不迁其运行时；
此处仅保证 import 成功 + Tool 装饰器把元数据挂在函数上（不改变函数行为）。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any, Callable, List, Optional


class ToolParamType(str, enum.Enum):
    """工具参数类型枚举（覆盖 plugin.py 用到的 STRING/FLOAT/BOOLEAN + 常见项）。"""

    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    BOOLEAN = "boolean"
    LIST = "list"


@dataclass
class ToolParameterInfo:
    """工具参数声明。"""

    name: str
    param_type: ToolParamType
    description: str = ""
    required: bool = False


def Tool(  # noqa: N802（与上游装饰器名一致）
    name: str,
    description: str = "",
    parameters: Optional[List[ToolParameterInfo]] = None,
    **kwargs: Any,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """装饰器替身：原样返回函数，附挂 tool 元数据。"""

    _ = kwargs

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        func.tool_name = name  # type: ignore[attr-defined]
        func.tool_description = description  # type: ignore[attr-defined]
        func.tool_parameters = list(parameters or [])  # type: ignore[attr-defined]
        return func

    return decorator


class MaiBotPlugin:
    """插件基类替身：仅提供 super().__init__() 与配置槽。"""

    def __init__(self) -> None:
        self.plugin_config: dict = {}
        self.plugin_root: str = ""

    def set_plugin_config(self, config: dict) -> None:
        self.plugin_config = dict(config or {})
