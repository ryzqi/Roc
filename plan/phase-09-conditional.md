# S09：条件立项的实验树与远程 Workspace

优先级：P2。依赖：S08 与具体需求/预算/隔离/材料条件。
来源：WP-09、WP-10 Remote 部分、RH-20/RH-21。
实施状态：in_progress（设计）。2026-11-07 用户要求“开始 S9”；已启动条件审查、
分支合同设计与 Remote RFC，尚未满足真实实验/后端实施条件。不属于 S00～S08 主线完成条件。
建议时间：独立排程，实验树约 3～5 周，远程后端另估。

当前交付：[启动报告](s09-execution-report.md)、[RH-20 分支设计](s09-experiment-tree-design.md)、
[RH-21 Remote RFC](s09-remote-workspace-rfc.md)。两轨均为 Designed，产品实现与实际运行
尚未验收；以下复选框仍表示完整实现/实证，不把文档设计勾为完成。
用户已确认暂不真实实验，远程目标暂未确定、先完成 RFC；本次范围为设计与缺口审查。
文档交付状态：`Verified passing`，链接、命令引用与范围检查证据见启动报告。

## 立项条件

实验树与远程后端分别决定，不能因完成 DAG 自动启用两者：

| 条件项 | 必需证据 |
| --- | --- |
| 两分支实验树 | 具体研究问题、已批准方法/指标/数据、用户预算、隔离资源、已验收 Experiment receipts |
| Remote/Container | 当前 local backend 无法满足的 Linux/GPU/隔离需求、具体 runner/账号、数据传输与费用范围 |

条件不足保留立项说明，不写默认开启、mock 成功或无用 backend 抽象。
研究助手仍为执行入口，复用 S06 scheduler 和现有 Experiment/Effect/Budget owner。

## RH-20：受限实验探索树

- [ ] **RH-20.1 分支合同**：hypothesis、parent node、批准方法、
  code/environment/dataset versions/hash、seed、metric、停止条件、
  budget reservation、所有输出/negative result/失败原因。
- [ ] **RH-20.2 初始边界**：先两个候选分支，固定总节点/深度/宽度和耗时/费用；
  后续扩展需评价和新的明确批准，不把普通写作/检索改成无限树搜索。
- [ ] **RH-20.3 执行**：通过已验收 Experiment Service、当前 scheduler、grant、
  resource admission 和 Effect store。生成代码必须在受控环境执行，
  不走任意宿主 shell；共享数据/输出 scope 按真实资源锁隔离。
- [ ] **RH-20.4 选择依据**：实验前冻结 metric、对照、停止和选择规则，
  best-first 仅按真实指标/成本/信息增益，不按模型“有趣”主观分。
  保留全部失败与负结果，禁止只导出胜出分支。
- [ ] **RH-20.5 高风险批准**：高成本或新风险 branch 显示具体代码/数据/环境/
  预算与 effect；超预留停止。原方法批准不允许自动无限补分支。
- [ ] **RH-20.6 Repro bundle**：复用 Notebook/实验比较/图稿 provenance/RO-Crate，
  区分 byte reproducibility、容差内功能复现、统计复现与不可核验。
- [ ] **RH-20.7 删除切换**：候选比较沿同一实验执行服务；
  删除 pilot 临时执行、mock 指标和未经采纳的搜索算法，不保留旧实验 Runtime。

交付：branch schema、有限探索 policy、真实两分支比较、完整失败/负结果、
用户批准与预算 receipt、复现 bundle 和独立科研评价。

验证：固定输入/环境重复实验符合预注册容差；branch crash/restart 不重复 effect；
取消无残留 child；超预算和越权实际 dispatch=0；负结果可进入 export。
运行现有 `pnpm test:research-resources`、`pnpm test:research-native-code`、
`pnpm test:research-p0` 与新增 branch/E2E 检查，再做获授权真实实验。

## RH-21：必要时 Remote/Container Workspace RFC

- [ ] **RH-21.1 需求证明**：测 local 不足的 workload/资源/隔离条件，
  写预期质量、费用、启动、数据传输与恢复收益，指定实际目标 backend。
- [ ] **RH-21.2 最小接口**：read/write/exec/inspect/snapshot/restore/limits；
  必须有真实 backend 能力，不写空 stub 或成功形 unsupported 返回。
- [ ] **RH-21.3 可信 task manifest**：服务端只接受精确 hash 的任务/输入/授权，
  独立凭证、受控网络、最小 scope；不暴露本机用户目录或继承父代理广权限。
- [ ] **RH-21.4 状态与 Effect**：复用原 operation/request identity，对 network timeout/
  receipt lost 先对账；服务端取消和实际结果验证可复查，不盲目重新远端提交。
- [ ] **RH-21.5 数据与费用**：明确上传对象、许可、目标、最大量与费用 hard cap；
  snapshot 不含秘密，真实传输/部署需要覆盖目标的授权。
- [ ] **RH-21.6 验证后切换**：新 backend 经过真实任务、sandbox、资源与恢复检查，
  当前接口用明确 backend 类型选择。合法 local/remote 实现是产品能力，
  不保留被替代的 legacy backend 或失败时偷偷转 trusted host。

RFC 是首个交付，不自动授权远端部署。通过 RFC 与具体实施授权后才写真实 backend。
Kubernetes、多租户和服务集群不随本任务自动进入范围。

## 接受标准

RH-20 与 RH-21 分别写 `未立项 / Designed / 工程验证 / 科学验证 / 外部验证` 与证据；
正式工作报告使用仓库规定的范围状态。
任一 pilot 必须满足主线 identity、approval、Effect、预算、取消、单壳和来源合同。
证据不足删除失败候选或关闭具体能力，不恢复旧执行路径。
