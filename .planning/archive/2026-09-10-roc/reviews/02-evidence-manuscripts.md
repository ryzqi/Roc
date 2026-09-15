# Evidence and manuscript review

基线：`26fd9816b18f8a27f1eaa07ddf33adc4a3d73f79`。范围：证据快照、主张修订、正文、审批与导出数据包。

## Standards

初审 1 项数据保留违规：更新主张粗粒度删除非 model_run 来源，会丢失原始工作流审计。修复为审计仅追加、派生证据关系去重、每版主张保存 evidenceIds；复查 0 项未解决问题。

另区分 Provenance 的 figure 实体和 figure_claim 图稿主张，保留已有图稿记录接口语义。独立内存实验验证归属拒绝、审计保留和关联去重。

## Spec

初审 1 项 P2：同一审计记录删除问题违背修订来源可追溯要求。修复后复查关闭，0 项未解决问题。

## Verification

- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test tests/main/plugins/research tests/main/ipc-contract-boundary.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/main/infrastructure/database-migrations.test.ts`：11 文件 / 68 测试通过。
- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`：通过。
- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc`：通过。
- 覆盖注册插件→IPC adapter→知识库→证据→正文→人工审批→导出数据包的行为链路；旧 migration 升级保留项目。

状态：Verified passing。实际 PDF/归档文件生成、角色运行与界面交互由后续增量完成。
