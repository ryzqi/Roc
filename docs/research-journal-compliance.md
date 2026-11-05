# Journal Compliance

投稿检查属于当前项目的论文工件。人工选择期刊、文章类型、投稿阶段、规则版本和日期；每条规则保存来源 URL、原文及“硬性要求 / 指导性建议”。日期来源明确区分官方日期与人工整理日期，抓取时间单独保存。没有默认期刊规则，也不把网页抓取日期当作官方生效日期。

## 检查合同

| 规则 | 检查范围 | 限制 |
| --- | --- | --- |
| `sections` | 保存小节标题精确匹配 | 不推断内容或语义等价 |
| `reference_count` | 正文来源按文献 ID / Evidence ID 去重后的数量 | 不认证引用样式 |
| `reference_fields` | 文献元数据 title/authors/doi/year/url | 无文献元数据的普通来源标为需人工核对 |
| `figure_files` | 所选已发布图稿真实文件、字节大小、点尺寸及栅格有效 DPI | DPI 仅适用于 PNG；未选图稿需人工核对适用性 |
| `supplements` | 明确所选项目相对路径及真实文件哈希 | 文件存在不证明内容符合要求 |
| `manual` | 结构、引用、图稿或补充材料的人工判断 | 人工决定独立保存，自动结果保持 `manual` |

自动结果为 `pass`、`fail` 或 `manual`；指导性规则也保留实际失败，不能被静默放宽。需要人工判断的规则可保存 pass/fail/not_applicable 与非空理由，但不能覆盖确定性检查，也不批准论文。

预览可以检查明确输入的完整规则与所选来源；未选择规则时 selection/material 为 null，结果为空，不制造通过标记。每次保存需要预览的 `expectedMaterialHash`、当前工件版本、精确上一版 ID/hash、稳定 requestId 和修订理由。资料在预览后变化时拒绝旧保存。

主进程读取保存稿件、确切 claim/Evidence 和当前引用元数据。图稿复用真实文件验证，保存清单哈希及尺寸；只保存所选图稿，不推断论文有无其他图稿。补充材料只接受项目内普通文件，拒绝链接、越界、读取中变化和单文件超过 64 MiB；保存 path/size/SHA-256，不保存机器绝对路径。

`research.journalCompliance.save` 的人工身份由实际 IPC sender 绑定，renderer 和模型不能声明身份。归档、已批准、非当前阶段及非有效工件集合拒绝新增检查。requestId 精确重试读取同一回执，不重复写入；请求或人工身份变化拒绝重试。

Research DB51 新增 `research_journal_compliance`，完整规则、来源、自动结果及人工判断追加版本。历史标记为 `stored_receipt`，验证保存字节、派生结果和上一版链；与当前来源检查分开，来源变化不会覆盖历史。没有旧 API、旧 schema 或推断默认字段。

## 实施范围

A6A 提供主进程 schema、确定性检查、真实来源服务、不可变时间线和人工 IPC；A6B 接入现有工件抽屉的惰性界面；A6C 接入审批、任务验收与导出。投稿检查和论文接受决定分别表达。

工件检查快照必须包含可空的 `journalCompliance` 最新回执头。规则日期、版本或人工判断修订会改变整个工件版本，旧版本审批失效。人工闸门和阶段任务验收复用科学来源服务：即使仅有投稿检查，也重新核对真实图稿、补充文件和正文中的实验结果 Evidence；所有异步读取完成后再同步核对整个工件集合。任务证明的工件引用使用相同检查快照哈希，并在生产验证结束后再次核对。

导出科学封存采用严格 schema 5，必填 `journalCompliance` 数组保存最新回执和全部分页 `stored_receipt` 历史。所检查图稿必须全部在实际导出选择内，并与导出源的 manifest/hash/validation 一致，否则准备和封存均拒绝。现有构建器复制这些图稿的真实文件；补充材料的 `supplementDelivery` 固定为 `metadata_only`，只封存相对路径、大小和哈希，不打包其文件，也不表示投稿材料已齐备。补充文件字节变化会使当前来源验证失败。旧科学 schema 直接拒绝。

## 验证

所有命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行，日志在 `.artifacts/research-optimization/xwrite-a6a-*.log`。

- `pnpm generate:ipc` 与 `pnpm typecheck`：exit 0。
- `node --test tests/unit/research-journal-compliance.test.mjs tests/unit/research-response-matrix.test.mjs tests/unit/research-citation-coverage.test.mjs`：29/29，包括 8 项投稿检查回归。覆盖严格日期/规则/人工合同、自动与人工结果分离、真实补充文件和链接拒绝、真实文献字段及版本、真实图稿尺寸/字节/来源变动、异步期间工件变化、102 条分页历史、重试及重哈希损坏、DB50→51。
- `pnpm build`：TypeScript 与应用构建 exit 0。
- `node scripts/run-research-p0.mjs`：13/13。
- `node --test tests/renderer/response-matrix.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs`：42/42。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer error。
- `pnpm check:ipc`：生成合同一致；`pnpm check:renderer-chunks`：eager JS 1,134,272 bytes / 6 files。
- 补充 `node --test tests/unit/`：1273/1273，在最终 A6A 源码后启动，提交后收集 exit 0。

