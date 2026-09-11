# Production 4c1 Review

基点：`dfb92f7`。范围：全局文献库与项目关联、DOI/检索记录/BibTeX/BibLaTeX/CSL JSON 导入导出、来源快照、元数据索引、归档与引用键版本控制、v6 数据库迁移、九条 IPC 及私有 Python 接线。

## Standards

初审确认无 DOI 的 CSL 本地身份遗漏原始字段，导致不同版次/编辑者被误合并。现以完整书目字段、preamble 和原始 CSL 计算规范化摘要，对象键顺序不影响身份；回归确认不同版本保留为不同条目。

初审还确认 `journal` 与 `journaltitle` 在导出时互相覆盖。仓储现将其作为同一组合并，导出统一检查：不同非空值明确报冲突；空/空白别名作为缺失处理，三种格式均保留非空期刊名。

最终复核：0 项未解决问题（硬违反 0，启发式判断 0）。独立复核 Node 22 项、Python bibliography 17 项通过。

## Spec

初审确认标准编辑者/版次在跨格式转换中丢失。现双向处理 editor、translator、edition，并为章节/会议论文使用 booktitle；通过 CSL → BibTeX → CSL 往返验证。

初审确认同 DOI 的后续原始 CSL 扩展被整体丢弃。现保存 `{metadata, bibliography}` 完整来源快照，仅内容变化时追加；主记录补齐非冲突扩展，冲突原始数据保留在各自快照中。

最终复核：0 项未解决问题。独立验证标准字段往返、扩展冲突保留及重复来源去重通过。

## Verification

- 科研域与 IPC：19 文件，118 项通过；三项需要真实资源/网络的用例在常规命令中跳过。
- Python 全套：44 项通过，含书目转换 17 项及既有下载、归档、模型、MIME、PDF 与工具链回归。
- 新工具链 `darwin-arm64-library-v4`：38,565 个文件或链接；真实 IPC → 受限私有 Python 文件往返通过，覆盖中文/机构作者、DOI 去重、引用键冲突、日期、期刊字段和元数据检索。
- 公共 DOI `10.1038/nphys1170` 实际联网导入及 BibTeX 导出通过，核实标题 Measured measurement、作者 Markus Aspelmeyer、年份 2009 和两个 ISSN。
- 文件往返证据：`.artifacts/research-library-integration/roc library integration-QWaCYk/result.json`。
- 公共 DOI 证据：`.artifacts/research-library-integration/roc library integration-kq3jRW/live-doi-result.json`。
- `build`（含 typecheck）、`check:ipc`、资源清单与差异检查通过。

复现命令（验证后的 v4 已激活到开发默认目录，真实资源用例必须显式提供工具链目录）：

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64/python/bin/python3 -B -m unittest discover -s /Users/Apple_501/Desktop/Roc/Roc/scripts/research/tests -q
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/library-ipc.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_LIVE_DOI=1 pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/library-ipc.test.ts -t 'imports a public DOI'
```

运行时边界：Crossref 内容协商返回 `journal-article` 和 ISSN/ISBN 数组，由 DOI API 边界显式映射为 CSL；普通 CSL 文件继续使用其契约。私有 Python 调用使用 `-B`，子进程继承禁写字节码环境，避免验证脚本改变完整性清单。

限制：当前验证为 arm64 macOS。全文附件/阅读资源、项目目录增量索引、Renderer、Intel 实机与最终打包继续后续增量。

状态：Verified passing。
