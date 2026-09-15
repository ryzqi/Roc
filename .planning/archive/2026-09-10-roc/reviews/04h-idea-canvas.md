# Integration 4h：Idea Canvas 与项目语言

状态：Verified passing。基点：`1fce157`。

## 范围

- 项目级中英语言设置写入 `research_projects.language`；省略时默认中文，旧项目升级为中文。
- 构思阶段保存结构化 Idea Canvas：问题、假设、新颖性、支持证据、反证、实验、风险、优先级和依据；支持性字段必须引用本项目证据。
- 已批准且当前版本的 Canvas 可晋升为新研究项目，复制语言并记录来源工件/版本；同一版本重复晋升返回原项目。
- 构思角色输出必须包含 `ideaCanvas`；缺少结构则运行失败，不打开审核闸门。Renderer 和 Packaging 仍待实现。

## Standards

硬违反：0。判断项：0。未解决：0。

审查中发现并已修复：

- 晋升创建项目后另写来源事件，事件失败会留下新项目；已放入同一事务，失败回滚。
- 来源三字段可半写入；读取拒绝不完整来源，迁移增加 INSERT/UPDATE 触发器。
- 旧运行上下文缺 `language/origin/ideaCanvas` 会无法恢复；v15 回填这些字段。

判断项：仓储对升级前表结构做列探测，只服务迁移夹具，不作为运行时兼容回退。Canvas 字段与具名章节重复，是为了保持结构化校验和可读快照。

## Spec

未解决：0。

- 结构化 Canvas：七个字段齐全，支持性内容要求真实 evidenceIds；假设/待验证不得标成 supported。
- 版本：首次 `expectedVersion=null`，之后按当前版本写入；过期写入冲突。
- 闸门：无 Canvas 不能 complete；角色缺少 `ideaCanvas` 失败且不创建工件。
- 晋升：仅已批准当前版本；新项目从 discovery 开始，复制语言，记录 origin；幂等。
- 语言：创建/更新/晋升均可设置 `zh|en`；阶段 Agent 提示使用项目语言。

独立回归 9/9 通过：默认/显式语言、证据与版本、批准后晋升幂等、晋升回滚、不完整来源拒绝、角色缺 Canvas 失败、角色写入后打开闸门、v14 升级、IPC 保存/晋升。

## 验证

```bash
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test /Users/Apple_501/Desktop/Roc/Roc/tests/main/plugins/research /Users/Apple_501/Desktop/Roc/Roc/tests/main/pdf-preview-protocol.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-plugin-adapter.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-contract-boundary.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-schema-generation.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/ipc-domain-structure.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-schemas.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-migrations.test.ts /Users/Apple_501/Desktop/Roc/Roc/tests/main/infrastructure/database-fast-probe.test.ts
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc exec tsc --noEmit -p tsconfig.json
rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc check:ipc
rtk git -C /Users/Apple_501/Desktop/Roc/Roc diff --check
```

相关回归 40 文件、288 项通过，34 项可选资源跳过。idea-canvas 9/9。typecheck、check:ipc 通过。
