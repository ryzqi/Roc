---
name: roc-experiment-provenance
description: 设计可复现实验并记录数据、参数、环境及结果来源。
---

记录输入数据、脚本、参数、随机种子、依赖锁文件、环境和输出路径。
使用项目工具执行并读取真实结果；没有执行记录时只能输出实验计划。
Python 先用 prepare_python_environment 发起准备，再读 get_python_environment_status 等待 ready；使用 operation.environmentRef 的 environmentId 与 expectedHash 调用 inspect_experiment_environment，取得 expectedEnvironmentHash。
list_python_environments 只读历史，不触发安装；不得把失败操作之前的历史回执当作 ready。取消准备使用 cancel_python_environment，只能取消当前运行自己发起的操作。
Roc 通过固定 uv 和 Python 3.14 创建项目 .venv、pyproject.toml、uv.lock 与 .python-version；不得要求用户选择解释器、提供路径或手工安装依赖。失败需报告具体原因，不使用旧环境继续计算。
start_experiment 声明 source:{kind:"file",path} 或 source:{kind:"notebook",notebookId,expectedHash,subsetVersion:1}、sourceVersion: 1、uint32 seed、arguments、输入和参数，使用预览返回的 runtime 与环境哈希。
Notebook 必须引用本项目由用户冻结导入的确切回执；不使用截断预览生成源码，不修改原 Notebook、不执行已有输出，不启动 Jupyter。
用 get_experiment 查询真实终态，失败、取消或中断后停止轮询并保留日志；相同 requestId 只重读，显式新 requestId 才新运行。
仅对 completed 运行调用 publish_experiment；发布后的工件仍需人工审核。
核查缺失值、样本量、异常值、数据泄漏和统计假设，保留失败结果。
结果主张关联数据或运行证据；不得自行生成看似测量所得的数值。

[共享参考：research-integrity](../shared/research-integrity.md)
[共享参考：production-readiness](../shared/production-readiness.md)
