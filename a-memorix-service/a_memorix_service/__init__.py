"""a_memorix-service 运行包（P0-1b）：FastAPI 壳与入口。

- ``a_memorix_service.service``：FastAPI 应用（``python -m a_memorix_service.service`` 启动）
- 宿主桩安装（host_stubs.install()）在 ``a_memorix_service.service.app`` import 时
  最先执行——先于任何 A_memorix 导入
"""
