# 科研写作检查

## X-WRITE A1：当前正文引用覆盖

`research.inspectCitationCoverage({projectId, artifactId, expectedHash})` 通过现有正文仓库读取当前已保存的正文，不要求正文已批准。`expectedHash` 必填，首次读取显式传 `null`；重读传上次报告的 hash。返回 `current` 或 `stale`、完整报告、报告 hash 和读取时间。

报告按小节及段落索引关联完整主张、实际 LaTeX 引用键、Evidence 原文与版本、固定 PDF 解析位置和当前书目版本。导入 PDF 的文件来源通过捕获的文档定位关联书目；不通过文件名猜测引用。原稿的引用键仍是 Evidence ID，最终导出的书目键由既有导出主链处理。

人工已确认且主张、来源版本一致的 `supports` / `qualifies` 才计入已审核引用。报告保留条件、审核人及完整关系，明确呈现反对关系；未确认支持、被拒绝的支持和依赖关系不会变成科学支持。`locator` / `page` / `region` 仅表示定位精度，不证明科学直接性或主张真实性。

报告 hash 包含完整正文、工件快照版本、来源、关系和书目 revision，读取时间不参与 hash。来源或正文失效明确拒绝检查；可以检查仍有效的已批准工件和归档项目，但不会批准、运行模型或写数据库。旧报告对象保持原字节，重读得到新报告。

这是引用检查的只读合同和主进程入口。检查器 UI、科学直接性的显式人工声明、跨正文/表格/图稿指标映射、审稿回复矩阵和期刊规则尚未由 A1 实现。

## 验证记录

工作目录：`/Users/Apple_501/Desktop/Roc/Roc`。日志目录：`.artifacts/research-optimization/`。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node --test tests/unit/research-citation-coverage.test.mjs` | 6/6 通过，含真实 SQLite 仓库、导入 PDF 坐标、人工关系和 IPC | `xwrite-a1-focused.log` |
| `pnpm build` | 通过，包含最终源码的 typecheck | `xwrite-a1-build.log` |
| `pnpm check:ipc` | 通过，生成合同当前 | `xwrite-a1-ipc.log` |
| `pnpm check:renderer-chunks` | 通过 | `xwrite-a1-chunks.log` |
| `node scripts/smoke-electron.mjs` | 13/13 通过，零 renderer error | `xwrite-a1-startup.log` |

最初 typecheck 失败是 `supportReview` 被推断为 `string`，已用合同 enum 类型明确标注。修复后类型检查及最终构建通过，未放宽 schema。实际 PDF 测试揭示并覆盖了文件来源书目遗漏。

这些检查证明本地工程行为；不证明独立科研样本的引用准确率，也不代替人工语义审核。
