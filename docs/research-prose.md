# 文稿检查（prose lint）

对已落库的正文跑一次**不依赖模型**的措辞与证据口径检查。结论进审稿与修订，不进正文本身。

## 为什么需要它

`resources/research-skills/review/SKILL.md` 要求「区分重大问题、次要问题和表达建议」，`writing/SKILL.md`
要求「没有证据的内容标记 hypothesis」。这两条在此之前**只有提示词在管**：模型自称做到了，没有
任何可复核的对象。文稿检查补的是这一层——它不判断学术质量，只把几类能机械识别的写法变成带
定位的条目。

它**不是**语法检查器，也**不替代**同行评审。三档严重度里只有 `error` 表示「证据口径被破坏」。
拼写是其中一类（`RocAcademic.Spelling`，`suggestion` 档）：它不参与导出闸门，只把「这段文本里
有个词不在词典与 Roc 词表里」变成可点击的条目。

## 检查的是什么文本

不是 `.tex` 文件，而是**投影**：每个小节投影成一个 Markdown 单元，单元内逐行记录「这一段属于
哪个 claim」（`src/main/plugins/research/prose-projection.ts`）。

这样做有两个直接原因：

- 论文正文的真身是 `sections[].claimIds` 指向的 claim 序列（`latex-source.ts` 从 claims 确定性
  重算 LaTeX）。拿 `.tex` 去查，行号对不上 claim，`\cite{}` 与 `\section{}` 还会被当成正文词。
- 审稿意见的落点必须是 `claimId`。「第 37 行」在文稿被重新生成后就没有意义了。

小节标题行、claim 之间的空行都不属于任何 claim，落在这些位置上的命中 `claimId` 为 `null`，
按小节级条目处理。**行号非正数或超出单元范围时一律不定位**，不做区间夹取——定位错了比没有定位更糟。

## 规则集

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

## 运行边界

Vale 3.24.0 作为 `bin/vale` 随工具链分发，调用点是 `toolchain.ts` 的 `lintProse()`：

- 走 `/usr/bin/sandbox-exec`，网络 `none`、禁止 POSIX spawn、只写 jobDir；
- `HOME` / `TMPDIR` / 缓存全部指向 jobDir 内的空目录，配置显式传 `--config` 且带 `--no-global`。
  **这是可复现性要求**：否则机器上装过的 style 包会改变结论，而这些结论要进溯源；
- 投影文件由主进程写进 `jobDir/prose/`，跑完连整个 jobDir 一起删除。

Vale 的两处行为值得记住，都已在代码里处理：读不到的文件**静默返回空对象**（所以文件由我们自己
写入并逐个核对），以及配置错误时返回 `{Code: 'E100', …}` 而不是报告（所以它被显式识别为失败，
不会被当成「没有命中」）。

## 合同

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

## 可以检查草稿

检查走 `manuscripts.inspectBundle`：它与 `exportBundle` 同构，**只少一条批准要求**。写作/修订刚产出的
未批准正文也能查——发现问题的时机越早越便宜，而导出仍然只认已批准正文。仍要求正文已保存
（`research_manuscript_required`）且未过期（`research_manuscript_stale`）。

## 角色侧仍然要做的事

检查发生在产物落库之后，所以它回答不了「写的时候就别这么写」。中文学术写作的语域、数字与量词
格式、以及「不许把 hypothesis 写成 supported」，仍然只能由 `writing` / `revision` 的 Skill 在生成时约束。
两者回答的不是同一个问题，不要用其中一个替代另一个。

## 验证

```bash
node --test tests/unit/research-prose-projection.test.mjs   # 投影与定位规则
node scripts/research/smoke.ts \
  --toolchain .runtime/research-toolchain/darwin-arm64 \
  --models .runtime/research-models \
  --output .artifacts/research-toolchain-smoke
```
