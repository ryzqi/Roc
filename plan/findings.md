# 仓库核对与设计依据

## 已核对

- 来源文档 862 行已完整阅读，覆盖 WP-00～WP-12、RH-00～RH-21、
  16 周路线、数据模型、测试、发布及风险章节。
- 根目录 `AGENTS.md`、`CONTEXT.md`、`README.md` 和 `package.json` 已读。
- 初始 Git 工作区仅有未跟踪的来源文档；本轮应保留该文件，不修改来源。
- 声明技术栈：Electron 45.0.0、TypeScript 7.0.2、React 19.3.1、
  Deep Agents 1.15.1、LangGraph 1.5.2。实际命令确认 Node v26.13.0、
  pnpm 12.5.1。其他声明版本尚未等同于本地运行验证。
- 当前 HEAD：`eea2087b5d2d79df3b2fea7764ce48e4975fd764`。来源文档记录
  `30bc77f`，历史验收账本记录 `6268012b`，三者不能混用为当前验收。

## 当前代码事实

| 范围 | 当前事实 | 执行含义 |
| --- | --- | --- |
| Task | `src/shared/schemas/research-tasks.ts` 使用 schemaVersion 2；根任务状态与 execution 父子关联已存在；当前已读 schema 未含 DAG edge、node lease 或 revision | 明确区分根任务、依赖节点和实际 execution；任务 DAG 作为同一事实源的组成部分 |
| 事件 | Task event 有创建、状态、执行关联、调用关联与结算；Chat event log 有数量/字节限制和快照 | 补科研事件语义，保留有界回放的真实边界 |
| Effect | `AgentToolEffectStore` 已含 operation/idempotency identity、attempt、lease generation、receipt | Task lease 控制节点提交；Effect lease 控制真实操作，两者用途不同；不重复建立 effect store |
| 授权 | `ExecutionGrantBroker` 绑定 run/thread/tool/manifest/request 等身份，研究 dispatch 有可信 token 校验 | 调度器不成为第二个授权入口 |
| Stage | `ResearchStageRuntime` 与 `ResearchTaskController` 已承担执行、闸门、暂停、取消和继续 | 整体切换调用方，删除重复生命周期分支 |
| Skill | `research-skills.ts` 静态导入 11 份 `SKILL.md?raw`，按阶段直接索引 | 全部内置阶段转为必填 Manifest；删除静态映射与无 Manifest 兼容加载 |
| 引用 | `ResearchCitationCoverageService` 已读已有文稿、来源、locator 和人工关系 | 确定性检查已有基础；新增语义建议不能覆盖人工决定 |
| Eval | `quality-evaluation/Task.md` 明确 16 项、全部 pilot、无 live adapter；已有协议锁、runner、journal、统计和隐藏期望边界 | 扩展当前 evaluator，禁止再造 runner；L1、L2 与科学质量分开验收 |
| 观测 | 已有任务抽屉、调用观测、当前工件版本、回放 gap、本地诊断导出；诊断上限 2 MiB | 增强现有组件与存储，不能把已实现观测列为全新能力 |
| 文档 | `research-optimization-status.md` 已明示历史状态及未完成外部/科学验证 | 不重写历史账本，不将历史授权视为本轮提交或远端授权 |
| 版本控制 | `.gitignore` 忽略 `.planning/` 和多项 `docs/*`，`plan/` 未被忽略 | 本轮计划直接写 `plan/`；后续新增 ADR 需核对跟踪规则 |

## 已定位的消费者与测试

- Renderer：`src/renderer/management/sections/ResearchTasksSection.tsx`、
  `src/renderer/artifacts/`、`src/renderer/app/AppShell.tsx`、
  `src/renderer/app/view-registry.ts`。
- 跨进程：`src/shared/ipc-registry.ts`、`src/shared/surfaces.ts`、
  `src/shared/schemas/research-tasks.ts` 及任务观测/证据/检索/导出 schemas。
- 测试：Task identity/cancellation/events/facts/diagnostics，run event/budget，
  tool effect，search plan，citation/evidence，quality evaluation，
  renderer research tasks 和原生资源 integration。
- CodeGraph 使用已有索引提供关键符号与调用信息；没有创建或刷新索引。

## 方案与用户要求的差异

来源倾向薄层扩展、可选 Skill Manifest、旧事件迁移、实验功能双路径。
用户允许整体重构并拒绝兼容和遗留代码，执行方案需据此改写切换与删除策略。

