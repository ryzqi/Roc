# Forge Guardrails

把 forge 的护栏思想以 LangChain v1 AgentMiddleware 形式接入 Roc 的 deepagents 链路。

详细设计见 `docs/superpowers/specs/2026-05-28-forge-guardrails-integration-design.md`。

## 模块布局

- `errors.ts` — RocToolResolutionError
- `message-tags.ts` — forge_message_type 标签
- `state-schema.ts` — LangGraph state schema
- `nudge-templates.ts` — context warning 文案
- `rescue-parser.ts` — 4 种野生格式解析
- `sampling-defaults.ts` — 采样默认值
- `preview-store.ts` — propose preview session-scoped 缓存
- `middleware/*` — LangChain middleware：错误预算、iteration 标记、文件工具错误、tiered compaction、rescue parsing、tool resolution、cleanup
