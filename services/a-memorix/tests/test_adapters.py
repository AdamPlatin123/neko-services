"""真实适配器测试（P0-1b #3）：OpenAI 兼容 chat / embeddings 出口。

假端点 = tests/conftest.py 的 fake_openai_server（真 HTTP，openai SDK 全链路）。
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import build_service_toml, swap_service_config


# ---------------------------------------------------------------------------
# 配置解析链
# ---------------------------------------------------------------------------


def test_resolve_task_full_chain(tmp_path, fake_openai_server):
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from adapters.openai_compat import resolve_task

        resolved, reason = resolve_task("memory")
        assert resolved is not None, reason
        assert resolved.model_name == "chat"
        assert resolved.model_identifier == "fake-chat-model"
        assert resolved.provider_name == "default"
        assert resolved.base_url == fake_openai_server.base_url


def test_resolve_task_unconfigured_reasons(tmp_path):
    with swap_service_config("", tmp_path):  # 空 toml → 全部环节缺失
        from adapters.openai_compat import resolve_task

        resolved, reason = resolve_task("memory")
        assert resolved is None
        assert "未配置模型任务" in reason

        resolved, reason = resolve_task("embedding")
        assert resolved is None
        assert "embedding" in reason


def test_model_config_status_warns_when_unconfigured(tmp_path, caplog):
    with swap_service_config("", tmp_path):
        from adapters.openai_compat import model_config_status

        status = model_config_status()
        assert status["chat_ready"] is False
        assert status["embedding_ready"] is False
        assert any("api_providers" in item for item in status["warnings"])
        assert any("embedding" in item for item in status["warnings"])


def test_model_config_status_ready(tmp_path, fake_openai_server):
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from adapters.openai_compat import model_config_status

        status = model_config_status()
        assert status["chat_ready"] is True
        assert status["embedding_ready"] is True
        assert status["warnings"] == []


# ---------------------------------------------------------------------------
# LLM 出口（src.services.llm_service 面）
# ---------------------------------------------------------------------------


def _run(coro):
    return asyncio.run(coro)


def test_llm_generate_against_fake_openai(tmp_path, fake_openai_server):
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from src.services import llm_service as llm_api

        request = llm_api.LLMServiceRequest(
            task_name="memory",
            request_type="test",
            prompt="请总结这段记忆",
        )
        result = _run(llm_api.generate(request))
        assert result.success is True, result.error
        assert "summary" in result.completion.response
        assert result.completion.model_name == "fake-chat-model"
        assert result.completion.total_tokens == 15

        # 假端点确实收到了 OpenAI 兼容请求
        chat_requests = [item for item in fake_openai_server.requests if item[0].endswith("/chat/completions")]
        assert chat_requests, "假端点未收到 chat 请求"
        assert chat_requests[-1][1]["model"] == "fake-chat-model"
        assert chat_requests[-1][1]["messages"][0]["content"] == "请总结这段记忆"


def test_llm_generate_unconfigured_returns_error_result(tmp_path):
    with swap_service_config("", tmp_path):
        from src.services import llm_service as llm_api

        request = llm_api.LLMServiceRequest(task_name="memory", request_type="test", prompt="hi")
        result = _run(llm_api.generate(request))
        assert result.success is False
        assert "LLM 任务不可用" in (result.error or "")


def test_llm_client_generate_response_and_single_model_path(tmp_path, fake_openai_server):
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from host_stubs.config_stubs import TaskConfig
        from src.services.llm_service import LLMServiceClient, LLMGenerationOptions

        client = LLMServiceClient(task_name="utils", request_type="test")
        completion = _run(client.generate_response(prompt="你好", options=LLMGenerationOptions(temperature=0.1)))
        assert completion.response  # 假端点返回的 canned JSON 文本
        assert completion.model_name == "fake-chat-model"

        # model_routing 单模型路径：设置 _orchestrator.model_for_task 后仍可用
        client._orchestrator.model_for_task = TaskConfig(model_list=["chat"])  # noqa: SLF001（复刻 model_routing 的注入方式）
        completion = _run(client.generate_response(prompt="单模型"))
        assert completion.response


def test_llm_client_unconfigured_raises_runtime_error(tmp_path):
    """未配置任务：generate_response 抛 RuntimeError（调用侧均有 try/except 降级）。"""

    with swap_service_config("", tmp_path):
        from src.services.llm_service import LLMServiceClient

        client = LLMServiceClient(task_name="memory", request_type="test")
        with pytest.raises(RuntimeError, match="LLM 任务不可用"):
            _run(client.generate_response(prompt="hi"))


def test_llm_prompt_shapes(tmp_path, fake_openai_server):
    """str 与 message dict 列表两种 prompt 形态都归一化为 messages。"""

    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from src.services.llm_service import LLMServiceClient

        client = LLMServiceClient(task_name="memory", request_type="test")
        completion = _run(
            client.generate_response(
                prompt=[{"role": "system", "content": "你是记忆助手"}, {"role": "user", "content": "总结"}]
            )
        )
        assert completion.response
        sent = [item for item in fake_openai_server.requests if item[0].endswith("/chat/completions")][-1][1]
        assert sent["messages"][0]["role"] == "system"

        with pytest.raises(TypeError):
            _run(client.generate_response(prompt=12345))


# ---------------------------------------------------------------------------
# embedding 出口（client_registry 面）
# ---------------------------------------------------------------------------


def test_embedding_client_registry_face(tmp_path, fake_openai_server):
    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from host_stubs.config_stubs import ModelInfo, build_model_config
        from src.llm_models.model_client.base_client import EmbeddingRequest, client_registry

        model_cfg = build_model_config()
        provider = model_cfg.api_providers_dict["default"]
        client = client_registry.get_client_class_instance(provider)
        request = EmbeddingRequest(
            model_info=ModelInfo(name="emb", model_identifier="fake-embedding-model", api_provider="default"),
            embedding_input="今天天气很好",
            extra_params={},
        )
        response = _run(client.get_embedding(request))
        vector = list(response.embedding)
        assert len(vector) == 256
        assert any(abs(item) > 1e-6 for item in vector)  # 非零
        norm = sum(item * item for item in vector) ** 0.5
        assert abs(norm - 1.0) < 1e-4  # L2 归一

        # 同文本同向量（确定性，闭环检索的前提）
        response2 = _run(client.get_embedding(request))
        assert list(response2.embedding) == vector

        embedding_requests = [item for item in fake_openai_server.requests if item[0].endswith("/embeddings")]
        assert embedding_requests
        assert embedding_requests[-1][1]["model"] == "fake-embedding-model"


def test_embedding_via_vendored_adapter(tmp_path, fake_openai_server):
    """vendored EmbeddingAPIAdapter（零改动）+ 真 registry 面 → 端到端 encode。"""

    toml_text = build_service_toml(data_dir=tmp_path / "data", api_base_url=fake_openai_server.base_url)
    with swap_service_config(toml_text, tmp_path):
        from A_memorix.core.embedding.api_adapter import create_embedding_api_adapter

        adapter = create_embedding_api_adapter(model_name="emb", default_dimension=256)
        matrix = _run(adapter.encode(["露娜在窗台上晒太阳", "露娜晒太阳"]))
        assert matrix.shape == (2, 256)
        similarity = float((matrix[0] * matrix[1]).sum())
        assert similarity > 0.5, f"共享字符文本应有较高余弦相似度: {similarity}"
        # 维度探测成功（打到假端点）
        assert adapter.get_embedding_dimension() == 256
