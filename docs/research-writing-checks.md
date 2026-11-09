# 科研写作检查

## 当前正文引用覆盖

`research.inspectCitationCoverage({projectId, artifactId, expectedHash})` 通过现有正文仓库读取当前已保存的正文，不要求正文已批准。`expectedHash` 必填，首次读取显式传 `null`；重读传上次报告的 hash。返回 `current` 或 `stale`、完整报告、报告 hash 和读取时间。

报告按小节及段落索引关联完整主张、实际 LaTeX 引用键、Evidence 原文与版本、固定 PDF 解析位置和当前书目版本。导入 PDF 的文件来源通过捕获的文档定位关联书目；不通过文件名猜测引用。原稿的引用键仍是 Evidence ID，最终导出的书目键由既有导出主链处理。

人工已确认且主张、来源版本一致的 `supports` / `qualifies` 才计入已审核引用。报告保留条件、审核人及完整关系，明确呈现反对关系；未确认支持、被拒绝的支持和依赖关系不会变成科学支持。`locator` / `page` / `region` 仅表示定位精度，不证明科学直接性或主张真实性。

报告 hash 包含完整正文、工件快照版本、来源、关系和书目 revision，读取时间不参与 hash。来源或正文失效明确拒绝检查；可以检查仍有效的已批准工件和归档项目，但不会批准、运行模型或写数据库。旧报告对象保持原字节，重读得到新报告。

数值映射见下文；图稿实际绘制数据见[图稿](research-figures.md)，审稿回复和期刊规则分别见[回复矩阵](research-response-matrix.md)与[期刊规则](research-journal-compliance.md)。

## 同壳引用检查器

正文工件检查器提供“检查正文引用”。用户展开后才加载模块并读取报告；沿用现有抽屉、来源阅读器和异步请求状态。全部、有问题、未确认支持筛选保留完整段落及原文，原生折叠面板可通过键盘操作。

重新检查保留报告 hash 基线，因此单独修改书目 revision 也会显示 `stale`。用户可明确按当前报告版本重新核对；工件快照变化则要求先刷新工件。等待和失败时隐藏旧成功报告，项目及工件版本隔离迟到回复。这些操作零数据库写入，不产生科学审批。

650px 两主题下长段落、原文及 hash 在抽屉内换行；筛选标签不收缩，保持单行及可用选框宽度。

## 人工引用直接性

`research.saveCitationReview` 要求明确填写 `direct`、`indirect` 或 `unsupported` 及理由，绑定当前报告 hash、正文主张和 Evidence。`parent` 首次显式传 `null`，后续必须传最新审核 ID 和 hash。人工身份仅来自主进程验证的窗口，不允许通过输入提供。

为每个主张与证据对追加不可变版本，保存完整请求、人工身份、时间、正文 hash、工件版本、主张与来源原文及 digest。相同请求和人工身份重放时核对当前主张/来源后返回原回执，不重复写入。已批准、失效、非当前工件或归档项目不能新增审核；旧报告、错父版本和重复请求内容冲突明确拒绝。

覆盖报告使用 schema 2，所有引用都包含显式 nullable `directnessReview`，同时记录直接、间接、不支持和未审核计数。主张或来源变化后，旧判断标为过期；直接性判断不授予语义支持或正文批准。最新审核回执头进入整工件快照和版本 hash，另一个窗口修改直接性会使旧阶段审批上下文失效。

`research.getCitationReviewHistory` 分页返回完整历史回执，明确 `verification: stored_receipt`。来源失效后仍可阅读已保存的历史原文；这不声明来源当前有效。历史读取核对原字节、hash、数据库索引字段、主张/来源 digest 和父版本锚点，损坏时拒绝。

没有旧 schema 解析或兼容别名。

## 人工编辑与历史界面

现有正文工件的引用检查内，每条引用可打开一个人工直接性编辑器。判断初始为空，理由必填；直接、间接、不支持和待审核计数独立于语义支持。显示当前/过期判断、完整理由、审核人、时间、hash 和原始 JSON 回执。历史按需读取，每页 10 项，明确只校验保存回执；等待或失败时隐藏旧页。

未保存或保存中锁定筛选、来源重查、引用选择及父抽屉的关闭、Escape、背景关闭、工件刷新和整阶段审核。请求 ID 在输入改变时更新；回复丢失后相同内容重试保留 ID，主进程返回原回执且零重复写入。保存成功刷新整个工件，旧审批上下文失效。项目切换隔离迟到回复。已批准、归档或非当前可写阶段只读。

## 来源指标与主张数值位置

`research.saveConsistencyReview` 将摘要、正文、表格或图稿 caption 中的完整数值字符位置绑定到真实实验结果指标及其 Evidence。每条映射显式包含主张 hash、位置、展示单位、指标 ID、结果 ID/hash、来源证据，以及转换、舍入和容差规则。位置使用 JS 字符索引，必须覆盖整个十进制数值 token（含符号和指数）。正文主张必须属于当前保存的正文。

