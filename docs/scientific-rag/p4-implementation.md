# 知识库优化 P4：写作上下文与正文依据检查

`WritingContextService` 复用原有 Wiki、Scientific Query、Evidence、Claim 与 Manuscript。
它保存章节写作准备回执，检查已保存正文，并给出来源变更的影响；不另建正文或证据数据库。

| 能力 | 输入 | 输出和效果 |
| --- | --- | --- |
| `research.writing.prepareContext` | `projectId`、`artifactId`、`sectionTitle`、`sectionGoal`、可选 `documentIds` | 原文引用、已捕获 Evidence、事实、人工审核主张、反面证据、缺口、限制与 `ready/incomplete` |
| `research.writing.checkGrounding` | `projectId`、`artifactId`、`contextId` | 读取实际 Manuscript 小节与 Claim；返回段落、主张、Evidence、文档与 UTF-16 数字位置 |
| `research.writing.reviewImpact` | 同上 | 只读来源、Wiki、Evidence、Claim、正文和有效配置变化，交给人工修订 |

准备时读取研究目标和相关 Topic Wiki，再分别调用统一原文检索与反证/局限性检索。
Wiki 只作导航，其文字不会直接变成已验证事实。事实必须来自当前知识发布，并且原文、单位和条件引用都能绑定到检索来源。
来源引用通过解析身份与原始块定位找到真实 `research_knowledge_chunks` 行，随后调用现有 Evidence 捕获入口。
检索候选 ID 不会被当作旧 chunk ID；缺少真实文本块的对象返回 `evidence_unbound`。
自动 Evidence 绑定目前面向文献库管理文档。项目索引（project-index）来源不能映射到该旧 Evidence 存储时保留
`evidence_unbound` 和 `incomplete`，不能据此宣称项目文件已具备正式写作证据。

首稿可以用同项目当前批准的阅读笔记、计划或其他上游材料作为准备锚点，随后对同项目新保存的 manuscript 使用原 `contextId` 检查。
已保存的当前可编辑草稿也可直接作为锚点。准备过程仍完整比较工件快照；准备后正常创建 Claim 和保存正文导致的 draft `updatedAt`
变化不会令材料上下文失效。批准上游的内容/状态、锚点生命周期、研究目标、来源和有效配置变化仍会拒绝或产生 `context_changed`。

Evidence、工作流事件和 provenance 回执在同一事务内写入。回执保存重建所需的逐轮检索数据、来源绑定、知识事实、Wiki 修订、
主张快照、正文映射摘要及分别计算的检索/知识配置摘要。读取时校验回执摘要和事件关联，并重新验证当前项目权限、PDF 字节、解析与知识发布。
准备过程发生工件、研究目标、权限、来源、配置或 Wiki 修订变化时拒绝发布；事务内失败同时回滚新捕获的 Evidence。
原始文本、已存在 Evidence、Claim 状态、审核决定和正文均不会被准备器改写。
角色运行的输入冻结只排除严格关联到同项目、同锚点准备事件且通过 schema、摘要与事件 payload 校验的派生回执。
普通 provenance 和伪造准备回执仍使输入版本过期，避免合法准备后立即误报 `research_stage_inputs_stale`。

没有当前版本的人工支持关系、抽取事实未获审核支持、指定论文覆盖不足、反证没有可验证结果或检索预算用尽时返回 `incomplete`。
`source_validated` 只表示原文绑定；抽取的 `scientificApproval` 始终保持 `unreviewed`。
`ready` 表示本次材料通过这些可检查门槛，科学结论仍由现有人工关系审核负责。

正文检查分别报告来源失效、未审核关系、缺少实验条件、原文数值/单位不匹配、把推断写成确定结论，以及遗漏已记录的反面证据或限定条件。
数字检查按原文 token 和已验证表格单位执行，不默许单位换算。它是保守的宿主检查，不声称完整语义蕴含；
精确实验数值换算仍使用既有 consistency 映射，正式批准与导出继续执行原有人工审核闸门。
中文紧邻数字、科学计数、SI 前缀、平方/立方及负指数、复合单位和未知英文单位保留完整数量对。
结构化实验值与单位也须共同绑定到同一原文数量或已验证事实，不能把 `90 ms` 和另一处 `2 kg` 拼成 `90 kg`。
影响检查不会替用户重写段落，来源失效也不销毁历史回执。

