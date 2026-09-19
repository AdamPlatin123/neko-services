"""A_memorix 注入式宿主桩（P0-1 #2）。

在 `import A_memorix` **之前**调用 `host_stubs.install()`，把 MaiBot 宿主依赖
（audit 文档 `docs/design/module-interface-audit.md` 第 4 节全集）以 sys.modules
预注册方式桩掉，上游 vendored 树（../A_memorix/）保持零修改。

install() 本身零副作用：不 import 任何 A_memorix/scripts 模块（防 --help 等
argv 快速路径在安装半途 SystemExit），一切树内模块按需惰性解析。

防线分层：
1. 显式桩：第 4 节列出的全部宿主模块（字段/签名与上游对齐，见各 *_stubs.py）。
2. `src.A_memorix.*` 别名：树内少量绝对导入自引用（memory_search_service）经
   meta path finder 原身份映射到真实 vendored 模块（避免双重加载破坏 isinstance）。
3. 严格模式（默认）：未显式桩到的 `src.*` 导入交回默认机制 → ModuleNotFoundError
   （`importlib.util.find_spec` 探测返回 None，语义同模块不存在——可选依赖检测
   不会误放行）。
4. 宽松模式（`NEKO_STUBS_LENIENT=1`）：未桩 `src.*` 给 WARN 占位（stderr，每属性
   一次，记录到 fallback_hits）——仅供排查懒加载盲区，注意占位模块会使
   hasattr/find_spec 探测为真。
"""

from __future__ import annotations

import importlib
import importlib.machinery
import os
import sys
import types
from typing import List, Optional, Tuple

from . import chat_stubs, common_stubs, config_stubs, llm_models_stubs, sdk_stubs, service_stubs, webui_stubs
from ._registry import ensure_package, register

__all__ = ["install", "is_installed", "get_fallback_hits", "reset_fallback_hits"]

_installed = False
_fallback_hits: List[Tuple[str, str]] = []
_warned: set[Tuple[str, str]] = set()

_SRC_ALIAS_PREFIX = "src.A_memorix"

# scripts/* 之间以顶层名互导（直跑时靠脚本自身目录入 sys.path）：惰性别名到真实模块
_SCRIPT_SIBLING_ALIASES = {
    "_bootstrap": "A_memorix.scripts._bootstrap",
    "process_knowledge": "A_memorix.scripts.process_knowledge",
}
# 上游笔误桥接点：release_vnext_migrate.py 从 metadata_store 导入
# RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION，该常量实际定义在 metadata_schema.py
_RELEASE_VNEXT_MIGRATE = "A_memorix.scripts.release_vnext_migrate"
_METADATA_STORE = "A_memorix.core.storage.metadata_store"
_METADATA_SCHEMA = "A_memorix.core.storage.metadata_schema"


def _is_lenient() -> bool:
    return os.environ.get("NEKO_STUBS_LENIENT", "") == "1"


# ---------------------------------------------------------------------------
# 宽松模式占位（NEKO_STUBS_LENIENT=1 时启用）
# ---------------------------------------------------------------------------


class _Placeholder:
    """占位对象：可再取属性（链式）、可调用但调用即报 NotImplementedError。"""

    __slots__ = ("_path",)

    def __init__(self, path: str) -> None:
        object.__setattr__(self, "_path", path)

    def __getattr__(self, name: str) -> "_Placeholder":
        return _Placeholder(f"{self._path}.{name}")

    def __call__(self, *args: object, **kwargs: object) -> object:
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
            "（严格模式下此处应为 ImportError；请补进 host_stubs 显式桩）",
            file=sys.stderr,
        )
    return _Placeholder(f"{module_name}.{attr_name}")


def _make_warn_module(module_name: str) -> types.ModuleType:
    module = types.ModuleType(module_name)
    module.__doc__ = f"host_stubs 宽松模式占位桩（未显式覆盖的宿主模块 {module_name}）"
    module.__getattr__ = lambda attr, _name=module_name: _warn_fallback(_name, attr)  # type: ignore[attr-defined]
    return module


