"""A_memorix 注入式宿主桩（P0-1 #2）。

在 `import A_memorix` **之前**调用 `host_stubs.install()`，把 MaiBot 宿主依赖
（audit 文档 `docs/design/module-interface-audit.md` 第 4 节全集）以 sys.modules
预注册方式桩掉，上游 vendored 树（../A_memorix/）保持零修改。

三层防线：
1. 显式桩：第 4 节列出的全部宿主模块（字段/签名与上游对齐，见各 *_stubs.py）。
2. `src.A_memorix.*` 别名：树内少量绝对导入自引用（memory_search_service）经
   meta path finder 原身份映射到真实 vendored 模块（避免双重加载破坏 isinstance）。
3. 警告型兜底：未显式桩到的 `src.*` 导入给出 WARN（stderr，每属性一次，不静默），
   并记录到 fallback_hits 供测试/巡检暴露懒加载盲区。
"""

from __future__ import annotations

import importlib
import importlib.machinery
import sys
import types
from typing import Any, Dict, List, Optional, Tuple

from . import chat_stubs, common_stubs, config_stubs, llm_models_stubs, sdk_stubs, service_stubs, webui_stubs
from ._registry import ensure_package, register

__all__ = ["install", "is_installed", "get_fallback_hits", "reset_fallback_hits"]

_installed = False
_fallback_hits: List[Tuple[str, str]] = []
_warned: set[Tuple[str, str]] = set()

_SRC_ALIAS_PREFIX = "src.A_memorix"


# ---------------------------------------------------------------------------
# 警告型占位（兜底防线）
# ---------------------------------------------------------------------------


class _Placeholder:
    """占位对象：可再取属性（链式）、可调用但调用即报 NotImplementedError。"""

    __slots__ = ("_path",)

    def __init__(self, path: str) -> None:
        object.__setattr__(self, "_path", path)

    def __getattr__(self, name: str) -> "_Placeholder":
        return _Placeholder(f"{self._path}.{name}")

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError(f"host_stubs: 兜底占位不可调用: {self._path}")

    def __repr__(self) -> str:
        return f"<host_stubs placeholder {self._path}>"


def _warn_fallback(module_name: str, attr_name: str) -> _Placeholder:
    key = (module_name, attr_name)
    if key not in _warned:
        _warned.add(key)
        _fallback_hits.append(key)
        print(
            f"[host_stubs][WARN] 未明确桩掉的宿主导入: {module_name}.{attr_name} → 返回占位"
            "（请补进 host_stubs 或确认该路径不需要）",
            file=sys.stderr,
        )
    return _Placeholder(f"{module_name}.{attr_name}")


def _make_warn_module(module_name: str) -> types.ModuleType:
    module = types.ModuleType(module_name)
    module.__doc__ = f"host_stubs 警告型兜底桩（未显式覆盖的宿主模块 {module_name}）"
    module.__getattr__ = lambda attr, _name=module_name: _warn_fallback(_name, attr)  # type: ignore[attr-defined]
    return module


# ---------------------------------------------------------------------------
# meta path finder：src.A_memorix.* 身份别名 + src.* 兜底
# ---------------------------------------------------------------------------


class _AliasLoader:
    """create_module 直接返回真实模块对象，保持类/函数身份（isinstance 兼容）。"""

    def __init__(self, target_name: str) -> None:
        self._target_name = target_name

    def create_module(self, spec: Any) -> types.ModuleType:
        return importlib.import_module(self._target_name)

    def exec_module(self, module: types.ModuleType) -> None:  # noqa: RUF029
        return None


class _WarnStubLoader:
    def create_module(self, spec: Any) -> types.ModuleType:
        return _make_warn_module(spec.name)

    def exec_module(self, module: types.ModuleType) -> None:  # noqa: RUF029
        return None


class _HostStubFinder:
    """sys.meta_path 前置 finder：只处理 src.* 名称，其余放行。"""

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname == "src" or not fullname.startswith("src."):
            return None
        if fullname in sys.modules:
            return None
        if fullname == _SRC_ALIAS_PREFIX or fullname.startswith(_SRC_ALIAS_PREFIX + "."):
            spec = importlib.machinery.ModuleSpec(fullname, _AliasLoader("A_memorix" + fullname[len(_SRC_ALIAS_PREFIX):]))
            return spec
        return importlib.machinery.ModuleSpec(fullname, _WarnStubLoader())


