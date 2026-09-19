# A_memorix 源树来源记录

- 来源仓库：Mai-with-u/MaiBot（https://github.com/Mai-with-u/MaiBot）
- 本地路径：`/mnt/shared/_Projects/N.E.K.O/MaiBot/`
- 来源 commit：`65b31f916d1b846469d72d01b22e79f69cb4ec41`（2026-09-18 03:46:12 +0000，"docs: 更新仓库状态图"）
- 拷贝日期：2026-09-19
- 拷贝方式：`rsync -a --exclude='__pycache__' --exclude='*.pyc' MaiBot/src/A_memorix/ → a-memorix-service/A_memorix/`（整树原样拷贝，125 个 .py 文件）

## 零修改承诺

`a-memorix-service/A_memorix/` 是上游树的原样副本（vendor）。**任何针对该目录内文件的直接修改都被禁止**；
所有宿主适配（`src.*` 依赖桩、配置注入、模型出口替换）一律通过本服务内的 `host_stubs/` shim 包以
`sys.modules` 预注册 / meta path finder 注入方式完成。上游同步时直接重新拷贝整树即可（见仓库 README runbook）。

依据：
- `docs/workplan.md` P0-1 节 #1/#2
- `docs/design/module-interface-audit.md` 第 4 节（宿主依赖清单）、第 7 节（Python 3.12 零语法障碍结论）

## 许可继承

- 上游 `src/A_memorix/LICENSE`：**GNU AFFERO GENERAL PUBLIC LICENSE v3.0（AGPL-3.0）**
- 上游 `src/A_memorix/LICENSE-MAIBOT-GPL.md`：Licensor（A_Dawn）授予的特殊授权条款，随树一并拷贝
- 本目录（`a-memorix-service/`）及其新增文件（`host_stubs/`、`tests/`、`config/` 等）作为该代码树的组合作品，**继承 AGPL-3.0 许可**分发。
- 上游归属：A_memorix 作者 A_Dawn（上游仓库 https://github.com/A-Dawn/A_memorix.git ，MaiBot 内同步分支 `MaiBot_branch`，同步边界见树内 `MODIFICATION_POLICY.md`）

## 拷贝校验

与源树逐文件比对（排除 `__pycache__`/`.pyc`）应当完全一致；校验命令：

```bash
diff -r --exclude='__pycache__' --exclude='*.pyc' \
  /mnt/shared/_Projects/N.E.K.O/MaiBot/src/A_memorix \
  /mnt/shared/_Projects/N.E.K.O/neko-services/a-memorix-service/A_memorix
```

## 已知的路径语义偏差（P0-1b 处理，不在本树内改）

- 树内 `paths.py` 的 `repo_root()` = 包目录上两级 = `a-memorix-service/` 的父目录（即本仓库根），
  因此 `config_path()` / `default_data_dir()` 默认解析到仓库根下的 `config/`、`data/`。
  独立部署语义修正（audit 文档第 5 节指出）通过内核构造参数 `plugin_root` / 纯 dict 配置注入解决，
  不修改 `paths.py`。
