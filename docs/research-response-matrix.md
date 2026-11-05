# Review Response Matrix

审稿矩阵属于当前项目的论文工件。原始审稿意见、人工回复与处理状态按完整矩阵追加版本；保存不会修改正文、证据、科学支持审核或人工闸门。

## 合同

`research.responseMatrix.save` 需要主进程根据实际 IPC sender 绑定的人工身份。renderer、模型和请求参数不能自授身份。输入必须给出项目、论文工件、幂等 requestId、当前工件快照版本、精确上一版 ID/hash、修订理由和完整意见集合。

每项包含稳定 commentId、审稿人和原始意见。既有意见不能被删除或改写；新的处理结果保留原意见并追加版本。状态由人工明确选择：

| 状态 | 要求 |
| --- | --- |
| `open` | 保持未处理；可保存调查中的回复、位置和证据 |
| `addressed` | 非空回复，至少一个修改稿中的精确位置 |
| `declined` | 非空回复，记录人工未采纳理由 |

位置绑定当前保存的主张 ID/hash、UTF-16 字符范围和完整原文；小节、主张版本、修改稿 LaTeX/contentHash/claimsHash 与所选项目 Evidence 一起冻结。位置只能来自该修改稿。所选 Evidence 必须处于 `recorded` 状态；关联本身不构成语义支持确认。文字或结构修改可以只绑定修改稿位置，科学证据需要人工明确选择。

同一请求和 sender 的精确重试返回原回执且零写入。请求内容、sender、parent 或工件版本冲突明确拒绝。已批准/非当前阶段工件及归档项目不能追加新版本。

## 当前核验与历史

`research.responseMatrix.inspect` 读取当前保存修改稿和最新矩阵，返回报告 hash、当前工件版本、原人工处理状态及 `reviewCurrent`。修改稿或所选 Evidence 的内容变化使原绑定失效；原状态保留供重新核对，不能被当成新修改稿已经处理完毕。过期正文必须先重新保存，不读取成功式缓存回退。

`research.responseMatrix.history` 按 limit/offset 读取最多 100 条，标记 `stored_receipt`。它验证保存字节、索引、父版本和内在位置/稿件/hash 合同，不要求恢复当前来源。历史不能证明当前来源或意见已经重新核查。没有审核时当前 review 为 null、各状态 ID 集合为空，不能推断没有外部审稿意见。

Research DB50 仅新增 `research_response_matrices`；旧迁移账本、用户工件与来源原样保留，不创建或推断审稿意见。没有旧 API、旧 schema 或默认字段兼容层。

## 实施边界

A5A 交付主进程合同、存储、读取、人工 IPC 和生成 preload。现有论文/LaTeX/语义支持闸门保持原有合同。后续独立部分接入现有工件抽屉中的惰性编辑，以及审批与导出消费者；当前存储 API 不宣称这些后续部分已经完成。

## 验证

以下命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行，最终 A5A 源码检查均 exit 0：

- `node --test tests/unit/research-response-matrix.test.mjs tests/unit/research-consistency.test.mjs tests/unit/research-citation-reviews.test.mjs tests/unit/research-semantic-publication.test.mjs`：35/35，包括 9 个矩阵合同、真实 sender、重试、事务失败、来源失效、磁盘重开、DB49→50 与 UTF-16 精确空白选区检查。
- `pnpm build`：TypeScript 与 main/preload/renderer 构建通过。
- `node scripts/smoke-electron.mjs`：13/13，无 renderer error。
- `pnpm check:ipc`：生成文件一致；`pnpm check:renderer-chunks`：eager JS 1,134,228 bytes / 6 files。

前一验证快照的 `node scripts/run-research-p0.mjs` 13/13，以及 `node --test tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/citation-coverage.test.mjs tests/renderer/scientific-consistency.test.mjs` 51/51。该快照后只修改精确选区合同、明确来源错误及相应 unit 检查，最终重新构建并启动验证。

日志保留于 `.artifacts/research-optimization/xwrite-a5a-final-*.log`，前一快照保留于 `xwrite-a5a-{p0,renderer,startup,ipc,chunks}.log`。C2C 消费者修正后的补充完整 unit 为 1249/1249；它不代表最终 A5A 的完整 suite 已运行。当前尚未验证矩阵编辑 UI、审批/导出消费者或独立科学验收。
