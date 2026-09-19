"""a-memorix-service 真实出口适配器（P0-1b）。

与 host_stubs 的分工：host_stubs 负责「把宿主模块面伪装出来」，本包提供
其中两个可调用面的**真实后端**（OpenAI 兼容 HTTP）：

- LLM 出口（`src.services.llm_service` 的 generate / LLMServiceClient，
  全包 LLM 调用唯一出口 core/utils/model_routing.py 的依赖面）
- embedding 出口（`src.llm_models.model_client.base_client.client_registry`
  .get_client_class_instance，core/embedding/api_adapter.py 的依赖面；
  适配器本体是 vendored 完整实现，无需重写）

配置源：config/a_memorix.toml 的 [model.*]（api_providers/models/tasks，
经 host_stubs.config_stubs.build_model_config 解释）。
"""

from adapters.openai_compat import (
    generate,
    generate_response,
    get_embedding_client,
    model_config_status,
    reset_clients,
    resolve_task,
)

__all__ = [
    "generate",
    "generate_response",
    "get_embedding_client",
    "model_config_status",
    "reset_clients",
    "resolve_task",
]
