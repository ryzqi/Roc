# Idea Canvas、方法计划与结果评估

构思能力由对话代理调用，方法计划与结果评估在[工件检查器](research-artifact-inspector.md)编辑和审核；没有独立构思页面，旧 `?view=ideas` 回到默认 LaTeX 视图（[ADR 0024](adr/0024-stage-surface-removed.md)）。

## 项目语言与 Canvas

项目 `language` 为 zh/en，创建时省略默认 zh；界面创建后锁定语言，`updateProject` API 仍可修改。阶段 Agent 按项目语言输出，界面为中文；导出语言由导出请求单独指定。数据库兼容要求见 [database-storage](database-storage.md)，不提供旧项目自动升级。

`saveIdeaCanvas` 只接受 idea_canvas 工件：problem、hypothesis、novelty、supportingEvidence、counterevidence、experiment、risks 七个字段齐全，支持证据与反证可空；另填 priority（high/medium/low）与 rationale。fields 恰好七项、key 唯一、content 与对应字段一致，status 为 supported/hypothesis/pending。supported 必须引用本项目当前有效 Evidence；结构完整不等于科学结论成立。

首次 expectedVersion=null，后续匹配当前版本；`getIdeaCanvas` / `getIdeaCanvasHistory` 读取当前与历史。complete/approve 重验归属、字段、证据与内容 hash。请求定义见 [research-ideas.ts](../src/shared/schemas/research-ideas.ts)，实现见 [idea-repository.ts](../src/main/plugins/research/idea-repository.ts)。

## 晋升项目

`promoteIdeaCanvas` 要求已批准、当前版本及新的 workspacePath，可显式指定 title/description/language。新项目从 discovery 开始，默认继承源语言，记录 origin.projectId/artifactId/version；同 Canvas 版本重试返回原项目。源工件、证据与流程保持原样。

构思 Agent 输出必须包含 ideaCanvas，写入本次运行创建的工件；结构、字段或证据校验失败会使运行失败，不打开审核闸门。

## 方法计划与人工冻结

方法计划追加版本，绑定 Canvas 工件 ID、version/hash；修订引用最新父 ID/hash 并填原因。冻结另存真实主进程 sender、审核说明、时间、请求和冻结 hash，wire 不接受 actor。精确重放返回原回执，不写新版本。

计划显式填写一致的假设、可证伪条件、指标定义/单位/方向/预期、数据、设计、分析和新颖性对比。样本量记录人工确认的方法、参数、样本数与证据，或未计算原因；服务不计算功效。观察前/后为人工声明，事后计划需当前 Evidence，后续不得改回观察前；不构成独立预注册证明。

Canvas/证据漂移、跨项目、归档或被替代工件拒绝保存/冻结。历史保留旧版本并显示 canvasCurrent。API：saveIdeaPlan、freezeIdeaPlan、getIdeaPlan、getIdeaPlanHistory。

## 真实结果的人工评估

结果评估是每个冻结方法独立的追加时间线，绑定计划 ID/version/hash、冻结 hash、真实结果回执 ID/hash，并保存指标 Evidence、实际运行起止时间、完整方法与人工说明。历史冻结方法可回填结果，修订引用最新父评估并说明原因；不修改假设、预期或测量。

每个计划指标关联该结果的一个实测 Evidence，或明确缺失原因，至少保留一个实测指标。遗漏、重复及跨结果映射拒绝。定义/单位/方向差异逐项保存，有差异只能选不可比；支持、反驳、无法判断由人工选择。

saveIdeaOutcome 绑定主进程身份，精确重放零写入。getIdeaOutcome 重验运行、输入/输出/源码与 Evidence，来源失效报错；getIdeaOutcomeHistory 标为 stored_receipt，仅核验保存历史，不表示当前来源有效。归档项目只读。

## 检查器与导出

检查器按需加载方法/评估编辑器，主动选择观察时序、冻结方法、真实运行与指标。方法历史每页 10 项；选中 ID/hash 复核。内容不变的重试保留 requestId；指标 Evidence 已保存而评估失败时明确保留证据。

未保存内容或 pending 写入锁住关闭、刷新、工件/任务及审核切换；方法与评估相互锁定。snapshot 聚合当前 Canvas、计划及每个冻结方法的最新评估 head/Evidence；任何变更使旧审核 hash 失效。历史查看与“复核当前来源”分开，来源漂移保留历史但撤销当前验证状态。

私有导出包含实际被正文/所选图稿引用结果的最新 ideaOutcomes 和全部 stored_receipt 历史；科学审核 schemaVersion=5。来源、冻结方法、真实运行时间与指标映射均精确核验，head/来源变更使旧 sources hash/seal 失效。公开 projection 与省略规则统一见[导出合同](research-exports.md)，不改写私有历史。验证入口见 [verification](verification.md)。
