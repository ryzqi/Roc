# Idea Canvas 方法计划

执行来源：`plan/research-optimization-execution-plan.md` 的 X-IDEA。
本地工作目录：`/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。

## A1：人工合同、版本与冻结

方法计划作为追加时间线绑定现有 Idea Canvas 的工件 ID、版本及内容 SHA-256。保存草稿也生成独立版本；修订必须引用最新父版本的 ID/hash 并填写原因。冻结另外记录人工审核说明、真实窗口身份、时间、请求 hash 和冻结 hash。草稿与冻结请求的精确重放没有数据库写入，内容或身份改变则拒绝。

假设必须与选中 Canvas 完全一致。计划必须显式提供可证伪条件、指标定义/单位/方向/预期结果、数据计划、实验设计和分析计划。新颖性始终为待核查推断，保留检索范围与证据对比。样本量记录人工确认的方法、参数、样本数、证据和审核说明，或者明确未计算原因；服务不会计算或补造功效。

观察数据前/后是人工声明，不能充当独立预注册证明。事后计划必须引用当前有效 Evidence；一旦记录事后观察，后续版本不得改回观察前。负结果不改写历史预期。保存或冻结时拒绝缺失、跨项目或失效证据，Canvas 漂移、归档和被替代工件；历史计划保留原版本并暴露 `canvasCurrent`。

IPC 提供 `saveIdeaPlan`、`freezeIdeaPlan`、`getIdeaPlan`、`getIdeaPlanHistory`，保存/冻结的人工身份仅来自主进程 sender。严格合同不接收 actor。DB45 只增加版本/冻结两表，不修改原 Canvas、修订历史或 Notebook 字节。读取校验规范 JSON、hash、请求和父版本元数据，以及冻结行与版本锚点的一致性。

### 验证

所有命令在上述仓库根目录执行，macOS arm64、Electron 45.0.0、CPython 3.14、项目声明的 pnpm/TypeScript/Zod。日志在 `.artifacts/research-optimization/`。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `pnpm generate:ipc` | 通过 | `xidea-a1-type.log` |
| `node --test tests/unit/research-idea-plans.test.mjs tests/unit/research-experiment-results.test.mjs` | 最终 10/10 | `xidea-a1-final-focused.log` |
| `node --test tests/unit/` | 1209/1209，零失败/跳过 | `xidea-a1-unit.log` |
| `pnpm build` | 最终通过，包含 typecheck | `xidea-a1-final-build.log` |
| `node scripts/run-research-p0.mjs` | 13/13 | `xidea-a1-p0.log` |
| `pnpm harness:eval` | 94/94 | `xidea-a1-harness.log` |
| `node --test --test-name-pattern='actual metric review freezes' tests/integration/research-python-experiments.test.mjs` | 真实指标消费者 1/1 | `xidea-a1-result-consumer.log` |
| `pnpm check:ipc` | 最终生成文件一致 | `xidea-a1-final-ipc.log` |
| `pnpm check:renderer-chunks` | 最终 eager JS 1,134,003 bytes，6 files | `xidea-a1-final-chunks.log` |
| `node scripts/smoke-electron.mjs` | 最终 13/13，零 renderer error | `xidea-a1-final-startup.log` |

六项计划回归覆盖严格输入、真实 adapter 身份、请求回复丢失后的零写入重放、冻结/修订及观察时序、实际失效 Evidence、Canvas 漂移/归档、损坏冻结回执、磁盘重启和 DB44→45 字节守恒。

A1 状态：**Verified passing**，范围为人工合同、追加式存储、冻结与现有消费者。尚不包含 renderer 编辑器或计划到实际实验的绑定；后续分别交付 A2 与 A3。工程 fixture 的样本量方法不代表科学功效验收。没有远程写入、付费调用、独立科学评估或预注册证明。

## A2：现有工件检查器中的编辑、历史与审核

方法计划在既有 560px Stage drawer 内按模块 lazy 加载。表单提供完整方法、指标预期、新颖性对比与功效声明；新计划的观察时序必须主动选择。保存/冻结的请求 ID 在内容不变时保持，回复丢失后的精确重放只返回原回执。未保存修改或 pending 写入阻止关闭、刷新、任务切换和返回审核；明确放弃恢复已保存内容。历史每页十项，选择时按精确 ID/hash 复核，归档范围只读。

严格 inspector snapshot 显式包含 nullable Canvas 与最新计划，并聚合计划所引用的 Evidence。保存、冻结、Canvas 或 Evidence 漂移都会改变审核 hash；旧 gate review 无法批准改变后的内容。回执显示人工身份、版本/hash、冻结时间和完整方法，冻结预期不被事后结果覆盖。

### 验证

以下命令均在本文件所列仓库根目录执行。最终进程退出码全部为零。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `node --test tests/unit/research-idea-inspection.test.mjs tests/unit/research-idea-plans.test.mjs tests/unit/research-artifact-inspector.test.mjs` | 11/11 | `xidea-a2-focused.log` |
| `node --test tests/unit/` | 1210/1210，零失败/跳过 | `xidea-a2-unit.log` |
| `pnpm build` | 通过，含 typecheck | `xidea-a2-final-build.log` |
| `node --test tests/renderer/idea-plans.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/experiment-results.test.mjs` | 最终 38/38 | `xidea-a2-final-renderer-corrected.log` |
| `node scripts/run-research-p0.mjs` | 13/13 | `xidea-a2-p0.log` |
| `pnpm harness:eval` | 94/94 | `xidea-a2-harness.log` |
| `node scripts/smoke-electron.mjs` | 13/13，零 renderer error | `xidea-a2-startup.log` |
| `pnpm check:ipc` | 生成文件一致 | `xidea-a2-ipc.log` |
| `pnpm check:renderer-chunks` | eager JS 1,134,042 bytes，6 files | `xidea-a2-chunks.log` |

真实 Electron renderer 覆盖人工写入与 gate 漂移、保存/冻结回复丢失、事后负证据与功效记录、分页/磁盘重启/归档/迟到回复、650px 浅深色与减弱动效。截图 `xidea-a2-ui/light-plan.png`、`dark-plan.png` 已目视核对焦点、固定 chrome 和本地滚动；`audits.json` 保存编辑、hover、展开三状态各主题的真实审计，全部 `cut=0`。

最初 UI 检查两次失败来自审计 fixture：把 DOM body 传给 selector 参数，以及错误要求全高 drawer 的窗口上/下/右边缘外阴影可见。原始失败日志保留；最终断言仍要求零半截裁切，并仅允许精确 drawer 元素的三个窗口边缘 `hidden/gap=0`，同时验证焦点和无横向溢出。精确 matcher 曾因序列化四个 class 而非审计脚本的三个失败，现已对齐。产品 CSS/阴影/动效未修改。

A2 状态：**Verified passing**，范围为现有检查器编辑/冻结/历史与审核绑定。A3 的真实实验结果关联仍待实现；无独立科学、预注册、真实 R/Julia 或付费调用验收声明。