最终计划统一采用：新合同直接切换所有生产消费者；旧实现通过固定 SHA 在隔离基线环境比较；
必要持久化转换使用有限的一次性离线迁移；运行时只读当前版本；不在生产保留旧路径。
用户数据、真实工作区文件和历史证据不属于“遗留代码”，不能因重构默认删除。

## 探索纠正

- 搜索时发现 `src/main/database/` 不存在；实际基础设施已定位为
  `src/main/infrastructure/database-migrations.ts`、`database-schemas.ts`、
  `database-pool.ts` 等，插件 repository 提供领域拥有者，不能照搬猜测目录。
- 当前 `research-search-plan.ts` 限制最多 3 queries、总候选最多 60。
  多视角不能默认扩大这两个边界，查询扩张必须有明确新合同与重新批准。
- ADR 0027 规定当前 Roc compactor 是唯一压缩器，不能同时开启上游 summarization。
- 评测代码搜索确认 Task split 仍硬编码 `pilot`，runner 拒绝非 pilot dispatch，
  audit 固定 `fullDatasetReady: false`。S01 需要实际重构输入/runner，而非只添加数据文件。
- 宽搜索结果被工具截断至 200 项，后续改为小范围路径核对；没有依据截断结果声称完整能力清单。
- 本轮属于静态计划编制，未执行新的 Harness/科学/界面运行验收。

## S00 当前实施核对（2026-11-06）

- 已实测隔离空库全部迁移：core 1、agent 19、memory 2、task 1、workspace 1、
  diagnostics 1、research 60。各库 `integrity_check` 与 `foreign_key_check` 结果保存在
  `.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/schemas.json`；
  这证明当前声明 schema 可构建，不表示已经检查真实用户库。
- 75 个直接安装依赖均与声明版本一致；Node v26.13.0、pnpm 12.5.1、
  macOS 27.0.1（26A434）、arm64。实际 Electron 45.0.0 内嵌 Node 24.22.0、
  ABI 150，宿主 Node 与 Electron 不共用 ABI；完整 runtime 信息进入 `baseline.json`。
- `runExecutionSnapshotSchema` 当前 v9，但 `legacyRunExecutionSnapshotSchema` 和
  `runExecutionSnapshotAnySchema` 仍提供 v7/v8 路径；grant broker 用 any schema
  解码后再限定 v9。S02 必须一起切换相关解码、恢复、grant 和测试。
- `ResearchTaskRepository` 明确与预算共用 agent DB；研究 stage/job 在 research DB。
  `linkStage/linkOwned` 已建立 execution 关联。两个库之间没有单事务保证；
  目标协议需要持久化 intent 与可重复对账，不能只称“原子切换”。
- `AgentPluginRuntime`、`buildRunHarness`、`ResearchStageRuntime` 与
  `ResearchTaskController` 现有职责有分工，也有可选 broker/executor/effects 及多套
  lifecycle 分支。保留通用 run 与领域输出分工；S02 收束身份/恢复协议与必需依赖。
- `createResearchRoleExecutor` 当前直接 `createAgent/invoke`，只有预算 middleware，
  没有给 stage 指定 checkpointer；stage 中断后 retry 与聊天同身份 checkpoint 恢复
  不应混称一种恢复。S02 要为阶段执行定义明确持久化与恢复合同。
- 引用核验已有 claim/source hash、人工支持关系和 directness receipt。
  `ResearchEvidenceRelationRepository.review` 明确由人工决定；模型语义建议应作为新增
  可失效记录，不覆盖这些既有事实。
- 11 份阶段 Skill 由 `research-skills.ts` 的 raw imports 装配。
  `assembleContextHarness` 已是聊天上下文装配入口；role executor 仍单独拼 prompt。
  S03 统一来源/约束输入，继续保留 ADR 0027 的唯一 Roc compactor。
- `pnpm list --depth 0 --json` 在当前命令包装下报重复 `--json`；普通 list 有压缩输出。
  依赖采集改为逐个读取已安装 `node_modules/<package>/package.json`，
  记录全部 75 项，避免依据截断列表推断完整性。
- findings 更新首次补丁因末句使用“验收”而非“验证”未匹配；读取末行后修正，
  没有改写原历史段落。

### S00 交付核对补充

- 六项当前检查均退出 0：typecheck、IPC、1469 个 unit、16 pilot 离线 quality audit、
  build、13/13 Electron smoke。完整时间/命令/log hash 在 `baseline.json`。
- unit 总计约 354 秒；现有 quality assessment 用例单项约 32～67 秒。
  采样时仍在执行 JS/SQLite，随后正常通过，未改测试超时、跳过测试或改业务代码。