## Agent 与阶段 Skills

主 Agent 暴露 `research_prepare_writing_context`、`research_check_draft_grounding` 和 `research_review_writing_impact`。
writing/revision 角色对应工具为 `prepare_writing_context`、`check_draft_grounding` 和 `review_writing_impact`，自动绑定项目，
只接受本次批准输入中的 artifact，检查工具要求 manuscript，并在异步调用前后核对 run、输入版本、取消信号与返回绑定。
新输出未保存时不得声称已完成 grounding；保存后主 Agent 可继续检查。prepare 进入既有 worker effect 记录。
effect 命中幂等重放时仍重新检查运行、冻结范围、取消与当前项目文档权限；prepare 还核验返回回执中全部 sourcePapers 的权限，
即使请求的 `documentIds` 为空也不能绕过撤权。重复调用复用成功回执，不重复产生准备或深读写入。

reading/planning/writing/revision 角色新增 `read_paper_deep_knowledge` 与 `request_paper_deep_knowledge`：先复用现有发布，
按实际问题、维度和章节/对象请求异步深读，立即返回作业；角色范围、项目文档权限和返回身份均受校验。
深读请求属于 effect 写入，不进入 review 角色。带 `scientificInput` 的父/子审阅只消费冻结证据；实时科学检索、
写作检查、来源迁移查询和深读均不能扩大材料范围。自动发布继续保留 `unreviewed`。
五个 Skills 更新至 `1.7.0`，同步 requiredCapabilities、eval requirements、内容摘要与 catalog；
科学检索角色映射改为实际执行的 `research.knowledge.scientificQuery`。

本阶段同时统一旧索引的原始块选择：空文本的科学表、图和公式仍占据索引位置。
Evidence 定位、重解析迁移建议、人工注释捕获和写作绑定使用同一选择函数，避免空图之后的段落错位。
此修复不迁移或删除既有用户资料。

## 工程验证

工作目录：仓库根。

```sh
node --test tests/unit/writing-context.test.mjs tests/unit/writing-grounding.test.mjs tests/unit/research-writing-role-tools.test.mjs tests/unit/research-scientific-review.test.mjs tests/unit/research-skill-registry.test.mjs tests/unit/writing-tools.test.mjs
node --test --test-concurrency=2 tests/unit/research-manuscript-integrity.test.mjs tests/unit/research-manuscript-sync.test.mjs tests/unit/research-export-validation.test.mjs tests/unit/research-export-body-gate.test.mjs tests/unit/research-scientific-writing.test.mjs tests/unit/run-capability-manifest.test.mjs tests/unit/paper-deep-tools.test.mjs tests/unit/writing-tools.test.mjs tests/unit/research-source-locator.test.mjs tests/unit/research-document-annotations.test.mjs
node scripts/check-research-skills.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
pnpm check:ipc
pnpm build
ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=.artifacts/p5-shell-smoke node scripts/smoke-electron.mjs
git diff --check
```

测试用隔离 SQLite、真实 PDF 字节和受控知识发布，覆盖正常捕获、回执重读、人工审核前后、知识换代、
来源/权限/配置/工件竞争、取消、事务回滚、原始块索引错位、数值与反证定位、只读影响和回执篡改，
以及批准输入准备后继续完成首稿、普通 provenance 仍失效、推进时钟的 draft 保存、冻结审阅和按需深读权限边界。
正式保存/导出与来源定位回归在最终源码上 72/72 通过，包含主 Agent 返回 contextId 错绑反例。
最终六文件定向套件 55/55 通过，包含单位指数与未知单位、正常保存草稿、角色幂等重放撤权回归；TypeScript 与 `git diff --check` 通过。
项目 Skill 校验通过（11 个阶段、36 个资源）。通用 skill-creator 的 Python quick_validate 因当前 python3 缺少 PyYAML 未运行成功，未为此修改全局环境。
`pnpm check:ipc` 与完整 `pnpm build` 通过，构建包含类型和前端分包检查。隔离数据目录的 Electron smoke 23/23 通过，
覆盖启动、项目、文件/终端、助手受控回复、设置、主题及缩放；无 renderer error。此运行使用构建目录，不代表打包发布或真实模型写作验收。
临时 PDF、数据库与构建 bundle 由 fixture 清理。此组检查不代表真实模型写作质量、科学事实覆盖率或人工验收。
