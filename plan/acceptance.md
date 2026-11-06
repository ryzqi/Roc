# 验收、工作包追踪与证据矩阵

本文件中的命令是后续执行入口，不表示本轮已运行。阶段任务详见对应阶段页。
全部命令默认从 `/Users/Apple_501/Desktop/Roc/Roc` 执行，物理路径为
`/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`。

## 1. 来源工作包与任务全覆盖

| 来源 | RH 任务 | 执行阶段 | 必须交付 |
| --- | --- | --- | --- |
| WP-00 | RH-00、RH-01 | S00 | 当前能力/依赖/表/消费者清单、基线、ADR 和删改计划 |
| WP-01 | RH-02、RH-03 | S02 | 新事件合同、因果关联、三种回放、故障与脱敏诊断 |
| WP-02 | RH-04、RH-05 | S01；S08 闭环 | 统一数据/runner、独立标注、冻结协议、A/B 和盲审 |
| WP-03 | RH-06、RH-07 | S04；S07 UI | 只读语义建议、来源失效、反证和人工核验 |
| WP-04 | RH-10、RH-11 | S05 | perspective plan、冻结审批、Evidence rerank 和公平比较 |
| WP-05 | RH-08、RH-09 | S03；S04 方法规则 | 11 阶段必填 Manifest、权限交集、质量门与许可核对 |
| WP-06 | RH-12 | S03 | 唯一 context assembly、事实冲突、证据安全压缩和长任务评价 |
| WP-07 | RH-13、RH-14、RH-15 | S06；S07 UI | DAG、CAS lease、fencing、有限 worker 与取消恢复 |
| WP-08 | RH-09、RH-16 | S04 | 独立 Reviewer、finding、修订和人工决定闭环 |
| WP-09 | RH-20 | S09 条件项 | 两分支实验树、负结果、预算与复现包 |
| WP-10 | RH-17、RH-21 | S02 边界；S07 攻击；S09 RFC | 权限矩阵、真实 sandbox/effect 验证；必要时远程方案 |
| WP-11 | RH-18 | S08 | 真实资源/许可证/版本导出闭包及独立发布批准 |
| WP-12 | RH-15、RH-07 | S07 | 管理任务抽屉、助手卡片、现有工件检查器与诊断 |
| 全部 | RH-19 | S08 | 固定 SHA 整体回归、科学评价、打包、迁移与完成报告 |

RH 编号沿用来源，不代表已有 Issue、PR 或 Git 提交。
S09 不纳入本轮主线完成率；必须有独立需求和条件后才能启动。

## 2. 核心接受标准

| ID | 接受标准 | 主阶段 | 检查证据 |
| --- | --- | --- | --- |
| AC-01 | 没有第二个 Runtime、Task DB、Effect store、预算 ledger 或执行入口 | S00/S02/S06 | 所有权清单、调用图、diff 和结构检查 |
| AC-02 | 当前版本只有一套接口/状态/Skill 加载，被替代路径全部删除 | 各阶段/S08 | 旧符号零引用、删除清单、生成 IPC 一致 |
| AC-03 | 跨项目、归档、伪造主体、过期审批不能改变真实状态/effect | S02/S07 | 实际执行边界 integration 和攻击日志 |
| AC-04 | 同版本恢复延续身份；未知 effect 先对账；重复 receipt 不重复提交/计费 | S02/S06 | crash/reopen/receipt/预算 digest |
| AC-05 | Chat/Task/科研事实可关联；有界 replay 的 gap 真实可见 | S02/S07 | 固定投影 hash、缺包/重排/裁剪检查 |
| AC-06 | 引用键、来源版本、locator、数值映射和人工关系确定性检查全过 | S04/S08 | 引用/evidence/export 专项测试 |
| AC-07 | 模型建议不能覆盖人类审核；来源或文稿变化令建议失效 | S04 | verdict hash、失效事件和人工路径 |
| AC-08 | 11 个内置 Skill 都有合法必填 Manifest，文本不扩权 | S03 | Manifest validator、grant 交集、许可/hash 检查 |
| AC-09 | 未批准 query 实际 dispatch 数 0；部分检索不伪装完整覆盖 | S05 | request ledger、冻结请求 hash、provider fault 回执 |
| AC-10 | DAG 无环、同根任务、最多一个有效提交者、旧 lease 回传拒绝 | S06 | SQLite 竞争、expiry、late result、cancel/restart |
| AC-11 | 压缩不丢硬约束/人工决定；失效事实不能作为有效 evidence | S03 | 长任务恢复、来源变化和摘要篡改检查 |
| AC-12 | 预定义攻击样本的真实未授权 effect 数 0，覆盖边界明确 | S07 | 路径/进程/网络/远端动作 sentinel 与 receipt |
| AC-13 | 单一壳、任务只在管理抽屉、懒加载、键盘焦点及迟到响应正确 | S07 | Electron 行为、截图、布局、chunks check |
| AC-14 | 真 ZIP 资源/hash/许可闭包；本地导出不自动发布 | S08 | archive readback、闭包 manifest、远端 dispatch=0 |
| AC-15 | 200 条独立合规样本、来源簇隔离、科学双盲审查和可复查仲裁 | S01/S08 | corpus manifest、hash、审查及 split audit |
| AC-16 | A/B 固定模型/预算/环境，失败留在分母，成本未知保持未知 | S01/S08 | protocol lock、runner journal、统计报告 |
| AC-17 | 新 schema 升级与匹配版本冷恢复实测，用户文件未被删除 | S02/S08 | backup/restore hash、行数/引用映射、workspace sentinel |
| AC-18 | 工程、科学、外部、发布分开报告，不把历史记录当本轮结果 | S08 | 完成报告的四种证据字段 |

