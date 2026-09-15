# Integration 4g3：真实阶段输出与模型 provenance

状态：Verified passing。基点：`c965997`。

## 范围

- 实验/绘图/导出阶段的模型输出绑定本次运行链已发布的真实工件，不再另造 `path=null` 空产物。
- 完成时追加 `model_run` provenance，locator 记录 provider/model/version；未发布则失败并保留模型版本。
- 失败或重试留下已发布记录；重试成功后把结构化输出写到这些工件。
- 人工批准和最终 ZIP 交付仍不向模型开放。Idea Canvas/项目语言、Renderer 和 Packaging 仍待实现。

## Standards

硬违反：0。判断项：0。未解决：0。

判断项：`outputArtifacts` / `ownedProductionArtifacts` / `ownerRunIdFor` 把绑定范围限制在当前阶段草稿和本次运行链，避免误绑他人发布的工件。IPC 仍允许人工创建元数据工件，但不能通过阶段 complete。

## Spec

未解决：0。

- 真实产物：实验/图稿 complete 使用已发布清单路径；未发布返回 `research_stage_production_required`，不创建空工件。
- 模型 provenance：工件同时保留 experiment 来源和本次 `model_run`，含模型身份 locator。
- 失败/重试：首次发布后失败仍保留工件；重试成功后把内容写到原工件。
- 工具面：导出角色有 prepare/get/publish，没有 write_export 或阶段批准。
- 闸门：实验阶段 complete 校验真实执行；图稿仍要求证据后进入 waiting_approval。

独立回归 7/7 通过：未发布失败、实验绑定/provenance、失败后重试绑定原工件、拒绝外源发布、图稿绑定/provenance、导出未发布失败、导出工具面。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-schemas.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-migrations.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --check
```

相关回归 38 文件、274 项通过，34 项可选资源跳过。production-role-results 7/7。typecheck、check:ipc 通过。