A6A 状态：`Verified passing`，范围为本地主进程与相关消费者回归；A6B/A6C 尚未接入。

测试使用合成规则与真实本地文件/图稿执行，不声明真实期刊接受或规则解释的科学准确性。初次 fixture 调用了不存在的 archiveProject/saveArtifact，随后图稿损坏 fixture 使用错误目录；均按现有真实合同修正，未放宽产品检查。

## A6B 工件抽屉

既有论文工件抽屉提供惰性“检查期刊投稿”入口。原生表单明确填写期刊、文章类型、投稿阶段、规则版本、规则日期及日期来源、带时区的资料获取时间；逐条录入六种检查条件、来源原文与要求性质。无期刊、要求性质或人工决定默认值。

先“检查规则与材料”取得真实材料 hash，再保存检查；规则、所选图稿或补充路径变化撤销预览。人工修订理由变化更换请求身份；同一丢失回执重试保留精确请求。异步核对、保存和未保存修改锁定整个抽屉，不能切换生产/审核、刷新或关闭。晚到的预览、保存和历史回复不能进入另一项目。

自动失败与指导性建议、人工判断分别展示，保存不批准论文。历史以 stored receipt 独立分页，当前材料失败时仍可查看完整日期、来源、规则及原始判断。用户可明确从最新历史规则进入编辑；保留来源错误、清空预览，重新核对材料后才能保存。只读、已批准、归档、非当前阶段禁止写入。图稿使用真实 listFigures 合同，最多展示最近 200 项；失效或未列出的已有选择可明确移除。

A6B `Verified passing`，命令均在仓库根目录执行：

- `pnpm typecheck`、最终 `pnpm build`：exit 0。
- `node --test tests/renderer/journal-compliance.test.mjs tests/renderer/response-matrix.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs`：49/49，含投稿 7 项真实 Electron 回归。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer error。
- `pnpm check:ipc`：合同一致；`pnpm check:renderer-chunks`：见 xwrite-a6b-chunks.log。
- macOS 本机 Electron，650px light/dark 长规则、字段/按钮焦点及 hover、减弱动效：四个完整裁切审计 cut=0；hidden 精确为抽屉在视口 top/right/bottom 的三个物理边缘，无横向溢出。截图位于 `.artifacts/research-optimization/journal-compliance-ui/`，已人工查看明暗主题。未验证 Windows。

首轮 fixture 使用猜测的 journal-compliance IPC 名称，已按 registry journal-* 合同修正；第二轮两项展开断言未等待原生可见状态，补充实际可见等待后通过。未放宽产品检查。最终日志 `.artifacts/research-optimization/xwrite-a6b-{build,renderer,startup,ipc,chunks}.log`。

## A6C 消费者验证

所有命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行，日志在 `.artifacts/research-optimization/xwrite-a6c-*.log`。

- `pnpm build`：类型与生产构建通过。
- `node --test tests/unit/research-journal-compliance.test.mjs tests/unit/research-response-matrix.test.mjs tests/unit/research-consistency.test.mjs tests/unit/research-figure-consistency.test.mjs tests/unit/research-citation-reviews.test.mjs tests/unit/research-semantic-publication.test.mjs tests/unit/research-export-body-gate.test.mjs`：70/70。包含 journal-only 闸门、检查快照/任务证明版本、异步期间规则/项目/来源/真实补充字节变化、多工件最终同步检查、102 条完整历史和拒绝空中间页、严格 schema 5 与 seal 修订。
- `node --test --test-name-pattern='scientific consistency binds actual|actual result metric evidence traces' tests/integration/research-python-experiments.test.mjs`：真实 CPython 两项通过。验证仅投稿检查时的实际实验 Evidence、缺失执行来源拒绝、真实图稿/补充字节、实际写作人工批准、遗漏所检查图稿的导出拒绝、补充材料变动拒绝和 SQLite 重启保留回执。
- `node scripts/run-research-p0.mjs`：13/13，含真实编译与交付。
- `node --test tests/renderer/journal-compliance.test.mjs tests/renderer/response-matrix.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs`：49/49。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer error。
- `pnpm harness:eval`：94/94。
- `pnpm test:unit`：完整单元测试 1277/1277，352,934 ms，退出码 0。
- `pnpm check:ipc`：一致；`pnpm check:renderer-chunks`：1,134,432 bytes / 6 eager JS files。

这是本机工程验证，未进行真实期刊规则的独立科学验收、Windows 验证或公开投稿/发布。