## 3. 分层检查与当前命令

以下入口均已对照当前 `package.json` 或现有路径定位。
未来新增 `check:skills`、full quality runner、专项 DAG/semantic/security 测试属于阶段交付，
不能在创建之前列作已通过命令。

| 层 | 当前命令 | 使用范围 |
| --- | --- | --- |
| L0 | `pnpm typecheck` | TS/共享合同/调用方改变 |
| L0 | `pnpm check:ipc` | registry、preload、生成 schema 改变 |
| L0 | `pnpm check:renderer-chunks` | UI、懒加载、共享 import 改变 |
| L1 | `pnpm build` | 跨层、打包资源、启动合同或业务运行测试前 |
| L1 | `pnpm test:unit` | 每次共享状态/数据/权限切换后及 S08 |
| L1 | `pnpm test:renderer` | UI 变更及 S08；发生资源竞争时记录串行条件 |
| L1 | `pnpm harness:eval` | Runtime、预算、context、Skill、effect 改变 |
| L1 | `pnpm harness:quality:check` | 数据/评测合同；不证明科学质量 |
| L1 | `pnpm research:retrieval-eval` | 学术检索排序合同 |
| L1 | `pnpm research:local-retrieval-eval` | 本地 evidence 检索合同 |
| L1 | `pnpm test:review-workflow` | 审稿、修订、证据和 workflow 集成 |
| L1 | `pnpm test:research-resources` | 资源准入、进程、取消 |
| L1 | `pnpm test:research-environment-boundaries` | 原生/Julia 环境边界 |
| L1 | `pnpm test:research-native-code` | 实验源码/输入/收据完整性 |
| L1 | `pnpm test:research-p0` | 包含 build 的当前生产原生路径 |
| L1 | `node scripts/smoke-electron.mjs` | 使用本阶段 build 的启动/renderer 错误检查 |
| 性能 | `pnpm research:retrieval-bench`、`pnpm research:network-bench` | 检索、provider partial/cancel/rate limit |
| 性能 | `pnpm research:graph-bench`、`pnpm research:admission-bench` | DAG/资源与关联消费 |
| 性能 | `pnpm research:storage-bench`、`pnpm harness:resource-bench` | 持久化/资源共享风险 |
| 打包 | `pnpm package:dir`、`pnpm smoke:mac` | S08 包构建与实际 macOS .app smoke |
| 打包 | `pnpm verify:native-packaging`、`pnpm verify:arm64-only`、`pnpm verify:paths` | S08 原生依赖、架构和路径 |

阶段先跑相关专项用例，共享风险才扩全量。通过的检查不因写文档重复；
新变更、失败或未解决疑点才触发重跑。原生 integration 对安装/宿主要求需读其实际脚本。
`pnpm test` 已聚合 unit、renderer 和 Electron smoke；使用聚合命令时不再无理由重复三者。

## 4. 科学数据与实验协议

质量任务总额 200，八族配额固定：

| 家族 | 数量 |
| --- | --- |
| 文献核验 | 30 |
| 多论文证据 | 30 |
| 长记忆 | 25 |
| 文件/报告 | 30 |
| 实验脚本 | 25 |
| MCP 恢复 | 20 |
| 权限注入 | 20 |
| 取消/崩溃 | 20 |

同论文改写、同模板换数字不能作为独立来源簇。科学家族用真实可核验材料；
操作家族可使用独立设计的故障场景，但必须标明 synthetic，不当作科学蕴含证据。
每族至少五个独立簇；具体 split 在标注前预注册，按来源簇划分，不按题目随机混合。
保留 pilot 作为 L1 fixture，不计入独立 200 任务的已完成数。

专项实验目标：300 条 claim、50 个检索问题、25 个长任务、30 个调度任务、
100～200 个攻击样本。它们不是与 200 任务相加的独立任务数；
manifest 明示抽样、嵌套关系和独立统计单位。样本数不足输出 `insufficient`。

A/B 起始协议沿用已存在统计规则：每任务三次配对重复、按簇 bootstrap 2,000 次、
95% 区间、非劣界 0.05；采纳前按任务风险、功效与预算预注册调整，
不能看结果后更改。检索等额查询/费用，调度比较 concurrency=1/2 的同一新调度器。
所有失败、空输出、超时和未决对账保留在分母，另列失败分类。
先满足安全与确定性正确，再满足科研质量非退步，最后讨论耗时/费用收益；
“耗时下降 20%”是探索目标，不是未测发布承诺。

L2 前锁定模型、价格/硬费用上限、隔离凭证、工具、数据、应用 SHA、最大请求和授权范围。
缺费用硬上限不 dispatch。L3、外部互操作和发布各有单独目标/账号/内容授权。

## 5. 验收材料和记录格式

实施后证据统一存入 `.artifacts/research-harness/<stage>/<timestamp>/`；
仓库计划记录相对证据路径和摘要，不把真实凭证、隐私原文或用户目录写入计划。

每条检查记录：

```text
阶段 / RH / AC:
开始与结束 SHA:
工作目录、宿主、Node/pnpm/Electron 版本:
完整命令、开始时间、结束时间、退出码:
成功/失败/跳过/取消数量:
数据/模型/Skill/规则/protocol hash:
日志/截图/receipt/report 路径与 SHA-256:
实际结果、限制、未完成条件、下一步:
```

阶段完成附代码删除清单、schema/IPC 变化、迁移和冷恢复证据。
L2/L3 附独立标注/盲审和真实 provider 费用报告，未运行明确写出。
工程检查通过而科学证据缺失时只写 `Verified passing（L0/L1）`，不标总体完成。
