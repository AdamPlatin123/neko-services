"""`src.chat.message_receive.chat_manager` 桩。

sdk_memory_kernel 仅 import（noqa）；search_hit_processing_service 用
get_existing_session_by_session_id 把 stream_token 解析成聊天流上下文（group_id/user_id）。
桩策略（audit 第 4 节）：返回 None → 检索源上下文降级为空，行为兼容。
"""

from __future__ import annotations

from typing import Any, Optional


class _ChatManagerStub:
    """宿主 chat_manager 单例替身。"""

    def get_existing_session_by_session_id(self, session_id: Optional[str]) -> Any:
        """恒返回 None：调用侧已按 session 为 None 做降级（group_id/user_id 置空）。"""

        _ = session_id
        return None


chat_manager = _ChatManagerStub()
