# S03 Skill 与上下文验收

日期：2026-11-07。开始 SHA：`71204210f35ed3592ad8ca7d2f4f9b5c3e4ad80f`。
范围状态：`Verified passing（S03 工程 L0/L1）`；科学评价未运行。

## 实现与证据对应

| 合同 | 实现 | 行为证据 |
| --- | --- | --- |
| RH-08.1～08.3 | 11 阶段必填 Manifest、封闭资源 catalog、唯一 Registry；固定正文/许可/来源/schema/runtime hash，Stage context 保存 skillPin | registry 回归覆盖全部阶段、缺字段、路径逃逸、未批准 reference、未知或未接受许可、内容/schema/version 变化 |
| RH-08.4 | role 白名单、持久化工具列表、Skill requirement 与同 Task/execution grant 交集；每次工具读取和模型调用复核 | 伪造上下文/工具列表/manifest、跨项目、撤销及暂停 grant 在读取前被拒绝；子角色不能超出父角色工具范围 |
| RH-08.5 | `pnpm check:skills` 接入 build；目录内文件、非 symlink、hash、许可、角色及输入输出 schema 检查 | 11 阶段、33 个资源与 catalog 一致；构建执行同一检查 |
| RH-09.1 | discovery 保留冻结问题/排除项，reading 明确 locator/条件/反证，review 明确缺陷与修订要求 | 11 阶段合同回归和现有输出校验；这些是方法合同，不代表科学效果提高 |
| RH-12.1～12.2 | `assembleResearchTaskContext` 共用于 chat/stage，每次模型调用重读账本；分开约束/人工决定、事实、来源及不可核验项；supersedes/contradicts 有界校验 | facts 回归验证过期/替代正文被排除、历史来源保留、人工纠正/冲突及非法关系/环被拒绝 |
| RH-12.3～12.4 | 唯一 Roc compactor 保留待响应 tool call/同批响应，摘要前保存原 transcript，按 thread/workspace/hash 重读原证据；诊断记录触发原因、消息数量/hash、摘要 hash、artifact refs 和风险 | compaction、contract audit、固定长任务与 checkpoint 回归；摘要失败直接暴露、无空摘要继续、显式重试恢复、证据不可读拒绝 |
| M07 | research DB 62 offline-only；拒绝缺 skillPin 的新 Stage；有限转换保留原 context、事件、证据/事实和 backup | 3 项离线迁移回归含 research61 来源、物理重开、旧 continue/retry 拒绝、新合同任务启动、unknown 预算保留 |

11 份内容沿用项目原创资源，许可证明确为 Roc 内部使用、保留权利；没有指定开源许可，
也没有复制未知许可上游文本。catalog 包含构建批准的资源，模型不能按文本链接加载任意文件。

## 切换与历史数据

删除 raw 静态 Skill map、`getResearchSkillInstructions`、省略工具列表时的默认授权、
stage 单独组装任务事实，以及 `summarizeContextOrSkip`、`compactToArtifactReferenceTail`
等摘要失败继续路径。生产源码旧符号零引用；有效 compactor 与原始证据存储继续复用。

离线转换仅接受 agent19/research60 或 agent20/research61，其他五库 schema/checksum
仍需完整匹配。旧 Stage/研究 Task 标历史不可恢复，原始 context 不补当前 skillPin；
关联聊天撤销授权，未关联研究 Task 的聊天保持原状态，未结预算转 unknown。
只演练隔离数据库，不迁移真实用户数据。S08 仍需完整应用包升级/冷恢复演练。

## 验证记录

以下 cwd 均为 `/Users/Apple_501/Desktop/Roc/Roc`；Node v26.13.0、pnpm 12.5.1。
采集时 HEAD 均为本报告开始 SHA；验证对象为本阶段待提交差异。

- [首轮 verification.json](../.artifacts/research-harness/S03/2026-11-06T18-39-12.928Z/verification.json)：
  `pnpm test:unit` 1546/1546；`pnpm check:ipc`、`pnpm test:review-workflow`（1/1）、
  `pnpm build`、`pnpm check:renderer-chunks`、`node scripts/smoke-electron.mjs`（13/13）exit 0。
  源码 hash 采集前后不变。smoke 为 dist-main-fallback、full=false，不代表完整打包验收。
- 首轮 `pnpm harness:eval` 的两个旧夹具失败：仍期待摘要失败自动继续，以及旧的预算错误。
  将夹具改为核验失败事件、无成功 digest、原约束不变及显式重试；保留首轮失败日志。
  仅修改 `scripts/harness-eval/context.ts` 与 `context-long-task.ts`，生产源码和 unit 未变。
- [最终补验 verification.json](../.artifacts/research-harness/S03/2026-11-06T18-46-37.350Z/verification.json)：
  `pnpm harness:eval` 94/94、`pnpm typecheck`、`pnpm check:skills` 全部 exit 0；源码 hash 无变化。
  两轮日志 hash 已核对；未重复不受夹具修改影响的完整单测/构建。

RH-09/12.5 的三阶段 A/B、25 个 50～100 turns 长任务和科学收益尚无独立材料、
人工审核与费用授权。固定长任务是确定性 fixture，不能据此声称真实模型质量或费用改善。
S04 后续实施；S01 科学仍为 insufficient，S09 仍是独立条件扩展。
