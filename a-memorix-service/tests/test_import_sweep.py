"""A_memorix 全树 import 扫描（P0-1 #2 验收：import-sweep 全绿）。

做法：host_stubs.install() 后 pkgutil.walk_packages 逐模块 import_module，
收集一切异常并断言为空；另附桩行为冒烟（logger 透传 / chat_manager 降级 /
LLM 占位可导入不可调用 / 配置 toml 生效 / src.A_memorix 别名身份一致）。

第三方依赖说明（真实依赖，非桩；P0-1b 移入 pyproject dependencies）：
已装 numpy、scipy、faiss-cpu、tomlkit、json-repair、sqlalchemy、sqlmodel、
pydantic、aiohttp、openai、jieba、psutil、ahocorasick_rs、rich、tenacity。
树内自带 try/except ImportError 降级守卫的重依赖（本环境未安装、也无需桩）：
- sentence_transformers（core/embedding/manager.py → HAS_SENTENCE_TRANSFORMERS=False）
- networkx / pyarrow / google.genai（scripts 内函数级延迟导入，import 阶段不触发）
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

import A_memorix
import host_stubs


def _iter_a_memorix_modules():
    seen: set[str] = set()
    for info in pkgutil.walk_packages(A_memorix.__path__, prefix="A_memorix."):
        if info.name in seen:
            continue
        seen.add(info.name)
        yield info.name


def test_import_sweep_whole_tree():
    """全树逐模块 import，任何异常都视为失败并给出完整清单。"""

    failures = []
    imported = []
    for module_name in _iter_a_memorix_modules():
        try:
            importlib.import_module(module_name)
            imported.append(module_name)
        except Exception as exc:  # noqa: BLE001（收集全部异常类型）
            failures.append(f"{module_name}: {type(exc).__name__}: {exc}")

    # scripts/ 是无 __init__ 的命名空间包，walk_packages 可能不展开：显式补扫
    import A_memorix.scripts as scripts_pkg  # noqa: E401

    for info in pkgutil.iter_modules(scripts_pkg.__path__, prefix="A_memorix.scripts."):
        try:
            importlib.import_module(info.name)
            imported.append(info.name)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{info.name}: {type(exc).__name__}: {exc}")

    assert not failures, "import-sweep 失败:\n" + "\n".join(failures)
    assert len(imported) >= 100, f"扫描模块数异常偏少: {len(imported)}"


def test_no_silent_fallback_during_sweep():
    """扫描不允许落入警告型兜底（命中即说明有宿主依赖没桩到）。"""

    hits = host_stubs.get_fallback_hits()
    assert hits == [], "警告型兜底命中（应补显式桩）: " + ", ".join(f"{m}.{a}" for m, a in hits)


def test_host_entry_modules_import():
    """host_service / plugin / kernel 三个关键入口可直接 import。"""

    importlib.import_module("A_memorix.host_service")
    importlib.import_module("A_memorix.plugin")
    importlib.import_module("A_memorix.core.runtime.sdk_memory_kernel")


def test_src_a_memorix_alias_identity():
    """src.A_memorix.* 别名与真实模块同一对象（isinstance 兼容）。"""

    real = importlib.import_module("A_memorix.core.retrieval")
    alias = importlib.import_module("src.A_memorix.core.retrieval")
    assert alias is real


def test_logger_stub_passthrough():
    from src.common.logger import get_logger

    logger = get_logger("A_memorix.Test")
    assert logger.name == "A_memorix.Test"


def test_chat_manager_degrades_to_none():
    from src.chat.message_receive.chat_manager import chat_manager

    assert chat_manager.get_existing_session_by_session_id("whatever") is None


def test_llm_stub_importable_but_not_callable():
    from src.services import llm_service as llm_api

    request = llm_api.LLMServiceRequest(
        task_name="memory", request_type="test", prompt="hi"
    )
    assert request.task_name == "memory"
    models = llm_api.get_available_models()
    assert isinstance(models, dict)
    assert "embedding" in models
    result = llm_api.LLMServiceResult.from_error("boom", "detail")
    assert result.success is False and result.error == "detail"

    client = llm_api.LLMServiceClient(task_name="utils", request_type="test")
    assert hasattr(client._orchestrator, "model_for_task")
    with pytest.raises(NotImplementedError):
        import asyncio

        asyncio.run(client.generate_response(prompt="hi"))


def test_message_service_stub_returns_empty():
    from src.services import message_service as message_api

    assert message_api.get_messages_by_time_in_chat(chat_id="c", start_time=0.0, end_time=1.0) == []
    assert message_api.build_readable_messages([]) == ""


def test_database_stub_raises():
    from src.common.database.database import get_db_session
    from src.common.database.database_model import PersonInfo

    with pytest.raises(RuntimeError):
        get_db_session(auto_commit=False)
    info = PersonInfo(person_id="p1", person_name="n")
    assert info.person_id == "p1"


def test_config_stub_reads_service_toml():
    from src.config.config import BOT_CONFIG_PATH, config_manager, global_config

    assert BOT_CONFIG_PATH.name == "a_memorix.toml"
    assert BOT_CONFIG_PATH.exists()
    assert config_manager.get_model_config().model_task_config.embedding.model_list == []
    assert global_config.a_memorix.plugin.enabled is True
    assert global_config.bot.nickname


def test_official_configs_roundtrip():
    from src.config.official_configs import AMemorixConfig

    payload = AMemorixConfig().model_dump(mode="json")
    assert set(payload) >= {
        "plugin", "integration", "storage", "embedding", "retrieval", "threshold",
        "filter", "global_memory_sharing_enabled", "shared_memory_groups",
        "episode", "person_profile", "memory", "advanced", "web",
    }
    AMemorixConfig.model_validate(payload)


def test_shared_memory_session_ids_passthrough():
    from src.common.utils.utils_config import AMemorixConfigUtils

    assert AMemorixConfigUtils.get_shared_memory_session_ids("chat-1") == {"chat-1"}
    assert AMemorixConfigUtils.get_shared_memory_session_ids("") == set()


def test_exception_hierarchy_matches_upstream():
    from src.llm_models.exceptions import (
        EmptyResponseException,
        LLMTaskTimeoutError,
        ModelAttemptFailed,
        NetworkConnectionError,
        RespNotOkException,
        RespParseException,
        ResponseContextException,
    )

    assert issubclass(LLMTaskTimeoutError, ModelAttemptFailed)
    assert issubclass(RespParseException, ResponseContextException)
    assert issubclass(EmptyResponseException, ResponseContextException)
    exc = RespNotOkException(429)
    assert "频繁" in str(exc)
    assert NetworkConnectionError("x").message == "x"


def test_update_toml_doc_merges():
    import tomlkit
    from src.webui.utils.toml_utils import _update_toml_doc

    target = tomlkit.parse("""[a]\nb = 1\n[a.c]\nd = 2\n""")
    _update_toml_doc(target, {"a": {"b": 9, "c": {"e": 3}}})
    assert target["a"]["b"] == 9
    assert target["a"]["c"]["d"] == 2
    assert target["a"]["c"]["e"] == 3


def test_sdk_stub_tool_decorator():
    from maibot_sdk import MaiBotPlugin, Tool
    from maibot_sdk.types import ToolParameterInfo, ToolParamType

    @Tool("search_memory", description="d", parameters=[ToolParameterInfo("q", ToolParamType.STRING, "", False)])
    async def search_memory(**kwargs):  # noqa: RUF029
        return None

    assert search_memory.tool_name == "search_memory"
    assert issubclass(MaiBotPlugin, object)
