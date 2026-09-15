# Integration 4g1：批准生产输入读取

状态：Verified passing。基点：`c64e3fa0a6778cae1ae6ab01ebe065ecea8c2631`。

## 范围

- 新增批准实验、图稿、导出输入的元数据/文件读取服务及两个 IPC；实际执行/发布记录决定文件范围，登记哈希决定返回内容。
- experiment/figure/writing/review/revision/export 角色增加两个按运行输入绑定的只读工具；分页限制 8000 字符，二进制返回元数据，调用前后验证运行有效性。
- 单次可读取文件仍受现有 4 MiB 预览上限约束；分页是模型返回文本分页，不表示任意大文件流式读取。NUL 二进制与 PDF 即使可解码为 UTF-8，也只向模型返回元数据。
- v13 为实验执行和工件的真实关联建立唯一索引；保留旧记录，不改 v1–v12。
- 4g2 生产副作用、4g3 真实阶段输出、Idea Canvas/项目语言、Renderer 和 Packaging 仍待实现。

## 验证

- 最终科研域、IPC、PDF 预览协议、数据库 schema/迁移回归：36 文件、262 项通过，34 项可选资源用例在常规命令中跳过。
- 真实图稿读取、真实中文 PDF/ZIP 导出及读取各 1 项通过；未选择的 7 项既有资源用例跳过，未冒充本轮执行结果。
- 真实 LangChain SDK 工具循环从已批准实验读取 CSV，再生成受证据支持的 LaTeX 正文，保留模型 provenance 和人工审批状态。
- v12→v13 保留已发布/未发布执行和工件；唯一索引拒绝一个工件关联多个实验。
- NUL 二进制/纯 ASCII PDF 回归先失败，修复后通过；运行归档、取消后迟到返回、关闭等待读取、文件篡改与跨项目拒绝均通过。
- `build`（含 typecheck）、`check:ipc`、暂存差异检查通过。
- 真实产物证据：`.artifacts/research-production-input-integration/roc figure integration-jMUlBq/figure-review-result.json` 与 `roc export integration-qbPLU3/delivery-result.json`。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-schemas.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-migrations.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-production-input-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/figure-ipc.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/export-ipc.test.ts -t 'publishes, previews|builds and approves'
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --cached --check
```

## Standards

按用户规则 §2–3，已核对批准状态复查、运行绑定、哈希校验和关闭等待。模型工具阻止 PDF、含 NUL 数据及 base64 内容进入文本；v13 仅追加唯一关联索引，保留旧迁移。

最终硬违反 0、判断项 0、未解决 0。Standards 独立执行生产输入/迁移 12 项回归通过，包含 SDK 循环与二进制边界；大型资源链路采用主代理验证证据。

## Spec

已确认运行输入绑定、批准/项目边界、文件哈希及取消/关闭后的返回拒绝。NUL 数据和纯 ASCII PDF 仅返回元数据；历史导出读取与当前发布/交付校验保持分离。4 MiB 文件上限及 8000 字符分页已明确记录。

未发现遗漏或范围扩张，最终未解决 0。Spec 独立执行生产输入 9 项回归通过，包含真实 LangChain SDK 循环及二进制回归；大型资源链路采用主代理证据。
