# Production 4b Review

基点：`bc04b41`。范围：主进程工具链接线、进程隔离、模板目录/ZIP 导入、文件编辑与编译版本、IPC、项目 PDF 预览协议。

## Standards

初审发现文件先替换、数据库后更新，失败时原文未恢复。已在写入前检查模板，保留原始字节；后续失败仅在目标仍匹配本次内容时回滚，不覆盖外部随后产生的编辑。

复查捕获数据库提交前取消当前编译的副作用。已将文件保存、入口切换、摘要刷新和新编译的取消操作放到成功持久化之后；已取消但迟到返回的当前运行明确收敛为失败，避免遗留 compiling。

最后复核了 OCR 计算权限：只有 `parse_document` 启用明确的五类 IOSurface/GPU/ANE 客户端；其他任务不开启，进程执行仍限所选命令。最终 0 项未解决问题。

## Spec

模板扩展名过滤会丢弃 `.tikz/.csv/.fd` 等合法资源。已改为保留通过路径和大小检查的普通资源，编辑权限单独限制。

独立复核文件回滚和在途编译事务：保存被拒绝时原文恢复、旧编译继续运行、迟到成功结果可正常发布，shutdown 后无残留运行身份。最终 0 项未解决问题。

## Verification

- 常规科研域、IPC、协议和数据库检查：18 文件，107 项通过；1 项真实资源用例在常规命令中跳过。
- 随后补充 v4→v5 模板升级回归，仓储测试 9 项通过；旧路径保留，旧 PDF 在摘要未验证时不标为当前结果。
- 显式提供 `ROC_RESEARCH_TOOLCHAIN` 运行 `toolchain.test.ts`：2 项通过，包含缺资源边界与完整真实链路。
- 真实链路覆盖固定清单校验、ZIP/嵌套资源模板、中英文/公式 LaTeX、PDF 摘要预览、PDFium 渲染、文件沙箱内 OCR、表格/公式/图稿提取。结果：1 页，五种块类型，无警告；公式为 `E = m c ^ { 2 }`。
- 实际证据：`.artifacts/research-production-integration/roc research integration-ctjYcU/result.json`。
- Python：27 项通过，含 ZIP 路径/链接/大小写/数量边界及 MIME 配置隔离。
- `build`（含 typecheck）、最终 typecheck、`check:ipc`、差异检查通过。

诊断结论：Python 3.12 的 MIME 初始化会扫描主机文件，需清空 knownfiles 后初始化内置表；Vision 需要组合计算客户端权限，只有通用图形权限不足。对照与最小化实验均保存在 `.artifacts/research-sandbox-debug/`。

限制：版面模型在稀疏页面中可能把公式识别为普通段落，保留原页供复核。实际验证为当前 arm64 macOS；Intel 实机、Renderer 和最终应用打包属于后续范围。

状态：Verified passing。
