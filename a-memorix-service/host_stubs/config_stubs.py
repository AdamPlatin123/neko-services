"""`src.config.config` / `src.config.official_configs` / `src.config.model_configs` 的桩。

- `src.config.config`：config_manager / global_config / BOT_CONFIG_PATH / model_config
  全部改为读服务自有 `config/a_memorix.toml`（tomllib，无 pydantic 模板依赖）。
- `src.config.official_configs.AMemorixConfig`：pydantic 配置模型随服务走，
  子节清单按 audit 第 5 节（plugin/integration/storage/embedding/retrieval/threshold/
  filter/global_memory_sharing_enabled/shared_memory_groups/episode/person_profile/
  memory/advanced/web）。子节字段集为「最小已知键 + extra=allow」——host_service 的
  model_dump/model_validate 往返现在即可工作，字段级全量 fidelity 留 P0-1b 配置注入时补。
- `src.config.model_configs`：APIProvider / ModelInfo / TaskConfig 结构化替身
  （episode_segmentation / summary_importer / api_adapter / migrate 脚本消费的面）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from ._config_loader import CONFIG_PATH, BotInfo, get_config_state

# ---------------------------------------------------------------------------
# official_configs：AMemorixConfig 及其全部子节
# ---------------------------------------------------------------------------


class _Section(BaseModel):
    """子节基类：允许额外键，任何子集 payload 都能 model_validate 通过。"""

    model_config = ConfigDict(extra="allow")


class AMemorixPluginConfig(_Section):
    enabled: bool = True


class AMemorixIntegrationConfig(_Section):
    enable_memory: bool = True
    enable_memory_filter: bool = True


class AMemorixStorageConfig(_Section):
    data_dir: str = ""


class AMemorixEmbeddingConfig(_Section):
    model_name: str = "auto"
    batch_size: int = 32
    max_concurrent: int = 5
    default_dimension: int = 1024
    enable_cache: bool = False
    dimension_request_mode: str = "explicit"


class AMemorixRetrievalConfig(_Section):
    pass


class AMemorixThresholdConfig(_Section):
    pass


class AMemorixFilterConfig(_Section):
    pass


class AMemorixEpisodeConfig(_Section):
    pass


class AMemorixPersonProfileConfig(_Section):
    pass


class AMemorixMemoryConfig(_Section):
    pass


class AMemorixAdvancedConfig(_Section):
    pass


class AMemorixWebConfig(_Section):
    import_config: Dict[str, Any] = Field(default_factory=dict)


class ChatStreamGroup(_Section):
    name: str = ""
    targets: List[str] = Field(default_factory=list)


class ConfigBase(BaseModel):
    """与上游 official_configs.ConfigBase 对名的基类（仅标识用途）。"""

    model_config = ConfigDict(extra="allow")


class AMemorixConfig(ConfigBase):
    """长期记忆配置（子节结构见类文档尾的 audit 引用）。"""

    plugin: AMemorixPluginConfig = AMemorixPluginConfig()
    integration: AMemorixIntegrationConfig = AMemorixIntegrationConfig()
    storage: AMemorixStorageConfig = AMemorixStorageConfig()
    embedding: AMemorixEmbeddingConfig = AMemorixEmbeddingConfig()
    retrieval: AMemorixRetrievalConfig = AMemorixRetrievalConfig()
    threshold: AMemorixThresholdConfig = AMemorixThresholdConfig()
    filter: AMemorixFilterConfig = AMemorixFilterConfig()
    global_memory_sharing_enabled: bool = False
    shared_memory_groups: List[ChatStreamGroup] = field(default_factory=list)
    episode: AMemorixEpisodeConfig = AMemorixEpisodeConfig()
    person_profile: AMemorixPersonProfileConfig = AMemorixPersonProfileConfig()
    memory: AMemorixMemoryConfig = AMemorixMemoryConfig()
    advanced: AMemorixAdvancedConfig = AMemorixAdvancedConfig()
    web: AMemorixWebConfig = AMemorixWebConfig()


def build_a_memorix_config() -> AMemorixConfig:
    """从服务 toml 的 [a_memorix.*] 节构建 AMemorixConfig。"""

    payload = get_config_state().a_memorix_section
    if not isinstance(payload, dict) or not payload:
        return AMemorixConfig()
    return AMemorixConfig.model_validate(payload)


# ---------------------------------------------------------------------------
# model_configs：APIProvider / ModelInfo / TaskConfig
# ---------------------------------------------------------------------------


@dataclass
class APIProvider:
    """API 提供商配置（消费面：core/embedding/api_adapter.py）。"""

    name: str = ""
    base_url: str = ""
    api_key: str = ""
    client_type: str = "openai"
    auth_type: str = "bearer"
    auth_header_name: str = "Authorization"
    extra_params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelInfo:
    """单个模型信息（消费面：api_adapter._find_model_info / migrate 脚本）。"""

    model_identifier: str = ""
    name: str = ""
    api_provider: str = ""
    price_in: float = 0.0
    cache: bool = False
    extra_params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskConfig:
    """任务配置（字段集覆盖 build_single_model_task 的 type(template)(...) 构造面）。"""

    model_list: List[str] = field(default_factory=list)
    max_tokens: int = 4096
    temperature: float = 0.3
    slow_threshold: float = 15.0
    selection_strategy: str = "priority"
    hard_timeout: float = 0.0


class ModelTaskConfig:
    """任务集合：固定 embedding 任务 + 任意文本任务，属性访问。"""

    def __init__(self, tasks: Optional[Dict[str, TaskConfig]] = None) -> None:
        tasks = dict(tasks or {})
        tasks.setdefault("embedding", TaskConfig())
        self._tasks = tasks

    @property
    def embedding(self) -> TaskConfig:
        return self._tasks["embedding"]

    def __getattr__(self, name: str) -> TaskConfig:
        tasks = object.__getattribute__(self, "_tasks")
        if name in tasks:
            return tasks[name]
        raise AttributeError(f"未配置模型任务: {name}")

    def as_dict(self) -> Dict[str, TaskConfig]:
        return dict(self._tasks)


class ModelConfig:
    """model_config 聚合对象（消费面：config_manager.get_model_config / migrate 脚本）。"""

    def __init__(
        self,
        api_providers: Optional[List[APIProvider]] = None,
        models: Optional[List[ModelInfo]] = None,
        model_task_config: Optional[ModelTaskConfig] = None,
    ) -> None:
        self.api_providers: List[APIProvider] = list(api_providers or [])
        self.models: List[ModelInfo] = list(models or [])
        self.model_task_config: ModelTaskConfig = model_task_config or ModelTaskConfig()
        self.api_providers_dict: Dict[str, APIProvider] = {}
        self.models_dict: Dict[str, ModelInfo] = {}
        self.refresh_dicts()

    def refresh_dicts(self) -> None:
        self.api_providers_dict = {item.name: item for item in self.api_providers}
        self.models_dict = {item.name: item for item in self.models}

    def replace_from(self, other: "ModelConfig") -> None:
        """reload 时原地换内容，保持对象身份（module 级 model_config 引用不失效）。"""

        self.api_providers = other.api_providers
        self.models = other.models
        self.model_task_config = other.model_task_config
        self.refresh_dicts()


def build_model_config() -> ModelConfig:
    """从服务 toml 的 [model.*] 节构建 ModelConfig。"""

    section = get_config_state().model_section
    providers = [
        APIProvider(
            name=str(item.get("name", "")),
            base_url=str(item.get("base_url", "")),
            api_key=str(item.get("api_key", "")),
            client_type=str(item.get("client_type", "openai")),
        )
        for item in section.get("api_providers", [])
        if isinstance(item, dict)
    ]
    models = [
        ModelInfo(
            name=str(item.get("name", "")),
            model_identifier=str(item.get("model_identifier", "")),
            api_provider=str(item.get("api_provider", "")),
        )
        for item in section.get("models", [])
        if isinstance(item, dict)
    ]
    tasks_raw = section.get("tasks", {})
    tasks: Dict[str, TaskConfig] = {}
    if isinstance(tasks_raw, dict):
        for task_name, task_payload in tasks_raw.items():
            if not isinstance(task_payload, dict):
                continue
            tasks[task_name] = TaskConfig(
                model_list=[str(item) for item in task_payload.get("model_list", []) or []],
                max_tokens=int(task_payload.get("max_tokens", 4096)),
                temperature=float(task_payload.get("temperature", 0.3)),
            )
    return ModelConfig(providers, models, ModelTaskConfig(tasks))


def build_task_config_map() -> Dict[str, TaskConfig]:
    """llm_service.get_available_models() 的数据源：任务名 → TaskConfig。"""

    return build_model_config().model_task_config.as_dict()


# ---------------------------------------------------------------------------
# src.config.config：config_manager / global_config / BOT_CONFIG_PATH / model_config
# ---------------------------------------------------------------------------


class GlobalConfig:
    """global_config 替身：属性访问时从服务 toml 现读（热重载友好）。"""

    @property
    def a_memorix(self) -> AMemorixConfig:
        return build_a_memorix_config()

    @property
    def bot(self) -> BotInfo:
        return get_config_state().bot


class ConfigManager:
    """config_manager 替身：模型配置 + bot 配置热重载回调注册。"""

    def __init__(self) -> None:
        self._model_config = build_model_config()
        self._reload_callbacks: List[Any] = []

    def get_model_config(self) -> ModelConfig:
        return self._model_config

    def register_reload_callback(self, callback: Any) -> None:
        self._reload_callbacks.append(callback)

    async def reload_config(self, changed_scopes: Any = None) -> bool:
        _ = changed_scopes
        get_config_state().reload()
        self._model_config.replace_from(build_model_config())
        for callback in list(self._reload_callbacks):
            result = callback(changed_scopes=("bot",))
            if hasattr(result, "__await__"):  # on_config_reload 是 async 的
                await result
        return True


config_manager = ConfigManager()
global_config = GlobalConfig()
BOT_CONFIG_PATH = Path(CONFIG_PATH)
model_config = config_manager.get_model_config()
