# neko-mem-client

N.E.K.O memory_server 的统一 HTTP 客户端（Python 3.11，仅依赖 httpx）。
封装 settle 管线四端点（cache/process/renew/settle）与读取三端点
（new_dialog/query_memory/health），契约同源于
`/mnt/shared/_Projects/N.E.K.O/neko-services/docs/design/neko-access-audit.md` §1。

核心行为：

- **强制检查 body 的 status 字段**——memory_server 写入端点失败时返回
  HTTP 200 + `{"status": "error", "message": ...}`（200+error 反模式），
  只看 HTTP 状态码会把失败当成功，本客户端一律拦截；
- **失败四分类异常**：`MemServerUnreachable`（连接层）/ `MemServerError`
  （body status:error 或 HTTP 非 2xx，携带服务端 message）/ 
  `MemServerTimeout` / `MemServerBadResponse`（body 无法按契约解析）；
- **request_id**：每个请求生成 uuid4 短形（12 hex），注入
  `X-Request-Id` header（服务端当前忽略，为未来留痕预留）与 debug 日志
  （logger `neko_mem_client`），异常对象携带同一 request_id；
- **超时可配**：默认 5s 对齐上游 `cross_server._post_memory_server`，
  per-call 可覆盖（LLM 端点建议 30s，见下表）。

## 端点契约速览

契约表代码化于 `neko_mem_client/contract.py`（`CONTRACTS`），下表为其摘要；
测试 `tests/test_contract.py` 会解析 audit 文档原文做逐字段同源核对。

| 端点 | Method/Path | 成功 body | 时机（节奏） | 幂等 | 重试安全 | 建议超时 |
|---|---|---|---|---|---|---|
| cache | POST `/cache/{name}` | `{"status":"cached","count":N}` | 每轮 turn 结束（增量） | 否 | 否 | 5s |
| process | POST `/process/{name}` | `{"status":"processed"}` | 会话结束、有增量 | 否 | 否 | 30s |
| renew | POST `/renew/{name}` | `{"status":"processed"}` | 会话重开（热重置）、有增量；持 settle_lock | 否 | 否 | 30s |
| settle | POST `/settle/{name}` | `{"status":"settled"}` | 热重置/会话结束、0 增量；wechat 清理前 | 近似* | 谨慎 | 30s |
| new_dialog | GET `/new_dialog/{name}` | PlainText（persona 记忆层） | 每次 start_session | 否** | 否 | 5s |
| query_memory | POST `/query_memory/{name}` | `{results,query,candidates_total,elapsed_ms}` | recall_memory 检索 | 是 | 是 | 5s |
| health | GET `/health` | JSON 带 INSTANCE_ID 指纹 | 探活 | 是 | 是 | 5s |

\* 空增量（`input_history="[]"`）结算近似幂等；带增量路径含 LLM 摘要。
\*\* 非纯读：写 prompt-locale、持 settle_lock（audit §1.2）。

写入四端点 body 统一为 HistoryRequest：
`{"input_history": "<JSON 序列化的 messages 数组字符串>", "language"?, "render_language"?}`；
`language` 与 `render_language` 互斥、仅发其一（对齐上游 wire 规则）。

## 使用示例

### 同步调用

```python
from neko_mem_client import MemoryServerClient

messages = [
    {"role": "user", "content": "早上好"},
    {"role": "assistant", "content": "早上好呀！"},
]

with MemoryServerClient() as mem:          # 默认 http://127.0.0.1:48912，5s 超时
    # turn 结束：轻量持久化（无前台 LLM）
    result = mem.cache("neko", messages)
    print(result["status"], result["count"])   # cached 2

    # 会话结束、0 增量：结算已 cache 的增量（含 LLM 摘要，放宽超时）
    mem.settle("neko", timeout=30.0)

    # 检索与 persona 记忆层
    hits = mem.query_memory("neko", query="我们聊过什么？")
    persona = mem.new_dialog("neko")
```

### 异步调用

```python
from neko_mem_client import AsyncMemoryServerClient

async with AsyncMemoryServerClient() as mem:
    await mem.cache("neko", messages)               # turn 结束
    await mem.process("neko", messages, timeout=30.0)   # 会话结束、有增量
    hits = await mem.query_memory("neko", query="hi")
    fingerprint = await mem.health()

# 也可注入进程级共享连接池（生命周期归调用方）：
# import httpx
# shared = httpx.AsyncClient(trust_env=False)
# mem = AsyncMemoryServerClient(client=shared)
```

### 错误处理

