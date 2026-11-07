# S00 持久化升级与匹配版本冷恢复合同

日期：2026-11-06。来源 SHA：`eea2087b5d2d79df3b2fea7764ce48e4975fd764`。
状态：S02 的 M01～M06 已实现并通过隔离迁移/恢复验收；真实用户数据转换未运行。
S01 的 M12 工程切换已完成，独立科学数据仍待补齐。
S03 的 M07 已通过隔离迁移/重开验收，目标 agent20/research62。S05 M09 已通过隔离转换，目标 agent20/research63。S00 只执行隔离空库 schema 探测。
本台账固定允许的来源、目标合同和拒绝条件；后续实现不能放宽为泛用历史 decoder。

## 1. 版本与来源锁

S02 允许的起点数据库组合为本 SHA 的 core 1 / agent 19 / memory 2 / task 1 /
workspace 1 / diagnostics 1 / research 60，且 `schema_migrations` checksum 与
[schema 探测](../.artifacts/research-harness/S00/2026-11-06T10-35-39.451Z/schemas.json)
一致。数据库总版本的后续编号按实际迁移顺序分配；不能在 S00 虚构未落地的 SQL 版本。
下表数字是选定的业务合同版本，独立于数据库 migration version。

S03 离线转换器允许完整 agent19/research60 或 agent20/research61 两组来源，
逐组核对 schema/checksum 并直接转换到 agent20/research62；其他来源拒绝。
生产 reader 不混读新旧合同，不能把当前 Manifest 回填成历史执行版本。
当前磁盘内允许出现的 v7/v8 snapshot、effect identity v0 是有限历史输入，
不表示任意旧数据库版本受支持。

execution v2 从 S02 起包含显式 `nodeBinding`：`kind=none` 表示无 DAG 节点，
`kind=dag` 必须有 nodeId/graphRevision。S02 不调度 dag 类型；S06 启用该已有合同，
不得在保持同一版本号时静默改变必填字段。具体 wire schema 在实施时补全严格类型与消费者。

