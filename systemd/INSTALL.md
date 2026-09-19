# systemd user unit 安装说明

> 对应 workplan P0-0 第 7 项部署裁决（代审后为三件套拓扑）。拓扑细节与
> 运维手册见 runbook：`/mnt/shared/_Projects/N.E.K.O/neko-services/README.md`
> 的「拓扑」节。

## 单元清单

| 文件 | 作用 | 端口 / service 字段 | 状态 |
| --- | --- | --- | --- |
| `neko-memory.service` | memory_server（中心记忆 HTTP） | 48912 / `memory` | 立即生效 |
| `neko-main.service` | main_server（桌面/对话主服务） | 48911 / `main` | 立即生效 |
| `neko-agent.service` | agent_server（agent/tool 服务，绑 TOOL_SERVER_PORT——历史命名） | 48915 / `agent` | 立即生效 |
| `neko-a-memorix.service` | a-memorix 记忆检索服务 | 48921（占位） | 占位——P0-1 服务化落地前 `ConditionPathExists` 不满足，start 显示 skipped，不产生报错 |
| `neko.target` | 总入口，`Wants=` 上述四个服务 | — | 立即生效 |

启动顺序对齐上游 `docker/entrypoint.sh` 先例：memory → main → agent
（unit 间用 `After=` 链表达；NapCat 由 qq_auto_reply 插件托管，stdout 接
日志文件供 `scripts/doctor.sh` 巡检，不设独立 unit）。

## ⚠️ 互斥警告：target 与桌面 launcher 二选一，勿同时

launcher（`uv run launcher.py`）启动时会探测 48911/48912/48915 三个默认
端口（`launcher_core/runtime.py` 的 `_validated_existing_backend_instance`）：

- 三口全部属于同一 N.E.K.O 实例（/health 的 `instance_id` 全同）→ attach
  复用，桌面前端直接连上 systemd 管理的三件套——这正是三 unit 共享
  `NEKO_INSTANCE_ID` 的目的；
- 三口空闲 → launcher 自己起一套子进程（多进程形态），与 systemd 三件套
  互不干扰，但**下次**再 start target 就会撞端口；
- **部分占用（最危险）**→ launcher 判定不齐三口，`apply_port_strategy`
  整套换 fallback 端口另起第二套——两套 memory_server 写同一数据根，
  造成记忆双写分裂。

因此：同一台机器上 `neko.target` 与桌面 launcher **要么二选一常驻，要么
先停再启**。切换顺序：

```bash
# launcher → target 切换：先完全退出桌面端（含托盘），再
systemctl --user start neko.target
# target → launcher 切换：
systemctl --user stop neko.target   # 三 unit 均设 PartOf=，一键全停
uv run launcher.py
```

桌面 launcher 场景若希望单进程形态（合并模式），用 `NEKO_MERGED=1
uv run launcher.py`（打包环境默认 merged；开发环境默认多进程，可用
`NEKO_MERGED=0/1` 显式覆盖——见 `launcher_core/runtime.py` 的
`_should_use_merged_mode`）。单进程形态同样占用三口，与 target 同样互斥。

## 安装步骤

```bash
# 0) 前置：N.E.K.O 仓库根先建好 venv（Python 3.11）
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O && uv sync

# 1) 生成部署唯一实例指纹（三 unit 共享；config/network.py:212 读
#    NEKO_INSTANCE_ID，未设则每进程随机——会导致三口指纹不齐、无法 attach）
python3 -c "import uuid; print(uuid.uuid4())"

# 2) 把生成的值写入三处 unit 的 NEKO_INSTANCE_ID=... 行（替换占位值，
#    三个文件必须是同一个值）：
#    systemd/neko-memory.service / neko-main.service / neko-agent.service
NEKO_INSTANCE_ID_UUID=<粘贴步骤1的输出>
for f in systemd/neko-memory.service systemd/neko-main.service systemd/neko-agent.service; do
    sed -i "s|^Environment=NEKO_INSTANCE_ID=.*|Environment=NEKO_INSTANCE_ID=${NEKO_INSTANCE_ID_UUID}|" "$f"
done

# 3) 拷贝单元到 systemd user 目录（源用绝对路径，不依赖当前目录）
NEKO_SERVICES=/mnt/shared/_Projects/N.E.K.O/neko-services   # 本仓库根，按实际位置调整
mkdir -p ~/.config/systemd/user
cp "${NEKO_SERVICES}/systemd/neko-memory.service" \
   "${NEKO_SERVICES}/systemd/neko-main.service" \
   "${NEKO_SERVICES}/systemd/neko-agent.service" \
   "${NEKO_SERVICES}/systemd/neko-a-memorix.service" \
   "${NEKO_SERVICES}/systemd/neko.target" \
   ~/.config/systemd/user/

# 4) 重载并启用
systemctl --user daemon-reload
systemctl --user enable --now neko.target

# 5) 验证：三口 /health 的 instance_id 必须完全一致
systemctl --user status neko.target
for p in 48911 48912 48915; do curl -s "http://127.0.0.1:${p}/health" | grep -o '"instance_id":"[^"]*"'; done
/mnt/shared/_Projects/N.E.K.O/neko-services/scripts/doctor.sh
```

## 日常操作

```bash
systemctl --user start neko.target       # 一键冷启三件套（验收目标 <2 分钟）
systemctl --user stop neko.target        # 一键全停（三 unit PartOf= 联动生效）
systemctl --user restart neko-memory.service
journalctl --user -u neko-memory.service -f   # 跟日志（main/agent 同理）
```

## 路径说明（迁移到其他机器时）

单元内路径写死为 `/mnt/shared/_Projects/N.E.K.O/N.E.K.O`（N.E.K.O 子项目
仓库根）与 `/mnt/shared/_Projects/N.E.K.O/neko-services`（本仓库），systemd
user unit 不支持外部环境变量展开。迁移时对 `~/.config/systemd/user/` 下已
拷贝的单元做前缀替换：

```bash
sed -i 's|/mnt/shared/_Projects/N.E.K.O/N.E.K.O|<新的N.E.K.O仓库根>|g' \
    ~/.config/systemd/user/neko-{memory,main,agent}.service
systemctl --user daemon-reload
```

若仓库位于用户 home 目录下，也可改用 `%h` specifier（如
`WorkingDirectory=%h/N.E.K.O`）以增强可移植性。端口如需修改：unit 内
`Environment=NEKO_*_SERVER_PORT=...`（上游键名）与 `scripts/lib.sh` 的探针
键（NEKO_MAIN_PORT/NEKO_MEMORY_PORT 等，自有命名，见其注释）都要同步。

## a-memorix 服务化落地后（P0-1 之后）

1. `cd /mnt/shared/_Projects/N.E.K.O/neko-services/a-memorix-service && uv sync`（Python 3.12）；
2. 修正 `neko-a-memorix.service` 的 `ExecStart` 入口模块名（现为占位 `a_memorix_service`）；
3. `systemctl --user daemon-reload && systemctl --user start neko-a-memorix.service`——
   无需改动 `neko.target`（Wants 弱依赖已包含）。
