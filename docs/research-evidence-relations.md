# 证据来源与关系审核

证据捕获、人工关系审核和当前批准是不同动作。可信捕获保留原文与版本；模型支持声明先成为提议，必须经用户确认才能用于批准与当前导出。

## 固定来源

`ResearchSourceLocator` 保存真实 document/parse/knowledge document/block ID、原文 sourceHash、规范化 parseHash、parserFingerprint、原始 locator 及完整页/区域。区域沿用原解析坐标，PDF 投影与历史原文读取见[阅读导航](research-pdf-navigation.md)。

捕获从实际 knowledge chunk 联接当前 ready parse，按非空块的实际索引顺序定位，并验证完整 excerpt、locator 和来源哈希；不靠重复正文猜块。Evidence、来源元数据及不可替换的定位 sidecar 同事务保存，冲突或失败全部回滚。非托管来源的 sourceLocator 为 null，仍保留原始来源文字。

重解析使旧引用标为 superseded，保留 Evidence、固定定位和历史原文。读取不迁移来源或写库；严格正文、图稿和导出消费者拒绝失效来源。页码越界或倒置/退化区域拒绝捕获；HTML 零面积区域保存为仅页定位，无位置时保持空数组。

## 主张与关系

Claim 必须显式填写 experiment 的 method、dataset、metric、value、unit、baseline、conditions 和 finding。未知文本/值用 `unknown`；数值必须有限，finding 为 improves/no_improvement/worsens/unknown。合同见 [research-evidence.ts](../src/shared/schemas/research-evidence.ts) 与[阶段产出 schema](../src/shared/schemas/research-runs.ts)，不为缺字段的旧产出补默认值。

`compareClaims` 绑定同项目两个主张的精确版本并核查原证据。条件不同返回 condition_difference；事实或证据不足返回 undetermined；完整可比条件下 finding 不同返回 conflict_candidate/unreviewed。数值高低不自动证明矛盾或确认关系。实验条件进入 Claim hash 与历史，修改产生新版本并使旧关系失效。

关系类型为 supports、contradicts、qualifies、depends_on、supersedes 和 historical。提议保存真实项目/端点、Claim version/hash、完整来源/digest、原文、定位、条件与提出者；qualifies 必须填条件，supersedes 必须指定同一主张版本的有效旧关系。

模型 supported 产出保存为 proposed supports，绑定实际阶段 run；hypothesis/pending 不自动升级。工件、主张、正文、提议及 run completion 同事务写入。其他关系由用户显式提议，角色没有用户确认能力。

confirm/reject 必须提交精确 relation version、claim version 和 source digest，并追加不可替换的审核人、时间、说明及修订快照。supersedes 只在确认后撤销旧关系；未审核或拒绝不改变旧关系。historical 仅是来源关联，不补造人工审核。

主张变更或证据失效在原事务中撤销相关 proposed/confirmed/historical 关系，追加系统原因并保留历史；修订失败撤回整个原写入。

## 可信人工入口与检查器

用户 IPC 请求不接受 actor；main 从有效 sender window 绑定 `window:<id>` 和精确项目/能力上下文。直接注册能力调用、缺 sender、跨项目或复用另一能力上下文均拒绝。agent 提议要求实际项目 active run，并受阶段编辑权限约束。

用户可在当前 draft 的 waiting_approval 中审核关系元数据；正文编辑仍遵守原权限。已批准、归档、非当前阶段或未附加到阶段的工件不可审核。版本/来源变化为 conflict，权限错误为 permission，端点缺失为 not_found，快照损坏为 degraded；未知错误继续抛出。

| 入口 | 当前行为 |
| --- | --- |
| `inspectEvidence` | 返回完整固定来源与规范化 digest，失效来源可读但明确标记 |
| `listEvidenceRelations` / `evidenceRelationHistory` | 返回真实关系与完整历史，读取不写库 |
| `proposeEvidenceRelation` / `reviewEvidenceRelation` | 经可信人工上下文写提议或审核 |
| `inspect_evidence_source` / `list_evidence_relations` | 角色只读分页，项目/运行由服务绑定；取消后拒绝 |

检查器按当前主张版本统计 confirmed/proposed 支持、反对与限定关系；historical/rejected/invalidated 不计入确认或待审核。筛选、固定原文、提议、确认/拒绝与按需历史读取共享真实端点，不生成科学分数。confirm 不改变 hypothesis 状态。

