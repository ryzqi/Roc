# 证据来源与关系审核

## 固定文档定位

`ResearchSourceLocator` 保存真实导入 document ID、固定 parse ID、知识文档 ID、
block ID、原文 source SHA、保存解析内容 SHA、parserFingerprint、原始 locator 文本
及解析器保存的页/区域。坐标使用原解析器的坐标系；投影到 PDF 与原文预览遵循[阅读导航](research-pdf-navigation.md)的实测坐标合同。

证据捕获从实际 knowledge chunk 联接原 document/parse；按原索引过滤非空块后的
顺序选择 block，并验证完整 excerpt/locator。重复正文不能靠文本匹配选错块。
解析必须是该文档的当前 ready 结果，原文 sourceHash 必须与解析一致。证据、
已有来源metadata和定位 sidecar 在同一事务中保存；失败全部回滚。

`research_evidence_source_locators` 按 evidence ID 保存不可替换的定位 JSON。
相同捕获幂等，已保存定位冲突拒绝写入。重解析保留旧 evidence 与定位，旧引用
仍明确标为 superseded；严格正文/图稿/导出消费者仍拒绝旧来源。旧 evidence
保持原始 locator 与状态，不迁移猜测坐标。非托管文档来源的 sourceLocator 为
null，原始来源文字仍可核对；这不表示它已具备托管文档预览。

## 关系快照与人工审核

`research_evidence_relations` 保存 supports、contradicts、qualifies、
depends_on、supersedes 及 historical。提议绑定真实 claim/evidence/project、
claim version/hash、完整来源快照/digest、原文、定位、适用条件和提出者。
qualifies 必须提供条件，supersedes 必须指定同一主张版本的有效旧关系。
agent 提议者必须对应实际项目的阶段 run，默认 proposed。

审核仅接受 user actor，必须显式提交 relation version、claim version 和 source
digest。confirm/reject 追加审核人、时间、说明及不可替换的修订快照。
supersedes 仅在用户确认时撤销旧关系；拒绝或未审核提议不改变旧关系。
仓库接受可信 main 调用者提供的 actor。用户 IPC 的 actor 由 main 从实际
sender window ID 绑定为 `window:<id>`；请求不能指定提出者或审核人。
模型 supported 产出已经接通 proposed supports；检查器提供用户提议与审核按钮。

主张修改和证据失效在原写入事务中撤销 proposed/confirmed/historical 关系，
保留原始来源和审核人，追加 system 原因。修订写入失败时，原主张/证据更新及
全部关系更新一起回滚。读取、列举和历史检查快照完整性，不产生写入。
检查器的 required relations 数组参与 artifact SHA；任何提议或审核变动都使
原人工闸门版本失效，需重新阅读整个阶段。

用户可在当前 draft 的 waiting_approval 闸门中审核关系元数据；正文编辑仍
受原阶段编辑权限约束。approved、archived、非当前阶段或未附加到阶段的
工件拒绝审核。agent 提议仍受原阶段编辑权限约束。

historical 只表示保存的来源关联，不表示已确认的 supports，也不补造提出者、
审核人或审核时间。批准和当前导出执行严格语义消费者准入；定位候选、
可信捕获与显式来源替代/实验重跑关联见下文。

## 可信用户 IPC

`research.inspectEvidence` 返回保存的完整来源及规范化 digest；失效来源仍能
读取旧片段，但明确标为 superseded。`research.listEvidenceRelations` 和
`research.evidenceRelationHistory` 返回真实关系及历史，读取不写库。
`research.proposeEvidenceRelation` 与 `research.reviewEvidenceRelation` 只在
main IPC adapter 建立的窗口/项目/能力上下文中写入。缺少 sender、直接调用
注册能力、跨项目或复用另一能力的上下文均拒绝；并发窗口的身份互不串用。

版本或来源变化返回 conflict；身份/项目/工件状态错误返回 permission；
缺少端点返回 not_found；破损来源或关系快照返回 degraded。未知失败继续
抛出，不包装为成功。generated preload/IPC 合同来自单一 ipc-registry。
原生验收已通过真实 SQLite、PDF parser 和 registry/adapter；测试 sender
为明确的 synthetic main 输入。检查器另有实际 Electron 窗口的键盘提议、
审核、历史读取及原闸门返回验收；模型提议已由明确的离线角色模型验收，没有实时科研查询。

