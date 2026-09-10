# Workflow lifecycle review

基线：`86405a4c173defcfc8f33375f0320452a63a17b3`。范围：阶段导航、产物生命周期、来源归属和对应 IPC。

## Standards

0 项未解决问题。初审发现原子性测试在 INSERT 前失败，无法检测事务被移除；改为关联 UPDATE 的 SQLite trigger 抛错，验证产物、关联、事件共同回滚。独立 review 实验确认移除事务会留下孤立产物，测试可识别回归。

## Spec

初审 1 项 P2：`artifactId: null` 配合跨项目 `subjectType: artifact` 可绕过归属校验。修复为检查 subject 所属项目，并要求 `artifactId === subjectId`；复查关闭，0 项未解决问题。

## Verification

- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test tests/main/plugins/research tests/main/ipc-contract-boundary.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/main/ipc-domain-structure.test.ts`：9 文件 / 39 测试通过。
- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`：通过。
- `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc`：通过。
- `rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --cached --check`：通过。

状态：Verified passing。角色运行、细粒度主张证据闸门及 Renderer 操作入口在后续增量完成。
