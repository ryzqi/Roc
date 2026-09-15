# Production 4f Review

基点：`58821cac5874f2cf64ff313233af5d443d4cfdd1`。差异：`rtk git diff --cached 58821cac5874f2cf64ff313233af5d443d4cfdd1`。范围：v12 导出作业、批准内容与来源快照、默认/用户模板、Tectonic/BibTeX/PDF/ZIP、发布/替换/最终审核、排他交付、七条 IPC 和 PDF 预览。

## Standards

发布与替换事务、取消/关闭、来源版本检查和排他写入符合用户规则 §2–3。共享 LaTeX 生成用三组有效输入与基点逐字节比对一致；工件替换保留原检查、状态变化和外层回滚行为。

窄复核确认模板注入目录、crossref 闭包/排序/父版本和引用键歧义处理；v12 增加查询索引，没有修改已提交的旧 migration。最终硬违反 0、设计判断 0、未解决 0。

## Spec

初审真实复现两项：嵌套入口会编译其目录下的旧占位正文，忽略根目录批准正文；crossref 父条目遗漏，PDF 引用缺会议、编辑和年份。两项已加入真实 PDF 回归，先失败后通过。

生成正文、BibTeX 和图稿现在位于实际入口目录；旧占位内容归档。书目收齐 crossref 父依赖，按子→父排序，并记录父版本。缺失、歧义、循环及父版本变化明确失败。另依据实际 Tectonic 输出拦截“BibTeX 错误被忽略”的成功退出，防止错误引用进入交付。

最终未解决 0。Spec 独立定向四项通过，原两项全部关闭。

## Verification

- 最终科研域、IPC、预览协议和数据库迁移：246 项通过；34 项可选资源测试在常规命令中跳过。
- 真实导出四项通过：中文 PDF + 批准图稿/实验数据 + 人工批准后 ZIP 保存；用户模板 + 真实库内作者/年份/引用键；嵌套入口 + 正文/图稿/BibTeX 注入；crossref 继承字段和父版本。
- ZIP 三项 Python 回归通过，覆盖 Unicode、字节内容、固定日期、哈希、链接/越界拒绝和已有文件不覆盖。
- 生命周期覆盖来源/文件/归档篡改、书目捕获后的迟到变化、旧审批换版、关闭时等待、取消/恢复、跨项目、引用键歧义、缺失/循环父引用、v11→v12 保留旧记录。
- `build`（含 typecheck）、`check:ipc`、差异检查通过。真实 ZIP 逐条解压检查大小/哈希及 CRC，已目检中文 PDF。
- 证据保留在 `.artifacts/research-export-integration/`，包括四种场景的运行记录、PDF、来源/引用、ZIP、交付结果和 PDFium 页面图。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-migrations.test.ts
rtk proxy /Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64/python/bin/python3 -B -m unittest discover -s /Users/Apple_501/Desktop/Roc/Roc/scripts/research/tests -p test_export_archive.py -v
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-export-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/export-ipc.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

边界：使用固定 Tectonic 与 BibTeX；模板声明正文与引用入口。交付目标必须是不存在的 ZIP 文件。单文件 64 MiB、内容总量 512 MiB、最多 10,000 文件。Agent 生产工具接线、完整界面与最终打包仍在后续计划。

状态：Verified passing。
