# Production 4c3a Review

基点：`7e3a329`。范围：嵌入配置修订与缓存隔离、原文摘要条件写入、严格响应与数值验证、分批原子提交、请求取消/关闭、配置密钥回滚及 v8 迁移。项目监听与持久索引任务继续 4c3b。

## Standards

初审使用实际 sqlite-vec 确认：逐坐标有限且非零并不足以保证 Float32 余弦距离可用，极大/极小范数仍会返回 SQL NULL。已在编码前按最大坐标缩放并计算单位向量，仓储及查询入口统一处理；非有限、零和畸形数据明确失败。

配置/密钥失败回滚、旧返回值、分批提交与关闭顺序未发现其他问题。最终 0 项未解决问题，独立定向 17 项通过。

## Spec

数值问题经同方向、已知夹角和真实检索排序回归关闭。配置修订隔离不同地址的同名模型；片段摘要与配置修订在提交事务中重新检查；失败设置不替换旧凭据、不终止旧请求；关闭等待所有在途请求，迟到响应不写入。

最终 0 项未解决问题；独立实际 SQLite 数值回归 3 项通过。

## Verification

- 已先复现错误响应接受、旧片段覆盖、同名模型跨配置混用、端点变化后旧响应提交、失败设置覆盖密钥与请求未归属关闭等失败，再修复。
- 科研域、IPC 和预览协议：24 文件 / 155 项通过；4 项既有真实工具链/远程 DOI 用例按配置跳过。
- 本机 HTTP 验证实际浮点请求/响应和传输取消；实际 SQLite 验证 1e100、1e30、1e-30、1e-300 尺度的有限余弦距离及正确排序。
- 分批请求中后续批次失败时不留下部分向量；原文更新后旧向量不能覆盖新内容。配置显示名更改保持缓存；端点、模型、维度、凭据或启用状态改变后使用新的配置修订。
- v7 → v8 迁移保留原始知识和旧缓存，将未绑定修订的向量隔离为 legacy，不参与新配置检索。
- `build`（含 typecheck）、`check:ipc`、差异检查通过。现有 Renderer 使用 `embeddingConfigId:null`，保持未配置时的关键词检索。

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/embedding-consistency.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/embedding-vectors.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research/adapters.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
```

协议参考为 Context7 中的 OpenAI 官方 Embeddings 文档索引；官网 HTML/Markdown 直连返回 403。本次验证使用本机 HTTP 与实际 SQLite，未调用真实远端 Embeddings 服务。Python 工具链未修改。

状态：Verified passing。
