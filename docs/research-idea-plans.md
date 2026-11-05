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

## A3A：冻结方法与真实负结果的人工评估

DB46 增加独立、追加式结果评估时间线。每条评估绑定精确冻结计划 ID、版本/hash、冻结 hash、真实指标结果回执 ID/hash，并保存完整计划、结果、指标 Evidence、运行起止时间和人工说明。它不修改 Canvas、冻结假设、预期结果或测量数据。历史冻结计划可回填结果；每个计划独立追加版本，修订必须指向最新父评估 ID/hash 并填写原因。

每个计划指标须明确关联该结果回执中的一个真实指标 Evidence，或注明缺失原因；至少保留一个实测指标。重复关联、遗漏和跨结果关联被拒绝。定义、单位、方向差异和缺失维度逐项保存，有差异只能选择“不可比”；支持、反驳、无法判断均由人工明确选择，服务不会根据数值自动选结论。

`saveIdeaOutcome` 的身份由主进程 sender 绑定；同请求、内容、身份和实际来源的精确重放零写入。`getIdeaOutcome` 重验真实运行、输入/输出/源码及指标 Evidence；当前来源失效时报错。`getIdeaOutcomeHistory` 明确标记 `stored_receipt`，仅核验历史保存回执，不能被视作当前来源仍有效。存储入口另外校验所有映射、嵌套 hash/项目/冻结身份、实际运行时间和差异，防止绕过 service 构造成功回执。归档项目拒绝写入，允许读取。

观察时序仍是人工声明；保存的运行起止时间来自真实运行记录，但不证明计划在独立系统中预注册。当前工程回归的时钟由 fixture 固定，以便精确比较。

### 验证

在上述仓库根目录执行。日志在 `.artifacts/research-optimization/`。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `pnpm generate:ipc` | 通过 | `xidea-a3a-type.log` |
| `pnpm build` | 最终通过，含 typecheck | `xidea-a3a-boundary-build.log` |
| `node --test tests/unit/research-idea-outcomes.test.mjs tests/unit/research-idea-plans.test.mjs tests/unit/research-experiment-results.test.mjs` | 最终 14/14 | `xidea-a3a-boundary-focused.log` |
| `node --test tests/unit/` | 1213/1213，零失败/跳过；随后新增 IPC 错误回归包含在最终 14/14 聚焦检查中 | `xidea-a3a-unit.log` |
| `node scripts/run-research-p0.mjs` | 13/13 | `xidea-a3a-p0.log` |
| `pnpm harness:eval` | 94/94 | `xidea-a3a-harness.log` |
| `node --test --test-name-pattern='actual frozen method assessment\|actual metric review freezes\|actual result metric evidence' tests/integration/research-python-experiments.test.mjs` | 最终 3/3 | `xidea-a3a-final-python-corrected.log` |
| `node --test tests/renderer/idea-plans.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/experiment-results.test.mjs` | 38/38 | `xidea-a3a-renderer.log` |
| `pnpm check:ipc` | 生成文件一致 | `xidea-a3a-boundary-ipc.log` |
| `pnpm check:renderer-chunks` | eager JS 1,134,042 bytes，6 files | `xidea-a3a-boundary-chunks.log` |
| `node scripts/smoke-electron.mjs` | 最终 13/13，零 renderer error | `xidea-a3a-boundary-startup.log` |

真实 CPython 回归覆盖负均值 -4、未变的正值预期、人工反驳与后续无法判断修订、精确重放零写入、不同 sender/content 拒绝、直接存储伪造映射/时间拒绝、回执重哈希后的损坏证据拒绝、分页历史、磁盘重启零 probe/compute、归档和失效 Evidence。独立 DB45→46 回归保留原 Canvas/冻结计划所有行字节与外键。

初轮 typecheck 暴露局部 `never` 回调缺少显式函数类型的控制流收窄问题，现已修正。时间漂移测试初轮误用与 fixture 相同的时间，被后续父版本冲突正确拒绝；改为不同时间后验证准确错误。原始失败日志保留。

