# Roc 架构优化执行计划

## 目标

依次完成 `plan/00-overview.md` 定义的 9 个架构优化阶段。每阶段必须完成实现、直接验证、子代理双轴审查、问题修复、复验和独立提交，之后才进入下一阶段。

## 范围

- 计划源：`plan/00-overview.md`、`plan/phase-1-*.md` 至 `plan/phase-9-*.md`
- 产品代码：仅各阶段明确列出的 main/preload/renderer/shared/test 路径
- 文档：阶段状态、执行发现和验证证据

## 约束

- 保留用户现有变更；不执行破坏性 git 操作。
- 不修改 deepagents vendor 版本。
- 不保留旧路径、兼容层、迁移胶水或静默 fallback。
- 每阶段使用该阶段开始时的 HEAD 作为 review fixed point。
- 每阶段先跑目标测试，再跑 `pnpm typecheck` 和 `pnpm test`；按风险追加 IPC/build/smoke 检查。
- 审查问题必须修复并复验后才能提交。

## 权威事实与当前假设

- 权威计划：`plan/00-overview.md` 及对应 phase 文件。
- 权威项目规则：`AGENTS.md`、`package.json`、`C:\Users\任彦舟\.codex\RTK.md`。
- 当前分支：`main`；开始时 HEAD 为 `45168f1`，相对 `origin/main` ahead 38。
- 当前未跟踪内容：`plan/`。所有权视为用户已有内容，执行中保留。
- 根因目前来自计划，尚待逐阶段代码验证：事件流被当作跨层数据通道、契约多处重复、repository/adapter seam 泄漏。

## 验收标准

- 9 个阶段均为 `complete`。
- 每阶段有目标行为测试、通用验证、双轴子代理审查及问题闭环记录。
- `plan/00-overview.md` 阶段状态与提交记录同步。
- 最终全量门禁通过；未运行项必须明确标记 `Blocked, not run` 及原因。

## 阶段

| 阶段 | 主题 | 状态 | 阶段门槛 |
| --- | --- | --- | --- |
| 1 | Interrupt 生命周期收敛 | complete | 实现 -> 验证 -> Standards/Spec 子代理审查 -> 修复 -> 提交 |
| 2 | session-repository 跨 seam 裸 SQL 收口 | complete | 同上 |
| 3 | executor 返回结构化 RunOutcome | complete | 同上 |
| 4 | IPC 契约单源化 | complete | 同上 + `pnpm generate:ipc` / `pnpm check:ipc` |
| 5 | Stream adapter 领域事件与投影合并 | pending | 同上 |
| 6 | task-repository 聚合化与按名注册 | pending | 同上 |
| 7 | Shell 安全 policy 单源 | pending | 同上 |
| 8 | 插件 DB 隔离 seam 修复 | pending | 同上 |
| 9 | 死代码与零深度微文件清理 | pending | 同上 + strict unused scan |

## 当前步骤

阶段 4 已 Verified passing：fixed point `fc6b95e`；最终 Standards/Spec 双轴复审均 PASS，串行全量 328 文件/1839 项与全部专项门禁通过。下一步创建阶段 4 独立提交，再以该提交为阶段 5 fixed point。

## Errors Encountered

> 2026-08-18：恢复阶段 4 时首次使用 `rtk cat` 读取技能与 RTK 规则，但 Windows PATH 中不存在 `cat`；已改用 `rtk powershell.exe -NoProfile -Command "Get-Content ..."`，不重复 Unix 命令。
>
> 2026-08-18：首次按行读取 `MEMORY.md` 时 PowerShell 数组范围表达式在嵌套命令中丢失变量名并触发 parser error；已转义 `$lines` 后成功读取，不再复用未转义写法。
>
> 2026-08-18：恢复批次沿用旧路径读取根目录 `plan.md`，实际计划入口仍为 `plan/plan.md`；后续固定使用真实路径。

