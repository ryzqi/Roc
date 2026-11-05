# 科研写作检查

## X-WRITE A1：当前正文引用覆盖

`research.inspectCitationCoverage({projectId, artifactId, expectedHash})` 通过现有正文仓库读取当前已保存的正文，不要求正文已批准。`expectedHash` 必填，首次读取显式传 `null`；重读传上次报告的 hash。返回 `current` 或 `stale`、完整报告、报告 hash 和读取时间。

报告按小节及段落索引关联完整主张、实际 LaTeX 引用键、Evidence 原文与版本、固定 PDF 解析位置和当前书目版本。导入 PDF 的文件来源通过捕获的文档定位关联书目；不通过文件名猜测引用。原稿的引用键仍是 Evidence ID，最终导出的书目键由既有导出主链处理。

人工已确认且主张、来源版本一致的 `supports` / `qualifies` 才计入已审核引用。报告保留条件、审核人及完整关系，明确呈现反对关系；未确认支持、被拒绝的支持和依赖关系不会变成科学支持。`locator` / `page` / `region` 仅表示定位精度，不证明科学直接性或主张真实性。

报告 hash 包含完整正文、工件快照版本、来源、关系和书目 revision，读取时间不参与 hash。来源或正文失效明确拒绝检查；可以检查仍有效的已批准工件和归档项目，但不会批准、运行模型或写数据库。旧报告对象保持原字节，重读得到新报告。

跨正文/表格/图稿指标映射、审稿回复矩阵和期刊规则尚未实现。

## X-WRITE A2：同壳引用检查器

正文工件检查器提供“检查正文引用”。用户展开后才加载模块并读取报告；沿用现有抽屉、来源阅读器和异步请求状态。全部、有问题、未确认支持筛选保留完整段落及原文，原生折叠面板可通过键盘操作。

重新检查保留报告 hash 基线，因此单独修改书目 revision 也会显示 `stale`。用户可明确按当前报告版本重新核对；工件快照变化则要求先刷新工件。等待和失败时隐藏旧成功报告，项目及工件版本隔离迟到回复。这些操作零数据库写入，不产生科学审批。

650px 两主题下长段落、原文及 hash 在抽屉内换行；筛选标签不收缩，保持单行及可用选框宽度。

## X-WRITE A3A：人工引用直接性

`research.saveCitationReview` 要求明确填写 `direct`、`indirect` 或 `unsupported` 及理由，绑定当前报告 hash、正文主张和 Evidence。`parent` 首次显式传 `null`，后续必须传最新审核 ID 和 hash。人工身份仅来自主进程验证的窗口，不允许通过输入提供。

DB47 为每个主张与证据对追加不可变版本，保存完整请求、人工身份、时间、正文 hash、工件版本、主张与来源原文及 digest。相同请求和人工身份重放时核对当前主张/来源后返回原回执，不重复写入。已批准、失效、非当前工件或归档项目不能新增审核；旧报告、错父版本和重复请求内容冲突明确拒绝。

覆盖报告使用 schema 2，所有引用都包含显式 nullable `directnessReview`，同时记录直接、间接、不支持和未审核计数。主张或来源变化后，旧判断标为过期；直接性判断不授予语义支持或正文批准。最新审核回执头进入整工件快照和版本 hash，另一个窗口修改直接性会使旧阶段审批上下文失效。

`research.getCitationReviewHistory` 分页返回完整历史回执，明确 `verification: stored_receipt`。来源失效后仍可阅读已保存的历史原文；这不声明来源当前有效。历史读取核对原字节、hash、数据库索引字段、主张/来源 digest 和父版本锚点，损坏时拒绝。

A3B 的人工编辑及历史界面在下一部分实现。没有旧 schema 解析或兼容别名。

## 验证记录

