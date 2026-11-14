# Forge Guardrails

以 LangChain AgentMiddleware 实现工具错误分类、迭代标记、救援解析和清理；实际 scope、mode 与顺序统一由 [middleware-stack.ts](../deep-agent/middleware-stack.ts) 装配。

## 模块布局

- `errors.ts` — RocToolResolutionError
- `message-tags.ts` — forge_message_type 标签
- `state-schema.ts` — LangGraph state schema
- `rescue-parser.ts` — 4 种野生格式解析
- `sampling-defaults.ts` — 采样默认值
- `preview-store.ts` — propose preview session-scoped 缓存
- `middleware/*` — iteration 标记、文件/运行错误、rescue parsing、tool resolution、cleanup；tiered compaction 模块保留但不装配到生产链

会话唯一压缩器是 `createRocContextCompactionMiddleware`，取舍见 [ADR 0027](../../../../docs/adr/0027-retain-roc-context-compaction.md)。
