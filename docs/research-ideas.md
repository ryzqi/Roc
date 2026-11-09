# Idea Canvas、方法计划与结果评估

构思阶段把研究想法写成结构化 Idea Canvas。项目语言是项目级中英设置，阶段 Agent 按该语言输出；界面仍为中文。成熟且已批准的 Canvas 可以晋升为新研究项目，并保留来源版本。晋升必须指定新的工作目录，不能沿用源项目目录。

## 项目语言

创建项目时 `language` 为 `zh` 或 `en`。省略时默认为中文。`updateProject` 可在之后修改。旧项目升级后为中文，没有来源记录。导出模板语言仍由导出请求单独指定。

```typescript
await research.createProject({
  title: '证据图研究',
  description: '把可晋升想法变成可追溯项目。',
  workspacePath: '/Users/me/research/evidence-graph',
  language: 'zh'
});
```

## 保存 Canvas

工件类型必须是 `idea_canvas`。七个字段都要填写：问题、假设、新颖性、支持证据、反证、实验、风险。支持性内容必须引用本项目真实 `evidenceIds`；假设和待验证字段不得标成 supported。空的反证可以保留，但字段本身不能缺。写入使用 `expectedVersion`：首次为 `null`，之后必须匹配当前版本。

```typescript
// 替换为当前项目中已有的真实 evidence ID。
const evidenceId = 'evidence-id-from-this-project';
const fields = [
  { key: 'problem', content: '如何保持证据图可检查？', status: 'pending', evidenceIds: [] },
  { key: 'hypothesis', content: '结构化 Canvas 能减少无依据晋升。', status: 'hypothesis', evidenceIds: [] },
  { key: 'novelty', content: '晋升保留已批准 Canvas 版本。', status: 'pending', evidenceIds: [] },
  { key: 'supportingEvidence', content: '既有方法缺少晋升记录。', status: 'supported', evidenceIds: [evidenceId] },
  { key: 'counterevidence', content: '', status: 'pending', evidenceIds: [] },
  { key: 'experiment', content: '批准后晋升并核对来源。', status: 'pending', evidenceIds: [] },
  { key: 'risks', content: '过期 Canvas 可能重复创建项目。', status: 'pending', evidenceIds: [] }
] satisfies Array<{
  key: 'problem' | 'hypothesis' | 'novelty' | 'supportingEvidence' | 'counterevidence' | 'experiment' | 'risks';
  content: string;
  status: 'supported' | 'hypothesis' | 'pending';
  evidenceIds: string[];
}>;

await research.saveIdeaCanvas({
  artifactId,
  expectedVersion: null,
  problem: '如何保持证据图可检查？',
  hypothesis: '结构化 Canvas 能减少无依据晋升。',
  novelty: '晋升保留已批准 Canvas 版本。',
  supportingEvidence: '既有方法缺少晋升记录。',
  counterevidence: '',
  experiment: '批准后晋升并核对来源。',
  risks: '过期 Canvas 可能重复创建项目。',
  priority: 'high',
  rationale: '新颖性最高，且有可检验路径。',
  fields
});
```

`getIdeaCanvas` 与 `getIdeaCanvasHistory` 读取当前版本和历史快照。构思阶段 complete/approve 会重新校验当前快照、证据归属和内容哈希。

## 晋升

仅已批准且当前版本的 Canvas 可以晋升：

```typescript
await research.promoteIdeaCanvas({
  artifactId,
  expectedVersion: 1,
  title: '证据图项目',
  workspacePath: '/Users/me/research/evidence-graph-project'
});
```

新项目从 discovery 开始，复制来源项目语言，并记录 `origin.projectId/artifactId/version`。同一 Canvas 版本重复晋升返回原项目，不另建副本。来源项目的产物、证据和流程保持不变。

## 阶段 Agent

构思角色输出必须包含 `ideaCanvas`。系统把它写入本次运行创建的 `idea_canvas` 工件；缺少结构、证据或字段一致性时运行失败，不打开审核闸门。

构思域**没有独立路由页面**（[ADR 0024](adr/0024-stage-surface-removed.md) 有意保留，登记在 `src/shared/surfaces.ts`
的 `PARKED_CAPABILITIES`）：保存 Canvas、查看历史与在已批准版本上晋升，都由对话代理调用上面这些
capability。方法计划与结果评估在工件检查器中编辑与审核。旧链接 `?view=ideas` 会回到默认 LaTeX 视图。

### 人工合同、版本与冻结

方法计划作为追加时间线绑定现有 Idea Canvas 的工件 ID、版本及内容 SHA-256。保存草稿也生成独立版本；修订必须引用最新父版本的 ID/hash 并填写原因。冻结另外记录人工审核说明、真实窗口身份、时间、请求 hash 和冻结 hash。草稿与冻结请求的精确重放没有数据库写入，内容或身份改变则拒绝。

假设必须与选中 Canvas 完全一致。计划必须显式提供可证伪条件、指标定义/单位/方向/预期结果、数据计划、实验设计和分析计划。新颖性始终为待核查推断，保留检索范围与证据对比。样本量记录人工确认的方法、参数、样本数、证据和审核说明，或者明确未计算原因；服务不会计算或补造功效。

