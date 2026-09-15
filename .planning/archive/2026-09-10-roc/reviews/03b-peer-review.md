# Peer review and revision review

基线：`96818f47c4a56e8a04ab0c91ea90be7058f45649`。范围：三角色独立评审、综合、人工接受/修订决策、两轮修订、旧稿和中断恢复。

## Standards

初审 1 项：v4 把旧审稿运行周期清空，导致升级后无法重试。迁移现在依据保存的输入稿件绑定周期，并迁移轮次；旧协调器获得只读报告工具，独立角色仍过滤其他报告。复查关闭，0 项未解决问题。

## Spec

初审 2 项 P2：上述升级恢复问题；重开审稿后仍保留旧 accepted，可跳回导出。回退到审稿或更早阶段现在立即撤销旧接受与当前报告集合，实际稿件及历史报告保留。两项复查关闭，0 项未解决问题。

## Verification

- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test tests/main/plugins/research tests/main/kernel tests/main/ipc-contract-boundary.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/main/infrastructure/database-migrations.test.ts`：20 文件 / 124 测试通过。
- 完整验证两轮修订回到审稿、第三轮拒绝、显式人工接受、并行互盲、综合保留分歧、取消部分报告后重试、重开审稿撤销旧接受。
- v3 review/revision 运行升级后均可从保存稿件恢复、生成结果并完成审批。
- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build`（含 typecheck）、`check:ipc` 与差异检查：通过。

状态：Verified passing。生产工具、科研 UI 和最终打包继续按计划实现。
