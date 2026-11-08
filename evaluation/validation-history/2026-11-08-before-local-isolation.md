> 历史记录：目录隔离与本机 Python 改造之前的验证。下列旧命令、Docker 限制和配置接口已失效；当前状态见 [VALIDATION.md](../VALIDATION.md)。历史运行目录保持原样。

# 验证记录 — 2026-11-08

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`；macOS ARM64，Node 26.13.0 / pnpm 12.5.1。全部手动触发，无付费模型调用、提交、部署或远程写入。

## 状态

- 手动框架、QASPER fixture + 真实应用工具链、native 可靠性封存：**Verified passing**。
- ScienceAgentBench 官方环境/真实容器/评分器校准、真实模型质量基线：**Blocked, not run**。缺 Docker、官方本地任务环境及正式模型配置。本轮仅验证其数据合同、评分协议、真实 Roc 写文件/消费执行授权到 host callback，以及缺环境时的封存行为。
- Task Specs 与 Roc World Skill 为 Draft / unreviewed；不能把实现测试替代用户对任务定义的批准。

## 精确命令与结果

以下命令均从上述工作目录执行。

```sh
node --test tests/unit/harness-bench.test.mjs tests/unit/harness-bench-application.test.mjs tests/unit/quality-application-adapter.test.mjs
```

20/20 通过（当时 protocol 11、真实应用联调 3、既有 S01 adapter 6）。随后新增 native 符号链接归档回归，并单独执行：

```sh
node --test tests/unit/harness-bench.test.mjs
```

12/12 通过。覆盖独立 QASPER 评分、隐藏真值隔离、稳定分组选择、退化/不兼容/不完整统计判定、证据篡改、请求预算、未知费用、Science 评分和导入、原生 link 元数据归档。新增测试后未重复未改变的应用集成检查。

```sh
node --test tests/unit/database-migrations.test.mjs tests/unit/tool-effect-store.test.mjs tests/unit/execution-grant-broker.test.mjs
pnpm typecheck
pnpm harness:quality:check
```

数据库/副作用/执行授权 42/42 通过；TypeScript 检查通过。共 63 个不同的相关测试通过。S01 检查退出 0，但报告明确为 16 个 fixture、独立 holdout 0/200、scientificStatus=insufficient；没有生成科研质量通过结论。

```sh
pnpm harness:bench run --suite roc-native
pnpm harness:bench run --suite qasper --dataset .artifacts/harness-bench/datasets/qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0 --profile fast --fixture
```

两者退出 0。native 94/94 原始 case 通过、全部普通文件归档，刻意构造的隔离测试符号链接作为元数据保存。QASPER 两轮分别完成 5/5 trial、10 次脚本模型交互，实际读取 paper.json，保存数据库/checkpoint/工具事件/请求响应/输出/清理证据。固定 Unanswerable transport 的 answerF1=0.2、evidenceF1=0.2、citationValidity=1；这些数字仅验证独立评分接线，不能用作模型质量。

最终运行目录：

- [native 报告](../../.artifacts/harness-bench/runs/roc-native-2026-11-07T17-47-17.557Z-ab6585b6/report.md)
- [QASPER 报告](../../.artifacts/harness-bench/runs/qasper-2026-11-07T17-47-17.557Z-f972f41e/report.md)
- 前轮 QASPER：`.artifacts/harness-bench/runs/qasper-2026-11-07T17-46-10.374Z-02a1eeeb`

```sh
pnpm harness:bench inspect .artifacts/harness-bench/runs/roc-native-2026-11-07T17-47-17.557Z-ab6585b6
pnpm harness:bench inspect .artifacts/harness-bench/runs/qasper-2026-11-07T17-47-17.557Z-f972f41e
pnpm harness:bench compare .artifacts/harness-bench/runs/qasper-2026-11-07T17-46-10.374Z-02a1eeeb .artifacts/harness-bench/runs/qasper-2026-11-07T17-47-17.557Z-f972f41e
```

两份 inspect 退出 0，全部文件 seal 校验通过；compare 退出 2，conclusion=insufficient，所有 confidence95=null，符合 fixture/单次重复边界。源码变化被记录，冻结条件保持一致。对比产物：

[comparison.json](../../.artifacts/harness-bench/comparisons/comparison-2026-11-07T17-48-10.271Z-16290630/comparison.json)

```sh
pnpm harness:bench run --suite scienceagentbench --dataset .artifacts/harness-bench/datasets/scienceagentbench-4034896c71cbbb3d6cc29b6f05d22239401327b49748ae10eaca7229e67c8353 --profile fast --provider evaluation/lib/provider.example.json
pnpm harness:bench inspect .artifacts/harness-bench/runs/scienceagentbench-2026-11-07T17-46-37.322Z-f3cf3cf7
```

这里使用的是单测生成的合成数据合同及不可用示例 provider，专门检查 preflight；不是官方 scientific evaluation。两命令均按预期退出 2，status=incomplete，environment/docker_not_installed，attempted=0，costBasis=not-dispatched。inspect 验证该失败报告的 seal 有效。

[环境缺失报告](../../.artifacts/harness-bench/runs/scienceagentbench-2026-11-07T17-46-37.322Z-f3cf3cf7/report.md)

## 本次发现与修复

1. 隔离 shell 工具使用 isolated_execution effect，而 SQLite 仍只允许四种旧 effect。追加 agent migration 22，保持旧 migration checksum；回归验证旧行/lease/receipt 字段、唯一索引、result event trigger 和现有类型校验。未重建或清空用户数据。
2. fixture 重复 completion ID 会让 LangGraph 替换消息，产生 missing conclusion；改为逐请求唯一 ID，实际文件工具与脚本工具联调通过。
3. 原生隔离 fixture 留下符号链接，新证据库拒绝 live link；改为普通文件快照 + native-links.json，绝不跟随目标。首次失败封存仍保留在 `roc-native-2026-11-07T17-46-10.390Z-120e754d`。

查看过 QASPER 全部五题的完整事件序列、两次请求/结果、独立 grade、进程退出和 cleanup；应用集成检查验证可见正文进入模型请求、隐藏 sentinel 不可读，Science write → consumed grant → host callback。科学 Docker 执行与真实模型行为仍未验证。本验证记录在运行封存后补写，源码 manifest 保留运行当时版本；之后仅补充验证文档不改变已封存结果。
