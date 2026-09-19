# systemd user unit 安装说明

> 对应 workplan P0-0 第 7 项部署裁决：常驻进程 = systemd user unit（`neko.target`
> 一键启停，日常冷启 <2 分钟）；launcher 仅用于桌面交互端；NapCat 保持插件托管。

## 单元清单

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `neko-memory.service` | memory_server（127.0.0.1:48912，中心记忆 HTTP） | 立即生效 |
| `neko-a-memorix.service` | a-memorix 记忆检索服务 | 占位——P0-1 服务化落地前 `ConditionPathExists` 不满足，start 显示 skipped，不产生报错 |
| `neko.target` | 总入口，`Wants=` 上述两个服务 | 立即生效 |

主进程（48911 桌面全家桶）**故意不在 target 内**：由 `launcher.py` 桌面/手动启动，
桌面端与常驻服务解耦。NapCat 由 qq_auto_reply 插件托管（stdout 接日志文件供
`scripts/doctor.sh` 巡检），不设独立 unit。

## 安装步骤

```bash
# 0) 前置：N.E.K.O 仓库根先建好 venv（Python 3.11）
cd /mnt/shared/_Projects/N.E.K.O/N.E.K.O && uv sync

# 1) 拷贝单元到 systemd user 目录（源用绝对路径，不依赖当前目录）
NEKO_SERVICES=/mnt/shared/_Projects/N.E.K.O/neko-services   # 本仓库根，按实际位置调整
mkdir -p ~/.config/systemd/user
cp "${NEKO_SERVICES}/systemd/neko-memory.service" \
   "${NEKO_SERVICES}/systemd/neko-a-memorix.service" \
   "${NEKO_SERVICES}/systemd/neko.target" \
   ~/.config/systemd/user/

# 2) 重载并启用
systemctl --user daemon-reload
systemctl --user enable --now neko.target

# 3) 验证
systemctl --user status neko.target neko-memory.service
curl -s http://127.0.0.1:48912/health   # 期望 {"app":"N.E.K.O","service":"memory","status":"ok",...}
/mnt/shared/_Projects/N.E.K.O/neko-services/scripts/doctor.sh
```

## 日常操作

```bash
systemctl --user start neko.target       # 一键冷启（验收目标 <2 分钟）
systemctl --user stop neko.target        # 一键停（两个 service 均设 PartOf=neko.target，stop/restart 联动生效）
systemctl --user restart neko-memory.service
journalctl --user -u neko-memory.service -f   # 跟日志
```

## 路径说明（迁移到其他机器时）

单元内路径写死为 `/mnt/shared/_Projects/N.E.K.O/N.E.K.O`（N.E.K.O 子项目仓库根）与
`/mnt/shared/_Projects/N.E.K.O/neko-services`（本仓库），systemd user unit 不支持外部
环境变量展开。迁移时对 `~/.config/systemd/user/` 下已拷贝的单元做前缀替换：

```bash
sed -i 's|/mnt/shared/_Projects/N.E.K.O/N.E.K.O|<新的N.E.K.O仓库根>|g' \
    ~/.config/systemd/user/neko-memory.service
systemctl --user daemon-reload
```

若仓库位于用户 home 目录下，也可改用 `%h` specifier（如
`WorkingDirectory=%h/N.E.K.O`）以增强可移植性。

## a-memorix 服务化落地后（P0-1 之后）

1. `cd /mnt/shared/_Projects/N.E.K.O/neko-services/a-memorix-service && uv sync`（Python 3.12）；
2. 修正 `neko-a-memorix.service` 的 `ExecStart` 入口模块名（现为占位 `a_memorix_service`）；
3. `systemctl --user daemon-reload && systemctl --user start neko-a-memorix.service`——
   无需改动 `neko.target`（Wants 弱依赖已包含）。