| ID / 阶段 | 当前输入 | 目标合同 | 转换、保留与拒绝 | 验证 / 状态 |
| --- | --- | --- | --- | --- |
| M01 / S02 | agent 19；`agent_runs.snapshot_version` 7/8/9，snapshot_json；checkpoint、message、telemetry refs | 新执行 snapshot v10；必填可信 origin、项目关联、输入/manifest/policy 版本；同版本恢复 | v9 仅在冻结身份/输入版本有原始证据时转换；v7/v8 不创建可恢复 v10 snapshot。终态或无法重建者保留原 payload/hash/ref 为独立只读审计，不进生产恢复 reader；旧活跃 run 全部停止/收束 | 来源行数与 ID 映射、snapshot hash、原始事件/checkpoint 保留、v10 读/跨版本拒绝、同版本恢复；complete（工程/隔离演练，见 s02-execution-report.md） |
| M02 / S02 | Task v2、execution v1；`research_tasks`、`research_task_executions`；research DB stage/job refs | Task 暂保 v2；execution v2，明确可信 origin、冻结输入与关联状态；Stage execution snapshot 新 v1 | 能证明的原 executionId/taskId/projectId/parent/manifestHash 原样保留；无法证明的关系标为历史不可继续，拒绝补造父链；新关联先 agent DB intent，再 research DB 写入，最后幂等确认 | 两库行数、跨库 ref/hash、注入“任一提交后崩溃”的 reconciliation；complete（工程/隔离演练，见 s02-execution-report.md） |
| M03 / S02 | Chat JSON events、Task event 行，无统一 versioned envelope；游标/投影快照 | 新事件 envelope v1；既有存储扩展，不另建同义 Event DB | 保留 sequence/event 原始 bytes/hash 与裁剪边界；确定来源字段可映射；无法证明的 actor/correlation/causation 不伪造，原记录进入只读历史审计。旧事件不能驱动真实工具 | 原/新 event 映射、count/sequence 连续性或明确 gap、projection 与 receipt replay 分开、损坏拒绝；complete（工程/隔离演练，见 s02-execution-report.md） |
| M04 / S02 | grant schema v1、approvals、dispatch grant、run fences | 继续 grant v1；不转移可执行审批 | 停机撤销/过期所有 issued grant/dispatch；consumed/revoked/expired 与旧 approval 保留审计。新 snapshot/request/manifest 变化重新取得审批，不用历史 approval 授权新执行 | 停机后无 issued；审批 ref 保留；旧 fence/token 拒绝；complete（工程/隔离演练，见 s02-execution-report.md） |
| M05 / S02 | effect identity v0/v1、receipt v1、operation/attempt/generation 与 reconciliation | 正常业务只读 identity v1、receipt v1 | v1 保持 operation/idempotency/hash；v0 仅有原始 canonical tool/input/version/receipt 证明时有限转换。不可重建的终态保留审计；unknown/in_progress/reserved 无法对账时阻止受影响执行升级/继续，不能改成 succeeded 或自动重做 | receipt hash/count、唯一 operation、旧 generation 拒绝、真实 reconciliation；complete（工程/隔离演练，见 s02-execution-report.md） |
| M06 / S02 | agent budget call/observation，Task/project budget policy v1 | 同一账源与 policy v1；新增幂等 settlement receipt 合同 v1 | 原 call ID、tokens/cost/pricing/version 及 unknown 原样保留；停机后未结 reservation 按真实对账转 unknown；历史未知费用不填零，不从其他 ledger 再计一次 | call ID 唯一、前后已知总额/unknown/reservation 分项对账、重复结算同 receipt、不一致拒绝；complete（工程/隔离演练，见 s02-execution-report.md） |
| M07 / S03 | raw 11 阶段 Skill、stage skillHash/context_json；Task facts contractVersion 1；context/harness revisions | 强制 Skill Manifest v1；facts 保持 v1；context/harness 新冻结 revision 引用 Manifest hash | 11 份内容保留并声明版本/许可/能力/output schema；旧 skillHash 的历史产物不改写。新执行使用新 Manifest；旧执行未固定完整版本时不可 resume；事实来源/ref/hash 与人工决定保持 | 11/11 Manifest、许可/hash/output schema 校验、facts 行数/hash、隔离上下文与权限交集；complete（S03 工程，见 s03-execution-report.md） |
| M08 / S04 | research 60 的 Evidence/Claim/Locator/人工 relation revisions、citation coverage v2 | 保留既有事实与 coverage v2；新增 semantic verdict/finding v1 | 无旧语义建议可迁移；新记录冻结 claim/source/artifact/rules/model/Skill refs/hash。人工 confirmed/rejected 原样保存，版本变化仅使建议失效 | Evidence/Claim/relation 行数/hash/reviewer 不变、建议失效、人工决定不可被模型覆盖；pending |
| M09 / S05 | 无独立版本字段的 search plan；检索执行/pool/`research_literature_request_receipts` 与 source refs | 新冻结 search plan v1、ranking receipt v1；复用既有检索来源表 | 历史检索原请求、来源和 receipt 保留；没有排序证据不生成历史 ranking receipt。新查询/候选预算变化需新审批；旧可恢复检索只有冻结边界全可证明才继续 | agent19/research60、agent20/research61 或 research62 离线到 research63；原 JSON/hash 审计、归档保留、旧批准撤销、结果 v13 到 v14、pool hash 与冷读取通过；complete（工程），科学比较未运行，见 s05-execution-report.md |
| M10 / S06 | Task v2、S02 execution v2，无 DAG node/edge/lease | Task v3；node/edge/lease 合同 v1；启用 execution v2 的 node-bound 类型 | 根任务 goal/status/budget/ID 不改成节点状态；历史 execution 不猜依赖边，不自动领取。需继续者根据当前人工确认输入建立新 graph revision；新节点持久化在同一 agent DB | 无环/同 Task/project、单有效 lease、generation/CAS、旧提交拒绝、根预算不重置；pending |
| M11 / S08 | manuscripts、export execution、artifact/provenance 与 public projection | 既有来源事实保留；新导出证据清单 v1 | 历史 ZIP 与审批不能宣称符合新清单；新导出从有效 refs 构建闭包并重新审核。工作区原文件不移动、不删除；路径/bytes hash 对账 | 实际 ZIP 内容/hash/manifest、私有字段排除、来源闭包、人工审核/公开授权分开；pending |
| M12 / S01 | 16 pilot fixture、protocol lock/journal、runner 文件数据 | 冻结 evaluation protocol 与 dataset revision；扩展同一 runner | 不触及用户 DB；pilot 保留工程 fixture；独立标注/来源 split 单独新建并冻结，不把 fixture 换名成 holdout。旧 journal 保留协议/hash，不伪造 live 结果 | hidden view、split/source 分离、旧 journal 可审计、live adapter 隔离；complete（工程）；科学数据/人工评价未运行，见 evaluation/scientific-readiness.md |