- smoke report 的 `target=dist-main-fallback`、`full=false`：
  当前 dist-main 构建与 13 条脚本路径成立，不等于已打包应用/full smoke 验收。
- 独立语料、train/dev/holdout 来源分离、盲审与 live adapter 仍缺失；
  quality audit 明示 `fullDatasetReady:false`、model/external calls 为 0。
- 根据真实 schema 探测纠正 inventory 的检索 receipt 表名：
  `research_literature_request_receipts`，不是 `research_literature_search_receipts`；
  event 拥有者实际类名为 `AgentRunEventLog`。
- `.gitignore` 的 `!docs/adr/` 已允许新增 ADR 文件；`git check-ignore` 三条新路径无匹配，
  无需增加冗余 whitelist。未发现 plan/docs 下更深层 AGENTS.md。
- 迁移台账固定业务目标：snapshot v10、execution v2、Stage snapshot/event envelope v1、
  Manifest/verdict/ranking v1，Task 在 S06 由 v2 到 v3；保留有效 facts/预算/人工证据合同。
  SQL migration 编号按真正实现顺序分配，本阶段不虚构已存在的目标数据库。

## S01 实施核对（2026-11-06）

- 当前质量数据、协议、runner、audit 全部直接导入 `QUALITY_TASKS`；Task split 为 `pilot`，
  full 检查固定拒绝。需切换全部消费者，而非添加第二 runner。
- 当前有 one-use fsync journal、失败分母、未知费用占用和 paired cluster bootstrap；
  保留这些合同。旧 arm 顺序只有奇偶交替，改为协议 seed 派生配对随机顺序。
- 隐藏期望仍与 prompt 共存于源码。将原 16 项移至显式 fixture 文件，期望单独存储。
- 应用 `buildRunHarness` 装配既有 context、manifest、budget、checkpointer 与 effect；
  adapter 应调用此入口，不能只重建 createAgent loop。
- 现有 macOS sandbox 不允许宿主 Node 路径或模型网络。新评测隔离应限 agent worker
  的文件和进程权限，并通过受控 host transport dispatch，不让 worker 获取 corpus 或凭证。

### S01 实施结果与边界

- 原 16 项已经迁入 `tests/fixtures/quality-evaluation/`，全标 fixture/contract-only。
  数据、protocol v3、runner、统计及 CLI 全部切换到显式 frozen dataset，旧 pilot API 删除。
- worker 走真实应用 executor/buildRunHarness；agent 与 memory 必须使用独立 SQLite。
  同库依次 apply 两种 schema 会触发 `database_schema_rebuild_required`，不能绕过生产 schema。
- 应用本地 stream 需要 SDK SSE chunk；host 调用为固定上限的非流式 completion，
  该桥接不能用于声称真实 provider 的流式延迟。console 重定向 stderr 保持协议 stdout 纯净。
- 真应用 terminal response 把 context contract JSON 前缀拼到模型答案之前。
  adapter 保留完整原文；回归明确其 `output_not_json`，未更改生产 stream collector。
  科学运行前须修复该产品行为，不把 adapter 裁剪答案当作修复。
- 当前 worker 使用空 MCP/Skill manifest、默认 backend 和新 trial 数据库；
  fixture 操作回执只验证 JSON 合同，不证明真实 effect 或跨 session 恢复。
  相应环境及观察器仍属 S02/S03/S06/S07。
- host-only transcript、stderr 与 cleanup 在 worker 可读写树之外；hidden ref 另有
  realpath containment 和 hash 检查。provider SDK 无真实凭证、无 tracing、retries=0。
- 两臂 bundle/真实 commit/lockfile/Node/依赖路径进入 environment hash，
  adapter 重新核验 bundle 与 lockfile，并要求两臂依赖 lock hash 相同。
- annotation hash/身份/时间能检查记录一致性，不能证明审核者确实独立或语义来源不重复。
  这些事实必须由负责人的人工审核保证。当前真实独立样本、双审、L2 及盲审均未运行。

### S01 科学运行故障诊断（2026-11-06）

真实 worker 回归在修复前 1 秒内稳定复现 context JSON + 模型 JSON 拼接。
缩小到已安装 Core ChatModelStream 与生产 stream adapter 后，同样把 human/system
消息发布为 assistant delta。根因：LangGraph 1.5.2 的 messages transformer 只排除
tool，其他输入仍进入消息流；Core 1.2.20 的 assembled output 无条件生成 AIMessage，
原 adapter 未读取 message-start 的原始 role。
依赖声明与本地 dist 实现一致，无需修改或升级依赖。

