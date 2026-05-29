# Forge Guardrails

把 forge 的护栏思想以 LangChain v1 AgentMiddleware 形式接入 Roc 的 deepagents 链路。

详细设计见 `docs/superpowers/specs/2026-05-28-forge-guardrails-integration-design.md`。

## 模块布局

- `errors.ts` — RocToolResolutionError
- `message-tags.ts` — forge_message_type 标签
- `state-schema.ts` — LangGraph state schema
- `nudge-templates.ts` — nudge 文案
- `rescue-parser.ts` — 4 种野生格式解析
- `sampling-defaults.ts` — 采样默认值
- `prerequisites-config.ts` — prereq + workflow 配置
- `respond-tool.ts` — 合成 respond ClientTool
- `preview-store.ts` — propose preview session-scoped 缓存
- `workflow-resolver.ts` — workflowHint -> WorkflowSpec
- `middleware/*` — 7 个 LangChain middleware
