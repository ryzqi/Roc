# 科研写作检查

## X-WRITE A1：当前正文引用覆盖

`research.inspectCitationCoverage({projectId, artifactId, expectedHash})` 通过现有正文仓库读取当前已保存的正文，不要求正文已批准。`expectedHash` 必填，首次读取显式传 `null`；重读传上次报告的 hash。返回 `current` 或 `stale`、完整报告、报告 hash 和读取时间。

报告按小节及段落索引关联完整主张、实际 LaTeX 引用键、Evidence 原文与版本、固定 PDF 解析位置和当前书目版本。导入 PDF 的文件来源通过捕获的文档定位关联书目；不通过文件名猜测引用。原稿的引用键仍是 Evidence ID，最终导出的书目键由既有导出主链处理。

人工已确认且主张、来源版本一致的 `supports` / `qualifies` 才计入已审核引用。报告保留条件、审核人及完整关系，明确呈现反对关系；未确认支持、被拒绝的支持和依赖关系不会变成科学支持。`locator` / `page` / `region` 仅表示定位精度，不证明科学直接性或主张真实性。

报告 hash 包含完整正文、工件快照版本、来源、关系和书目 revision，读取时间不参与 hash。来源或正文失效明确拒绝检查；可以检查仍有效的已批准工件和归档项目，但不会批准、运行模型或写数据库。旧报告对象保持原字节，重读得到新报告。

科学直接性的显式人工声明、跨正文/表格/图稿指标映射、审稿回复矩阵和期刊规则尚未实现。

## X-WRITE A2：同壳引用检查器

正文工件检查器提供“检查正文引用”。用户展开后才加载模块并读取报告；沿用现有抽屉、来源阅读器和异步请求状态。全部、有问题、未确认支持筛选保留完整段落及原文，原生折叠面板可通过键盘操作。

重新检查保留报告 hash 基线，因此单独修改书目 revision 也会显示 `stale`。用户可明确按当前报告版本重新核对；工件快照变化则要求先刷新工件。等待和失败时隐藏旧成功报告，项目及工件版本隔离迟到回复。这些操作零数据库写入，不产生科学审批。

650px 两主题下长段落、原文及 hash 在抽屉内换行；筛选标签不收缩，保持单行及可用选框宽度。

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