修复在生产 adapter 读取开头 role（该版本 AI message-start 无 role），输入不发布；
保留真正 assistant 的实时 text/reasoning/usage 和原样 evaluator 输出。
配套验证覆盖真实应用、主/子代理、完成前首 token 与非法 role。
初始缩小测试直接 for-await Core thenable，触发 namespace 错误；按已安装 LangGraph
公开 non-thenable handle 合同修正。subagent 补显式 cause 字段，失败日志全部保留。

## S02 继续核查（2026-11-07）

- 当前代码含 execution v2、snapshot v10、事件 envelope、outbox 与离线转换，原进度过时。
- 首次恢复专项 59 项通过；不能替代完整单测、构建、smoke 或完整 S02 验收。
- CodeGraph 返回当前未提交符号（含 reconcileTaskLinks / flushTaskEvents），可辅助导航。
- 超长批读有截断；后续按文件分段，未据截断输出认定完整核对。
- Stage 冻结输入同时包含来源内容与人工批准状态；dispatch、完成、retry、恢复审批均复核。
  诊断会隐藏失效输入的继续/恢复入口，返回明确 recoveryIssues；outbox 未送达数量与失败可见。
- 冷恢复回归已走真实 Agent runtime/executor/checkpointer：磁盘备份关闭重开后维持 runId、
  threadId 和冻结 snapshot，旧 reservation 保持 unknown，新调用独立结算。
- 生产旧 snapshot v7/v8/v9 decoder、读时升级和 effect identity v0 自动升级已删除；
  新库 agent 20 / research 61。既有库拒绝自动切换，有限离线转换仅接受台账来源版本，
  历史执行保留 audit 与完整 backup，并阻止恢复。
- 全量 unit 与 renderer 同时运行出现资源竞争超时，Renderer 首个失败项单独通过；
  继续按验收矩阵串行复核。首轮全量期间诊断/审批夹具有更新，不能用首轮构建作为最终版本证据。

## S03 权限与历史执行核查（2026-11-07）

- Stage role tools 过去读取调用方的 toolNames/context；现在与持久化 run/context 比对，
  broker 还校验 agent DB 的已确认关联、Task 状态和冻结输入，授权在检索前发生。
- `agent_execution_run_fences` 的 FK 仅接受 chat run；stage 撤销依据同一 Task/execution
  的状态与关联，不把该表误当作通用 stage fence。
- 确定性 compactor 会先删除旧消息，保护待审批工具必须在该段就生效，不能只保护 summary tail。
- 当前 research 61 的旧 context_json 缺 skillPin 会使 startup bindTask 严格解析失败。
  计划通过新的 offlineOnly schema 和现有离线转换器标历史不可恢复；不回填当前 Manifest。
  原产物、context、事实和审计需保留；不运行真实用户数据迁移。

- S03 实测 research62 离线门成立；S02 旧上下文在审计和原 context_json 中原样保留，
  不回填当前 skillPin。未关联研究阶段的聊天不受本次 Skill 合同切换影响。
  `applyResearchDatabaseSchema` 在每次打开连接时注册 outbox 使用的 SQL hash 函数；
  只在建库时执行 schema、关闭后直接重开不能代替完整连接初始化。

### S03 收尾与 S04 入口核对

- S03 旧 `getResearchSkillInstructions`、raw 阶段映射、默认工具授权及空摘要恢复分支
  在生产源码中零引用。全量采集期间未改业务源码。
- S04 真实阶段页为 `phase-04-scientific-review.md`；首次猜测
  `phase-04-verification-review.md` 不存在，改按目录清单定位。
- 现有 `ResearchCitationCoverageService` 已绑定 manuscript/claim/source 和人工关系，
  `ResearchReviewRepository` 只通过明确人工 accept/revise 推进；保留这两个事实拥有者。
  当前 stage output 只有通用 verdict 和文本，没有结构化 semantic suggestion/finding。
  S04 在这些所有者上接入独立、可失效的建议及修订关联，不创建第二个 Evidence ledger。

### S05 入口预查（S04 验收期间，只读）

- 当前 `research-search-plan.ts` 没有 schemaVersion、稳定 query ID 或 perspectives，
  `LiteratureExecutionContext.queryIndex` 仍按数组下标授权；ImportService 实际发请求前
  对 query JSON 严格比较、每页复核 assertCurrent，既有边界需保留并切换为 ID。
- `literature-fusion.ts` 已记录原始 provider rank、RRF k=60/version=1、来源权重、
  元数据冲突/DOI/别名/arXiv 版本；标题不建立身份。无需再造 identity system。
