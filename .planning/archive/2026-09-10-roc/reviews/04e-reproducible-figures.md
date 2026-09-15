# Production 4e Review

基点：`27f9f5ab1aaa24f702241e28724b3725eab571ec`。差异：`rtk git diff --cached 27f9f5ab1aaa24f702241e28724b3725eab571ec`。范围：Matplotlib 实际绘图、渲染入口/代码/数据快照、PNG/SVG/PDF 独立验证、v11 图稿发布关联、原子替换、证据审核闸门、三条 IPC 和版本化预览。

## Standards

确认并修复两项审批生命周期问题：核验期间退回、换图、重新提交，旧请求可能批准新图；应用关闭后，迟到的核验结果可能继续批准。两项回归先稳定失败，再验证修复。

图稿服务现在跟踪发布和审批操作，关闭时等待结束；核验前后比较阶段、图稿和主张版本快照，检查关闭状态后同步提交。发布/替换在同一数据库事务内完成，旧图和证据保留；v11 追加迁移不修改已提交的旧 migration。

最终硬违反 0、设计判断 0、未解决 0。Standards 独立定向运行图稿服务与预览协议，25 项通过。

## Spec

初审真实复现两项：Matplotlib 热图的内嵌 PNG 被 SVG 响应 CSP 拦截；保留文本的 SVG 中，普通标题 `Frequency of url(...) tokens` 被误判为外部资源。

两个资源入口仅增加 `img-src data:`；SVG 资源语法扫描限定于实际 CSS 属性和 style 节点，普通文本保持原样。真实 Matplotlib 热图/文本及外部链接拒绝回归通过；独立 Electron 使用实际响应头检查，两个入口均显示正确的红色像素且无 CSP 错误。

最终未解决 0；原两项均关闭，无额外范围或独立功能遗漏。

## Verification

- 最终科研域、IPC、协议：215 项通过；30 项可选真实资源用例在常规命令下按环境跳过。
- 实际绘图 IPC：5 项通过，包含连续两次输出字节相同、独立验证拒绝伪造文件且保留日志、图稿/证据/人工批准与文件篡改拦截、SVG 文本和热图真实显示、外部链接继续拒绝。
- 图稿服务定向 12 项通过：发布事务、重复请求、快照校验、关闭、审批竞态、替换后历史、跨项目边界、v10→v11 保留旧记录、渲染选项纳入输入摘要及保留路径冲突拒绝。
- `build`（含 typecheck）、`check:ipc`、差异检查通过。新增代码复用既有固定工具链，无新增依赖。
- 真实证据位于 `.artifacts/research-figure-integration/`，包括运行记录、三种图稿、审核结果及 `svg-preview/preview-result.json` 和截图。已目检折线图的标题、坐标轴和数据点。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-figure-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/figure-ipc.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

边界：绘图使用 Matplotlib 和内置/uv Python；任意用户代码中的自建随机源或时钟仍须自行固定。自动文件验证不替代图稿和科学结论的人工审核。完整界面、最终导出和 Intel 实机验证继续后续增量。

状态：Verified passing。