真实区域保留原坐标及 origin；当前 HTML 的零面积坐标转为仅页定位（bbox/origin
均 null）。没有 locations 时保持空数组，不从任意来源字符串猜页码或矩形。
页码超出保存的 pageCount、倒置/退化的非零区域拒绝捕获。

工件 inspector 每条 evidence 增加 required nullable sourceLocator；它参与既有
工件 SHA，读取没有文件 IO、数据库写入或 worker。UI 的显式页/区域预览仍属
[PDF 阅读导航](research-pdf-navigation.md)；原文快照始终保留保存定位。

## 检查器矩阵

检查器延迟加载关系模块。支持/反对/限定列分别显示当前主张版本的 confirmed
与 proposed 数量；historical、rejected、invalidated 不计作确认或待审核。
来源必须与当前捕获一致。筛选支持全部、未确认支持、已确认反对、待审核；
保留主张原顺序，明确说明统计口径，没有模型生成的分数或假冒科研质量结论。
依赖、替代及历史关联仍在主张详情中显示原文、条件和状态。

用户选择当前工件显示的证据后，单独通过 source inspector 重读真实片段及
digest，再保存 proposed。qualifies 必须填写条件；supersedes 必须明确旧
关系。确认/拒绝位于固定原文旁，提交精确 relation/claim/source 版本，
支持可空审核说明、真实 pending 和明确错误。confirm 不改变 Claim 的
hypothesis 状态。缺少当前权限、旧工件或失效来源不能审核或提议；人工
审核历史只在明确读取时请求，读取不写库。

成功写入刷新工件，旧 SHA 显示 stale，必须明确重新核对当前版本；整个阶段
的闸门上下文仍需另行重读，再返回助手作原闸门决定。关闭/换项目后晚到的
写入响应和历史不刷新新工件，不传递批准状态。所有文本由 React 转义。
current source inspector 也包含关系的真实 evidence 端点，不能只枚举旧
evidenceIds。矩阵跳转聚焦详情组；原生 summary 保持独立键盘展开。

## 模型产出与只读角色工具

阶段输出中的 supported 是模型的支持性声明。main 在保存真实 Claim 后，
为每个声明的真实 evidenceId 保存 proposed supports，绑定实际阶段 run、
claim version/hash 和完整来源/digest；审核人、审核时间、审核说明为空。
hypothesis/pending 的来源关联不自动转换成支持关系，也不升级主张状态。
产出保存与提议/历史使用原事务，关系历史失败回滚工件、主张、正文及 run
completion；重复完成、结束或非当前阶段的 agent 不能再提出关系。

角色通过 `inspect_evidence_source` 分页读取固定原文与 source digest，
通过 `list_evidence_relations` 区分 proposed/confirmed/historical/invalidated。
工具的项目来自 main 绑定，要求真实 active run；来源失效可核查旧原文，
取消后的工具拒绝读取。列表明确标原文截取长度，完整来源通过分页读取。
角色没有用户确认能力；写入 reviewer 仍只能走可信窗口上下文。

模型产出直接表达 supports，其他关系类型仍由用户显式提议。
模型提议必须另经用户确认，不能把产出声明当作已经通过科学语义审核。

## 批准与当前导出

complete 允许草稿进入 waiting_approval，以便用户先核查关系。approve 在原最终
写事务中检查所有 supported 主张：每个声明来源必须有当前 confirmed supports
或 qualifies；qualifies 保存明确适用条件。confirmed contradicts 即使同时存在
支持关系也拒绝批准，需用户核对并显式替代旧反对关系。historical、proposed、
rejected、invalidated、depends_on、supersedes 都不能冒充支持确认。

正文创建/保存和草稿 inspectBundle 仍检查声明状态及来源完整性；不提前要求人工
确认而阻断核查。exportBundle 及当前导出正文、图稿另外执行严格关系检查。来源
失效、主张变化或审核版本变化不能通过当前导出；检查器仍可核对旧原文和审核历史。
批准拒绝使用 research_relation_review_required 或 research_relation_conflict，
原 LangGraph 闸门仅捕获这些已知用户可处理错误，返回新 interrupt；用户审核、
重读全阶段版本后再决定。未知错误继续抛出。

离线原生工作流经真实 registry/generated adapter，由明确 synthetic window:93
逐条确认模型支持提议，再进行版本冻结与批准。该测试证明传输、事务和消费者链，
不证明真实科学结论。原冻结科研样本保持不变。

## 固定导出审核封印