观察数据前/后是人工声明，不能充当独立预注册证明。事后计划必须引用当前有效 Evidence；一旦记录事后观察，后续版本不得改回观察前。负结果不改写历史预期。保存或冻结时拒绝缺失、跨项目或失效证据，Canvas 漂移、归档和被替代工件；历史计划保留原版本并暴露 `canvasCurrent`。

IPC 提供 `saveIdeaPlan`、`freezeIdeaPlan`、`getIdeaPlan`、`getIdeaPlanHistory`，保存/冻结的人工身份仅来自主进程 sender。严格合同不接收 actor。版本与冻结分别存储，不修改原 Canvas、修订历史或 Notebook 字节。读取校验规范 JSON、hash、请求和父版本元数据，以及冻结行与版本锚点的一致性。

### 现有工件检查器中的编辑、历史与审核

方法计划在既有 560px Stage drawer 内按模块 lazy 加载。表单提供完整方法、指标预期、新颖性对比与功效声明；新计划的观察时序必须主动选择。保存/冻结的请求 ID 在内容不变时保持，回复丢失后的精确重放只返回原回执。未保存修改或 pending 写入阻止关闭、刷新、任务切换和返回审核；明确放弃恢复已保存内容。历史每页十项，选择时按精确 ID/hash 复核，归档范围只读。

严格 inspector snapshot 显式包含 nullable Canvas 与最新计划，并聚合计划所引用的 Evidence。保存、冻结、Canvas 或 Evidence 漂移都会改变审核 hash；旧 gate review 无法批准改变后的内容。回执显示人工身份、版本/hash、冻结时间和完整方法，冻结预期不被事后结果覆盖。

### 冻结方法与真实负结果的人工评估

结果评估使用独立、追加式时间线。每条评估绑定精确冻结计划 ID、版本/hash、冻结 hash、真实指标结果回执 ID/hash，并保存完整计划、结果、指标 Evidence、运行起止时间和人工说明。它不修改 Canvas、冻结假设、预期结果或测量数据。历史冻结计划可回填结果；每个计划独立追加版本，修订必须指向最新父评估 ID/hash 并填写原因。

每个计划指标须明确关联该结果回执中的一个真实指标 Evidence，或注明缺失原因；至少保留一个实测指标。重复关联、遗漏和跨结果关联被拒绝。定义、单位、方向差异和缺失维度逐项保存，有差异只能选择“不可比”；支持、反驳、无法判断均由人工明确选择，服务不会根据数值自动选结论。

`saveIdeaOutcome` 的身份由主进程 sender 绑定；同请求、内容、身份和实际来源的精确重放零写入。`getIdeaOutcome` 重验真实运行、输入/输出/源码及指标 Evidence；当前来源失效时报错。`getIdeaOutcomeHistory` 明确标记 `stored_receipt`，仅核验历史保存回执，不能被视作当前来源仍有效。存储入口另外校验所有映射、嵌套 hash/项目/冻结身份、实际运行时间和差异，防止绕过 service 构造成功回执。归档项目拒绝写入，允许读取。

观察时序仍是人工声明；保存的运行起止时间来自真实运行记录，但不证明计划在独立系统中预注册。

### 结果评估界面与工件审核绑定

现有 Stage drawer 按模块 lazy 加载结果评估。用户主动读取冻结方法历史、最近 200 次真实运行和分页结果，再按精确 ID/hash 复核选中来源。每个计划指标主动选择实测指标或缺失原因，人工选择结论并填写审核说明；定义、单位、方向差异逐项显示，存在差异只能保存不可比评估。真实指标 ID 经编码后作为选项值，不与缺失选项冲突。

保存先逐项幂等捕获指标 Evidence，再追加人工评估。相同内容重试保留请求 ID；Evidence 已保存而评估失败时明确保留这些证据。计划与评估分别维护 dirty/pending，互相锁住修改，并共同锁住关闭、刷新、任务和审核切换。冻结审核说明也计入未保存修改；迟到写入回复不能清除新 Canvas 的修改状态。

严格 inspector snapshot 必须包含每个冻结方法的最新评估 head，并将其 Evidence 聚合到既有来源审核。新计划草稿不会删除旧方法评估；修订旧方法评估会改变审核 hash。历史分页显示保存回执，独立“复核当前来源”重新读取实际文件；来源漂移时移除当前验证状态，保留可读历史，不以旧 hook 数据表示成功。

### 导出来源、人工评估与完整历史

私有导出来源快照包含当前 `ideaOutcomes`；科学审核使用 schema 5，收集当前评估及每个冻结方法的全部 `stored_receipt` 历史。公开 ZIP 中的 `provenance/sources.json` 与 `provenance/scientific-review.json` 使用 `public_projection` 包装，改写后的历史标为 `private_source_receipt`，具体省略规则见[导出合同](research-exports.md)。无评估时显式为空数组，拒绝旧 schema 或缺少必填字段的合同。历史按每页 100 条收集，仍受现有文件及归档大小上限约束。

导出仅纳入正文与所选图稿 Evidence 实际引用结果的评估。项目、结果 ID/hash、冻结方法/冻结 hash、真实运行时间、指标 Evidence/metadata 与计划引用证据均精确核验；同项目的无关结果和其他项目不被关联。每个冻结方法只导出最新评估 head。当前 head 或来源改变使原来源 hash 和审核 seal 失效；校验没有数据库写入，也不修改已冻结的 sources 或审核文件。