```python
from neko_mem_client import (
    MemClientError, MemServerBadResponse, MemServerError,
    MemServerTimeout, MemServerUnreachable,
)

try:
    result = mem.cache("neko", messages)
except MemServerUnreachable as e:
    ...  # 连接层失败：memory_server 未启动/已退出——可提示用户或静默降级
except MemServerTimeout as e:
    ...  # 超时：写入端点非幂等，勿盲目重发（可能重复入库），先探活再决定
except MemServerError as e:
    ...  # 服务端明确报错（200+status:error 或 HTTP 4xx/5xx）
    log.warning("memory server: %s (rid=%s)", e.server_message, e.request_id)
except MemServerBadResponse as e:
    ...  # 契约漂移：body 无法解析/成功值不在契约集——fail loud，需人工排查
# 所有异常都继承 MemClientError，可一网打尽；均携带
# e.request_id / e.endpoint / e.lanlan_name 便于对日志
```

## settle 管线节奏（照抄 audit §1.1）

- turn 结束 → `/cache`（增量）
- 会话重开（热重置）→ `/renew`（有增量）或 `/settle`（0 增量）
- 会话结束 → `/process`（有增量）或 `/settle`（0 增量）

## 迁移指南（N.E.K.O 侧，后续分支实施）

本客户端替代上游散落各处的裸 `httpx` 调用与 `raise_for_status` 模式。
`raise_for_status` 只查 HTTP 状态码，拦不住 200+`status:"error"` 反模式，
且异常不区分连接层/超时/契约漂移——迁移后统一由四分类异常承载。

### wechat_integration 三 helper

文件：
`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/wechat_integration/__init__.py`（730-770 行附近）

| 现有 helper（行号） | 现行为 | 迁移映射 |
|---|---|---|
| `_fetch_memory_context`（约 731-749） | 裸 `httpx.AsyncClient` GET `/new_dialog/{her_name}`，`is_success` 判定，异常整体吞掉返回 None | `await mem.new_dialog(her_name)`；调用方按需 catch `MemClientError` 决定是否降级为 None |
| `_cache_memory_delta`（约 751-768） | 裸 POST `/cache`，`is_success` 判定，异常吞掉 | `await mem.cache(her_name, messages)` |
| `_settle_memory_session`（约 771-795） | 裸 POST `/settle`，`input_history="[]"`，timeout=30，`is_success` | `await mem.settle(her_name, timeout=30.0)`（空增量为默认行为） |

三个 helper 共同的「异常整体吞掉」语义由调用方保留：客户端负责把失败
变成带 request_id 的四分类异常，是否降级仍由通道侧决定。

### qq_auto_reply memory_bridge 的 raise_for_status 调用点

文件：
`/mnt/shared/_Projects/N.E.K.O/N.E.K.O/plugin/plugins/qq_auto_reply/memory_bridge.py`
（该文件每个方法一处 `raise_for_status`，合计 14 处；行号以当前 main 为准）

**直接映射到本客户端的 3 处**（非 `/internal/*` 端点）：

| 方法（行号） | 端点 | 迁移映射 |
|---|---|---|
| `fetch_bootstrap_memory`（102-106） | GET `/new_dialog/{her_name}` | `await mem.new_dialog(her_name)` |
| `query_relevant_memory`（217-222） | POST `/query_memory/{her_name}`（带 query/time/subjects/language） | `await mem.query_memory(her_name, query=..., time=..., subjects=..., language=...)`，`raw_results`/`elapsed_ms` 从返回 dict 取 |
| `post_memory_history`（293-300） | POST `/{endpoint}/{her_name}`（cache/process/renew/settle 泛化封装） | 按节奏改调 `mem.cache/process/renew/settle`；如需保留泛化入口，可用 `getattr(mem, endpoint)(...)`——四个方法签名一致 |

**其余 11 处为 `/internal/*` scoped 端点**（129-134 scoped_context、148-153
scoped_mentions、167-172 scoped_forget、344-349 scoped_history、368-379
legacy_speaker_trust、398-409 identity/scope、429-439 bind、452-457
ensure、471-479 unbind、490-495 speaker_profile、549-556
scoped_history_batch）：本客户端 v1 按契约范围只覆盖 audit §1.1/§1.2 的
统一端点，`/internal/*`（audit §1.3）留待后续分支扩展（届时在
`contract.py` 增加契约项、客户端加对应方法即可，模式与现有七端点相同）。

### 迁移收益清单

- 200+`status:"error"` 不再被 `is_success`/`raise_for_status` 漏判；
- 连接拒绝 / 超时 / 服务端错误 / 契约漂移四分类，调用方可差异化降级
  （如：Unreachable→提示记忆服务离线，Timeout→不重发只告警）；
- request_id 贯穿 header 与日志，跨进程排障可追踪；
- body 构造集中一处（`input_history` JSON 序列化 + language 互斥规则），
  不再各通道手拼。

## 开发

```bash
cd /mnt/shared/_Projects/N.E.K.O/neko-services/.worktrees/p1-1-mem-client/mem-client
uv venv --python 3.11
uv sync
uv run pytest
```

测试全部基于 `httpx.MockTransport`（无真实网络、无端口绑定），并解析
audit 文档原文与契约表做同源断言。