_finder: Optional[_HostStubFinder] = None


# ---------------------------------------------------------------------------
# 显式桩注册（第 4 节全集）
# ---------------------------------------------------------------------------


def _register_explicit_stubs() -> None:
    # --- src 根包 ---
    ensure_package("src")

    # --- src.common.logger ---
    register("src.common.logger", get_logger=common_stubs.get_logger)

    # --- src.common.prompt_i18n ---
    register("src.common.prompt_i18n", load_prompt=common_stubs.load_prompt)

    # --- src.common.utils.utils_config ---
    register("src.common.utils.utils_config", AMemorixConfigUtils=common_stubs.AMemorixConfigUtils)

    # --- src.common.data_models.llm_service_data_models ---
    register(
        "src.common.data_models.llm_service_data_models",
        LLMServiceResult=service_stubs.LLMServiceResult,
        LLMServiceRequest=service_stubs.LLMServiceRequest,
        LLMGenerationOptions=service_stubs.LLMGenerationOptions,
        LLMResponseResult=service_stubs.LLMResponseResult,
    )

    # --- src.common.database.database / database_model ---
    register(
        "src.common.database.database",
        get_db_session=common_stubs.get_db_session,
        DatabaseUnavailableError=common_stubs._DatabaseUnavailableError,
    )
    register("src.common.database.database_model", PersonInfo=common_stubs.PersonInfo)

    # --- src.chat.message_receive.chat_manager ---
    register(
        "src.chat.message_receive.chat_manager",
        chat_manager=chat_stubs.chat_manager,
    )

    # --- src.services.llm_service（dataclass 同名再导出，与上游一致）---
    register(
        "src.services.llm_service",
        LLMServiceClient=service_stubs.LLMServiceClient,
        generate=service_stubs.generate,
        get_available_models=service_stubs.get_available_models,
        resolve_task_name=service_stubs.resolve_task_name,
        LLMServiceRequest=service_stubs.LLMServiceRequest,
        LLMGenerationOptions=service_stubs.LLMGenerationOptions,
        LLMServiceResult=service_stubs.LLMServiceResult,
        LLMResponseResult=service_stubs.LLMResponseResult,
    )

    # --- src.services.message_service ---
    register(
        "src.services.message_service",
        get_messages_by_time_in_chat=service_stubs.get_messages_by_time_in_chat,
        build_readable_messages=service_stubs.build_readable_messages,
    )

    # --- src.config.config ---
    register(
        "src.config.config",
        config_manager=config_stubs.config_manager,
        global_config=config_stubs.global_config,
        BOT_CONFIG_PATH=config_stubs.BOT_CONFIG_PATH,
        model_config=config_stubs.model_config,
    )

    # --- src.config.official_configs ---
    register(
        "src.config.official_configs",
        ConfigBase=config_stubs.ConfigBase,
        AMemorixConfig=config_stubs.AMemorixConfig,
        ChatStreamGroup=config_stubs.ChatStreamGroup,
        AMemorixPluginConfig=config_stubs.AMemorixPluginConfig,
        AMemorixIntegrationConfig=config_stubs.AMemorixIntegrationConfig,
        AMemorixStorageConfig=config_stubs.AMemorixStorageConfig,
        AMemorixEmbeddingConfig=config_stubs.AMemorixEmbeddingConfig,
        AMemorixRetrievalConfig=config_stubs.AMemorixRetrievalConfig,
        AMemorixThresholdConfig=config_stubs.AMemorixThresholdConfig,
        AMemorixFilterConfig=config_stubs.AMemorixFilterConfig,
        AMemorixEpisodeConfig=config_stubs.AMemorixEpisodeConfig,
        AMemorixPersonProfileConfig=config_stubs.AMemorixPersonProfileConfig,
        AMemorixMemoryConfig=config_stubs.AMemorixMemoryConfig,
        AMemorixAdvancedConfig=config_stubs.AMemorixAdvancedConfig,
        AMemorixWebConfig=config_stubs.AMemorixWebConfig,
    )

    # --- src.config.model_configs ---
    register(
        "src.config.model_configs",
        APIProvider=config_stubs.APIProvider,
        ModelInfo=config_stubs.ModelInfo,
        TaskConfig=config_stubs.TaskConfig,
        ModelTaskConfig=config_stubs.ModelTaskConfig,
        ModelConfig=config_stubs.ModelConfig,
    )

    # --- src.llm_models.exceptions ---
    register(
        "src.llm_models.exceptions",
        error_code_mapping=llm_models_stubs.error_code_mapping,
        NetworkConnectionError=llm_models_stubs.NetworkConnectionError,
        ReqAbortException=llm_models_stubs.ReqAbortException,
        RespNotOkException=llm_models_stubs.RespNotOkException,
        ResponseContextException=llm_models_stubs.ResponseContextException,
        RespParseException=llm_models_stubs.RespParseException,
        EmptyResponseException=llm_models_stubs.EmptyResponseException,
        ModelAttemptFailed=llm_models_stubs.ModelAttemptFailed,
        LLMTaskTimeoutError=llm_models_stubs.LLMTaskTimeoutError,
    )

    # --- src.llm_models.model_client.base_client ---
    register(
        "src.llm_models.model_client.base_client",
        EmbeddingRequest=llm_models_stubs.EmbeddingRequest,
        client_registry=llm_models_stubs.client_registry,
    )

    # --- src.webui.utils.toml_utils ---
    register("src.webui.utils.toml_utils", _update_toml_doc=webui_stubs._update_toml_doc)

    # --- maibot_sdk（legacy plugin.py 的 import 面；带子模块 types，须注册为包）---
    sdk_pkg = ensure_package("maibot_sdk")
    sdk_pkg.MaiBotPlugin = sdk_stubs.MaiBotPlugin
    sdk_pkg.Tool = sdk_stubs.Tool
    register(
        "maibot_sdk.types",
        ToolParameterInfo=sdk_stubs.ToolParameterInfo,
        ToolParamType=sdk_stubs.ToolParamType,
    )


