#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 monika 人格 payload 注入 N.E.K.O 的 characters.json「莫妮卡」角色 _reserved。

P2-3 A 段部署产物。N.E.K.O 的 /import-card 端点按安全设计剥离 _reserved
（CHARACTER_SYSTEM_RESERVED_FIELDS），persona_override / ai_context /
character_origin 必须在角色导入后单独落到 characters.json——本脚本即该步骤。

用法（在 N.E.K.O 服务【停止】时执行；若在运行中执行，改完后需 restart）：
    python3 apply-persona-override.py [--neko-docs ~/Documents/N.E.K.O]

前置：
  1. N.E.K.O 已首次启动并完成初始化（~/Documents/N.E.K.O/config/characters.json 已生成）；
  2. 已在角色管理界面导入同目录 monika-character-card.zip（角色「莫妮卡」已存在）。

行为：
  - 读 characters.json，定位 characters['猫娘']['莫妮卡']（不存在则报错退出）；
  - 从 monika-persona-override.json 读 payload，按其 modules 列表从
    ../../core/persona/modules/ 现场读取五件运行模块文本拼为 append_guidance
    （patch 003 声明式挂载：mount_mode=replace 主骨架 + append-only 模块轨）；
  - 写入 _reserved.persona_override / ai_context / character_origin 三件套；
  - 原 characters.json 备份为 characters.json.bak-<时间戳> 后写回。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAYLOAD_PATH = HERE / "monika-persona-override.json"
MODULES_ROOT = (HERE / ".." / ".." / "core" / "persona").resolve()
DEFAULT_DOCS = Path.home() / "Documents" / "N.E.K.O"
CHARACTER_NAME = "莫妮卡"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--neko-docs",
        type=Path,
        default=DEFAULT_DOCS,
        help="N.E.K.O 用户数据根（默认 ~/Documents/N.E.K.O）",
    )
    args = parser.parse_args()

    chars_path = args.neko_docs / "config" / "characters.json"
    if not chars_path.exists():
        print(
            f"[错误] 未找到 {chars_path}\n"
            "  N.E.K.O 尚未首次启动生成角色存储。请先启动一次 N.E.K.O\n"
            "  （systemctl --user start neko.target），完成初始化并导入\n"
            "  monika-character-card.zip 后再运行本脚本。",
            file=sys.stderr,
        )
        return 1

    chars = json.loads(chars_path.read_text(encoding="utf-8"))
    character = (chars.get("猫娘") or {}).get(CHARACTER_NAME)
    if not isinstance(character, dict):
        print(
            f"[错误] characters.json 中不存在角色「{CHARACTER_NAME}」。\n"
            "  请先在 N.E.K.O 角色管理界面导入 monika-character-card.zip。",
            file=sys.stderr,
        )
        return 1

    payload = json.loads(PAYLOAD_PATH.read_text(encoding="utf-8"))

    # append_guidance：五件运行模块文本（现场读取，单一事实来源）
    append_guidance = []
    for rel in payload["modules"]:
        module_path = MODULES_ROOT / rel
        if not module_path.exists():
            print(f"[错误] 缺少模块文件: {module_path}", file=sys.stderr)
            return 1
        append_guidance.append(module_path.read_text(encoding="utf-8").strip())

    reserved = character.setdefault("_reserved", {})
    persona_override = dict(payload["persona_override"])
    persona_override["append_guidance"] = append_guidance
    reserved["persona_override"] = persona_override
    reserved["ai_context"] = payload["ai_context"]
    reserved["character_origin"] = payload["character_origin"]

    backup = chars_path.with_name(
        f"characters.json.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    )
    shutil.copy2(chars_path, backup)
    chars_path.write_text(
        json.dumps(chars, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[OK] 已注入「{CHARACTER_NAME}」的 _reserved 三件套：")
    print(f"     persona_override（mount_mode={persona_override['mount_mode']}, "
          f"append_guidance={len(append_guidance)} 模块, "
          f"env_context={persona_override['env_context']}）")
    print(f"     ai_context.rename_events = []（从空数组开始累积）")
    print(f"     character_origin.source = {payload['character_origin']['source']}")
    print(f"     备份: {backup}")
    print(f"     目标: {chars_path}")
    print("注意: 若 N.E.K.O 正在运行，请 systemctl --user restart neko.target 使其重载。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
