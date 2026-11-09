# 本地实验闭环验证 — 2026-11-09

**Verified passing（本地实验流程）**：已接通 `sealed run → incident → 冻结 experiment → run --experiment → assess → 人工 decide`。流程要求固定实验条件、声明候选改动、一次候选登记、独立比较、绝对与逐题质量底线；fixture、未完成、证据不足不能被采纳。使用方法见 [EXPERIMENTS.md](EXPERIMENTS.md)。

在 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

```sh
node --test evaluation/tests/experiment.test.mjs evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/quality-runner.test.mjs tests/unit/quality-evaluation.test.mjs tests/unit/quality-dataset.test.mjs
pnpm typecheck
pnpm harness:quality:check
```

64/64 测试通过，无失败或跳过；类型检查通过，以上命令均退出 0。S01 检查仍为 16 个 fixture、独立数据 0/200、`scientificStatus=insufficient`、modelCalls=0、externalCalls=0，退出 0 不代表真实质量通过。另已检查 CLI 帮助、示例与新增文档链接，并执行 `git diff --check`。本轮未重复全量 native 94 项。

测试覆盖 incident 的原始观察与人工假设分离、禁止 holdout 优化、未声明源码改动、数据/模型/预算/工具合同漂移、实际 schema 变化、重复候选登记、低分非劣仍不满足绝对底线、逐题失败不能被均分掩盖、冻结更严格非劣界限、人工决定与证据绑定，以及证据改写拒绝。尚未封存的候选明确显示等待状态；fixture 切换到真实模型会在打开模型宿主前失败。

CLI 生命周期使用真实 Roc worker 和固定模型响应完成两轮运行，每轮真实执行一次 `read_file`，两次模型请求均为 fixture。工具读到答案 `25%`，固定响应却为 `Unanswerable`；独立 grader 正确给出答案与证据 F1 为 0。已核对完整 transcript、请求响应、工具结果、输出、grade、进程退出和清理；数据库文件保留，但没有查询 checkpoint 行。验收正确返回 `blocked / insufficient`，最终记录 `reject`，不构成模型效果改善的证据。

- [精确命令、退出码与日志索引](../.artifacts/harness-eval-loop-2026-11-09/verification-hatlhi93/verification.json)
- [完整轨迹核对记录](../.artifacts/harness-eval-loop-2026-11-09/verification-hatlhi93/trace-review.md)
- [基线报告](runs/qasper-2026-11-09T10-56-34.832Z-b6a3a855/report.md) 与 [候选报告](runs/qasper-2026-11-09T10-56-38.082Z-9d8f60ca/report.md)
- [冻结协议](local/experiments/experiment-2026-11-09T10-56-37.614Z-95ab6ef4/protocol.json)、[验收](local/experiments/experiment-2026-11-09T10-56-37.614Z-95ab6ef4/assessment.json) 与 [人工决定记录](local/experiments/experiment-2026-11-09T10-56-37.614Z-95ab6ef4/decision.json)

真实模型质量基线、S01 独立留出集、MCP 故障任务环境、官方 Science 任务审计与生产发布集成仍待完成。示例阈值不是已校准产品标准，人工采纳仅是本地开发决定。本轮无付费推理、真实凭据检查、部署、提交或远程写入。本文在运行封存后补写，已封存源码身份对应执行时文件，没有改写历史证据。

以下保留先前验证历史。

# 本机隔离评测验证 — 2026-11-08

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。macOS ARM64，Node 26.13.0、pnpm 12.5.1、Electron 45、Python 3.14.7。全部手动触发，无付费推理请求、提交或远程写入。目录名使用 UTC，因此本地 11 月 8 日对应部分目录的 11 月 7 日时间。

## 历史工具合同与预算修复验证（预算功能现已删除）

**Verified passing**：模型请求按 manifest 和 main/subagent scope 过滤；public benchmark 宿主在转发前核对固定工具集合并保留实际 schema；比较器拒绝工具、权限、schema 漂移，缺少实际 schema 的旧记录只能给出不足证据；最低请求预算不可行时在打开模型宿主前失败。执行授权硬守卫保持有效。

先加入回归测试，旧代码按预期出现 5 项失败（QASPER/Science 额外工具、比较遗漏、缺失证据、预算预检），修改后通过。随后在本文顶部工作目录执行：

```sh
node --test evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/quality-runner.test.mjs tests/unit/quality-evaluation.test.mjs tests/unit/quality-dataset.test.mjs tests/unit/run-capability-manifest.test.mjs tests/unit/wiki-tools.test.mjs
pnpm typecheck
pnpm harness:eval
pnpm harness:quality:check
```

结果：78/78 相关测试、94/94 原生场景和类型检查通过，命令均退出 0。覆盖实际 worker 两类工具集合、宿主拒绝缺失/额外/重复/畸形工具及后续 schema 漂移、子代理 scope 与 Plan 限制、固定工具比较、150 次最低请求与默认 60 次预算的预检失败，以及两个全新工作区经 runner 执行后的 schema 证据封存。S01 仍为 16 个 fixture、独立数据 0/200、`insufficient`，没有质量通过结论。模型宿主测试仅用临时合成配置和本机回环服务，无付费调用，也未检查用户真实凭据。

完整命令与日志在 [verification.json](../.artifacts/agent-harness-evaluation-fixes-2026-11-08/verification.json)。实际模型质量、官方 Science 与独立 S01 评测仍未运行。本轮修复工程评测可信度，不证明模型质量提高。

以下保留工具合同修复前的验证历史；对应 run 与 seal 没有改写，不能作为修复后实际 schema 的证据。

## 状态

- **Verified passing**：独立目录、Roc 只读模型工厂桥接、本机 Python 沙箱、五类自动评分校准、真实工具/授权链路、native/QASPER fixture、封存与比较。
- **Blocked, not run**：真实默认模型质量基线。默认模型缺少 credentialRef；另一已配置模型在系统凭据可用性检查超时，尚未发生推理调用。
- **Blocked, not run**：Science 官方任务质量评测。尚未提供和审计官方任务目录、依赖与本地 grader；合成测试只证明实现链路。
- 精确 Task Specs / World Skill 保持 Draft / unreviewed；S01 独立 holdout 仍为 0/200、insufficient。

## 测试与静态检查

```sh
node --test evaluation/tests/harness-bench.test.mjs evaluation/tests/harness-bench-application.test.mjs evaluation/tests/roc-model.test.mjs tests/unit/quality-application-adapter.test.mjs tests/unit/database-schema.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
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
pnpm harness:bench run --suite qasper --dataset evaluation/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile smoke --provider-options evaluation/provider-options.example.json
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
