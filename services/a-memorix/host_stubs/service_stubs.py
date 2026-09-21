"""`src.services.llm_service` / `src.common.data_models.llm_service_data_models`
/ `src.services.message_service` 的桩。

结构字段与上游 MaiBot 对齐（src/common/data_models/llm_service_data_models.py、
src/services/llm_service.py、src/services/message_service.py）。

P0-1b 起 LLM 可调用面接真实出口（adapters.openai_compat，OpenAI 兼容 chat）：
model_routing 是全包 LLM 调用唯一出口，其依赖面 generate /
LLMServiceClient.generate_response / get_available_models 三者分别落到
adapters.generate / adapters.generate_response / config_stubs.build_task_config_map。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# src.common.data_models.llm_service_data_models
# ---------------------------------------------------------------------------


@dataclass
class LLMResponseResult:
    """单次 LLM 响应结果（上游为 output_items 元组派生，此处简化为直存正文）。"""

    response: str = ""
    reasoning: str = ""
    model_name: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    prompt_cache_hit_tokens: int = 0
    prompt_cache_miss_tokens: int = 0
    tool_calls: Optional[List[Any]] = None
    provider_response: Optional[Dict[str, Any]] = None

    @classmethod
    def from_portable_output(cls, *, response: str = "", **extra: Any) -> "LLMResponseResult":
        return cls(response=response, **extra)


@dataclass
class LLMServiceRequest:
    """LLM 服务层统一请求对象（字段集与上游一致）。"""

    task_name: str
    request_type: str
    session_id: str = ""
    prompt: Any = None
    context_factory: Any = None
    model_name: Optional[str] = None
    tool_options: Optional[List[Any]] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    response_format: Any = None
    interrupt_flag: Optional[asyncio.Event] = None

    def __post_init__(self) -> None:
        self.task_name = self.task_name.strip()
        self.session_id = str(self.session_id or "").strip()
        if not self.task_name:
            raise ValueError("`task_name` 不能为空")
        has_prompt = self.prompt is not None
        has_context_factory = self.context_factory is not None
        if has_prompt == has_context_factory:
            raise ValueError("`prompt` 与 `context_factory` 必须且只能提供一个")


@dataclass
class LLMGenerationOptions:
    """LLM 文本生成选项。"""

    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    model_name: Optional[str] = None
    tool_options: Optional[List[Any]] = None
    response_format: Any = None
    interrupt_flag: Optional[asyncio.Event] = None
    raise_when_empty: bool = True


@dataclass
class LLMServiceResult:
    """LLM 服务层统一响应对象。"""

    success: bool = False
    completion: LLMResponseResult = field(default_factory=LLMResponseResult)
    error: Optional[str] = None

    @classmethod
    def from_response_result(cls, completion: LLMResponseResult) -> "LLMServiceResult":
        return cls(success=True, completion=completion, error=None)

    @classmethod
    def from_error(cls, error_message: str, error_detail: Optional[str] = None) -> "LLMServiceResult":
        return cls(
            success=False,
            completion=LLMResponseResult.from_portable_output(response=error_message),
            error=error_detail or error_message,
        )

    def to_capability_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "success": self.success,
            "response": self.completion.response,
            "reasoning": self.completion.reasoning,
            "model_name": self.completion.model_name,
            "prompt_tokens": self.completion.prompt_tokens,
            "completion_tokens": self.completion.completion_tokens,
            "total_tokens": self.completion.total_tokens,
            "prompt_cache_hit_tokens": self.completion.prompt_cache_hit_tokens,
            "prompt_cache_miss_tokens": self.completion.prompt_cache_miss_tokens,
        }
        if self.completion.tool_calls is not None:
            payload["tool_calls"] = self.completion.tool_calls
        if self.error:
            payload["error"] = self.error
        return payload


# ---------------------------------------------------------------------------
# src.services.llm_service
# ---------------------------------------------------------------------------


class _StubOrchestrator:
    """model_routing.generate_with_resolved_model 依赖的编排器内部属性面。"""

    def __init__(self, task_name: str = "", request_type: str = "", session_id: str = "") -> None:
        self.task_name = task_name
        self.request_type = request_type
        self.session_id = session_id
        self.model_for_task: Any = None
        self.model_usage: Dict[str, tuple] = {}

    def _refresh_task_config(self) -> Any:
        return self.model_for_task


class LLMServiceClient:
    """面向上层模块的 LLM 服务门面：真实出口 adapters.openai_compat（P0-1b）。

    model_routing.generate_with_resolved_model 的单模型路径会设置
    ``client._orchestrator.model_for_task``（单模型 TaskConfig）——
    _StubOrchestrator 保留该属性面，generate_response 将其作为
    task_config_override 传入 adapters。
    """

    def __init__(self, task_name: str, request_type: str = "", session_id: str = "") -> None:
        self.task_name = str(task_name).strip()
        self.request_type = request_type
        self.session_id = str(session_id or "").strip()
        self._orchestrator = _StubOrchestrator(self.task_name, request_type, self.session_id)

    async def generate_response(
        self,
        prompt: Any,
        options: Optional[LLMGenerationOptions] = None,
        **kwargs: Any,
    ) -> LLMResponseResult:
        from adapters.openai_compat import generate_response as _real_generate_response

        _ = kwargs
        return await _real_generate_response(
            task_name=self.task_name,
            prompt=prompt,
            options=options,
            single_model_task=self._orchestrator.model_for_task,
        )

    async def generate_response_with_context(
        self,
        context_factory: Any,
        options: Optional[LLMGenerationOptions] = None,
        **kwargs: Any,
    ) -> LLMResponseResult:
        prompt = context_factory() if callable(context_factory) else context_factory
        return await self.generate_response(prompt, options, **kwargs)


def get_available_models() -> Dict[str, Any]:
    """返回任务名 → TaskConfig 映射（读服务自有 toml 的 [model.tasks.*]）。"""

    from .config_stubs import build_task_config_map

    return build_task_config_map()


async def generate(request: LLMServiceRequest) -> LLMServiceResult:
    """src.services.llm_service.generate 真身（adapters.openai_compat.generate）。"""

    from adapters.openai_compat import generate as _real_generate

    return await _real_generate(request)


def resolve_task_name(task_name: str = "") -> str:
    models = get_available_models()
    normalized = str(task_name or "").strip()
    if normalized and normalized in models:
        return normalized
    if models:
        return next(iter(models))
    raise RuntimeError("没有可用的模型任务配置")


# ---------------------------------------------------------------------------
# src.services.message_service
# ---------------------------------------------------------------------------


def get_messages_by_time_in_chat(
    chat_id: str,
    start_time: float,
    end_time: float,
    limit: int = 0,
    limit_mode: str = "latest",
    filter_mai: bool = False,
    filter_command: bool = False,
    filter_intercept_message_level: Optional[int] = None,
) -> List[Any]:
    """桩：返回空列表（检索主路径不需要宿主聊天历史；P0-1b 对接 N.E.K.O 会话历史）。"""

    _ = (chat_id, start_time, end_time, limit, limit_mode, filter_mai, filter_command, filter_intercept_message_level)
    return []


def build_readable_messages(
    messages: List[Any],
    replace_bot_name: bool = True,
    timestamp_mode: str = "relative",
    read_mark: float = 0.0,
    truncate: bool = False,
    show_actions: bool = False,
) -> str:
    """桩：空消息 → 空文本。"""

    _ = (replace_bot_name, timestamp_mode, read_mark, truncate, show_actions)
    if not messages:
        return ""
    raise NotImplementedError("host_stubs: build_readable_messages 仅支持空消息列表（P0-1b 对接会话历史）")