> 2026-08-17：恢复阶段误读根目录 `plan.md`，实际文件位于 `plan/plan.md`；已改用真实路径，未重复失败命令。
>
> 2026-08-17：`rg -uuu` 搜索 pnpm 依赖时命中多个未安装平台可选包的断链并返回 exit 1；已取得 LangChain HITL 声明的明确路径，后续只读取该文件，不再递归遍历 `node_modules/.pnpm`。
>
> 2026-08-17：检查 direct IPC 边界时误猜 `src/main/ipc/index.ts`，该文件不存在；已保留成功读取的 plugin adapter 证据，改用 `rg --files src/main/ipc` 定位真实入口。
>
> 2026-08-17：事件发送点搜索错误地在 `shell_command` 外又嵌套 PowerShell，正则 `|` 被外层解析，两条查询均未执行；后续直接使用 `rtk rg` 且不加管道，避免重复引用错误。
>
> 2026-08-18：shared schema 首轮 typecheck 39 项失败，归为 descriptor 索引后 input 仍为 `unknown`、text/reasoning 合并 schema 令判别提取为 `never`、`z.json()` 暴露生产者/夹具仍传 `unknown` 三类；修复方式为共享 schema parse、拆分判别分支、在 tool payload 构造边界验证 JSON，不放宽契约。
>
> 2026-08-18：两段测试切片读取因 Node 换行正则经过 JSON/PowerShell 后过度转义而返回空输出；改用 `split(String.fromCharCode(10))`，不重复反斜杠方案。
>
> 2026-08-18：第二、三次 typecheck 仅余 `chat-run-state.test.ts` 括号语法错误，源于机械替换 helper 闭合符命中相邻边界；第三次暴露更早位置残留一个多余 `)`，改用函数级精确锚点并检查该文件 diff，不回退 JSON-safe helper 方案。
>
> 2026-08-18：内容契约首轮聚焦测试 84/85，通过项覆盖其余边界；唯一失败为旧测试要求 question payload 静默 strip 未知字段。根据 strict schema 与 fail-explicit 规则，更新测试为额外字段拒绝，不恢复旧 strip 行为。
>
> 2026-08-18：本轮续跑首次补记 findings/progress 使用了交接摘要措辞而非磁盘精确原文，`apply_patch` 校验失败且未写入；已读取文件尾部取得精确锚点后重新应用。
>
> 2026-08-18：Windows 下 `rg` 不展开 `src/shared/types/*.ts` 与 `src/shared/schemas/*.ts` 通配符，扫描返回 os error 123；后续改为直接传目录并用文件过滤参数，不重复 glob 写法。
>
> 2026-08-18：settings/hook schema 扫描误猜 `src/main/services/hook-config-service.ts` 与 `hook-trust-service.ts`，文件不存在并令该只读命令 exit 1；有效输出已保留，后续先用 `rg --files` 定位真实路径。
>
> 2026-08-18：IPC registry 切换真实 schema 后首轮 typecheck 20 项失败，集中为手写 `SettingsSaveRequest` 的 `Record<string, unknown>` 宽于 JSON schema，以及手写 `TaskEvent.payload: unknown` 宽于判别联合；不放宽 registry，改为让 settings/task 类型从同一 shared schema 推导。
>
> 2026-08-18：settings/task 改为 `z.infer` 后第二轮 typecheck 剩 11 项：3 个 task event 构造点未走 schema parse、main config 仍保留 3 个宽 schema、renderer/provider-config 两处 JSON helper 仍返回 `Record<string, unknown>`、1 个 hook fixture 缺 nullable 字段；按真实边界逐项收敛，不增加断言或 fallback。