def _alias_script_siblings() -> None:
    """scripts/* 之间以顶层名互导（直跑时依赖脚本目录入 sys.path）：
    `_bootstrap`（自举路径常量）与 `process_knowledge`（LPMM 导入器），
    统一别名到 A_memorix.scripts.* 真实模块，保持单一身份。
    """

    for top_name in ("_bootstrap", "process_knowledge"):
        if top_name in sys.modules:
            continue
        try:
            real = importlib.import_module(f"A_memorix.scripts.{top_name}")
        except ImportError:
            continue
        sys.modules[top_name] = real


def _patch_upstream_import_quirks() -> None:
    """上游已知 import 笔误的兼容再导出（不改 vendored 树的前提下桥接）。

    scripts/release_vnext_migrate.py:66 从 `A_memorix.core.storage.metadata_store`
    导入 `RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION`，但该常量实际定义在
    `metadata_schema.py`（metadata_store 只再导出了 SCHEMA_VERSION）——上游脚本
    笔误。此处把正确来源桥接到 metadata_store 模块对象上。
    """

    try:
        metadata_store = importlib.import_module("A_memorix.core.storage.metadata_store")
        metadata_schema = importlib.import_module("A_memorix.core.storage.metadata_schema")
    except ImportError:
        return
    if not hasattr(metadata_store, "RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION"):
        metadata_store.RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION = (  # type: ignore[attr-defined]
            metadata_schema.RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION
        )


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------


def install() -> None:
    """预注册全部宿主桩 + 安装 meta path finder。幂等；必须在 import A_memorix 前调用。"""

    global _finder, _installed
    if _installed:
        return

    _register_explicit_stubs()

    if _finder is None:
        _finder = _HostStubFinder()
    if _finder not in sys.meta_path:
        sys.meta_path.insert(0, _finder)

    _alias_script_siblings()
    _patch_upstream_import_quirks()
    _installed = True


def is_installed() -> bool:
    return _installed


def get_fallback_hits() -> List[Tuple[str, str]]:
    """兜底防线命中记录（module, attr）——测试断言/巡检用。"""

    return list(_fallback_hits)


def reset_fallback_hits() -> None:
    _fallback_hits.clear()
    _warned.clear()
