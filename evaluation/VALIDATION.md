# 本机隔离评测验证 — 2026-11-08

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。macOS ARM64，Node 26.13.0、pnpm 12.5.1、Electron 45、Python 3.14.7。全部手动触发，无付费推理请求、提交或远程写入。目录名使用 UTC，因此本地 11 月 8 日对应部分目录的 11 月 7 日时间。

## 状态

- **Verified passing**：独立目录、Roc 只读模型工厂桥接、本机 Python 沙箱、五类自动评分校准、真实工具/授权链路、native/QASPER fixture、封存与比较。
- **Blocked, not run**：真实默认模型质量基线。默认模型缺少 credentialRef；另一已配置模型在系统凭据可用性检查超时，尚未发生推理调用。
- **Blocked, not run**：Science 官方任务质量评测。尚未提供和审计官方任务目录、依赖与本地 grader；合成测试只证明实现链路。
- 精确 Task Specs / World Skill 保持 Draft / unreviewed；S01 独立 holdout 仍为 0/200、insufficient。

## 测试与静态检查

```sh
node --test evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/database-migrations.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
pnpm typecheck
pnpm harness:quality:check
```

67/67 通过，TypeScript 通过。组成：评测协议 12、真实 benchmark runtime 4、模型桥接 3、既有 S01 adapter 6、数据库/副作用/执行授权 42。S01 命令退出 0，但明确报告 16 个 fixture、fullDatasetReady=false、scientificStatus=insufficient，没有质量通过结论。

覆盖：真实 read/write 工具和 consumed ExecutionGrant；Python 执行和独立数值评分；隐藏文件、网络、子进程拒绝；超时与取消清理；oracle/alternative 接受与 incorrect/corrupt/shortcut 拒绝；数据及证据篡改；配对统计和预算；配置/轮转凭据保持字节不变。模型宿主成功路径通过临时本地 llama.cpp 协议服务验证；真实工厂的温度、请求头、工具 schema、输出上限通过受控服务验证，不表示实际云端模型可用。

## 手动命令与证据

```sh
pnpm harness:bench run --suite roc-native
pnpm harness:bench run --suite qasper --dataset evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile fast --fixture
```

native 94/94，QASPER 两轮各 5/5 trial，均退出 0。QASPER 每题实际 read_file，固定 Unanswerable fixture 的答案和证据 F1 均为 0.2，引用合法性为 1；这些是接线检查数字，不是模型质量。已检查两次请求、tool call、输出、grade、退出码和清理记录，均完整。

- [native 报告](runs/roc-native-2026-11-07T18-17-49.815Z-36c66ae0/report.md)
- [QASPER 第一轮](runs/qasper-2026-11-07T18-17-49.807Z-5397e9bb/report.md)
- [QASPER 第二轮](runs/qasper-2026-11-07T18-18-32.389Z-5fa97993/report.md)

```sh
pnpm harness:bench inspect evaluation/runs/roc-native-2026-11-07T18-17-49.815Z-36c66ae0
pnpm harness:bench inspect evaluation/runs/qasper-2026-11-07T18-17-49.807Z-5397e9bb
pnpm harness:bench compare evaluation/runs/qasper-2026-11-07T18-17-49.807Z-5397e9bb evaluation/runs/qasper-2026-11-07T18-18-32.389Z-5fa97993
```

inspect 均退出 0。compare 对两轮都重新验 seal 后按预期退出 2，conclusion=insufficient，所有 confidence95=null，避免 fixture/单次重复被判为质量通过。[comparison.json](comparisons/comparison-2026-11-07T18-19-05.591Z-05f0d35f/comparison.json)。

```sh
pnpm harness:bench environment cli-stdlib --python python3
```

退出 0，创建并冻结 [environment.json](environments/cli-stdlib-2026-11-07T18-18-32.394Z-a050fd6e/environment.json)。真实科学链路使用单测准备的标准库环境与合成输入，不冒充 Science 官方数据。

## 实际模型配置阻塞的可观测性

```sh
node evaluation/lib/cli.mjs doctor
node evaluation/lib/cli.mjs doctor --provider-id nvidia --model-id nvidia/nemotron-3.5-lightning-30b-a3b
pnpm harness:bench run --suite qasper --dataset evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile smoke --budget evaluation/budget.example.json
pnpm harness:bench inspect evaluation/runs/qasper-2026-11-07T18-18-32.387Z-ac8f76af
```

默认 doctor 返回 provider_credential_missing。指定 NVIDIA 的 doctor 返回 roc_model_host_timeout_credential_availability（30 秒启动限时），可确认停在 safeStorage 可用性阶段，不能据此断言根因就是权限或 app identity。二者均无推理请求，退出 2。

默认模型 smoke 封存 [失败报告](runs/qasper-2026-11-07T18-18-32.387Z-ac8f76af/report.md)：expected=1、attempted=0、unattempted=1、environment/provider_credential_missing、costBasis=not-dispatched。inspect 校验封存成功，同时因运行 incomplete 返回 2；不会变成 agent 错误或通过报告。

## 必要的生产兼容修复

`src/main/infrastructure/database-schemas.ts` 追加 agent migration 22，使既有工具副作用表接受生产 broker 使用的 isolated_execution。旧 migration checksum 不变；回归验证历史行/receipt/lease、四个索引、唯一约束及 result trigger。此次运行仅在评测/测试数据库应用，未初始化或迁移用户 Roc 数据库。

原有 S01 worker 已恢复，不依赖新 benchmark worker。native runner 只增加可选 --output-root，旧默认入口不变。评测源码、任务、数据、状态和结果归入 evaluation/。

## 剩余边界

本机隔离依赖 macOS sandbox-exec；无容器式总内存/总磁盘配额，外部系统库未完整冻结。官方 Science 环境整理和 verifier 来源仍需逐题审计。公开数据 holdout 不保证无训练污染，bootstrap 判据尚未做功效校准。seal 为可核验文件哈希，不是签名或不可改写存储。原始轨迹保存本地，无自动上传。

[改造前验证历史](validation-history/2026-11-08-before-local-isolation.md) 与原 `.artifacts/harness-bench/` 全部保留。本文在运行封存后补写，已封存 manifest 对应执行时源码；补充文档不改写旧证据。
