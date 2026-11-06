# S08：科研导出闭包、整体验收与发布材料

优先级：P1。依赖：S01～S07 的相应工程/科学验收。
来源：WP-11、全量验收、RH-18/RH-19。
实施状态：pending。建议时间：第 15～16 周；外部验收按条件完成。

## 目标与关口

验证从研究问题到可信材料包的完整路径与失败/修订分支。
真实资源、版本、许可和科学审查形成闭包；工程、科学、外部与发布分别报告。
本地包构建和可审查发布材料先完成，远端发布需要具体目标授权。

## 当前起点

[export service](../src/main/plugins/research/export-service.ts)、
[RO-Crate exporter](../src/main/plugins/research/export-ro-crate.ts)、
[public projection](../src/main/plugins/research/export-public-projection.ts)、
[export publication](../src/main/plugins/research/export-publication.ts)
已有本地工件闭包、公开投影及发布审查，不重建导出系统。
现有未公开域继续由助手工具和检查器使用，不恢复旧阶段界面。

## 按顺序执行

- [ ] **RH-18.1 闭包核对**：当前 artifact → claim → evidence/source →
  experiment/data/code → figure/manuscript → export 逐关系验证
  精确文件 bytes、ID/ref、版本、hash、许可、人工审核和语义建议有效性。
- [ ] **RH-18.2 Validation Manifest**：导出机器清单包含确定性检查、
  未确认语义主张、实验可复现层级、不可分发依赖、metadata-only 外链、
  source/artifact/gate/Skill versions 与用户决定引用。
- [ ] **RH-18.3 真 ZIP 回读**：打开实际 archive，验证所有文件和元数据闭包，
  防重复/越界 path、错误 hash、失效 locator、未知许可和私有字段泄漏。
  未许可正文/附件不得打包，metadata-only 不伪造为已收录全文。
- [ ] **RH-18.4 外部动作分开**：本地 prepare/export 完成不调用 Zenodo/其他发布。
  sandbox 集成按具体账号、目标、材料、预算/网络授权后验收；
  正式公开发布独立批准，不复用 stage 或科研质量闸门。
- [ ] **RH-19.1 全链路案例**：至少一条研究问题 → perspective draft →
  人工冻结检索 → 有依赖读取/证据综合 → 方法/已有实验 →
  文稿核验 → finding/修订 → 人工接受 → 本地导出的真实工作流。
  加入 provider partial、来源替换、Worker crash、取消/继续、
  过期 approval、反证/负结果和修订失败分支。
- [ ] **RH-19.2 迁移/冷恢复**：隔离旧版本数据备份 → 离线转换 → 新版本启动 →
  task/event/evidence/receipt 检查 → 停机恢复匹配旧版本与备份。
  新产生外部 effect 不因 DB 回滚撤销，必须先对账；用户 workspace sentinel 字节不变。
- [ ] **RH-19.3 删除收尾**：逐项关闭 deletion ledger，旧接口/alias/decoder、
  raw Skill、旧调度/UI、生产 A/B flags、失败候选算法和调试代码零引用。
  不通过删回归测试掩盖行为变化，不批量删历史研究数据。
- [ ] **RH-19.4 科学/性能报告**：完整 200 样本与专项实验按冻结协议比较，
  报告族回退、置信区间、失败、未知费用、blind human review、
  retrieval/context/DAG 的质量与耗时/费用。没有独立材料不宣称科学收益。
- [ ] **RH-19.5 Mac package**：实际 arm64 .app 打包并 smoke，
  核验 native dependencies/resources、启动、项目门户、助手运行、
  任务观察、PDF protocol、取消恢复、键盘和深浅主题。
- [ ] **RH-19.6 发布材料**：完成变更说明、迁移/冷恢复手册、已知限制、
  数据/模型/Skill/protocol 版本、license、成本/隐私和停止执行办法。
  是否发布作为具体产物与授权的独立决定，不因计划结束自动上传。

## 交付物

真实 ZIP/manifest/receipt、端到端案例与故障截图、全量 regression 与 A/B 报告、
迁移和冷恢复报告、版本化 macOS .app、删除清单、开发/操作/发布材料。
更新相关现有领域文档与三个 ADR，不把历史验收账本改成“最新全部通过”。
计划新增 `plan/final-acceptance.md` 统一指向实际证据与未完成条件。

## 验证顺序

先共享合同和业务回归，再原生/打包，不重复聚合命令内已跑相同检查：

```bash
pnpm check:ipc
pnpm build
pnpm test
pnpm harness:eval
pnpm harness:quality:check
pnpm test:review-workflow
pnpm test:research-resources
pnpm test:research-environment-boundaries
pnpm test:research-native-code
pnpm test:research-p0
pnpm check:renderer-chunks
pnpm package:dir
pnpm verify:native-packaging
pnpm verify:arm64-only
pnpm verify:paths
pnpm smoke:mac
```

`pnpm build` 包含 typecheck；`pnpm test:research-p0` 再 build。
实施时同一源码范围若已 build，可直接 `node scripts/run-research-p0.mjs` 复用该产物，
记录实际选择，避免无理由重复。真实 full Eval 与新增 E2E 入口在 S01/S07 创建，
本阶段执行其具体命令并保留日志。
原生资源/打包测试涉及生成物和宿主依赖，按脚本核实目标，不改用户系统安全设置。

## 接受标准和发布决定

AC-01～18 主线全部按范围验收。最终报告必须分开：

| 范围 | 通过所需证据 | 缺条件时 |
| --- | --- | --- |
| 工程 | 当前 build、unit/renderer/native、故障/攻击、E2E、迁移、packaging | 报具体失败与受影响模块 |
| 科学 | 独立 corpus、受控真实模型、盲审、统计与任务族质量 | 工程可完成；科学未完成，不能默认发布承诺 |
| 外部 | 真实账号/服务/数据/许可范围的互操作记录 | 本地 fixture 通过；外部未运行 |
| 正式发布 | 具体应用产物、发布目标和授权、版本/数据恢复办法 | 产物准备完成；未发布 |

本轮主线无需 S09 实验树/远程后端。G-E 决定后续立项价值，
不能将 P2 尚未立项算作本地工程失败，也不能将缺少科学验收算作总体完成。
