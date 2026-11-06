# S03：必填 Skill Manifest 与证据安全上下文

优先级：P0/P1。依赖：S01 工程协议、S02。来源：WP-05/WP-06、RH-08/RH-09/RH-12。
实施状态：complete（工程 L0/L1；科学评价未运行）。建议时间：第 3～7 周。

## 目标与关口

一次覆盖 11 个内置阶段的机器可验证 Skill 合同，删除无 Manifest 静态加载。
统一上下文装配、来源失效与压缩诊断；不把 summary 变成权限或科学事实。
科学方法试点仍先选择 discovery/reading/review，不以契约覆盖代替效果验证。

## 阶段起点

[research-skills.ts](../src/main/plugins/research/research-skills.ts)直接导入 11 份 raw Markdown。
[role-profiles.ts](../src/main/plugins/research/role-profiles.ts)已有阶段、Skill ID 与 capability 白名单。
[research-task-context-middleware.ts](../src/main/services/deep-agent/research-task-context-middleware.ts)、
[task-facts-store.ts](../src/main/plugins/research/task-facts-store.ts)和
[compaction pipeline](../src/main/services/deep-agent/context/context-compaction-pipeline.ts)已有实现。
[ADR 0027](../docs/adr/0027-retain-roc-context-compaction.md)要求 Roc compactor 为唯一压缩器。

## 按顺序执行

- [x] **RH-08.1 Manifest Schema**：必填 id、version、entry、license、source/revision/hash、
  inputs/outputs、requiredCapabilities、forbiddenEffects、qualityGates、evalCases、
  当前 runtime contract。entry/reference 只允许受控目录内已批准资源。
- [x] **RH-08.2 全量切换**：为 discovery/retrieval/reading/ideation/planning/experiment/
  figure/writing/review/revision/export 写合规 Manifest，准确对应当前 role Skill ID。
  未知许可不填占位符；核验来源或编写有明确归属的原创内容。
- [x] **RH-08.3 Registry**：目录摘要用于路由，选中后加载固定 hash 正文和 references；
  同步内容/许可/版本变化使旧 run snapshot 无效，不静默注入最新版本。
  替换 raw import map，所有 role 和 builder 改用 registry。
- [x] **RH-08.4 权限交集**：Skill requirement 必须满足角色白名单、run Manifest 和
  broker grant；不得自动追加工具。未知能力、hash 变化、未接受非商业许可直接失败。
- [x] **RH-08.5 校验命令**：新增 `check:skills` 并接入 build/CI 所需合同检查，
  覆盖 Manifest、角色对应、资源路径、hash、许可与输出 schema。
- [x] **RH-09.1 三阶段方法**：discovery 冻结问题/排除项，reading 输出 locator/
  evidence/条件/反证，review 输出结构化缺陷/修订需求。
  从方法论提炼规则，不复制未知许可上游文本。
- [x] **RH-12.1 Context Assembly**：硬约束/人工决定、不可变 task facts、
  source/artifact 引用、可压缩 transcript 四类显式组装；授权筛选发生在检索前。
- [x] **RH-12.2 来源与冲突**：facts 使用 supersedes/contradicts/stale source，
  输入来源更新后旧事实不再可用于新结论；保留历史审计，人工纠正不被摘要覆盖。
- [x] **RH-12.3 唯一压缩器**：重构当前 pipeline，输出触发原因、片段范围、摘要 hash、
  约束保留、artifact refs 和风险。大的工具结果入现有 context artifact store，
  失败直接暴露，不退回无界 prompt 或启用第二个 summarizer。
- [x] **RH-12.4 恢复再验证**：checkpoint 恢复后逐项校验硬约束、用户决定和 source versions；
  无法读取原证据时标明不可核验，不拿压缩文本替代。
- [ ] **RH-09/12.5 评价**：用 S01 协议比较三阶段输出与 25 个长任务，
  50～100 turns 测 constraint retention、false memory、citation、token 和费用。

## 交付与删除

计划新增 `resources/research-skills/<stage>/skill.manifest.json`、
Manifest schema/registry、`scripts/check-research-skills.mjs` 和内容 hash 构建校验。
改写 role profiles、agent builder、context middleware 与 compaction 调用方。

删除 raw 静态映射、无 Manifest 读取、兼容 Skill ID alias、重复 context assembly、
上游/自建双压缩入口、过期 facts 仍进入回答的分支、内部默认成功/空摘要兜底。
同一当前 compactor 的预算参数可以配置，不保留旧 compaction 实现开关。

## 验证

当前专项：

```bash
node --test tests/unit/research-task-facts.test.mjs tests/unit/builtin-skills.test.mjs tests/unit/context-contract-audit.test.mjs
pnpm typecheck
pnpm harness:eval
pnpm build
```

新增 `pnpm check:skills` 后执行，不提前宣称入口存在。
新增回归应证明：11 阶段必填完整、未许可与恶意 reference 被拒绝、同名内容变更失效、
子 Agent 不扩权、摘要不能授权、来源失效后检索不使用旧 facts、
待审批 tool call 和压缩后消息链可正确恢复。
真实长任务与科学 A/B 没有材料/费用授权时留在工程完成。

## 接受标准与下一步

AC-08/11 与权限/版本共同合同成立；11 阶段已走唯一 Manifest registry，
被替代 Skill/context 代码删除。三阶段科学改善必须有 S01 独立评价。
解锁 S04 核验/审稿、S05 检索和 S06 Worker 的合同依赖。

工程实现、迁移与验证记录见 [S03 执行报告](s03-execution-report.md)。