单位一致时显式选择 identity；转换使用带原/目标单位、scale、offset 和理由的 affine 规则。舍入可选择不舍入或 0–12 位十进制、half-away-from-zero；十进制舍入由有理数计算，负数半数同样远离零。允许差异为 `max(absolute, relative * abs(expected))`，无隐藏 epsilon。转换、差异和容差超出有限范围时明确拒绝。不一致值照实保存 observed/expected/difference，不强行改成一致。

按工件追加不可变人工审核版本，保存完整主张、Evidence、结果回执和计算。首次 parent 为显式 null；后续要求最新 ID/hash。窗口身份来自主进程，同内容重试复核当前来源后零重复写入。错项目、错主张、错指标、失效来源、旧工件版本、旧 parent、已批准工件和归档项目明确拒绝。当前保存边界也独立校验材料及正文归属。

`research.inspectConsistency` 按当前来源重新核对最新映射，主张变化将旧位置标为 changed；来源字节或 Evidence 失效拒绝检查。报告保留每个未映射数值位置，映射一个值不会隐藏同主张的其他数值。读取 hash 可识别报告变化，异步来源核对后再检查工件版本。审核回执头进入整个工件快照 hash，保存数值审核使旧阶段审批上下文失效；数值一致不授予科学批准。

`research.getConsistencyHistory` 分页读取 `stored_receipt`，独立核对保存原文/hash、材料计算、数据库字段和父版本锚点。当前来源失效后仍可阅读原始历史，历史不会冒充当前来源检查。

主张数值位置由主进程合同与下述同壳编辑器共同约束。图稿 caption 的文字核对不能证明实际绘制数据一致；实际绘制数据需另行核对[图稿数据映射](research-figures.md)。

## 同壳数值映射与历史

正文和图稿工件抽屉提供“检查科研数值”，展开后才加载模块并请求报告。每个未映射数值独立显示，已映射位置显示实际值、期望值、差异及允许差异；主张变化明确标记。报告版本与抽屉快照不一致时只显示刷新提示，历史仍可独立读取。等待或来源失败时隐藏上次成功报告。

用户明确选择完整数值位置、该主张的真实指标 Evidence、展示位置和单位，再填写转换、舍入及容差规则和理由。主张 hash 使用合同 schema 的完整 JSON；指标来自 `getExperimentResultEvidence` 的确切结果回执。选择项、转换数值和科学判断没有默认推定。添加或替换一个位置、移除映射均只修改本地草稿。

保存整份审核需要人工理由、当前工件版本及最新父回执。待加入映射必须先加入或清空。内容不变的连接中断重试复用完整请求 ID，不重复写入；父版本或来源冲突保留原草稿和错误，用户可明确放弃后刷新。脏草稿和保存过程锁定抽屉关闭、Escape、遮罩关闭、刷新及阶段审批；只读、批准和归档范围禁用保存。跨项目迟到的报告、指标和保存回执不能刷新新工件。

历史每页 10 版，完整 JSON 回执包含原主张、指标来源、单位规则和人工身份。历史明确标注当前来源未复核，不代替当前报告。650px 两主题下实际比例、偏移、舍入和容差控件可读；长 ID 换行，保存区保留焦点和原生纵向滚动。

## Vale 措辞检查

对已落库的正文跑一次**不依赖模型**的措辞与证据口径检查。结论进审稿与修订，不进正文本身。

### 为什么需要它

`resources/research-skills/review/SKILL.md` 要求「区分重大问题、次要问题和表达建议」，`writing/SKILL.md`
要求「没有证据的内容标记 hypothesis」。这两条在此之前**只有提示词在管**：模型自称做到了，没有
任何可复核的对象。文稿检查补的是这一层——它不判断学术质量，只把几类能机械识别的写法变成带
定位的条目。

它**不是**语法检查器，也**不替代**同行评审。三档严重度里只有 `error` 表示「证据口径被破坏」。
拼写是其中一类（`RocAcademic.Spelling`，`suggestion` 档）：它不参与导出闸门，只把「这段文本里
有个词不在词典与 Roc 词表里」变成可点击的条目。

### 检查的是什么文本

不是 `.tex` 文件，而是**投影**：每个小节投影成一个 Markdown 单元，单元内逐行记录「这一段属于
哪个 claim」（`src/main/plugins/research/prose-projection.ts`）。

这样做有两个直接原因：

- 论文正文的真身是 `sections[].claimIds` 指向的 claim 序列（`latex-source.ts` 从 claims 确定性
  重算 LaTeX）。拿 `.tex` 去查，行号对不上 claim，`\cite{}` 与 `\section{}` 还会被当成正文词。
- 审稿意见的落点必须是 `claimId`。「第 37 行」在文稿被重新生成后就没有意义了。

小节标题行、claim 之间的空行都不属于任何 claim，落在这些位置上的命中 `claimId` 为 `null`，
按小节级条目处理。**行号非正数或超出单元范围时一律不定位**，不做区间夹取——定位错了比没有定位更糟。

### 规则集

两套规则都是 Roc 自己写的，不是从上游 style 包抄来的，所以随本仓库的许可分发：