# ---------------------------------------------------------------------------
# meta path finder：src.A_memorix.* 身份别名 / scripts 惰性别名 /
# 上游笔误桥接 / 未桩 src.* 的严格与宽松两种处置
# ---------------------------------------------------------------------------


class _AliasLoader:
    """create_module 直接返回真实模块对象，保持类/函数身份（isinstance 兼容）。"""

    def __init__(self, target_name: str) -> None:
        self._target_name = target_name

    def create_module(self, spec: object) -> types.ModuleType:
        return importlib.import_module(self._target_name)

    def exec_module(self, module: types.ModuleType) -> None:  # noqa: RUF029
        return None


class _WarnStubLoader:
    def create_module(self, spec: object) -> types.ModuleType:
        return _make_warn_module(spec.name)  # type: ignore[attr-defined]

    def exec_module(self, module: types.ModuleType) -> None:  # noqa: RUF029
        return None


def _ensure_metadata_store_reexport() -> None:
    """惰性桥接上游 release_vnext_migrate.py 的导入笔误（不改 vendored 树）。

    在该脚本被 import 之前，把 metadata_schema.RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION
    补挂到 metadata_store 模块对象上；失败则交回脚本自身的 try/except 处置。
    """

    try:
        metadata_store = importlib.import_module(_METADATA_STORE)
        metadata_schema = importlib.import_module(_METADATA_SCHEMA)
    except Exception:  # noqa: BLE001（桥接失败 = 与上游缺依赖时同构的行为）
        return
    if not hasattr(metadata_store, "RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION"):
        metadata_store.RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION = (  # type: ignore[attr-defined]
            metadata_schema.RUNTIME_AUTO_MIGRATION_MIN_SCHEMA_VERSION
        )


class _HostStubFinder:
    """sys.meta_path 前置 finder：只处理 src.* 与 scripts 顶层别名，其余放行。"""

    def find_spec(self, fullname: str, path: object = None, target: object = None) -> object:
        if fullname in sys.modules:
            return None
        if fullname == "src" or fullname.startswith("src."):
            if fullname == _SRC_ALIAS_PREFIX or fullname.startswith(_SRC_ALIAS_PREFIX + "."):
                return importlib.machinery.ModuleSpec(
                    fullname, _AliasLoader("A_memorix" + fullname[len(_SRC_ALIAS_PREFIX):])
                )
            if _is_lenient():
                return importlib.machinery.ModuleSpec(fullname, _WarnStubLoader())
            return None  # 严格模式：交回默认机制（import → ModuleNotFoundError，find_spec 探测 → None）
        alias_target = _SCRIPT_SIBLING_ALIASES.get(fullname)
        if alias_target is not None:
            return importlib.machinery.ModuleSpec(fullname, _AliasLoader(alias_target))
        if fullname == _RELEASE_VNEXT_MIGRATE:
            _ensure_metadata_store_reexport()
        return None


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


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------


def install() -> None:
    """预注册全部宿主桩 + 安装 meta path finder。

    幂等；必须在 import A_memorix 前调用。本函数不 import 任何 A_memorix/scripts
    模块——scripts 顶层互导别名（_bootstrap/process_knowledge）与上游笔误桥接均由
    finder 惰性解析，install() 在任何宿主进程 argv 形态下都安全完成。
    """

    global _finder, _installed
    if _installed:
        return

    _register_explicit_stubs()

    if _finder is None:
        _finder = _HostStubFinder()
    if _finder not in sys.meta_path:
        sys.meta_path.insert(0, _finder)

    _installed = True


def is_installed() -> bool:
    return _installed


def get_fallback_hits() -> List[Tuple[str, str]]:
    """宽松模式占位命中记录（module, attr）——测试断言/巡检用。"""

    return list(_fallback_hits)


def reset_fallback_hits() -> None:
    _fallback_hits.clear()
    _warned.clear()
