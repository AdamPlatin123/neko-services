"""服务自有配置装载：读取本服务（services/a-memorix）config/a_memorix.toml。

替代 MaiBot 宿主的 bot_config.toml / model_config（audit 第 4 节：
`src.config.config` → 服务自有 toml 配置）。
"""

from __future__ import annotations

import threading
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

SERVICE_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = SERVICE_ROOT / "config" / "a_memorix.toml"


@dataclass
class BotInfo:
    """global_config.bot 的最小替身（summary_importer 读 nickname/personality）。"""

    nickname: str = "N.E.K.O"
    personality: str = ""


class ConfigState:
    """a_memorix.toml 的懒加载快照；reload() 重新读盘。"""

    def __init__(self, config_path: Path = CONFIG_PATH) -> None:
        self.config_path = Path(config_path)
        self._lock = threading.Lock()
        self._loaded = False
        self._raw: Dict[str, Any] = {}

    def reload(self) -> None:
        with self._lock:
            if self.config_path.exists():
                with self.config_path.open("rb") as handle:
                    self._raw = tomllib.load(handle)
            else:
                self._raw = {}
            self._loaded = True

    @property
    def raw(self) -> Dict[str, Any]:
        if not self._loaded:
            self.reload()
        return self._raw

    @property
    def a_memorix_section(self) -> Dict[str, Any]:
        section = self.raw.get("a_memorix", {})
        return dict(section) if isinstance(section, dict) else {}

    @property
    def model_section(self) -> Dict[str, Any]:
        section = self.raw.get("model", {})
        return dict(section) if isinstance(section, dict) else {}

    @property
    def bot(self) -> BotInfo:
        section = self.raw.get("bot", {})
        if not isinstance(section, dict):
            return BotInfo()
        return BotInfo(
            nickname=str(section.get("nickname") or "N.E.K.O"),
            personality=str(section.get("personality") or ""),
        )


_state: ConfigState | None = None


def get_config_state() -> ConfigState:
    global _state
    if _state is None:
        _state = ConfigState()
    return _state


def reset_config_state() -> None:
    """测试辅助：丢弃单例，下次访问重新读盘。"""

    global _state
    _state = None
