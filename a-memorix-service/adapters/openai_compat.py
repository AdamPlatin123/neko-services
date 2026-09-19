"""OpenAI 兼容真实出口（P0-1b）：chat 与 embeddings 两个适配器。

消费面（audit docs/design/module-interface-audit.md 第 4 节）：
- LLM：``core/utils/model_routing.py`` 是全包 LLM 调用唯一出口，依赖
  ``src.services.llm_service`` 的 ``generate`` / ``LLMServiceClient.generate_response``
  / ``get_available_models`` 三个面——前两者在本文件实现（第三者由
  host_stubs.config_stubs.build_task_config_map 读同一 toml 提供）。
- embedding：``core/embedding/api_adapter.py``（vendored 完整实现）通过
  ``client_registry.get_client_class_instance(api_provider)`` 取 client 并调
  ``client.get_embedding(EmbeddingRequest)``——本文件提供该 client。

模型解析链：任务名 → [model.tasks.<task>].model_list（priority 顺序）→
[model.models] 按条目 name 匹配 → [model.api_providers] 按条目名匹配 →
base_url/api_key/model_identifier 发起 OpenAI 兼容调用。任一环节缺失即
返回未配置错误（不抛出未捕获异常，调用侧全部有 try/except 降级）。

未配置行为：所有入口返回带 reason 的错误结果/None（进程不崩），服务启动时
由 ``model_config_status()`` 汇总并在 FastAPI 壳打 WARN。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import openai

logger = logging.getLogger("a_memorix_service.adapters.openai_compat")

REQUEST_TIMEOUT_SECONDS = 60.0
SDK_MAX_RETRIES = 1  # embedding 重试由 EmbeddingAPIAdapter._request_with_retry 负责，SDK 层只留 1 次


def _http_trust_env() -> bool:
    """是否让 httpx 读取代理环境变量（默认关）。

    默认 trust_env=False 的原因：桌面代理环境注入的 ALL_PROXY=socks5:// 会让
    openai SDK（httpx2）在客户端构造期就因缺 socksio 抛 ImportError，且服务
    的 OpenAI 兼容端点通常直连（本机网关/回环）。需要经系统代理出网时设
    A_MEMORIX_HTTP_TRUST_ENV=1。
    """

    return os.getenv("A_MEMORIX_HTTP_TRUST_ENV", "").strip() in {"1", "true", "yes", "on"}


def _new_async_http_client() -> Any:
    import httpx2  # openai 3.x 的 httpx 依赖线；传给 SDK 的 http_client 必须同源

    return httpx2.AsyncClient(trust_env=_http_trust_env(), timeout=REQUEST_TIMEOUT_SECONDS)


# ---------------------------------------------------------------------------
# 配置解释（与 host_stubs.config_stubs.build_model_config 同一数据源）
# ---------------------------------------------------------------------------


def _build_model_config() -> Any:
    from host_stubs.config_stubs import build_model_config

    return build_model_config()


@dataclass(frozen=True)
class ResolvedModel:
    """一次成功解析出的可调用模型。"""

    task_name: str
    model_name: str
    model_identifier: str
    provider_name: str
    base_url: str
    api_key: str
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


def resolve_task(
    task_name: str,
    *,
    model_hint: str = "",
    task_config_override: Any = None,
) -> tuple[Optional[ResolvedModel], str]:
    """解析任务到首个可用（模型+provider 均配置完整）的候选。

    返回 (ResolvedModel, "") 或 (None, reason)。reason 供调用侧组装错误信息。
    """

    normalized_task = str(task_name or "").strip()
    if not normalized_task:
        return None, "task_name 为空"

    model_cfg = _build_model_config()

    task_config = task_config_override
    if task_config is None:
        task_config = model_cfg.model_task_config.as_dict().get(normalized_task)
    if task_config is None:
        return None, f"未配置模型任务: {normalized_task}"

    candidates: List[str] = []
    hint = str(model_hint or "").strip()
    if hint:
        candidates.append(hint)
    candidates.extend(
        str(item or "").strip() for item in (getattr(task_config, "model_list", []) or []) if str(item or "").strip()
    )
    if not candidates:
        return None, f"任务 {normalized_task} 的 model_list 为空（请在 config/a_memorix.toml 的 [model.tasks.{normalized_task}] 配置）"

    reasons: List[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue  # 去重（model_hint 与 model_list 重叠时）
        seen.add(candidate)
        model_info = model_cfg.models_dict.get(candidate)
        if model_info is None:
            reasons.append(f"模型 {candidate} 未在 [model.models] 定义")
            continue
        model_identifier = str(getattr(model_info, "model_identifier", "") or "").strip()
        if not model_identifier:
            reasons.append(f"模型 {candidate} 缺少 model_identifier")
            continue
        provider_name = str(getattr(model_info, "api_provider", "") or "").strip()
        provider = model_cfg.api_providers_dict.get(provider_name)
        if provider is None:
            reasons.append(f"模型 {candidate} 的 provider `{provider_name}` 未在 [model.api_providers] 定义")
            continue
        if not str(provider.base_url or "").strip() or not str(provider.api_key or "").strip():
            reasons.append(f"provider `{provider_name}` 缺少 base_url 或 api_key")
            continue
        return (
            ResolvedModel(
                task_name=normalized_task,
                model_name=candidate,
                model_identifier=model_identifier,
                provider_name=provider_name,
                base_url=str(provider.base_url or "").strip(),
                api_key=str(provider.api_key or "").strip(),
                temperature=getattr(task_config, "temperature", None),
                max_tokens=getattr(task_config, "max_tokens", None),
            ),
            "",
        )
    return None, f"任务 {normalized_task} 无可用模型候选: " + "; ".join(reasons)


# ---------------------------------------------------------------------------
# openai 客户端缓存（provider 名 → AsyncOpenAI；避免每次调用重建连接池）
# ---------------------------------------------------------------------------

_chat_client_cache: Dict[str, openai.AsyncOpenAI] = {}
_embedding_client_cache: Dict[str, "OpenAICompatEmbeddingClient"] = {}


def reset_clients() -> None:
    """清空客户端缓存（配置 reload / 测试用；旧连接交给 GC 关闭）。"""

    _chat_client_cache.clear()
    _embedding_client_cache.clear()


def _get_chat_client(resolved: ResolvedModel) -> openai.AsyncOpenAI:
    client = _chat_client_cache.get(resolved.provider_name)
    if client is None:
        client = openai.AsyncOpenAI(
            base_url=resolved.base_url,
            api_key=resolved.api_key,
            http_client=_new_async_http_client(),
            timeout=REQUEST_TIMEOUT_SECONDS,
            max_retries=SDK_MAX_RETRIES,
        )
        _chat_client_cache[resolved.provider_name] = client
    return client


# ---------------------------------------------------------------------------
# LLM 出口：src.services.llm_service 的两个可调用面
# ---------------------------------------------------------------------------


def _prompt_to_messages(prompt: Any) -> List[Dict[str, Any]]:
    """调用侧 prompt 归一化：str → 单条 user；dict 列表 → 原样 messages。"""

    if isinstance(prompt, str):
        return [{"role": "user", "content": prompt}]
    if isinstance(prompt, list):
        messages = []
        for item in prompt:
            if isinstance(item, dict) and "role" in item and "content" in item:
                messages.append({"role": str(item["role"]), "content": item["content"]})
            elif isinstance(item, str):
                messages.append({"role": "user", "content": item})
            else:
                raise TypeError(f"prompt 列表元素非法: {type(item).__name__}")
        if messages:
            return messages
    raise TypeError(f"不支持的 prompt 类型: {type(prompt).__name__}")


async def generate_response(
    *,
    task_name: str,
    prompt: Any,
    options: Any = None,
    single_model_task: Any = None,
) -> Any:
    """LLMServiceClient.generate_response 的真实实现。

    返回 host_stubs.service_stubs.LLMResponseResult；未配置/失败时抛
    RuntimeError（model_routing 与各服务调用侧均有 try/except 降级）。
    """

    from host_stubs.service_stubs import LLMResponseResult

    resolved, reason = resolve_task(
        task_name,
        model_hint=str(getattr(options, "model_name", "") or ""),
        task_config_override=single_model_task,
    )
    if resolved is None:
        raise RuntimeError(f"LLM 任务不可用: {reason}")

    messages = _prompt_to_messages(prompt)
    kwargs: Dict[str, Any] = {"model": resolved.model_identifier, "messages": messages}
    temperature = getattr(options, "temperature", None)
    if temperature is None:
        temperature = resolved.temperature
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    max_tokens = getattr(options, "max_tokens", None)
    if max_tokens is None:
        max_tokens = resolved.max_tokens
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)

    client = _get_chat_client(resolved)
    completion = await client.chat.completions.create(**kwargs)
    choice = completion.choices[0] if getattr(completion, "choices", None) else None
    content = ""
    if choice is not None and getattr(choice, "message", None) is not None:
        content = str(choice.message.content or "")
    usage = getattr(completion, "usage", None)
    return LLMResponseResult(
        response=content,
        model_name=str(getattr(completion, "model", "") or resolved.model_name),
        prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
        completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
        total_tokens=int(getattr(usage, "total_tokens", 0) or 0),
    )


async def generate(request: Any) -> Any:
    """src.services.llm_service.generate 的真实实现（返回 LLMServiceResult）。"""

    from host_stubs.service_stubs import LLMServiceResult

    try:
        completion = await generate_response(
            task_name=request.task_name,
            prompt=request.prompt,
            options=request,
        )
    except Exception as exc:  # noqa: BLE001（与上游一致：错误进 result 不上抛）
        message = f"生成内容时出错: {exc}"
        logger.error(message)
        return LLMServiceResult.from_error(message, str(exc))
    return LLMServiceResult.from_response_result(completion)


# ---------------------------------------------------------------------------
# embedding 出口：client_registry.get_client_class_instance 的真实实现
# ---------------------------------------------------------------------------


@dataclass
class EmbeddingResponse:
    """embedding 响应（上游 llm_models client 返回面的最小形状：.embedding）。"""

    embedding: List[float]
    model_name: str = ""


class OpenAICompatEmbeddingClient:
    """OpenAI 兼容 embeddings 客户端（EmbeddingAPIAdapter 的依赖面）。

    - 模型名取 EmbeddingRequest.model_info.model_identifier
    - extra_params 原样透传（api_adapter 已在其中放 dimensions/output_dimensionality）
    - 不做自身重试：api_adapter._request_with_retry 负责（openai 连接/超时
      异常类型在其 retriable 集合内）
    """

    def __init__(self, api_provider: Any) -> None:
        self._base_url = str(getattr(api_provider, "base_url", "") or "").strip()
        self._api_key = str(getattr(api_provider, "api_key", "") or "").strip()
        self._client = openai.AsyncOpenAI(
            base_url=self._base_url,
            api_key=self._api_key,
            http_client=_new_async_http_client(),
            timeout=REQUEST_TIMEOUT_SECONDS,
            max_retries=0,
        )

    async def get_embedding(self, request: Any) -> EmbeddingResponse:
        model_identifier = str(getattr(getattr(request, "model_info", None), "model_identifier", "") or "").strip()
        if not model_identifier:
            raise RuntimeError("embedding 请求缺少 model_identifier")
        extra_params = dict(getattr(request, "extra_params", None) or {})
        response = await self._client.embeddings.create(
            model=model_identifier,
            input=str(getattr(request, "embedding_input", "") or ""),
            **extra_params,
        )
        data = getattr(response, "data", None)
        if not data:
            raise RuntimeError("embedding 响应为空")
        return EmbeddingResponse(
            embedding=[float(item) for item in (data[0].embedding or [])],
            model_name=str(getattr(response, "model", "") or ""),
        )


def get_embedding_client(api_provider: Any) -> OpenAICompatEmbeddingClient:
    """client_registry.get_client_class_instance 的真实替身（按 provider 名缓存）。"""

    name = str(getattr(api_provider, "name", "") or "")
    client = _embedding_client_cache.get(name)
    if client is None:
        client = OpenAICompatEmbeddingClient(api_provider)
        if name:
            _embedding_client_cache[name] = client
    return client


# ---------------------------------------------------------------------------
# 启动自检汇总（服务壳 WARN 用）
# ---------------------------------------------------------------------------


def model_config_status() -> Dict[str, Any]:
    """汇总 chat/embedding 出口配置完整性与告警文案（不发网络请求）。"""

    warnings: List[str] = []
    embedding_ready = False
    embedding_models: List[str] = []
    try:
        model_cfg = _build_model_config()
        embedding_models = [
            str(item or "").strip()
            for item in (getattr(model_cfg.model_task_config.embedding, "model_list", []) or [])
            if str(item or "").strip()
        ]
    except Exception as exc:  # noqa: BLE001（自检自身失败也要给出可读 WARN）
        warnings.append(f"模型配置读取失败: {exc}")
        return {"chat_ready": False, "embedding_ready": False, "chat_models": [], "embedding_models": [], "warnings": warnings}

    if not model_cfg.api_providers:
        warnings.append("[model.api_providers] 为空——LLM 与 embedding 出口均不可用")
    for provider in model_cfg.api_providers:
        if not str(provider.base_url or "").strip() or not str(provider.api_key or "").strip():
            warnings.append(f"provider `{provider.name}` 缺少 base_url/api_key——相关模型调用将失败")

    text_tasks = {
        task_name
        for task_name, task_config in model_cfg.model_task_config.as_dict().items()
        if task_name not in {"embedding", "voice", "vlm"}
        and any(str(item or "").strip() for item in (getattr(task_config, "model_list", []) or []))
    }
    chat_ready = False
    for task_name in ("memory", "utils"):
        resolved, _ = resolve_task(task_name)
        if resolved is not None:
            chat_ready = True
            break
    if text_tasks and not chat_ready:
        warnings.append("文本任务已配置 model_list 但无可解析的模型/provider 链（检查 [model.models] 与 [model.api_providers]）")
    if not text_tasks:
        warnings.append("未配置任何文本生成任务模型（[model.tasks.memory/utils] 的 model_list 为空）——LLM 相关组件将降级")

    if embedding_models:
        for model_name in embedding_models:
            resolved, reason = resolve_task("embedding", model_hint=model_name)
            if resolved is not None:
                embedding_ready = True
            else:
                warnings.append(f"embedding 模型 {model_name} 不可用: {reason}")
    else:
        warnings.append("embedding 任务未配置模型（[model.tasks.embedding] 的 model_list 为空）——向量检索/写入将降级为回填队列")

    return {
        "chat_ready": chat_ready,
        "embedding_ready": embedding_ready,
        "chat_models": sorted(text_tasks),
        "embedding_models": embedding_models,
        "warnings": warnings,
    }
