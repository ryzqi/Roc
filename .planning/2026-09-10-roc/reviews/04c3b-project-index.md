# Production 4c3b Review

基点：`c7a5b3c`。范围：项目文件范围配置、持久扫描与任务、目录监听、增量索引/重建/暂停/恢复/重试、不可变来源快照与证据读取、v9 迁移及六条 IPC。实验、绘图和完整 Renderer 继续后续增量。

## Standards

初审发现解析器升级后旧任务可能复用旧缓存，以及扫描失败被残留排队文件掩盖。已统一比较最近任务的解析器身份；重启队列先重扫，执行和发布前也核验工具链。无实际运行任务时，持久扫描错误优先于残留文件队列状态。

两项问题均经失败回归和修复复核关闭。其余调度恢复、迟到发布、来源快照和资源边界未发现新增缺陷。最终 0 项未解决问题，独立定向 4 文件 / 36 项通过。

## Spec

解析器升级对 queued/running/failed 状态的遗漏已修复；最新解析器失败后保留失败状态，普通重扫不会无限重试同一版本。监听关闭时的排队任务重启后也会重新核验缓存身份。

最终 0 项未解决问题。独立升级回归 6 项通过，另用真实 `fs.watch` 验证目录替换后仍能捕获修改。

## Verification

- 最终科研域、IPC、预览协议回归：28 文件 / 183 项通过，5 个可选真实资源用例按环境跳过。
- 已独立开启真实目录监听及私有工具链 PDF 索引：2 项通过，覆盖文本变化/删除、暂停恢复、全文检索、证据捕获及原始文件版本读取。
- 证据目录：`.artifacts/research-index-integration/roc project index integration-HJngrf/filesystem-result.json`、`roc project index integration-TrvYye/pdf-result.json`。
- 仓储事务、v8 → v9 迁移、旧证据身份、配置/项目变化后的迟到结果、文件筛选/Unicode 定位、嵌入缓存与原文保留均有回归。
- `build`（含 typecheck）、`check:ipc`、staged 差异检查通过。Python 工具链未修改。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts
rtk proxy env PYTHONDONTWRITEBYTECODE=1 ROC_RESEARCH_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_RESEARCH_ARTIFACT_ROOT=/Users/Apple_501/Desktop/Roc/Roc/.artifacts/research-index-integration pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/index-ipc.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

边界：tex/bib/md/csv 按原始文本及物理行索引；PDF/图片/HTML 使用固定 Docling。单项目最多 10,000 个受支持文件、50,000 个遍历条目；纯文本 16 MiB、文档/图片 512 MiB。旧证据保留来源副本，删除原文件会移除当前搜索索引。

状态：Verified passing。
