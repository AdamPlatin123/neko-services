"""memory_server 端点契约表（单一事实源，供测试断言与文档同源）。

契约来源：``docs/design/neko-access-audit.md`` §1（2026-09-19 代码级盘点）。
写入端点的 success_statuses 已对照 ``app/memory_server/routes.py``
（cache→routes.py:912 / process→routes.py:990 / renew→routes.py:1053 /
settle→routes.py:1113）逐端点核实：

- /cache    成功返回 ``{"status": "cached", "count": N}``   （routes.py:984）
- /process  成功返回 ``{"status": "processed"}``             （routes.py:1048）
- /renew    成功返回 ``{"status": "processed"}``             （routes.py:1108）
- /settle   成功返回 ``{"status": "settled"}``               （routes.py:1162）
- 四端点失败一律 HTTP 200 + ``{"status": "error", "message": ...}``
  （routes.py:987/1051/1110/1165）——**200+error 反模式**，客户端必须
  强制检查 body 的 status 字段，不能只看 HTTP 状态码。

服务监听 127.0.0.1:48912（config/network.py:160-168 的 MEMORY_SERVER），
无鉴权，纯 http 回环直连。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class EndpointContract:
    """单个 memory_server 端点的完整契约描述。

    字段与 audit 文档 §1 的表格列一一对应；``idempotent`` / ``retry_safe``
    是依据 side_effects 推导的客户端侧语义（audit 未直接给出，推导理由
    写在 notes）。
    """

    #: 端点短名（客户端方法名后缀），如 "cache"
    endpoint: str
    #: HTTP 方法
    method: str
    #: 路径模板，``{name}`` 为经 URL quote 编码的 lanlan_name 段
    path_template: str
    #: 请求体构造说明（HistoryRequest / QueryMemoryRequest / 无 body）
    body_spec: str
    #: 写入管线端点：body ``status`` 字段的合法成功值集合；
    #: 读取端点（new_dialog/health）无此语义，为空元组
    success_statuses: tuple[str, ...]
    #: 成功响应形状描述
    response_shape: str
    #: 服务端副作用（audit §1.1「做什么」列）
    side_effects: str
    #: 调用方与时机（audit §1.1「调用方与时机」列 / §1.2「调用方」列）
    caller_rhythm: str
    #: 相同请求重复执行是否幂等（只读端点=True；写入端点见 notes）
    idempotent: bool
    #: 失败后盲目重发是否安全（True=可无条件重试）
    retry_safe: bool
    #: 幂等/重试推导理由与交叉验证备注
    notes: str = ""


#: settle 管线的确切节奏（audit §1.1「确切节奏（照抄）」）。
#: turn 结束 → /cache（增量）；会话重开（热重置）→ /renew（有增量）或
#: /settle（0 增量）；会话结束 → /process（有增量）或 /settle（0 增量）。
SETTLE_RHYTHM: str = (
    "turn 结束 → /cache（增量）；"
    "会话重开（热重置）→ /renew（有增量）或 /settle（0 增量）；"
    "会话结束 → /process（有增量）或 /settle（0 增量）"
)

#: HistoryRequest 公共请求体说明（audit §1.1，routes.py:75）：
#: ``{input_history: str(JSON 序列化的 messages 数组), language?, render_language?}``
HISTORY_REQUEST_SPEC: str = (
    "{input_history: str(JSON 序列化的 messages 数组), language?, render_language?}"
)

_HISTORY_BODY = (
    "HistoryRequest: " + HISTORY_REQUEST_SPEC
    + "；language 与 render_language 互斥（仅发其一，对齐"
    " cross_server._post_memory_server 的 wire 规则）"
)

_CACHE_CONTRACT = EndpointContract(
    endpoint="cache",
    method="POST",
    path_template="/cache/{name}",
    body_spec=_HISTORY_BODY,
    success_statuses=("cached",),
    response_shape='{"status": "cached", "count": int}',
    side_effects=(
        "轻量持久化：update_history(compress=False) + time store"
        "（SQLite INSERT）+ outbox 事后信号（计数/复读嗅探/check_feedback）；"
        "无前台 LLM（Stage-1 事实抽取由后台 _periodic_signal_extraction_loop 批处理）"
    ),
    caller_rhythm="每轮 turn 结束（cross_server run_sync_connector；wechat_integration 每轮回复后）",
    idempotent=False,
    retry_safe=False,
    notes=(
        "每次调用生成新 uid 写 time store，重放会追加重复对话行——"
        "超时后盲目重试可能重复入库，需先确认服务端已写入再决定重试"
    ),
)

_PROCESS_CONTRACT = EndpointContract(
    endpoint="process",
    method="POST",
    path_template="/process/{name}",
    body_spec=_HISTORY_BODY,
    success_statuses=("processed",),
    response_shape='{"status": "processed"}',
    side_effects=(
        "带 LLM 摘要压缩 + store + outbox + review；"
        "首个 /process 触发向量 warmup（setflag 非阻塞）"
    ),
    caller_rhythm="会话结束且【有增量】时（cross_server session end）",
    idempotent=False,
    retry_safe=False,
    notes="LLM 摘要压缩与落盘重复执行会重复消耗与追加；涉及 LLM 时建议超时上调",
)

_RENEW_CONTRACT = EndpointContract(
    endpoint="renew",
    method="POST",
    path_template="/renew/{name}",
    body_spec=_HISTORY_BODY,
    success_statuses=("processed",),
    response_shape='{"status": "processed"}',
    side_effects=(
        "同 process（LLM 摘要压缩 + store + outbox + review），"
        "但持 settle_lock——阻塞 /new_dialog 直到摘要落盘"
    ),
    caller_rhythm="会话重开（热重置）且【有增量】时（cross_server 热重置）",
    idempotent=False,
    retry_safe=False,
    notes=(
        "成功 status 为 processed 而非 renewed（routes.py:1108 实测核对）；"
        "settle_lock 期间并发 /new_dialog 会被阻塞，重试需注意锁窗口"
    ),
)

_SETTLE_CONTRACT = EndpointContract(
    endpoint="settle",
    method="POST",
    path_template="/settle/{name}",
    body_spec=_HISTORY_BODY,
    success_statuses=("settled",),
    response_shape='{"status": "settled"}',
    side_effects="结算已通过 /cache 持久化的增量：摘要 + 时间戳",
    caller_rhythm="热重置/会话结束且【增量=0】时；wechat 会话清理前（5 分钟无活动）",
    idempotent=False,
    retry_safe=False,
    notes=(
        "主节奏下 settle 总是空增量（input_history=[]，wechat 同款）；"
        "空增量结算近似幂等，但带增量的 settle 路径含 LLM 摘要故整体标非幂等；"
        "wechat 实现对该端点用 30s 超时（含 LLM 摘要耗时）"
    ),
)

_NEW_DIALOG_CONTRACT = EndpointContract(
    endpoint="new_dialog",
    method="GET",
    path_template="/new_dialog/{name}",
    body_spec="无请求体（GET）",
    success_statuses=(),
    response_shape=(
        "PlainTextResponse：persona markdown + 内心活动 + recent history"
        "（`名 | 文本` 行）+ gap 提示 + 节假日（分段顺序为 prefix cache 优化）"
    ),
    side_effects="非纯读：写 prompt-locale、持 settle_lock",
    caller_rhythm="每次 start_session（lifecycle.py:1519）；wechat_integration 首次会话（:740）",
    idempotent=False,
    retry_safe=False,
    notes=(
        "响应是纯文本而非 JSON，不适用 body status 检查；"
        "locale 写入与 settle_lock 是隐性副作用，重复调用主要代价是重复渲染"
    ),
)

_QUERY_MEMORY_CONTRACT = EndpointContract(
    endpoint="query_memory",
    method="POST",
    path_template="/query_memory/{name}",
    body_spec=(
        "QueryMemoryRequest: {query?, time?, subjects?[]}——query/time 至少给"
        "一个有效值；subjects 显式空列表=无授权主体（fail-closed 返回空），"
        "省略(None)=legacy 私话语料；1..8 条"
    ),
    success_statuses=(),
    response_shape=(
        "{results: [], query: str, candidates_total: int, elapsed_ms: float}"
        "——hybrid_recall/recall_by_time 结构化结果；失败永返空（空 results 兜底）"
    ),
    side_effects="只读：BM25 + 向量并行召回 + RRF 融合（recall_memory 工具的数据源）",
    caller_rhythm="recall_memory 工具调用时（tool_calling.py:292）",
    idempotent=True,
    retry_safe=True,
    notes="纯检索无写入；服务端承诺入参异常也返回空 results 而非 4xx",
)

_HEALTH_CONTRACT = EndpointContract(
    endpoint="health",
    method="GET",
    path_template="/health",
    body_spec="无请求体（GET，不带 lanlan_name）",
    success_statuses=(),
    response_shape="JSON 带 INSTANCE_ID 指纹（区分本服务与占用端口的无关进程）",
    side_effects="无（只读探活）",
    caller_rhythm="启动器/前端探活、启动就绪判定",
    idempotent=True,
    retry_safe=True,
    notes="带 INSTANCE_ID 签名（runtime.py:305 build_health_response）",
)


#: 全部已封装端点的契约注册表，键为 endpoint 短名
CONTRACTS: dict[str, EndpointContract] = {
    c.endpoint: c
    for c in (
        _CACHE_CONTRACT,
        _PROCESS_CONTRACT,
        _RENEW_CONTRACT,
        _SETTLE_CONTRACT,
        _NEW_DIALOG_CONTRACT,
        _QUERY_MEMORY_CONTRACT,
        _HEALTH_CONTRACT,
    )
}

#: 写入管线（settle 管线）四端点的固定顺序（audit §1.1 表格行序）
WRITE_PIPELINE_ENDPOINTS: tuple[str, ...] = ("cache", "process", "renew", "settle")

#: 读取端点
READ_ENDPOINTS: tuple[str, ...] = ("new_dialog", "query_memory", "health")

#: 每端点建议超时（秒）：默认 5.0 对齐上游 _post_memory_server；
#: settle 带 LLM 摘要，wechat 参考实现用 30.0
SUGGESTED_TIMEOUTS: dict[str, float] = {
    "cache": 5.0,
    "process": 30.0,
    "renew": 30.0,
    "settle": 30.0,
    "new_dialog": 5.0,
    "query_memory": 5.0,
    "health": 5.0,
}