工作目录：`/Users/Apple_501/Desktop/Roc/Roc`。日志目录：`.artifacts/research-optimization/`。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node --test tests/unit/research-citation-coverage.test.mjs` | 6/6 通过，含真实 SQLite 仓库、导入 PDF 坐标、人工关系和 IPC | `xwrite-a1-focused.log` |
| `pnpm build` | 通过，包含最终源码的 typecheck | `xwrite-a1-build.log` |
| `pnpm check:ipc` | 通过，生成合同当前 | `xwrite-a1-ipc.log` |
| `pnpm check:renderer-chunks` | 通过 | `xwrite-a1-chunks.log` |
| `node scripts/smoke-electron.mjs` | 13/13 通过，零 renderer error | `xwrite-a1-startup.log` |
| `pnpm test:unit` | 1220/1220 通过；A1 提交后收集的补充完整验证，后续 A2 仅修改 renderer | `xwrite-a1-unit.log` |
| `node scripts/run-research-p0.mjs` | 13/13 通过 | `xwrite-a1-p0.log` |
| `pnpm harness:eval` | 94/94 通过 | `xwrite-a1-harness.log` |

最初 typecheck 失败是 `supportReview` 被推断为 `string`，已用合同 enum 类型明确标注。修复后类型检查及最终构建通过，未放宽 schema。实际 PDF 测试揭示并覆盖了文件来源书目遗漏。

这些检查证明本地工程行为；不证明独立科研样本的引用准确率，也不代替人工语义审核。

### A2 最终检查

以下命令在同一工作目录依次运行，最终退出码为 0。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm build` | 通过，包含 typecheck | `xwrite-a2-layout-build.log` |
| `node --test tests/renderer/citation-coverage.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` | 40/40 通过，含 6 项新引用检查 | `xwrite-a2-layout-renderer.log` |
| `node scripts/smoke-electron.mjs` | 13/13 通过，零 renderer error | `xwrite-a2-layout-startup.log` |
| `pnpm check:ipc` | 生成合同当前 | `xwrite-a2-layout-ipc.log` |
| `pnpm check:renderer-chunks` | 1,134,084 bytes，6 个 eager 文件 | `xwrite-a2-layout-chunks.log` |

最初夹具在原生 disclosure 内容可见前读取文本，以及错误调用匿名审计函数，已修正并保留实际键盘/原文断言。审计 `cut=0`；3 个 `hidden` 是既有抽屉在物理窗口 top/right/bottom 边缘完全隐藏的阴影，精确断言元素、方向、类型、gap=0 和原因。截图及审计在 `citation-coverage-ui/`，最终两主题截图已实际查看；标签孤字换行已修复并增加布局回归。

验证使用真实 Electron renderer、SQLite 仓库及 IPC 适配器，场景包含合成来源，不构成独立科学准确率验证。A2 没有修改主进程或共享合同；A1 完整 unit、P0 和 Harness 的补充结果见上表。

### A3A 检查

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node --test tests/unit/research-citation-reviews.test.mjs tests/unit/research-citation-coverage.test.mjs tests/unit/research-artifact-inspector.test.mjs tests/unit/research-idea-inspection.test.mjs tests/unit/research-export-body-gate.test.mjs tests/unit/research-semantic-publication.test.mjs tests/unit/research-gate-review.test.mjs` | 最终快照合同上 39/39 通过，含新增审核 7 项 | `xwrite-a3a-head-final-focused.log` |
| `pnpm build` | 最终源码通过，含 typecheck | `xwrite-a3a-head-build.log` |
| `node --test tests/renderer/citation-coverage.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` | 40/40 通过 | `xwrite-a3a-head-renderer.log` |
| `node scripts/run-research-p0.mjs` | 13/13 通过，含实际实验重启 | `xwrite-a3a-head-p0.log` |
| `node scripts/smoke-electron.mjs` | 13/13 通过，零 renderer error | `xwrite-a3a-head-startup.log` |
| `pnpm check:ipc` | 生成合同当前 | `xwrite-a3a-head-ipc.log` |
| `pnpm check:renderer-chunks` | 1,134,084 bytes，6 eager 文件 | `xwrite-a3a-head-chunks.log` |
| `pnpm test:unit` | 快照回执头修改前 1226/1226 通过；最终合同另由上表 39 项和实际消费者验证 | `xwrite-a3a-unit.log` |
| `pnpm harness:eval` | 快照回执头修改前 94/94 通过 | `xwrite-a3a-harness.log` |

首次审核测试错误读取 Evidence 包装层的 sourceVersion、使用错误数据库名；已按现有合同修正。产品历史读取原来要求当前有效来源，现改为校验存储来源身份，允许明确标注的历史回执。新闸门夹具最初处于 running 状态，已使用真实工作流转换进入 waiting_approval。原 P0 12/13 的实际实验启动超时保留在 `xwrite-a3a-p0.log`；最终串行 P0 13/13，通过时未改变等待条件或超时阈值。

A3A 范围状态：`Verified passing`。最终完整 unit/Harness 补充检查已启动，收集后登记；这里不将未完成的补充检查报为通过。历史校验、来源版本、跨项目和窗口身份拒绝均有回归；验证不构成科学直接性准确率证明。