core、memory、task、workspace、diagnostics 本阶段无目标 schema 变化，仍纳入完整备份与
integrity/FK 检查。它们不是可以丢弃的“无关库”。知识索引、文档 parse 与来源迁移/替代、
综述人工 screening/quality 冻结记录及其 refs 全部保留；如果后续字段变更涉及这些对象，
必须先补明确台账，不能让通用转换器猜测。

## 2. 停机、备份与有限离线转换

1. 在来源应用版本上禁止新 dispatch，暂停根 Task，停止 chat/stage/领域 job、
   等待实际 cleanup、撤销 grant。记录终止失败与 unknown effect；无法确认停止就不转换。
2. 冻结完整应用数据目录、全部 DB、需要的配置/安全存储引用与索引；SQLite 先 checkpoint/
   关闭连接或用一致性 backup API，不能单拷正在写入的 `.sqlite` 丢掉 WAL。
   同时固定匹配的旧应用构建与源码 SHA。备份可能含私有数据，只放用户指定本地位置。
3. 在备份副本离线预检：schema/checksum、integrity/FK、状态、行数、ID/ref/hash，
   包括跨库关系与真实工作区文件 bytes。记录文件清单，不修改原始工作区。
4. 转换器仅接受本台账允许的来源与目标；每库短事务，跨库 intent、转换 journal 与
   幂等 reconciliation 明示。转换失败保留证据并退出，不启用新应用。
5. 离线完整性报告通过后启动匹配的新应用，验证当前 reader、只读历史审计、来源/文稿/
   任务可见性与新执行审批。程序/schema 不匹配立即拒绝启动；不尝试运行时升级 fallback。

不在 S00 自动选择用户备份目标、不转换真实用户数据。实施与演练使用隔离副本；
用户真实升级按覆盖目标数据和停机影响的授权执行。

## 3. 历史记录与无法重建的数据

只读审计记录保留原 payload、来源 schemaVersion、rawHash、原 ID/ref、转换原因与
可确定的当前关联。它不是旧生产 decoder，也不暴露恢复、工具 dispatch 或 approval reuse。
对已裁剪事件记录已知范围/gap；对缺 execution-time model/Skill/source version 记录
不可继续的原因。禁止把当前模型/Skill/来源版本回填为历史执行版本。

全局完整性损坏、跨项目关联、来源 checksum 不一致、无法停止活跃执行、unknown effect
未对账、预算已知值不一致、原始 bytes/hash 缺失均为拒绝条件。历史记录不满足新执行输入
但自身完整时可以只读保留；此条件不等于数据损坏，也不能被解释成成功迁移出可恢复 run。

## 4. 冷恢复与验收材料

冷恢复先停止新应用和 worker，核对升级后新增的外部 effect/用户文稿变化，再恢复
**匹配旧应用 + 迁移前完整备份**。旧应用不得读取新 DB；新应用不得用旧审批继续。
升级后真实用户文件不能被备份覆盖流程静默删除，外部操作不能靠数据库回退撤销。
存在新副作用时先人工核对并保留清单，确认恢复范围后再执行。

每次演练报告固定：来源/目标 app SHA 与数据库版本/checksum、备份路径/hash、
开始结束时间、停机/cleanup/grant 状态、各表前后行数、ID/ref/hash 映射、unknown 项、
转换 journal、拒绝原因、冷恢复应用与数据配对、所有检查命令及日志。
S02 实现有限转换；S08 演练完整升级/冷恢复。S00 的空库通过不能替代这些验收。