每个新导出保存 `provenance/scientific-review.json`。私有科学审核快照使用 schema 5，记录 project、
原 `sourceHash`、Claim version/hash、实际 inspected evidence（含 sourceLocator）、
所有关联关系及其完整修订历史。独立关系的证据端点也进入快照，即使它没有进入
旧 claim.evidenceIds。原文、条件、提出者、审核人、时间和失效历史均来自真实仓库。
JSON 采用固定序列化；公开交付使用 `public_projection`，明确记录省略与私有回执来源，见[导出合同](research-exports.md)。当前 manifest schema 3 保存文件 SHA/size，归档哈希覆盖该文件。

ready 落库、publish、complete/approve 的最终事务、异步校验后及交付链接前均比较
当前只读审核快照与已存文件 SHA/size。缺少封印返回
research_export_semantic_snapshot_required；变化返回
research_export_semantic_snapshot_changed。用户需核对当前关系并重新生成导出，
原 LangGraph 闸门保留新的人工中断。异步导出失败保留准确领域码。

历史 `sources`、sourceHash 和归档不重写，不补造历史人工审核，也没有兼容 alias。
历史 inspect/read/source 仅验证保存文件和归档哈希；当前来源失效后仍可读取原 PDF
及原审核快照。当前发布/校验/交付另要求有效来源、关系与封印。缺少新审核文件的
历史归档可以核对其原内容，不能用于当前发布。读取不撤销、替换或生成文件。

## 重解析后的定位候选

保存不可替换的 source-migration proposal 与完整快照 SHA。同一文档的实际
新解析完成后，在原 parse/index/证据失效事务中生成候选。原来源快照、digest、
固定旧定位及新 parse/source/hash/fingerprint 均保留；不修改旧 Evidence、Claim
或恢复旧科学审核。没有旧已捕获来源的解析不进行块匹配。不补造历史候选。

匹配规则公开为 exact_text_then_whitespace/1：先匹配完整原文，再仅规范化空白。
多个同文块标 ambiguous，保留真实索引顺序，不按旧页距离选一个；正文变化
标 no_match，targets 为空。每个目标保存实际 chunk ID 与原始解析 block，包含
实际页/区域数据；它是待核查提议，不能把原始 bbox 当作已经校准的 PDF 投影。

只读 list 按真实 project/evidence 限定。后续解析使旧提议的 targetStatus 为 stale，
其原内容不改；当前目标的 document sourceHash 或 canonical parseHash 变化拒绝
读取，破损提议 SHA 拒绝。所有候选保持 needs_review，没有科学确认或自动捕获。

候选写入失败同时回滚 parse/index/失效标记。延迟知识写入移到事务提交后入队，
避免后续 flush 发布已回滚的解析。真实回归在旧入队位置复现了 rollback-new
幽灵索引；修正后 DB 与外部写入队列均保持原状态。

## 同文档定位候选与用户决定

候选保存不可替换的旧来源快照/digest、新 source/parse/hash/fingerprint 与
实际索引顺序中的完整原始解析 block。算法先比较完整原文，再只规范空白；多个
匹配保持 ambiguous，不按旧页距离挑选。改变正文保存 no_match，不猜替代。
当前目标源与保存 parse SHA 必须一致；后续解析使旧候选 targetStatus 为 stale，
候选原记录保持不变。原始区域按保存的坐标依据投影；历史记录缺少坐标依据时只允许页级定位。

research_source_migration_decisions 为每个候选保存一个不可替换的用户决定。
required proposalHash 随 list/get 返回；capture/reject 必须明确提交候选、旧来源
和目标 parse SHA、requestId 与 nullable note。capture 必须指定实际候选 chunkId，
即使只有一个目标也不自动选择；reject 不接受 chunkId。无匹配或旧目标可拒绝，
旧目标不能捕获。新捕获校验当前真实 chunk/parse/block/source，并调用 evidence.capture；
证据、locator 与决定同事务，任一步失败回滚。

主进程 research-human-context 绑定实际窗口与精确 capability/project，关系审核和
定位决定共用该权限边界。wire 不接受 actor/source；直接 capability 无人审上下文
拒绝。同 project/requestId 的重试必须保持同 actor 与完整 request SHA，返回原决定
且不写入；改变选择、说明、动作或窗口身份拒绝。其他 request 也不能重复决定候选。
历史决定保存当时 recorded 的真实新来源/digest；list/get 另外返回当前
capturedReferenceStatus，重解析不改原决定或旧证据。

