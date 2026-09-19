"""A_memorix 全树 import 扫描（P0-1 #2 验收：import-sweep 全绿）。

做法：host_stubs.install() 后 pkgutil.walk_packages 逐模块 import_module，
扫描结果与磁盘 *.py 清单精确比对；另附桩行为冒烟（logger 透传 / chat_manager
降级 / LLM 占位可导入不可调用 / 配置 toml 生效 / src.A_memorix 别名身份一致）、
严格模式默认行为（未桩 src.* → ImportError）、宽松模式开关行为、以及独立进程
真实启动顺序契约（subprocess）。

桩模式说明：默认严格（未桩 src.* 导入直接 ImportError，find_spec 探测返回 None，
可选依赖检测不误放行）；设 NEKO_STUBS_LENIENT=1 进宽松模式（WARN 占位）。

第三方依赖说明（真实依赖，非桩；已入 pyproject dependencies，uv sync 干净复现）：
numpy、scipy、faiss-cpu、tomlkit、json-repair、sqlalchemy、sqlmodel、pydantic、
aiohttp、openai、jieba、psutil、ahocorasick-rs、rich、tenacity、pyarrow。
树内自带 try/except ImportError 降级守卫的重依赖（本环境未安装、也无需桩）：
- sentence_transformers（core/embedding/manager.py → HAS_SENTENCE_TRANSFORMERS=False）
- networkx / google.genai（scripts 内函数级延迟导入，import 阶段不触发）
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import pkgutil
import subprocess
import sys
from pathlib import Path

import pytest

import A_memorix
import host_stubs

SERVICE_ROOT = Path(__file__).resolve().parent.parent
TREE_ROOT = Path(A_memorix.__file__).resolve().parent


def _sweep_module_names() -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for info in pkgutil.walk_packages(A_memorix.__path__, prefix="A_memorix."):
        if info.name not in seen:
            seen.add(info.name)
            names.append(info.name)
    # scripts/ 是无 __init__ 的命名空间包，walk_packages 不展开：显式补扫
    import A_memorix.scripts as scripts_pkg  # noqa: PLC0415

    for info in pkgutil.iter_modules(scripts_pkg.__path__, prefix="A_memorix.scripts."):
        if info.name not in seen:
            seen.add(info.name)
            names.append(info.name)
    return names


def _expected_module_names_from_disk() -> set[str]:
    """磁盘 *.py 清单 → 期望模块名集合（__init__.py 折叠为包名，含包根）。"""

    expected = {"A_memorix"}
    for py_file in sorted(TREE_ROOT.rglob("*.py")):
        if "__pycache__" in py_file.parts:
            continue
        parts = list(py_file.relative_to(TREE_ROOT).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        expected.add("A_memorix" + ("." + ".".join(parts) if parts else ""))
    return expected


def test_import_sweep_whole_tree():
    """全树逐模块 import；导入集与磁盘文件清单精确一致，任何异常都失败。"""

    failures = []
    imported = {"A_memorix"}
    for module_name in _sweep_module_names():
        try:
            importlib.import_module(module_name)
            imported.add(module_name)
        except Exception as exc:  # noqa: BLE001（收集全部异常类型）
            failures.append(f"{module_name}: {type(exc).__name__}: {exc}")

    assert not failures, "import-sweep 失败:\n" + "\n".join(failures)

    expected = _expected_module_names_from_disk()
    missing = expected - imported
    extra = imported - expected
    assert not missing, f"磁盘上存在但未被扫描导入的模块: {sorted(missing)}"
    assert not extra, f"被导入但磁盘无对应文件的模块: {sorted(extra)}"


def test_no_silent_fallback_during_sweep():
    """扫描不允许落入宽松占位（命中即说明有宿主依赖没桩到）。"""

    hits = host_stubs.get_fallback_hits()
    assert hits == [], "宽松占位命中（应补显式桩）: " + ", ".join(f"{m}.{a}" for m, a in hits)


def test_strict_mode_rejects_unknown_src():
    """默认严格模式：未桩 src.* 导入 ImportError、find_spec 探测 None。"""

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("src.never_stubbed_module_zz")
    assert importlib.util.find_spec("src.never_stubbed_module_zz") is None


def test_lenient_mode_warn_placeholder(monkeypatch):
    """NEKO_STUBS_LENIENT=1：未桩 src.* 给 WARN 占位并记录 fallback_hits。"""

    monkeypatch.setenv("NEKO_STUBS_LENIENT", "1")
    try:
        module = importlib.import_module("src.lenient_probe_module_zz")
        placeholder = module.some_attr
        assert "src.lenient_probe_module_zz" in repr(placeholder)
        hits = host_stubs.get_fallback_hits()
        assert ("src.lenient_probe_module_zz", "some_attr") in hits
    finally:
        sys.modules.pop("src.lenient_probe_module_zz", None)
        host_stubs.reset_fallback_hits()


def test_subprocess_entry_contract():
    """独立进程按真实启动顺序安装并导入关键入口（含惰性 scripts 别名）。"""

    script = "\n".join(
        [
            "import host_stubs",
            "host_stubs.install()",
            "import A_memorix.host_service",
            "import A_memorix.plugin",
            "import A_memorix.core.runtime.sdk_memory_kernel",
            "import _bootstrap",  # 惰性别名：此刻才加载 A_memorix.scripts._bootstrap
            "assert _bootstrap.DEFAULT_DATA_DIR",
            "from src.config.config import global_config",
            "assert global_config.a_memorix.plugin.enabled is True",
            "print('ENTRY_OK')",
        ]
    )
    env = dict(os.environ)
    env.pop("NEKO_STUBS_LENIENT", None)
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"
    assert "ENTRY_OK" in result.stdout


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

    logger = get_logger("A_Memorix.Test")
    assert logger.name == "A_Memorix.Test"


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
