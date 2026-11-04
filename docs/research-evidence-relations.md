# 证据来源与关系审核

## 固定文档定位

`ResearchSourceLocator` 保存真实导入 document ID、固定 parse ID、知识文档 ID、
block ID、原文 source SHA、保存解析内容 SHA、parserFingerprint、原始 locator 文本
及解析器保存的页/区域。坐标使用原解析器的坐标系；本合同不声称已经实现 PDF
像素投影或原文预览，二者属于后续 PR-07。

证据捕获从实际 knowledge chunk 联接原 document/parse；按原索引过滤非空块后的
顺序选择 block，并验证完整 excerpt/locator。重复正文不能靠文本匹配选错块。
解析必须是该文档的当前 ready 结果，原文 sourceHash 必须与解析一致。证据、
已有来源metadata和定位 sidecar 在同一事务中保存；失败全部回滚。

DB20 `research_evidence_source_locators` 按 evidence ID 保存不可替换的定位 JSON。
相同捕获幂等，已保存定位冲突拒绝写入。重解析保留旧 evidence 与定位，旧引用
仍明确标为 superseded；严格正文/图稿/导出消费者仍拒绝旧来源。旧 evidence
保持原始 locator 与状态，不迁移猜测坐标。非托管文档来源的 sourceLocator 为
null，原始来源文字仍可核对；这不表示它已具备托管文档预览。

## 关系快照与人工审核

DB21 `research_evidence_relations` 保存 supports、contradicts、qualifies、
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

迁移只把现存 evidenceIds 保存为 historical 关联，不补造 supports、提出者、
审核人或审核时间，不改历史 Claim status。跨项目、悬空端点或破损来源使
整个迁移回滚，数据库保持 DB20。批准和当前导出已使用严格语义消费者准入；定位迁移候选
仍属于后续增量，不能以当前消费者完成代替 PR-06 整体验收。

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
后续 PR-07；现有原文快照可核对保存定位。

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

本增量模型产出直接表达 supports，其他关系类型仍由用户显式提议。
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

每个新导出保存 `provenance/scientific-review.json`。严格 schema 记录 project、
原 `sourceHash`、Claim version/hash、实际 inspected evidence（含 sourceLocator）、
所有关联关系及其完整修订历史。独立关系的证据端点也进入快照，即使它没有进入
旧 claim.evidenceIds。原文、条件、提出者、审核人、时间和失效历史均来自真实仓库。
JSON 采用固定序列化；manifest v2 保存文件 SHA/size，归档哈希覆盖该文件。

ready 落库、publish、complete/approve 的最终事务、异步校验后及交付链接前均比较
当前只读审核快照与已存文件 SHA/size。缺少封印返回
research_export_semantic_snapshot_required；变化返回
research_export_semantic_snapshot_changed。用户需核对当前关系并重新生成导出，
原 LangGraph 闸门保留新的人工中断。异步导出失败保留准确领域码。

历史 `sources`、sourceHash 和归档不重写，不补造历史人工审核，也没有兼容 alias。
历史 inspect/read/source 仅验证保存文件和归档哈希；当前来源失效后仍可读取原 PDF
及原审核快照。当前发布/校验/交付另要求有效来源、关系与封印。缺少新审核文件的
历史归档可以核对其原内容，不能用于当前发布。读取不撤销、替换或生成文件。

原生验收保留科学审核快照、manifest v2 和 historical-export-audit.json。实际
PDF source/parse/block 定位、synthetic window:93 确认及修订历史均进入封印。
任务创建文件篡改后检查/读取拒绝；精确恢复后通过。来源失效后保存记录、审核
文件及 PDF 保持原哈希；当前交付失败、目标不存在、所有读取与拒绝零 DB 写入。

## 重解析后的定位候选

DB22 保存不可替换的 source-migration proposal 与完整快照 SHA。同一文档的实际
新解析完成后，在原 parse/index/证据失效事务中生成候选。原来源快照、digest、
固定旧定位及新 parse/source/hash/fingerprint 均保留；不修改旧 Evidence、Claim
或恢复旧科学审核。没有旧已捕获来源的解析不进行块匹配。迁移不回填历史候选。

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

本增量为同文档重解析的仓库基础。用户选择/捕获候选、检查器展示、显式来源
替代和实验重跑 lineage 仍待后续完成；不把同一文献的另一个附件猜成替代来源。

## 已验证范围

来源定位增量 unit830、Harness94、fresh build/type/native13、相关串行 renderer22、
startup12/zero errors、IPC/chunks1132980bytes/6files通过。定位 unit6 使用真实
repositories 和明确 synthetic parsed data，覆盖重复/空块、无区域、旧解析保留、
来源/块冲突事务回滚、页/区域拒绝和19→20迁移历史保留。native full workflow
实际解析冻结 PDF，经真实角色 capture 保存 document/parse/block/source/parse hash
与原区域，readonly inspection 无 DB 写入；evidence-source-locator.json 与工件检查
记录保留。冻结 fixtures 没有修改。

关系仓库、可信 IPC 与矩阵增量的最终命令、结果和截图路径以
`plan/research-optimization-execution-log.md` 为准。

## 后续验收

`evidenceIds` 是来源关联，不表示已经人工确认科学支持。明确关系、版本绑定、
人工审核、修订历史、模型支持提议与 UI 已实现；严格语义消费者准入、定位
迁移候选及历史导出仍待接通。来源完整性、科学语义和人工审核分别报告，PR-06
整体尚未完成。

严格批准/当前导出增量已验证 focused32/unit857/Harness94/native13/UI37/startup12。
导出审核封印增量已验证 unit858/final focused9/Harness94/native13/UI27/startup12、
fresh build/type/IPC/chunks1132980bytes6files。定位迁移候选仍未完成；上述离线
传输和来源验收不构成真实科学结论或整体计划完成。