| 时间 | 错误 | 尝试 | 处理 |
| --- | --- | --- | --- |
| 2026-08-16 | PowerShell 默认输出编码导致中文计划显示乱码 | 1 | 显式使用 UTF-8 读取，后续沿用该方式 |
| 2026-08-16 | 并行命令中 `git check-ignore` 以“未忽略”返回 exit 1，导致组合调用失败 | 1 | 拆分读取；后续对预期 exit 1 的查询显式处理，不重复组合方式 |
| 2026-08-16 | 嵌套 PowerShell 行号读取脚本的 `$` 变量被外层 shell 提前展开 | 1 | 改用单引号包裹 `powershell.exe -Command` 脚本，避免外层插值 |
| 2026-08-16 | PowerShell 行范围脚本中单元素嵌套数组自动展开，`[Math]::Min` 参数类型错误 | 1 | 不再构造范围数组；改用固定 `Select-Object -Skip/-First` 读取 |
| 2026-08-16 | `pnpm test -- <files>` 在当前 Vitest 4 脚本中把 `--` 传给 Vitest，误跑 323 个文件 | 1 | 后续目标测试使用 `pnpm exec vitest run <files>`；全量仍使用 `pnpm test` |
| 2026-08-16 | 误跑全量时 Node 25 的 node-pty console helper 报 `AttachConsole failed` | 1 | 记录为环境噪声；阶段门禁若重现，核对项目支持 Node 版本和 smoke 结果 |
| 2026-08-16 | 新 `interrupt-projection.ts` 引用 `record-utils` 的相对路径少了两层 | 1 | 改用现有模块真实路径 `../../services/deep-agent/record-utils` |
| 2026-08-17 | executor interface 首次 typecheck 有 69 项错误：4 项产品类型问题，其余为测试 fake 仍返回 AsyncGenerator | 1 | 先修产品类型，再用显式 execution/outcome helper 迁移测试；拒绝 legacy union/fallback |
| 2026-08-17 | AST 迁移脚本使用 TypeScript 默认 ESM 导入，`ScriptTarget` 未定义 | 1 | 改用 `import * as ts from 'typescript'`；确认失败发生在任何写入前 |
| 2026-08-17 | 当前 Node ESM 对 TypeScript 只暴露 `default/module.exports`，namespace import 仍无 compiler API | 1 | 脚本改用 `createRequire()` 加载 CommonJS compiler API |
| 2026-08-17 | TypeScript 7 包的 CommonJS 入口同样不含 compiler API | 1 | 放弃 AST；改用限定语法且处理字符串/注释的括号扫描，并用 typecheck/diff 验证 |
| 2026-08-17 | 全量 Vitest 首次重跑出现 1 个断言失败和 2 个未处理 rejection：事件流失败时 outcome 未消费 | 1 | runtime 在事件流异常/取消早退边界消费 outcome；execution 工厂和测试 helper 立即注册 rejection handler；聚焦测试复验通过 |
| 2026-08-17 | Standards 审查发现迁移后两个未使用类型导入 | 1 | 清理 `interrupt-projection.ts` 与 `runtime-types.ts` 导入；strict unused tsc 通过 |
| 2026-08-17 | 双轴子代理 `wait_agent` 多次超时，但 agent 已完成 | 2 | 使用 `close_agent` 读取完成报告；修复后复审同样取得 PASS 报告 |
| 2026-08-17 | projection 直测首次因 FK 夹具缺失失败，提前停止测试因 mock 不响应 abort 超时 | 1 | 补真实 thread/run 夹具；让受控 provider 显式 reject/close 后验证 outcome settle |
| 2026-08-17 | 阶段 2 首次全量测试的 `terminal-session-service` 因 Node 25/ConPTY 关闭事件未到达并触发临时目录 EPERM | 1 | 单测复跑 4/4 通过；全量复跑 324 文件/1818 项通过，确认环境波动而非阶段回归 |
| 2026-08-17 | 从 `git diff` 动态拼接 Vitest 路径时 PowerShell 将数组传成单一 filter，提示 `No test files found` | 1 | 改用显式目录与文件参数；聚焦 58 文件/358 项通过 |
| 2026-08-17 | strict unused 检查发现 runtime 残留未使用 `toChatRunMode` import | 1 | 删除残留 import；typecheck 与 strict unused 复验通过 |
| 2026-08-17 | 首次阶段 3 全量测试发现 `observeSettledOutcomeUsage` 空 `catch` 违反代码质量门禁 | 1 | 改为显式 Promise resolved/rejected 双分支；质量测试与全量测试复验通过 |
| 2026-08-17 | Standards 复审发现 live `run_started` 仍发布 `chat`，与 shared/replay 的 `run` 不一致 | 1 | live 事件改用 `snapshot.mode`，新增 live/replay 等值断言；双轴最终复审 PASS |
| 2026-08-17 | 并行读取批次因预期 exit 1 的 `git check-ignore` 被 Promise 聚合为整体失败，未返回单项结果 | 1 | 改用 `Promise.allSettled`，对单项失败独立记录；不再用 `Promise.all` 聚合可能非零退出的查询 |
| 2026-08-17 | Windows PowerShell 5.1 默认输出编码再次令 UTF-8 中文追踪文件显示乱码 | 1 | 改用 Node 以 UTF-8 读取文件；不依据乱码输出做设计判断 |
| 2026-08-17 | 探测性 `rg` 批次再次因无匹配 exit 1 被 `Promise.all` 整体中断 | 2 | 确认为执行规约回归；后续所有可能无结果的搜索固定使用 `Promise.allSettled`，不再聚合失败传播 |
| 2026-08-17 | task event schema 首轮 typecheck 4 项：动态 options 数组不满足 discriminated tuple、persisted output 变 unknown、async status 过宽 | 1 | persisted schema 改用交叉约束；读取 deepagents 官方 `AsyncTaskStatus` 枚举后收紧，拒绝字符串兜底 |
| 2026-08-17 | TaskEvent 主进程边界聚焦测试 14 项失败：持久化事件 payload 的 `enabledCapabilities` 未纳入严格共享契约 | 1 | typecheck 已通过；沿生产写入路径补齐真实 payload schema，并增加回归测试后复验 |
| 2026-08-17 | 台账补丁使用了交接摘要中并不存在的 `findings.md` 精确行，校验失败且未写入 | 1 | 读取三个文件尾部取得磁盘精确锚点后重新应用 |
| 2026-08-17 | 仅依据“当前无读取方”删除 assistant message 的 provider/model，违反已有 repository 契约测试 | 1 | 撤回删减；保留必填审计字段并补全 renderer 测试夹具 |
| 2026-08-17 | `import('esbuild')` 与 `pnpm exec esbuild` 均失败：仅有传递依赖且旧 bin 链接失效 | 1 | TypeScript 7 也不导出 transpile API；将锁内 `esbuild@0.28.1` 声明为直接 devDependency，生成器只依赖公开 API |
| 2026-08-17 | IPC registry 首轮 typecheck 两项：生成 literal union 令运行时 Map/测试 Set 的 `has/get(string)` 过窄 | 1 | 容器边界显式声明为 `Map<string, Mapping>` 与 `Set<string>`；保留生成项自身的精确字面量类型 |
| 2026-08-18 | 恢复批次直接用 `rtk` 包装 PowerShell cmdlet，`Select-String`/`Get-Content` 未被解析为可执行程序 | 1 | 改用 `rtk powershell.exe -NoProfile -Command ...`；外部程序仍直接使用 `rtk <program>` |
| 2026-08-18 | 并行读取五份技能文件与 RTK 规则时输出通道关闭，未取得可用结果 | 1 | 缩小输出批次并逐项读取；后续大文件读取限制范围或拆批 |
| 2026-08-18 | schema 使用点探测误用 Unix `head`，Windows PATH 无该程序，组合命令 exit 1 | 1 | 后续使用 `rg -m` 或 `rtk powershell.exe ... Select-Object` 限制输出；不再调用 `head` |
| 2026-08-18 | `pnpm check:ipc` 在 TS registry 引入真实 schema 后失败：data URL 单文件 transform 无法解析 `zod` 与相对模块 | 1 | 生成器改用 esbuild bundle 完整模块图，再从内存 ESM 载入 registry |
| 2026-08-18 | bundle 修复后 `pnpm check:ipc` 正确报告 `ipc-generated.ts` 漂移 | 1 | 运行 `pnpm generate:ipc` 更新受控生成物，再用 `pnpm check:ipc` 复验 |
| 2026-08-18 | IPC 聚焦首轮 14/15：preload event channel 在生成代码中因 `on`/`off` 合法出现两次，测试错误按一次计数 | 1 | 期望改为 request key 一次、event key 两次，继续锁定无缺失/无额外 key |
| 2026-08-18 | runtime parse 接入后 typecheck 发现 adapter 残留 `omit-first` 兼容分支已成为 `never` | 1 | 删除废弃 transform 分支；字段裁剪只保留 registry request schema 的显式 `.omit()` |
| 2026-08-18 | `rg` 定位 adapter `omit-first` 分支时 exit 1 且无输出，与 typecheck 行号不一致 | 1 | 改用 Node UTF-8 精确读取报错行段；不重复无结果搜索 |
| 2026-08-18 | 阶段 4 扫描结论补入 `findings.md` 时误用只存在于 `progress.md` 的“阶段证据模板”锚点 | 1 | 读取 `findings.md` 磁盘尾部取得精确锚点后重试；失败补丁未写入 |
| 2026-08-18 | 插件聚焦测试首次 3 项 task history 失败：shared IPC request schema 比旧 task contract 放宽 limit/cursor/thread 约束；同批 node-pty 报 Node 25 `AttachConsole failed` 环境噪声 | 1 | 将旧有效约束收紧到 shared schema；ConPTY 错误不改变失败断言根因，修复后单测复跑 |
| 2026-08-18 | 收紧 shared task history schema 后，`progress.md` 追加证据使用了显示摘要的非精确锚点，补丁未写入 | 1 | 读取 UTF-8 文件尾部后按磁盘原文追加 |
| 2026-08-18 | Node `-e` 内联中文关键词读取 progress 时触发 `SyntaxError`，命令未执行 | 1 | 改用 `rg` 直接搜索 UTF-8 文件；后续 Node 内联脚本只用 ASCII 条件 |
| 2026-08-18 | 恢复批次误用 `rtk cat` 读取技能文件，Windows PATH 无 `cat`，批次未执行 | 1 | 改用 `rtk proxy powershell.exe -NoProfile -Command "Get-Content ..."`，后续不再使用 Unix `cat` |
| 2026-08-18 | 嵌套 PowerShell 统计技能文件行数时 `$p*` 被外层 shell 提前展开 | 1 | 删除嵌套变量，改用绝对路径直接调用 `Get-Content`，随后成功取得行数并分段读完技能 |
| 2026-08-18 | 阶段 4 strict unused fresh 扫描报 45 个 unused import、涉及 7 个文件 | 1 | 确认为 shared schema 单源迁移后的旧类型/值导入；只删除编译器列出的 specifier，随后复跑 strict unused 与阶段门禁 |
| 2026-08-18 | 阶段 4 首次全量测试 327 文件中 2 文件失败、1832 项中 3 项失败 | 1 | config 两项为旧断言与 strict shared schema 语义冲突，IPC adapter 一项为 `chat.startRun` main-only 字段未裁剪的真实回归；先追踪权威契约，再分别修复测试或实现并复跑 |
| 2026-08-18 | 阶段 4 第二次全量测试剩 1 项 `metrics-service.test.ts` 性能阈值失败（5.79ms >= 5ms） | 1 | 该文件未被阶段修改；先单独复跑确认 Node 25/机器负载波动，不擅自修改无关性能测试 |
| 2026-08-18 | 阶段 4 第三次全量测试剩 1 项 terminal-capabilities 清理临时目录 `EPERM`，并有 teardown RPC 未处理 rejection | 1 | 未改动该测试；按阶段 2 先例视为 Node 25/ConPTY 环境波动，目标复跑后改用串行全量验证 |
| 2026-08-18 | 串行全量验证耗时约 6.8 分钟，期间仅输出已知 node-pty `AttachConsole failed` 噪声 | 1 | `pnpm exec vitest run --fileParallelism=false` 退出码 0，327 文件/1832 项全部通过；保留噪声证据，不修改 node-pty 或测试 |
| 2026-08-18 | 阶段 4 Standards 子代理因服务端 429 Too Many Requests 超过重试上限，未产出审查报告 | 1 | 保留失败证据；等待 Spec 结果后重启 Standards 子代理，不跳过双轴审查 |
| 2026-08-18 | 本轮恢复再次将 PowerShell `Get-Content` 和 Unix `cat` 直接交给 `rtk`，均因不是 PATH 可执行程序失败 | 1 | 改用 `rtk cmd /c type` 或 `rtk node -e` 读取；不再重复已记录的 cmdlet/Unix 命令误用 |
| 2026-08-18 | 本轮恢复再次误读根目录 `plan.md`，且 `cmd if` 的括号被 PowerShell 预解析 | 1 | 已使用真实路径 `plan/plan.md`；目录存在性改用无 shell 控制语法的 `rtk cmd /c dir /b .codegraph` |
| 2026-08-18 | 查询子代理状态时给 `wait_agent` 传入低于最小值的 1000ms，调用被参数校验拒绝 | 1 | 改用 `list_agents` 做即时状态检查；后续 `wait_agent` 固定使用至少 10000ms |
| 2026-08-18 | HITL schema 提取后 strict unused 报 `chat.ts` 的 `jsonObjectSchema` 无调用方 | 1 | 删除提取后残留常量；不改合同，复跑 strict unused 与相关门禁 |
| 2026-08-18 | Spec 复审发现 session resume 审计 payload 仍以 `Reflect.get` + 数组强转绕过 HITL decision schema，且 `chat-view.tsx` 保留一处 persisted message guard | 1 | 新增 malformed decision 与 source guard 红测；改用共享 `hitlResumeDecisionSchema` parse，并直接访问已解析 TaskEvent message；复跑相关门禁 |
| 2026-08-18 | `git diff --cached --check` 经 `rtk` 返回 exit 1 但过滤了诊断 | 1 | 使用 `rtk proxy git diff --cached --check` 取得原始输出，定位并删除两个新 schema 文件的 EOF 多余空行；重新暂存后复验 |
