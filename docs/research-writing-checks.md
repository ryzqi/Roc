# 科研写作检查

正文引用覆盖、人工直接性、数值映射与 Vale 措辞检查分别回答来源覆盖、引用性质、数值对应和表达问题；任何一项通过都不授予科学批准。入口位于现有[工件检查器](research-artifact-inspector.md)，不新增阶段页。

## 参考文献字段检查

助手工具 `research_check_references` 调用 `research.library.checkReferences`，一次检查当前项目 1–10 条唯一文献 ID。先校验整组选项归属，再经现有 provider/governor/cache 查询 Crossref 与 OpenAlex，返回文献 revision、输入哈希、查询时间、响应哈希、缓存及错误。

DOI 身份、题名/作者/年份的 match / different / unknown 和撤稿观察分别保存；`consistent` 只表示元数据一致。缺 DOI 默认 unknown，显式 `titleSearch: true` 才查询题名候选；候选始终 unresolved / needs_review，题名相似度不能证明文献身份或论断支持。该入口检查文献库条目，不解析任意工作区 `.bib`，也不修改来源记录。

## 引用覆盖与直接性

`inspectCitationCoverage({projectId, artifactId, expectedHash})` 读取已保存且有效的正文，不要求已批准。首次 `expectedHash: null`，重读传上次 hash；返回 current/stale、完整报告、hash 和读取时间。

报告 schema 2 按小节/段落关联主张、LaTeX 引用键、Evidence 原文与版本、固定 PDF 解析位置及书目 revision。PDF 文件来源通过保存的定位关联书目，不按文件名猜测。原稿键仍为 Evidence ID，最终 BibTeX 键由[导出](research-exports.md)处理。

只有主张/来源版本一致、人工确认的 supports / qualifies 计入已审核语义引用；反对、未确认和拒绝关系分别保留。定位精度不证明科学直接性。每条引用有 nullable `directnessReview`，直接/间接/不支持/未审核计数独立于语义支持。

`saveCitationReview` 要求人明确填写 direct / indirect / unsupported、理由、当前报告 hash、主张与 Evidence。首次 parent 为显式 null，后续为最新审核 ID/hash。主张或来源改变后旧判断过期；最新审核头进入工件快照 hash，使旧阶段核对版本失效。

报告 hash 包含正文、工件版本、来源、关系和书目 revision，不含读取时间。失效正文/来源拒绝当前检查；仍有效的批准工件和归档项目可只读检查。`getCitationReviewHistory` 分页返回完整不可变 `stored_receipt`，来源失效后仍可读原始历史，不宣称当前有效。

## 主张数值与实验指标

`saveConsistencyReview` 将摘要、正文、表格或图稿 caption 的数值位置绑定到真实实验指标及 Evidence。映射显式包含主张 hash、JS/UTF-16 位置、展示单位、指标 ID、结果 ID/hash、来源证据、转换、舍入、容差与理由。位置须覆盖整个十进制 token，含符号及指数；正文主张必须属于当前保存稿件。

| 规则 | 合同 |
| --- | --- |
| 转换 | 相同单位显式 identity；affine 指定原/目标单位、scale、offset、理由 |
| 舍入 | 不舍入或 0–12 位十进制、half-away-from-zero；有理数计算，负半数同样远离零 |
| 容差 | `max(absolute, relative * abs(expected))`，无隐藏 epsilon；非有限结果拒绝 |
| 结果 | 保存 observed、expected、difference；不一致照实保留 |

`inspectConsistency` 重验当前来源与工件版本；主张变化标为 changed，来源字节/Evidence 失效则失败。每个未映射数值单独保留，映射一个位置不会隐藏同主张的其他数值。`getConsistencyHistory` 只核验保存回执、计算、索引和父链。

caption 数值一致不能证明图中实际绘制数据一致；绘制数据另有[图稿数据映射](research-figures.md)。回复与期刊检查分别见[回复矩阵](research-response-matrix.md)、[期刊检查](research-journal-compliance.md)。

## 人工保存与检查界面

直接性和数值审核均追加不可变版本，绑定当前工件、主张、Evidence、结果及最新 parent。身份来自主进程验证窗口。相同请求/身份重试先核对当前来源，再返回原回执；旧版本、错父链、跨项目、已批准、失效或归档范围拒绝新增。

检查模块按展开动作加载；等待/失败隐藏旧成功报告，报告版本不符要求显式刷新。历史按需分页，标明只校验保存回执，保留完整原文、规则、理由、身份和 JSON。脏草稿及保存中锁定来源重查、选择、关闭、刷新和阶段审批；冲突保留草稿，同内容丢失回执重试保留请求 ID。保存刷新整个工件，批准/归档范围只读，迟到响应不能进入其他项目或工件。

## Vale 措辞检查

Vale 使用随包规则做确定性检查，不运行模型、不修改正文、不落库，也不进入严格阶段输出合同。写作/修订 Skill 仍约束生成时的证据口径；措辞命中不能代替语义审核或同行评审。

| 目标 | 入口与输入 | 投影 |
| --- | --- | --- |
| 正文工件 | capability `research.prose.lint`；IPC `roc:research:prose-lint`，preload `research.lintManuscript`，角色工具 `research_lint_manuscript`；`{projectId, artifactId, expectedHash?}` | 按小节投影 Markdown 并定位 claim；要求已保存有效正文，可检查未批准稿 |
| 工作区 TeX | capability `research.prose.lintTex`；助手工具 `research_lint_tex`；`{projectId, path, expectedHash?}` | 项目工作区 `.tex`，单文件上限 2 MiB，标记 workspace_tex；当前没有专用 preload 方法 |

读前/检查后重验内容 hash。正文标题/空行命中无 claimId；行号非正或越界不定位。TeX 投影有明确 limitations，不将文件位置伪装成主张位置。报告包含目标 kind/path/contentHash、`roc-prose-v2`、Vale 版本、toolchainHash、缓存 hit/miss、truncated 和 droppedUnits；缓存原始命中按当前主张重新定位。

| 规则集 | 条数 | 范围 |
| --- | --- | --- |
| RocAcademic | 英文 9 | 模糊限定词、无出处断言、超出证据、新颖性、共识、冗长、被动、名词化、拼写 |
| RocAcademicZh | 中文 8 | 半角标点、模糊限定词、无出处断言、超出证据、新颖性、共识、冗余动宾、口语 |

error/warning/suggestion 表示规则严重度；拼写为 suggestion，措辞报告不充当导出闸门。规则与词表在 `resources/research-runtime/vale/`，参与工具链 lockHashes，修改后须重建科研工具链。

Vale 使用显式本地配置、`--no-global`、禁网沙箱及私有 jobDir；运行后回收临时目录。缺文件与配置错误明确失败，不变成空成功报告。命中上限 2,000，超出报告标为 truncated，调用方须保留截断与投影限制。
