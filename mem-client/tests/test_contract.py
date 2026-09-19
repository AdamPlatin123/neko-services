"""契约表内容测试 + 与 docs/design/neko-access-audit.md §1 的同源核对。

同源核对的意义：audit 文档是契约的权威源，CONTRACTS 是代码侧单一事实源；
本文件解析 audit 原文做逐字段比对，任何一侧漂移都会在这里 fail loud。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from neko_mem_client import (
    CONTRACTS,
    READ_ENDPOINTS,
    SETTLE_RHYTHM,
    WRITE_PIPELINE_ENDPOINTS,
)
from neko_mem_client.client import MemoryServerClient

AUDIT_PATH = (
    Path(__file__).resolve().parents[2] / "docs" / "design" / "neko-access-audit.md"
)


@pytest.fixture(scope="module")
def audit_text() -> str:
    assert AUDIT_PATH.exists(), f"audit doc missing: {AUDIT_PATH}"
    return AUDIT_PATH.read_text(encoding="utf-8")


# ── 注册表结构 ────────────────────────────────────────────────────


def test_registry_covers_all_seven_endpoints() -> None:
    assert set(CONTRACTS) == {
        "cache", "process", "renew", "settle",
        "new_dialog", "query_memory", "health",
    }
    assert set(WRITE_PIPELINE_ENDPOINTS) == {"cache", "process", "renew", "settle"}
    assert set(READ_ENDPOINTS) == {"new_dialog", "query_memory", "health"}


def test_write_pipeline_success_statuses_match_routes_py() -> None:
    """成功 status 逐端点核对（routes.py:984/1048/1108/1162 实测值）。"""
    assert CONTRACTS["cache"].success_statuses == ("cached",)
    assert CONTRACTS["process"].success_statuses == ("processed",)
    assert CONTRACTS["renew"].success_statuses == ("processed",)
    assert CONTRACTS["settle"].success_statuses == ("settled",)


def test_read_endpoints_have_no_write_status() -> None:
    for name in READ_ENDPOINTS:
        assert CONTRACTS[name].success_statuses == ()


def test_idempotency_classification() -> None:
    # 纯只读端点：幂等且可安全重试
    for name in ("query_memory", "health"):
        assert CONTRACTS[name].idempotent, f"{name} should be idempotent (read-only)"
        assert CONTRACTS[name].retry_safe
    # 写入端点：非幂等（详见各 notes）
    for name in WRITE_PIPELINE_ENDPOINTS:
        assert not CONTRACTS[name].idempotent
        assert not CONTRACTS[name].retry_safe
    # new_dialog 虽是读取端点，但 audit §1.2 注明其写 prompt-locale、持
    # settle_lock——非幂等
    assert not CONTRACTS["new_dialog"].idempotent
    assert not CONTRACTS["new_dialog"].retry_safe


# ── 与 audit 文档同源核对 ─────────────────────────────────────────


def test_every_contract_method_path_appears_in_audit(audit_text: str) -> None:
    """CONTRACTS 的 (method, path_template) 必须能在 audit §1 的表格行中
    找到完全一致的 ``METHOD `/path` `` 片段（audit 表格中 method 为裸文本、
    path 单独包反引号）。health 例外：audit 只在 §1.3 汇总格以
    `` `/health`（带 INSTANCE_ID 指纹） `` 形式提及（method GET 来自
    runtime.py:305 的 ``@app.get("/health")``，已在契约 notes 记录）。"""
    for name, contract in CONTRACTS.items():
        if name == "health":
            assert "`/health`（带 INSTANCE_ID 指纹）" in audit_text
            continue
        needle = f"{contract.method} `{contract.path_template}`"
        assert needle in audit_text, (
            f"contract {name}: {needle!r} not found in audit doc "
            "(contract drifted from docs/design/neko-access-audit.md §1)"
        )


def test_audit_section_11_rows_match_write_pipeline(audit_text: str) -> None:
    """§1.1 表格的四个写入端点行（method+path+处理函数）逐行在场。"""
    for fragment in (
        "| POST `/cache/{name}` | cache_conversation（routes.py:912）",
        "| POST `/process/{name}` | process_conversation（routes.py:990）",
        "| POST `/renew/{name}` | process_conversation_for_renew（routes.py:1053）",
        "| POST `/settle/{name}` | settle_conversation（routes.py:1113）",
    ):
        assert fragment in audit_text, f"audit §1.1 row missing: {fragment!r}"


def test_audit_section_12_rows_match_read_endpoints(audit_text: str) -> None:
    for fragment in (
        "| GET `/new_dialog/{name}` |",
        "| POST `/query_memory/{name}` |",
    ):
        assert fragment in audit_text, f"audit §1.2 row missing: {fragment!r}"
    assert "`/health`（带 INSTANCE_ID 指纹）" in audit_text


def test_settle_rhythm_matches_audit_verbatim(audit_text: str) -> None:
    """SETTLE_RHYTHM 必须与 audit §1.1「确切节奏（照抄）」句的端点序列一致：
    cache → renew → settle → process → settle。"""
    rhythm_row = next(
        line for line in audit_text.splitlines() if "确切节奏（照抄）" in line
    )
    audit_order = re.findall(r"`/(cache|renew|settle|process)`", rhythm_row)
    assert audit_order == ["cache", "renew", "settle", "process", "settle"]
    rhythm_order = re.findall(r"/(cache|renew|settle|process)", SETTLE_RHYTHM)
    assert rhythm_order == audit_order


def test_history_request_spec_matches_audit(audit_text: str) -> None:
    """HistoryRequest 形状（audit §1.1 首段）与 build_history_payload 行为一致。"""
    assert "`{input_history: str(JSON序列化的messages数组), language?, render_language?}`" in audit_text
    messages = [{"role": "user", "content": "hi"}]
    payload = MemoryServerClient.build_history_payload(messages)
    # input_history 是 JSON 序列化的 messages 数组【字符串】，可 round-trip
    assert isinstance(payload["input_history"], str)
    assert json.loads(payload["input_history"]) == messages
    # language / render_language 互斥：仅发其一，优先 language
    both = MemoryServerClient.build_history_payload(
        messages, language="zh-CN", render_language="en"
    )
    assert both.get("language") == "zh-CN" and "render_language" not in both
    only_render = MemoryServerClient.build_history_payload(
        messages, render_language="en"
    )
    assert only_render.get("render_language") == "en" and "language" not in only_render
    neither = MemoryServerClient.build_history_payload(messages)
    assert "language" not in neither and "render_language" not in neither


def test_query_memory_contract_matches_audit(audit_text: str) -> None:
    assert "`QueryMemoryRequest{query?, time?, subjects?[]}`" in audit_text
    assert "{results:[], query, candidates_total, elapsed_ms}" in audit_text
    assert "失败永返空" in CONTRACTS["query_memory"].response_shape, (
        "query_memory 契约必须保留 audit 原词「失败永返空」"
    )


def test_side_effects_carry_audit_key_facts() -> None:
    """契约表 side_effects 保留 audit §1.1 的关键事实锚点。"""
    assert "update_history(compress=False)" in CONTRACTS["cache"].side_effects
    assert "无" in CONTRACTS["cache"].side_effects and "LLM" in CONTRACTS["cache"].side_effects
    assert "settle_lock" in CONTRACTS["renew"].side_effects
    assert "摘要" in CONTRACTS["process"].side_effects
    assert "摘要" in CONTRACTS["settle"].side_effects
    assert "prompt-locale" in CONTRACTS["new_dialog"].side_effects
    assert "RRF" in CONTRACTS["query_memory"].side_effects