- Search ledger 和 immutable pool 已保存 execution/request/strategy、每次 transport
  receipt、unknown interrupted 状态及原始 provider records。S05 在这些拥有者扩展。

### S05 验收与迁移复核

- 全量 unit 1555/1555 通过，renderer 串行执行中；采集期间保持业务源文件不变。
- 最终差异发现旧检索计划转换将归档项目强制改回 active；应保留 archived，
  只重置其内部检索阶段并撤销旧计划批准。等当前采集结束后修复并补迁移回归。
- S06 预查：当前 StageRuntime 直接 schedule/executeChild，执行 snapshot 和 linkStage
  明确只接受 nodeBinding=none；Task v3 需同步这些边界、两库关联和人工接受，不仅加表。

- S05 审批截图已核对：浅色完整视角/预算说明、深色 800px 长查询内部滚动，
  焦点和底部审批动作可见，无横向溢出。全量 renderer 仍在运行。
- S06 接入边界：`execution.ts` 已预留 `{kind: dag,nodeId,graphRevision}`，
  但 Task budget、grant broker 与 run frozen validator 目前明确拒绝 dag。
  不能仅新增表；需一起切换 agent/research 两库 pending intent、关联确认与实际工具授权。
- Review 当前在父执行内 Promise.all 三个 child，再归并。新 scheduler 必须把
  child 和 reducer 都当节点，否则父占并发槽等待 child 会死锁，且绕过 lease。
  child 完成只产只读建议，父结果仍走现有人工 gate。
- 本轮误猜 `phase-06-orchestration.md`、`agent-execution.ts` 和 `tool-effects.ts`；
  实际分别为 phase-06-task-dag.md、execution.ts，effect 调用方待按符号定位。

### S05 归档回归与 S06 调度切换边界

- 临时隔离回归已复现旧计划离线转换将 archived 改为 active；证据
  `.artifacts/research-harness/S05/archive-before-v2.log`。初版错误期待 SQLite backup
  API 产生与源库完全相同的文件 bytes；已改按报告 backupHash 与真实归档行核对，
  源库 bytes 仍必须不变。待完整采集结束后将回归纳入正式测试并修正 SQL。
- CodeGraph 当前读取的源码确认 `insertRun` 先提交 agent DB pending intent，
  research DB 记录后 `bindTask/confirmExecution`。S06 节点需由这个边界创建，
  不在已冻结 snapshot 之后补造 nodeBinding；retry 必须保留原 node 的逻辑身份。
- `research:retrieval-eval` CLI 必须带 input/output 两个参数；全量 unit 中的
  literature-retrieval-evaluation 测试已经实际运行 CLI，覆盖工程报告、拒绝覆盖、
  非法输入不发布结果与人工标注包。没有独立语料时不能运行成科学指标。

### S05 最终结果

- 上述 renderer 等待及待修状态已结束：450/450 通过，归档迁移回归已纳入正式测试。
- 旧 result schema13 和 queryIndex pool 必须在离线门转换；运行时双 reader 不保留。
  历史策略只给 auditId/reason，不伪造 query ID 或批准；无策略 review/monitor pool
  保持原 bytes/hash，历史请求账本原样留存。冷读取、原排名/来源一致和损坏拒绝通过。
- 最终补验记录全量后 7 个源码变化与所有日志 hash，见 S05 执行报告。

### S07 恢复与验收边界

- consumed grant 的持久状态复核已经落地，执行到 spawn 之间保持同步；
  6 条真实 host sentinel 攻击与原生 36 条已有日志保留，完整 S07 尚未通过。
- 现有原生/发布/角色/事实账本回归可复用为独立攻击目录；须按每项实际到达层
  区分 schema、policy、SQLite、transport stub、native process，不能统一称 sandbox。
- 当前 UI layout audit 会降低一次性测试窗口 minWidth；生产最小宽度应另记，
  380px 只能按 renderer fixture 验证，不能声称生产原生窗口支持。

### S07 最终结论与 S08 起点

- 窄设置表单仅检测 viewport overflow/阴影不足：列宽也需验收。增加 body>=240px、
  内部横向 overflow<=1px；380px 改纵向导航并限制 provider 控件宽度，截图已复核。
- 真实 PDF/MCP P0 旧 fixture 与 S05 queryId、严格 result receipt 合同漂移；只修夹具。
- S08 需核对现有 schema3 export manifest 和 schema5 scientific-review 对 S04 语义
  finding/方法建议、Skill/gate 版本和复现等级的闭包，不新建第二套导出系统。
- 本次工具组合输出曾截断；已拆分重新读取 S08、权限矩阵、技能和最终日志。