A3A 状态：**Verified passing**，范围为追加式存储、人工 API、真实来源绑定与现有消费者，所有表列进程退出码为零。renderer 评估 UI、审核 snapshot 的 outcome 聚合和导出绑定属于后续部分；没有扩展为全计划或独立科学验收。

## A3B：结果评估界面与工件审核绑定

现有 Stage drawer 按模块 lazy 加载结果评估。用户主动读取冻结方法历史、最近 200 次真实运行和分页结果，再按精确 ID/hash 复核选中来源。每个计划指标主动选择实测指标或缺失原因，人工选择结论并填写审核说明；定义、单位、方向差异逐项显示，存在差异只能保存不可比评估。真实指标 ID 经编码后作为选项值，不与缺失选项冲突。

保存先逐项幂等捕获指标 Evidence，再追加人工评估。相同内容重试保留请求 ID；Evidence 已保存而评估失败时明确保留这些证据。计划与评估分别维护 dirty/pending，互相锁住修改，并共同锁住关闭、刷新、任务和审核切换。冻结审核说明也计入未保存修改；迟到写入回复不能清除新 Canvas 的修改状态。

严格 inspector snapshot 必须包含每个冻结方法的最新评估 head，并将其 Evidence 聚合到既有来源审核。新计划草稿不会删除旧方法评估；修订旧方法评估会改变审核 hash。历史分页显示保存回执，独立“复核当前来源”重新读取实际文件；来源漂移时移除当前验证状态，保留可读历史，不以旧 hook 数据表示成功。

### 验证

下列命令均在本文件所列仓库根目录执行，退出码全部为零。日志位于 `.artifacts/research-optimization/`。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `pnpm build` | 最终通过，含 typecheck | `xidea-a3b-final-build.log` |
| `node --test tests/unit/research-idea-outcomes.test.mjs tests/unit/research-idea-inspection.test.mjs` | 最终 5/5 | `xidea-a3b-final-focused.log` |
| `pnpm test:unit` | 1214/1214，零失败/跳过；随后补充的错误码断言由最终聚焦检查覆盖 | `xidea-a3b-unit.log` |
| `node --test tests/renderer/idea-outcomes.test.mjs tests/renderer/idea-plans.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` | 最终 45/45 | `xidea-a3b-final-renderer.log` |
| `node scripts/run-research-p0.mjs` | 13/13 | `xidea-a3b-p0.log` |
| `pnpm harness:eval` | 94/94 | `xidea-a3b-harness.log` |
| `node scripts/smoke-electron.mjs` | 13/13，零 renderer error | `xidea-a3b-startup.log` |
| `pnpm check:ipc` | 生成文件一致 | 本轮终端回执 |
| `pnpm check:renderer-chunks` | eager JS 1,134,084 bytes，6 files | 本轮终端回执 |

新增七项 Electron renderer 回归使用真实 CPython 3.14 负结果，覆盖键盘保存、丢失回执后的零写入重试、差异与缺失、两个历史冻结方法在新草稿下保留独立 heads、分页/精确父评估、迟到回复、归档及真实源码漂移。浅深色 650px 截图 `xidea-a3b-ui/light-outcome.png`、`dark-outcome.png` 已目视检查焦点、固定 header 和本地滚动；六种审计状态均 `cut=0`，仅既有全高 panel 的窗口上/下/右边缘外阴影完全隐藏。

初轮界面检查为 44/45：真实源码漂移被错误归为内部错误。保留现场和聚焦红测试后，删除没有生产调用方的旧错误码，登记真实 `research_experiment_snapshot_changed`；最终界面同时断言实际 service 错误、IPC 错误码和准确中文提示。诊断插桩已移除，失败日志与 `source-drift-diagnosis.json` 保留。

A3B 状态：**Verified passing**，范围为现有检查器评估、来源复核和审核 snapshot。界面 fixture 使用真实 renderer 与 main capability adapter，未替代 production preload 或实际 OS picker 验收。导出绑定将在独立增量交付；没有独立科学、预注册或真实 R/Julia 验收声明。
