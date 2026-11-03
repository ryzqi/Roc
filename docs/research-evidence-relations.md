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

真实区域保留原坐标及 origin；当前 HTML 的零面积坐标转为仅页定位（bbox/origin
均 null）。没有 locations 时保持空数组，不从任意来源字符串猜页码或矩形。
页码超出保存的 pageCount、倒置/退化的非零区域拒绝捕获。

工件 inspector 每条 evidence 增加 required nullable sourceLocator；它参与既有
工件 SHA，读取没有文件 IO、数据库写入或 worker。UI 的显式页/区域入口与语义
关系矩阵仍属后续增量；现有原文快照可核对保存定位。

## 已验证范围

最终 unit830、Harness94、fresh build/type/native13、相关串行 renderer22、
startup12/zero errors、IPC/chunks1132980bytes/6files通过。新增 unit6 使用真实
repositories 和明确 synthetic parsed data，覆盖重复/空块、无区域、旧解析保留、
来源/块冲突事务回滚、页/区域拒绝和19→20迁移历史保留。native full workflow
实际解析冻结 PDF，经真实角色 capture 保存 document/parse/block/source/parse hash
与原区域，readonly inspection 无 DB 写入；evidence-source-locator.json 与工件检查
记录保留。冻结 fixtures 没有修改。

## 后续语义关系

`evidenceIds` 当前是来源关联，不表示已经人工确认科学支持。下一增量加入
supports/contradicts/qualifies/depends_on/supersedes 的明确关系、提出者、版本绑定、
人工审核与修订历史；模型默认提出，人工确认科学语义。旧关联保存为历史事实，
不得伪造历史审核人。来源完整性、科学语义和人工审核分别报告。