定位捕获不改 Claim evidenceIds、status、version、正文、图稿或科学关系/修订历史。
旧 supports 审核继续 invalidated。需用户/助手另建主张版本与关系并重新科学审核，
原批准/当前导出不能通过新位置捕获恢复。后端与可信传输已接入同一工件检查器；明确来源替代与实验 rerun lineage 使用下文的独立用户决定。

## 候选检查器

旧证据的托管文档来源详情提供按需加载的定位候选。新匹配保留原始解析块顺序、
完整原文、原始 locator 与实际页信息，明确区分完整文本、仅规范空白、多个匹配、
无匹配与旧目标。候选/source/parse SHA 放在原生详情中；不把原始区域称为已经
投影到 PDF 的坐标，不自动选择单个或多个目标。

用户核对当前工件后显式通过原生 radio 选择目标，再捕获或拒绝。无匹配与旧目标
不能捕获；当前项目归档或工件快照未重新核对时，决定按钮禁用。动作使用既有
异步状态模型，保留主进程错误，待保存时禁用字段和两种决定。相同完整选择/说明
重试复用 requestId；成功后重读实际候选，不伪造前端成功记录。

已捕获与已拒绝均可读取不可替换的用户、时间、说明、请求和完整决定。捕获记录
与当前 capturedReferenceStatus 分开展示；后续解析只显示当前定位也已失效，
不改原捕获的 recorded 快照。关闭、换工件、换项目后的晚到读/写响应不会刷新
新选择或提交批准。定位确认继续不恢复任何科学关系。

候选及外层来源的 ::details-content 使用局部 overflow:clip 覆盖，避免 Chromium
在聚焦原生折叠内的输入框时把 overflow:hidden 匿名容器内部滚动，隐藏原 locator、
原文或候选说明。沿用现有折叠动效；没有新时长、全局 CSS 或第二套布局。真实
Electron 验证依据最终原生区域坐标，不仅依据 getAnimations().finished 或阴影审计。

## 明确来源替代与重跑前后关联

research_source_replacements 保存用户明确选定的两个真实 Evidence。请求必须
指定 document_replacement 或 experiment_rerun、两端 ID、两端当前 digest、requestId
和 nullable note；窗口身份仍由主进程绑定。新文档附件或同名实验本身不会产生替代。
文档替代必须是两个不同的托管文档；同文档重解析继续走定位候选。实验关联必须
绑定本项目两个实际完成的托管执行，保存完整原请求、代码/输入/环境/输出文件
和执行快照 SHA。用户选择只表达前后端点意图，不证明结果等价或科学可比。

替代事务保存原来源及 digest、失效后的同一来源快照、新来源/digest、用户、时间
与完整请求/SHA。只撤销选定项目/Evidence 的有效关系，不改 Evidence 的原文、
sourceVersion、locator、Claim status/version/evidenceIds、原实验执行/输出或旧导出。
其他项目对共享文档的引用不失效。新位置或新执行仍需新主张/关系与人工科学审核。
scientificReviewAtSelection=needs_review 是选择时的固定事实，不冒充当前审核状态。

新端点必须当前 recorded，真实 chunk/text/locator/hash 与固定来源一致；文档
sourceHash 与当前 ready parse SHA 一致。实验源不可由非托管记录、未完成运行或
同名标签代替。捕获原记录和旧关系失效共用事务，记录失败时完整回滚。相同
project/requestId 与 actor/request SHA 重试只返回原记录；不同内容、窗口或重复
关系拒绝。list/get 比较固定快照 SHA，当前 targetReferenceStatus 单独显示，目标
后续失效时原前后关联仍可读取。

只读角色工具 `read_source_migrations` 与 `read_source_replacements` 按字符分页返回完整固定记录；项目与运行由服务绑定，取消或终止后拒绝读取。替代记录列表包含证据作为前序或新来源的两种情况，按保存顺序返回。工具不会接受用户身份、写入替代决定或恢复科学支持；`nextOffset` 用于继续读取完整实验输入、环境和输出快照。

检查器的「来源替代」按需读取固定前后关联。目标证据来自本项目实际捕获列表，没有默认选择；用户先核对两端当前原文、locator、版本与摘要，再明确确认文档替代或实验重跑关联。实验展示真实完成状态、完整输入/环境/输出记录。失效目标、同文档位置、非托管来源或未完成运行不允许提交。相同完整选择与说明的重试保留 requestId，保存期间字段禁用；成功后刷新工件并要求重新核对。迟到读取或已提交写入的迟到响应不影响另一工件或项目。
