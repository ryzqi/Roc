# S04：主张核验、独立审稿与修订质量门

优先级：P0/P1。依赖：S01 最小独立数据、S02、S03。
来源：WP-03/WP-08、RH-06/RH-07/RH-09/RH-16。
实施状态：pending。建议时间：第 4～9 周。

## 目标与关口

在已有引用/证据/人工关系上建立可失效的主张语义建议和独立审稿程序。
writer、verifier、reviewer、人类批准各有清晰责任；科学建议不能自动成为 verified。
没有最小独立数据时可实施确定性合同，语义收益验收仍等待材料。

## 当前起点

- [citation coverage](../src/main/plugins/research/citation-coverage-service.ts)、
  [citation integrity](../src/main/plugins/research/citation-integrity.ts)、
  [evidence relations](../src/main/plugins/research/evidence-relation-repository.ts)已存在。
- [citation review repository](../src/main/plugins/research/citation-review-repository.ts)、
  [review repository](../src/main/plugins/research/review-repository.ts)和
  [response matrix schema](../src/shared/schemas/research-response-matrix.ts)已有人工审核/修订基础。
- [工件检查器](../src/renderer/artifacts/)是现有展示与来源读取落点。

## 按顺序执行

- [ ] **RH-06.1 确定性核验统一**：以当前服务为拥有者收敛重复引用检查，
  校验 citation key、source/artifact version、locator、数值/图稿/实验映射、
  人工关系和导出审批。缺定位/过期/未审核不能被语义模型覆盖。
- [ ] **RH-06.2 Semantic suggestion schema**：输入明确 claim ID/version、
  固定 evidence/source versions、反证、限定条件、研究类型和 task/run。
  输出 verdict、原文 locators、rationale、counter evidence、规则/模型/Skill hash、
  status 与输入 hash；不提供修改人工关系或 workflow approve 的能力。
- [ ] **RH-06.3 类型化审查**：事实、比较、数值、因果、实验结果、贡献/SOTA、假设
  各有证据条件。因果/SOTA 无充分设计或覆盖时显式 insufficient/qualifies，
  confidence 不能被当作科学概率。
- [ ] **RH-07.1 反证覆盖**：支持与反驳、负结果及替代解释进入同一审查输入；
  没找到反例标记检索覆盖，不能把“未发现”写成不存在。
- [ ] **RH-07.2 失效合同**：claim、正文、source、解析、evidence 或规则版本改变时
  原 suggestion 失效，保留历史与审计，下一次输出重新核验。
- [ ] **RH-09.2 科研判断规则**：discovery 明确问题/排除，ideation 明确竞争假设/
  失败条件，planning 明确变量、对照、指标、预算与停止条件。
  fatal flaw、method fit、evidence sufficiency、novelty support、reproducibility、
  writing integrity 都有原始证据引用和可执行动作。
- [ ] **RH-16.1 独立 Reviewer**：只读冻结稿件、证据、反例、实验和标准，
  不共享 writer 推理上下文、不直接改批准稿、不授予额外工具。
  Reviewer 与 verifier 的输出不同：finding 驱动修订，verdict 驱动证据核验。
- [ ] **RH-16.2 Finding/修订闭环**：finding 保存 severity、claim/evidence、
  reviewer、source/artifact versions、action、status。
  finding → revision task → 修改位置 → reverify → 人工接受/退回可追踪，
  旧意见不被新稿静默覆盖。
- [ ] **RH-16.3 Quality gate**：确定性门阻断真实违规；
  语义建议进入人工批准。经独立评测决定是否启用更强语义门，
  不由模型直接终止研究、推进阶段或批准公开发布。
- [ ] **RH-07.3 现有 UI 合同**：返回工件检查器所需原文定位、反证、失效和人工动作
  数据；S07 完整核验布局/焦点，后端合同本阶段同步必要消费者。
- [ ] **RH-06/16.4 盲审**：首批 30～50 条 claim pilot，最终目标 300 条；
  覆盖综述、方法论文、实验报告，报告支持 precision/recall、反证漏检、
  条件误判、误阻断及人类返工，不以模型自评分作成功标准。

## 交付物与删除

计划新增 `verification/` 职责模块、semantic suggestion/finding/gate schemas，
在现有研究 DB 保存输入绑定的建议与 finding，复用已有 evidence、人工关系和 response matrix。
改写 writing/review/revision/export gate 调用方，同步 IPC 和现有工件组件。

删除重复检查、单段自由文本审稿作为唯一状态、模型直接核准主张的路径、
来源变更后旧建议仍有效的分支、旧 suggestion schema alias 和生产试验双路径。
有效引用检查和历史科研证据继续作为当前事实源；不重建 Evidence Ledger。

## 验证

```bash
node --test tests/unit/research-citation-integrity.test.mjs tests/unit/research-citation-coverage.test.mjs tests/unit/research-evidence-relations.test.mjs tests/unit/research-citation-reviews.test.mjs tests/unit/research-response-matrix.test.mjs
pnpm typecheck
pnpm check:ipc
pnpm test:review-workflow
pnpm build
```

新增回归证明 suggestion 不能批准，source/manuscript 变更失效，
模型冲突进入人工处理、反证与负结果保留、Reviewer 不可改稿/越权，
人工接受和拒绝都绑定正确版本。观察真实关系/工件状态，不能只断言 verdict 文本。
模型语义实验沿 S01 adapter 和授权执行。

## 接受标准与下一步

AC-06/07 工程全过；AC-15/16 科学结果单独报告。
完整语义收益不足时不强化自动 gate，不保留旧 verifier 回退。
S07 承接真实桌面审核流程；S08 承接确定性与人工核验后的导出闭包。