| 规则集 | 语言 | 条数 | 内容 |
| --- | --- | --- | --- |
| `RocAcademic` | 英文 | 9 | 模糊限定词、无出处的「有研究表明」、超出证据的论断、新颖性声称、领域共识、冗长表达、被动语态、名词化、**拼写** |
| `RocAcademicZh` | 中文 | 8 | 中文里的半角标点、模糊限定词、无出处的「有研究表明」、超出证据的论断、新颖性声称、领域共识、冗余动宾结构、口语化 |

拼写那条是 `RocAcademic/Spelling.yml`，`extends: spelling`——**不是**把 Vale 自带的 `Vale`
style 加进 `BasedOnStyles`。原因在严重度：上游 `Vale.Spelling` 把每一处拼错判成 `error`，
在 Roc 的语义里那等于「证据口径被破坏」，一次打字错误就会变成硬问题。包一层 Roc 规则后它落在
`suggestion` 档，并且与其它规则一样参与 `lockHashes`。词表是
`styles/config/vocabularies/Roc/accept.txt`（术语、工具名、中文项目里的英文专名）。
不用 Hunspell / Aspell：Vale 自带词典与词表机制，再打一个二进制进工具链是纯增重。

严重度三档按「证据口径被破坏的程度」划分，不按语气好听不好听：

| 档位 | 内容 | 理由 |
| --- | --- | --- |
| `error` | 无出处的有研究表明、声称已证实 | 直接对口 `export/SKILL.md` 的「未经支持的主张阻断导出」 |
| `warning` | 新颖性声称（首次 / 填补空白）、领域共识（普遍认为 / it is widely accepted）、模糊限定词 | 它们的问题通常是**检索不足**，不是否定证据；当成错误会让闸门把可讨论的表述判成错 |
| `suggestion` | 冗长表达、被动语态、名词化、口语化、拼写 | 可读性；拼写错本身不改变「有没有证据」 |

两套规则按语言分工，而且**同一条命中只能由一个规则负责**：两套 style 都作用于每一份文稿，
所以 `一般认为` 只在 `RocAcademicZh/Consensus.yml`，英文的 `it is widely accepted that` 只在
`RocAcademic/Consensus.yml`。重复命中会让报告里同一个位置出现两条不同严重度的条目。

规则文件在 `resources/research-runtime/vale/styles/`，配置是 `.vale.ini`。**改规则要重建工具链**：
规则集参与 `lockHashes`（`scripts/research/prepare.ts`），所以改一条规则既会要求重建，也会被
运行时的 `research_toolchain_source_mismatch` 抓到。

### 运行边界

Vale 3.24.0 作为 `bin/vale` 随工具链分发，调用点是 `toolchain.ts` 的 `lintProse()`：

- 走 `/usr/bin/sandbox-exec`，网络 `none`、禁止 POSIX spawn、只写 jobDir；
- `HOME` / `TMPDIR` / 缓存全部指向 jobDir 内的空目录，配置显式传 `--config` 且带 `--no-global`。
  **这是可复现性要求**：否则机器上装过的 style 包会改变结论，而这些结论要进溯源；
- 投影文件由主进程写进 `jobDir/prose/`，跑完连整个 jobDir 一起删除。

Vale 的两处行为值得记住，都已在代码里处理：读不到的文件**静默返回空对象**（所以文件由我们自己
写入并逐个核对），以及配置错误时返回 `{Code: 'E100', …}` 而不是报告（所以它被显式识别为失败，
不会被当成「没有命中」）。

### 合同

```text
capability  research.prose.lint
IPC         roc:research:prose-lint   →  preload: research.lintManuscript
工具        research_lint_manuscript（对话代理，只读）
```

输入 `{ projectId, artifactId }`，`artifactId` 必须是 `manuscript` 类产物。报告记录产出它的
`valeVersion` 与 `toolchainHash`——同一份文稿在不同 Vale 版本下结论不同时，报告本身要能说明这件事。

报告**不落库**，也不进阶段输出契约（`researchStageOutputSchema` 是 `.strict()` 的，往角色输出里
加字段会让那次运行直接失败）。需要留档时由调用方写入导出的 `provenance/`。

命中数有上限（2000），超出时 `truncated` 为真：报告是**被截断的**，不是「只有这些」。

### 可以检查草稿

检查走 `manuscripts.inspectBundle`：它与 `exportBundle` 同构，**只少一条批准要求**。写作/修订刚产出的
未批准正文也能查——发现问题的时机越早越便宜，而导出仍然只认已批准正文。仍要求正文已保存
（`research_manuscript_required`）且未过期（`research_manuscript_stale`）。

### 角色侧仍然要做的事

检查发生在产物落库之后，所以它回答不了「写的时候就别这么写」。中文学术写作的语域、数字与量词
格式、以及「不许把 hypothesis 写成 supported」，仍然只能由 `writing` / `revision` 的 Skill 在生成时约束。
两者回答的不是同一个问题，不要用其中一个替代另一个。
