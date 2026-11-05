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

A6A 提供主进程 schema、确定性检查、真实来源服务、不可变时间线和人工 IPC。现有工件抽屉的惰性界面由 A6B 接入；审批与导出消费者由 A6C 接入。投稿检查和论文接受决定分别表达。

## 验证

所有命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行，日志在 `.artifacts/research-optimization/xwrite-a6a-*.log`。

- `pnpm generate:ipc` 与 `pnpm typecheck`：exit 0。
- `node --test tests/unit/research-journal-compliance.test.mjs tests/unit/research-response-matrix.test.mjs tests/unit/research-citation-coverage.test.mjs`：29/29，包括 8 项投稿检查回归。覆盖严格日期/规则/人工合同、自动与人工结果分离、真实补充文件和链接拒绝、真实文献字段及版本、真实图稿尺寸/字节/来源变动、异步期间工件变化、102 条分页历史、重试及重哈希损坏、DB50→51。
- `pnpm build`：TypeScript 与应用构建 exit 0。
- `node scripts/run-research-p0.mjs`：13/13。
- `node --test tests/renderer/response-matrix.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs`：42/42。
- `node scripts/smoke-electron.mjs`：13/13，零 renderer error。
- `pnpm check:ipc`：生成合同一致；`pnpm check:renderer-chunks`：eager JS 1,134,272 bytes / 6 files。
- 补充 `node --test tests/unit/` 在最终源码后启动，提交时仍在运行，不作为本次通过依据。

A6A 状态：`Verified passing`，范围为本地主进程与相关消费者回归；A6B/A6C 尚未接入。

测试使用合成规则与真实本地文件/图稿执行，不声明真实期刊接受或规则解释的科学准确性。初次 fixture 调用了不存在的 archiveProject/saveArtifact，随后图稿损坏 fixture 使用错误目录；均按现有真实合同修正，未放宽产品检查。
