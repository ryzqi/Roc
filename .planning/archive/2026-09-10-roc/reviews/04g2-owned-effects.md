# Integration 4g2：生产副作用归属

状态：Verified passing。基点：`892b6f8`。

## 范围

- 阶段 Agent 的脚本、模板、实验、图稿和导出写工具由服务绑定当前项目和本次运行；模型不能指定 projectId 或 ownerRunId。
- 脚本/模板修改使用 expectedHash；实验和导出使用 requestId 幂等。取消或替换阶段运行后，迟到写入、完成结果和发布均被拒绝。
- v14 回填旧实验/导出快照的 ownerRunId=null，并新增 workspace 文件版本表。不改 v1–v13。
- 人工批准和最终 ZIP 交付仍不向模型开放。4g3 真实阶段输出、Idea Canvas/项目语言、Renderer 和 Packaging 仍待实现。

## Standards

硬违反：0。判断项：0。未解决：0。

审查中发现并已修复：

- 迟到实验完成事件仍按原始 `result.status` 记录；已改为使用归属校验后的终态。
- 取消只扫描最近 200 条作业；已改为按 `ownerRunId` 查询进行中的实验/导出。
- 模板保存/编译在异步文件操作后才校验归属，迟到写回可能先落盘；校验已移到持久化之前，失败回滚文件。
- 工作区文件版本记录写入未与运行归属同一事务；已在 persist 事务内再次 `requireActive`。
- 带 `superRefine` 的启动合同不能 `omit`；已拆出绑定项目的 owned schema。

判断项：`ResearchProductionEffectService` 是归属绑定门面，不是多余转发。IPC 仍允许人工启动无 `ownerRunId` 的实验/导出，符合现有界面路径。

## Spec

未解决：0。

- 项目/运行身份由服务绑定：角色工具 schema 不含 `projectId`/`ownerRunId`；伪造字段被拒绝。
- 版本与幂等：脚本/模板 `expectedHash` 冲突失败；相同 `requestId` 返回已有作业，参数变化冲突。
- 取消边界：取消后的脚本写入、实验完成/发布、模板编译/保存均被拒绝；迟到结果不发布工件。
- 迁移：v13 作业升级后 `ownerRunId=null`，workspace 文件表存在。
- 范围外：阶段 `complete()` 仍新建 `path=null` 工件，属 4g3。

独立回归 6/6 通过：归属绑定、伪造项目身份、迟到实验发布、迟到工作区写入、迟到模板编译/保存、v13 回填。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-schemas.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-migrations.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --check
```

相关回归 37 文件、268 项通过，34 项可选资源跳过。owned-effects 6/6。typecheck、check:ipc 通过。
