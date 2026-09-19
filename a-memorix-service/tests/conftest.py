"""服务层/适配器测试公共 fixtures（P0-1b）。

- ``fake_openai_server``：线程化假 OpenAI 兼容端点（/v1/embeddings +
  /v1/chat/completions），embedding 用字符袋确定性向量（同文本同向量、
  共享字符→高余弦相似，供闭环检索冒烟）。
- ``swap_service_config``：把 host_stubs 的配置单例换到临时 toml 并重建
  模块级 model_config / 适配器客户端缓存，退出时还原（进程级隔离）。
"""

from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest

# 本机桌面代理（v2rayA）会注入 ALL_PROXY 等 SOCKS 变量，httpx 默认 trust_env
# 会对回环假端点也走代理（socksio 缺失直接报错）——测试进程内显式绕过回环。
for _key in ("NO_PROXY", "no_proxy"):
    _current = os.environ.get(_key, "")
    if "127.0.0.1" not in _current:
        os.environ[_key] = ("127.0.0.1,localhost," + _current).strip(",")

FAKE_EMBEDDING_DIM = 256


def _char_bag_vector(text: str, dim: int = FAKE_EMBEDDING_DIM) -> List[float]:
    """确定性字符袋向量：相似文本（共享字符）→ 高余弦相似度。"""

    vec = [0.0] * dim
    for char in str(text or ""):
        vec[ord(char) % dim] += 1.0
    norm = sum(item * item for item in vec) ** 0.5
    if norm <= 0:
        vec[0] = 1.0
        norm = 1.0
    return [item / norm for item in vec]


class _FakeOpenAIHandler(BaseHTTPRequestHandler):
    """假 OpenAI 兼容 HTTP 端点。"""

    def log_message(self, *args: Any) -> None:  # 静音默认访问日志
        _ = args

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802（http.server 约定）
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            self._send_json(400, {"error": {"message": "invalid json"}})
            return
        self.server.requests.append((self.path, body))  # type: ignore[attr-defined]
        path = self.path.rstrip("/")
        if path.endswith("/embeddings"):
            self._send_json(200, self._embeddings_payload(body))
        elif path.endswith("/chat/completions"):
            self._send_json(200, self._chat_payload(body))
        else:
            self._send_json(404, {"error": {"message": f"unknown path: {self.path}"}})

    def _embeddings_payload(self, body: Dict[str, Any]) -> Dict[str, Any]:
        text = body.get("input")
        if not isinstance(text, str):
            text = json.dumps(text, ensure_ascii=False)
        return {
            "object": "list",
            "model": str(body.get("model") or "fake-embedding"),
            "data": [
                {
                    "object": "embedding",
                    "index": 0,
                    "embedding": _char_bag_vector(text, self.server.dim),  # type: ignore[attr-defined]
                }
            ],
            "usage": {"prompt_tokens": 1, "total_tokens": 1},
        }

    def _chat_payload(self, body: Dict[str, Any]) -> Dict[str, Any]:
        content = json.dumps({"summary": "测试用聊天总结", "entities": [], "relations": []}, ensure_ascii=False)
        return {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "model": str(body.get("model") or "fake-chat"),
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }


class FakeOpenAIServer:
    """持有 ThreadingHTTPServer 与请求记录的轻封装。"""

    def __init__(self) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOpenAIHandler)
        self.httpd.dim = FAKE_EMBEDDING_DIM  # type: ignore[attr-defined]
        self.httpd.requests: List[Tuple[str, Dict[str, Any]]] = []  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}/v1"

    @property
    def requests(self) -> List[Tuple[str, Dict[str, Any]]]:
        return self.httpd.requests  # type: ignore[no-any-return]

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def fake_openai_server() -> Iterator[FakeOpenAIServer]:
    server = FakeOpenAIServer()
    server.start()
    try:
        yield server
    finally:
        server.stop()


@contextmanager
def swap_service_config(toml_text: str, target_dir: Path) -> Iterator[Path]:
    """把服务配置换成临时 toml（含模块级 model_config 与适配器客户端重建）。"""

    from adapters.openai_compat import reset_clients
    from host_stubs import _config_loader
    from host_stubs.config_stubs import build_model_config, config_manager

    config_file = target_dir / "a_memorix.toml"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(toml_text, encoding="utf-8")

    old_state = _config_loader._state
    _config_loader._state = _config_loader.ConfigState(config_file)
    config_manager._model_config.replace_from(build_model_config())  # noqa: SLF001（测试隔离）
    reset_clients()
    try:
        yield config_file
    finally:
        _config_loader._state = old_state
        config_manager._model_config.replace_from(build_model_config())  # noqa: SLF001
        reset_clients()


def build_service_toml(
    *,
    data_dir: Path,
    api_base_url: str,
    api_key: str = "test-key",
    enabled: bool = True,
    embedding_dim: int = FAKE_EMBEDDING_DIM,
) -> str:
    """生成一份指向假 OpenAI 端点的服务配置 toml 文本。"""

    return f"""
[a_memorix.plugin]
enabled = {str(enabled).lower()}

[a_memorix.storage]
data_dir = "{data_dir}"

[a_memorix.embedding]
model_name = "emb"
dimension = {embedding_dim}

[[model.api_providers]]
name = "default"
base_url = "{api_base_url}"
api_key = "{api_key}"
client_type = "openai"

[[model.models]]
name = "emb"
model_identifier = "fake-embedding-model"
api_provider = "default"

[[model.models]]
name = "chat"
model_identifier = "fake-chat-model"
api_provider = "default"

[model.tasks.embedding]
model_list = ["emb"]
max_tokens = 4096
temperature = 0.3

[model.tasks.memory]
model_list = ["chat"]
max_tokens = 4096
temperature = 0.3

[model.tasks.utils]
model_list = ["chat"]
max_tokens = 4096
temperature = 0.3

[bot]
nickname = "N.E.K.O"
personality = ""
"""