关系数组参与 artifact SHA。写入成功后需刷新并重新核对工件及整个阶段闸门版本，再返回助手决定；旧 SHA 不能批准。保存期间禁用字段，失败保留明确错误；换项目/工件或关闭后的迟到响应不影响新选择。

## 批准与导出

complete 允许草稿进入 waiting_approval。approve 在最终事务检查每个 supported 主张的每条声明来源都有当前 confirmed supports 或带明确条件的 qualifies；confirmed contradicts 即使同时有支持也拒绝批准。其他关系状态/类型不能充当支持确认。

正文草稿保存与 inspectBundle 检查状态和来源完整性，供人工核查；exportBundle 及当前导出正文/图稿另执行严格关系准入。已知的 `research_relation_review_required` / `research_relation_conflict` 使原 LangGraph 闸门返回新 interrupt；用户审核、重读后再决定，未知失败不隐藏。

新导出冻结私有科学审核 schema 5，涵盖实际主张版本、inspected evidence、所有关系及修订历史，包含不在旧 claim.evidenceIds 中的关系端点。公开包保存 `public_projection`，文件 SHA/size 由 manifest schema 3 与归档覆盖。当前生成、批准、发布及交付重验快照；缺失或变化要求重新准备与审核。

历史归档只验证保存字节，不重写来源或补造审核；缺少现行审核封印的旧包可读，不能用于当前发布。完整交付与错误码见[导出合同](research-exports.md)。

## 同文档重解析与定位决定

有旧捕获来源的文档重解析在 parse/index/引用失效事务中生成不可替换候选，冻结旧来源/digest 与新 source/parse/hash/fingerprint。`exact_text_then_whitespace/1` 先匹配完整原文，再仅规范空白；多匹配保持 ambiguous 和实际索引顺序，正文变化保存 no_match/空 targets，不按旧页距离挑选。候选失败回滚解析与失效，知识写入在提交后入队。

目标保存真实 chunk 与原始解析块/位置。候选一直 needs_review；后续解析令 targetStatus=stale，不改历史记录。来源/解析 SHA 或候选快照损坏拒绝读取。原始区域使用保存坐标依据投影，缺依据仅页定位。

capture/reject 必须提交 proposalHash、旧来源与目标 parse SHA、requestId、可空 note；capture 显式选实际 chunkId，即使只有一个目标。无匹配或 stale 目标可拒绝，不能捕获。捕获复核当前真实 chunk/parse/block/source，Evidence、locator 与不可替换决定同事务保存。

相同项目/requestId/actor/完整请求 SHA 重试返回原决定，不重复写；变化或另一请求重复决定拒绝。原决定的 recorded 新来源与当前 capturedReferenceStatus 分开返回。定位捕获不修改 Claim、正文、图稿或关系，也不恢复失效 supports；必须另建主张版本与关系并重新审核。

检查器按需读取候选，显式 radio 选择、核对和捕获/拒绝；无默认目标。归档或未核对当前工件时不可提交。成功后重读真实决定；历史快照与当前失效状态分开展示。

## 文档替代与实验重跑关联

`research_source_replacements` 保存用户显式选择的两个真实 Evidence：document_replacement 必须来自不同托管文档；同文档重解析走定位候选。experiment_rerun 必须绑定本项目两个实际完成的托管执行，冻结完整请求、代码/输入/环境/输出与执行 SHA。新附件、同名实验或用户选择不证明等价、科学可比性或支持关系。

请求指定两端 ID/当前 digest、kind、requestId 和可空 note。新端点必须当前 recorded 且真实 chunk/text/locator/hash 一致；非托管或未完成实验拒绝。事务保存前后来源、用户、时间与请求 SHA，只使所选项目/旧 Evidence 的有效关系失效；不改 Evidence、Claim、运行、旧导出或其他项目引用。

重试、快照完整性与窗口身份沿用可信人工边界。原关联保持不变，当前 targetReferenceStatus 单独显示；scientificReviewAtSelection=needs_review 是选择时事实。检查器先核对两端再明确保存，成功后要求重读工件。

角色只读 `read_source_migrations` / `read_source_replacements`，按字符分页返回完整固定记录与 nextOffset，项目/运行由服务绑定；取消后拒绝，无写入或审核恢复能力。

验证入口与科学验收限制见[验证说明](verification.md)。合成窗口、离线角色模型及坐标夹具用于验证合同和事务，不能证明真实科学结论。
