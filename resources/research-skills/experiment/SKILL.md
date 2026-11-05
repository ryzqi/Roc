---
name: roc-experiment-provenance
description: 设计可复现实验并记录数据、参数、环境及结果来源。
---

记录输入数据、脚本、参数、随机种子、依赖锁文件、环境和输出路径。
使用项目工具执行并读取真实结果；没有执行记录时只能输出实验计划。
Python 先用 list_python_environments 读取本项目的用户选择，再用 inspect_experiment_environment 核验并取得 expectedEnvironmentHash。
没有选择时请用户在项目管理中选择环境；不得提供解释器路径、安装依赖或把历史选择当作当前预览。
start_experiment 声明 source:{kind:"file",path} 或 source:{kind:"notebook",notebookId,expectedHash,subsetVersion:1}、sourceVersion: 1、uint32 seed、arguments、输入和参数，使用预览返回的 runtime 与环境哈希。
Notebook 必须引用本项目由用户冻结导入的确切回执；不使用截断预览生成源码，不修改原 Notebook、不执行已有输出，不启动 Jupyter。
用 get_experiment 查询真实终态，失败、取消或中断后停止轮询并保留日志；相同 requestId 只重读，显式新 requestId 才新运行。
仅对 completed 运行调用 publish_experiment；发布后的工件仍需人工审核。
核查缺失值、样本量、异常值、数据泄漏和统计假设，保留失败结果。
结果主张关联数据或运行证据；不得自行生成看似测量所得的数值。
