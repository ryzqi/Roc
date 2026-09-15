# Production 4d1 Review

基点：`3e9ba8e`。范围：Python/Notebook 实际执行、内置/uv 环境校验、输入快照、持久运行/取消/中断恢复、日志/输出哈希、知识索引/证据/流程发布、v10 迁移、八条 IPC 和资源预览。R/Julia、图稿编排、完整 Renderer 和最终导出继续后续增量。

## Standards

初审复现子进程更换进程组后逃过清理，以及索引事务失败时丢失已收集文件登记、清单错误记录成功。已在 Darwin 进程边界禁止更换进程组/会话，执行脚本与 Notebook 同时禁止 posix_spawn；受控 Notebook provisioner 在原进程组启动内核。失败路径保留已验证日志与输出，发布时从已提交状态生成并校验清单。

复核又确认 uv 启动项目 Python 时，`.pth` 会继承其 posix_spawn 权限。已先验证解释器来自固定工具链，再在严格限制的独立进程中探测项目环境；uv 只检查不含启动钩子的安装元数据副本。副本关闭系统 site-packages，明确指定解释器和 UV_PROJECT_ENVIRONMENT；两次探测的临时写入目录隔离，元数据摘要参与环境指纹。

最终硬违反 0、启发式问题 0、未解决 0。独立定向 20 项通过。

## Spec

初审复现成功 Notebook 文本输出没有索引、输出校验失败后日志不可读，以及清单缺失仍可发布。已按单元格和输出序号提取文本；保留所有已验证文件；发布前生成或校验与持久运行记录一致的清单。原始文本换行保持不变。

最终 0 项未解决。原三个回归及后续环境隔离语义已独立复核；可信解释器、运行前后环境摘要及 metadataHash 符合文档契约。

## Verification

- 最终科研域、IPC 和预览协议：201 项通过，12 个可选真实资源用例按环境跳过。
- 真实 IPC → 私有运行时：7 项通过，覆盖冻结输入/参数与项目外读写限制、uv 环境校验及锁文件不变、指定 Notebook 内核与失败单元格、Notebook/子进程取消、`.pth` 权限隔离、本地 wheel 包运行/安装元数据变化、未验证解释器拒绝。
- `.pth` 风险先由真实 uv 回归复现，再验证修复；实际 uv stderr 确认采用 uv-check 临时环境。
- 权限收紧后，原工具链的 LaTeX/PDF/OCR/表格/公式集成 2 项通过。工具链 38,565 项完整性校验通过，未改私有 Python 或其依赖。
- v9 → v10 保留旧实验记录，不虚构执行快照；管理中的运行不可被旧 record 接口覆盖；跨项目与未完成实验不能作为已完成来源。
- `build`（含 typecheck）、`check:ipc`、staged 差异检查通过。真实证据保留在 `.artifacts/research-experiment-integration/` 与 `.artifacts/research-experiment-toolchain-regression/`。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-experiment-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/experiment-ipc.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

边界：uv 环境共享已校验的内置 Python，不继承系统包；应用不自动安装或改写项目环境。单文件 64 MiB，输入/输出各 256 MiB，文件预览 4 MiB。中断运行不会自动重复执行。完整使用契约见 `docs/research-experiments.md`。

状态：Verified passing。
