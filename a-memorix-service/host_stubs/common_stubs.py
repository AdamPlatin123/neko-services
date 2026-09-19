"""`src.common.*` 桩：logger / prompt_i18n / utils_config / database / data_models。

- logger：get_logger 返回标准 logging.Logger（名字透传），替代上游 structlog BoundLogger。
- prompt_i18n：load_prompt 读本地 prompt 文件（config/prompts/{name}[_{locale}].txt）。
- utils_config：AMemorixConfigUtils.get_shared_memory_session_ids → 入参单元素集合
  （共享记忆组逻辑 P0-1b 由 N.E.K.O 调方算好 shared_chat_ids 传入，见 audit 第 4 节）。
- database：进程内不用 DB——get_db_session 调用即抛错（调用侧有 try/except 降级），
  PersonInfo 为简单 dataclass（person_profile_service 的字段消费面）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Set

from ._config_loader import SERVICE_ROOT

PROMPTS_ROOT = SERVICE_ROOT / "config" / "prompts"

_LOGGER_CACHE: Dict[Optional[str], logging.Logger] = {}


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """标准 logging.Logger 适配（上游返回 structlog BoundLogger；名字透传）。"""

    logger = _LOGGER_CACHE.get(name)
    if logger is None:
        logger = logging.getLogger(name or "a_memorix_service")
        if not logger.handlers and name != "maim_message":
            _handler = logging.StreamHandler()
            _handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s"))
            logger.addHandler(_handler)
        logger.propagate = False
        _LOGGER_CACHE[name] = logger
    return logger


def load_prompt(
    name: str,
    locale: Optional[str] = None,
    category: Optional[str] = None,
    prompts_root: Optional[Path] = None,
    custom_prompts_root: Optional[Path] = None,
    **kwargs: Any,
) -> str:
    """读本地 prompt 文件并做 str.format(**kwargs) 渲染。

    查找顺序：{root}/{name}.{locale}.txt → {root}/{name}.txt；
    root 依次为 prompts_root、custom_prompts_root、config/prompts/。
    """

    _ = category
    roots = [root for root in (prompts_root, custom_prompts_root, PROMPTS_ROOT) if root is not None]
    normalized = str(name or "").strip()
    if not normalized:
        raise ValueError("prompt 名称不能为空")
    candidates = []
    if locale:
        candidates.append(f"{normalized}.{locale}.txt")
    candidates.append(f"{normalized}.txt")
    for root in roots:
        for candidate in candidates:
            path = Path(root) / candidate
            if path.is_file():
                template = path.read_text(encoding="utf-8")
                return template.format(**kwargs) if kwargs else template
    raise FileNotFoundError(
        f"host_stubs: 未找到 prompt 文件 '{normalized}'（查找根：{[str(r) for r in roots]}）"
    )


class AMemorixConfigUtils:
    """共享记忆组工具替身：P0-1 阶段视为「不与其他流共享」。"""

    @staticmethod
    def get_shared_memory_session_ids(session_id: Optional[str]) -> Set[str]:
        clean = str(session_id or "").strip()
        if not clean:
            return set()
        return {clean}


class _DatabaseUnavailableError(RuntimeError):
    """进程内不使用宿主数据库；person 解析按调用侧降级路径处理。"""


def get_db_session(*args: Any, **kwargs: Any) -> Any:
    _ = (args, kwargs)
    raise _DatabaseUnavailableError(
        "host_stubs: 进程内服务不使用 MaiBot 数据库（person_id 回查 P0-1b 换服务内建 person_alias 或 HTTP 回查）"
    )


@dataclass
class PersonInfo:
    """宿主 PersonInfo 表的 dataclass 替身（person_profile_service 消费的字段面）。"""

    person_id: str = ""
    person_name: str = ""
    user_nickname: str = ""
    group_cardname: str = ""
    platform_id: str = ""
