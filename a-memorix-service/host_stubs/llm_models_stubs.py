"""`src.llm_models.*` 桩：exceptions 异常层次 + model_client.base_client。

- exceptions：类的层次关系与真包（MaiBot src/llm_models/exceptions.py）逐类对齐，
  保证上游 `except XxxError` 子句兼容。
- base_client：EmbeddingRequest dataclass 字段齐全；client_registry.get_client_class_instance
  调用即 NotImplementedError（P0-1b 整个 EmbeddingAPIAdapter 重写为直连 OpenAI 兼容 API，
  见 audit 第 4 节）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

# ---------------------------------------------------------------------------
# src.llm_models.exceptions（层次与上游一致）
# ---------------------------------------------------------------------------

error_code_mapping = {
    400: "参数不正确",
    401: "API-Key错误，认证失败，请检查配置是否正确",
    402: "账号余额不足",
    403: "模型拒绝访问，可能需要实名或余额不足",
    404: "Not Found",
    413: "请求体过大，请尝试压缩图片或减少输入内容",
    429: "请求过于频繁，请稍后再试",
    500: "服务器内部故障",
    503: "服务器负载过高",
}


class NetworkConnectionError(Exception):
    """连接异常，常见于网络问题或服务器不可用"""

    def __init__(self, message: str | None = None):
        super().__init__(message)
        self.message = message

    def __str__(self):
        return self.message or "连接异常，请检查网络连接状态或URL是否正确"


class ReqAbortException(Exception):
    """请求异常退出，常见于请求被中断或取消"""

    def __init__(self, message: str | None = None):
        super().__init__(message)
        self.message = message

    def __str__(self):
        return self.message or "请求因未知原因异常终止"


class RespNotOkException(Exception):
    """请求响应异常，见于请求未能成功响应（非 '200 OK'）"""

    def __init__(self, status_code: int, message: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    def __str__(self):
        if self.status_code in error_code_mapping:
            return error_code_mapping[self.status_code]
        if self.message:
            return self.message
        return f"未知的异常响应代码：{self.status_code}"


class ResponseContextException(Exception):
    """携带原始响应上下文的异常基类。"""

    default_message: str = "请求失败"

    def __init__(self, ext_info: Any = None, message: str | None = None):
        super().__init__(message)
        self.ext_info = ext_info
        self.message = message

    def __str__(self):
        return self.message or self.default_message


class RespParseException(ResponseContextException):
    """响应解析错误，常见于响应格式不正确或解析方法不匹配"""

    default_message = "解析响应内容时发生未知错误，请检查是否配置了正确的解析方法"


class EmptyResponseException(ResponseContextException):
    """响应内容为空"""

    default_message = "响应内容为空，这可能是一个临时性问题"


class ModelAttemptFailed(Exception):
    """当在单个模型上的所有重试都失败后抛出，以通知调度器切换模型。"""

    def __init__(self, message: str, original_exception: Exception | None = None):
        super().__init__(message)
        self.message = message
        self.original_exception = original_exception

    def __str__(self):
        return self.message


class LLMTaskTimeoutError(ModelAttemptFailed):
    """任务级 hard_timeout 触发的异常（复用切模型链路）。"""

    def __init__(self, task_name: str, model_name: str, timeout_s: float):
        super().__init__(
            f"任务 '{task_name}' 模型 '{model_name}' 触发硬超时 {timeout_s}s",
            original_exception=None,
        )
        self.task_name = task_name
        self.model_name = model_name
        self.timeout_s = timeout_s


# ---------------------------------------------------------------------------
# src.llm_models.model_client.base_client
# ---------------------------------------------------------------------------


@dataclass
class EmbeddingRequest:
    """统一的嵌入请求（字段集与上游 base_client.EmbeddingRequest 一致）。"""

    model_info: Any
    embedding_input: str
    extra_params: Dict[str, Any] = field(default_factory=dict)
    trace_context: Any = None


class _ClientRegistryStub:
    """client_registry 替身：P0-1b 由直连 OpenAI 兼容 embedding 适配器取代。"""

    def get_client_class_instance(self, api_provider: Any) -> Any:
        _ = api_provider
        raise NotImplementedError(
            "host_stubs: client_registry 为 P0-1 占位桩（P0-1b 重写 EmbeddingAPIAdapter 直连 OpenAI 兼容 API）"
        )


client_registry = _ClientRegistryStub()
