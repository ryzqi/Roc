# 主线最终分项验收

日期：2026-11-07。状态：`Verified passing`（S08 本地工程）。
S02～S07 已提交，S08 起点 `0734156e5f50726a66c2dccc68ecc1f3f263d9ed`。
S08 工程与材料已完成，随本文件提交；S01 科学验收未完成，S09 未立项。
本文件不代表总体完成或发布批准。

## 范围结论

| 范围 | 已有证据 | 尚缺条件 |
| --- | --- | --- |
| 本地工程 | 最终 build/typecheck、1590 unit、94 harness、P0 19/19；452 renderer 冻结基线及受影响界面 10/10；真实 ZIP、迁移/冷恢复；最终包 full smoke 14/14 + 62/62、原生 smoke、arm64 20/20、PDF 与 50 布局状态 | 工程关口通过；原生 OS IME 尚未手工验收，现有覆盖为合成事件 |
| 科学 | 数据格式、冻结协议、审查/统计 runner 与合成工程案例 | 独立语料 0/200；独立双审/仲裁、专项实证和受控 live A/B 未运行，无科学收益结论 |
| 外部互操作 | 本地合成 provider、协议故障与审批/拒绝 fixture | 真实账号、服务、材料许可与具体目标授权未齐；未执行真实远端写操作 |
| 正式发布 | arm64 本地候选包、许可/隐私说明、升级和冷恢复手册 | ad-hoc 签名；未 notarize、上传或发布；发布需独立目标授权及适用验收 |

## 接受标准逐项映射

以下“通过”限对应工程证据。S02～S07 报告是已提交阶段的历史证据，不冒充本轮全量复测；
S08 日志与源码 hash 给出本轮覆盖和冻结后变化。

| AC | 结果与证据 |
| --- | --- |
| 01 唯一执行所有权 | 工程通过；[S02](s02-execution-report.md)、[S06](s06-execution-report.md)、本轮 harness / workflow |
| 02 单一合同/删除 | 工程通过；[删除台账](deletion-ledger.md)、S08 deletion-audit.json、IPC/build；有效 DAG 关联入口不误删 |
| 03 项目/审批隔离 | 工程通过；[S07 权限矩阵](s07-permission-matrix.md)、[S07 报告](s07-execution-report.md)、本轮 native / 最终 P0 19/19 |
| 04 恢复/回执/预算 | 工程通过；S02/S06、S08 原生故障分轮补验、最终 P0 19/19、真实迁移/恢复及最终包强制崩溃续跑 |
| 05 关联与有界回放 | 工程通过；S02、当前 P0 分页 gap 校验、P4 2439 事件 / 13 页与 516 消息虚拟化 |
| 06 确定性引用/人工关系 | 工程通过；[S04](s04-execution-report.md)、本轮 unit/workflow/P0 真实 ZIP |
| 07 模型建议/人工权威 | 工程通过；S04 与 S08 当前性封存；新增来源使建议失效，不能沿用旧导出审批 |
| 08 必填 Skill/权限交集 | 工程通过；[S03](s03-execution-report.md)、本轮 unit/harness；历史执行 pin 保留 |
| 09 冻结查询/部分检索 | 工程通过；[S05](s05-execution-report.md)、本轮 P0 provider partial 与 unit |
| 10 DAG/lease/fence | 工程通过；S06 SQLite 竞争和恢复证据、本轮 unit/workflow/P0 |
| 11 上下文/证据失效 | 工程通过；S03 与本轮 unit/harness；独立长任务科学比较未运行 |
| 12 攻击边界 | 已提交 S07 156 场景分轮通过：126 攻击 + 30 控制；本轮 native/P0 相关回归；不声称未知攻击全防御 |
| 13 单壳/桌面交互 | 已提交 S07 与最终包 50 布局状态、原生 smoke、packaged 14/14 + 62/62；原生 OS IME 未手工验收 |
| 14 导出闭包/不自动发布 | 工程通过；validation v1 / manifest v4、真实 ZIP 逐成员 size/hash 回读、metadata-only 和人工处置；外部发布未运行 |
| 15 独立语料/盲审 | 未通过：0/200，缺独立材料及双审/仲裁；[数据准备情况](evaluation/scientific-readiness.md) |
| 16 受控科学 A/B | 协议/runner 工程通过，实证未运行：缺数据、锁定模型/费用与授权；合成 fixture 不计科学样本 |
| 17 迁移/冷恢复 | 工程通过；真实 S05 9d16212d 应用 agent20/research63 → 21/64 → 匹配旧版；七库、原事件、1 effect/6 budget 和 workspace sentinel 保持一致 |
| 18 分项报告 | 本文件、[S08 报告](s08-execution-report.md) 与 [操作手册](s08-release-handbook.md) 区分工程、科学、外部和发布 |

## 本轮证据与版本边界

证据根：`.artifacts/research-harness/S08/`。

- `2026-11-07T06-12-06.038Z/verification.json`：1524 个源码 hash，采集期间无变化。
  原生 35/36、P0/smoke 因 Electron 安装缺失未启动，因此原报告保持 failed。
- `native-cancellation-recheck.log`：原样失败用例 1/1。`p0-recheck.log`：17/19；
  两个冷重开夹具采用生产连接初始化后 `p0-restart-fixed.log` 2/2。
  后续最终源码完整 P0 19/19 通过（six-verdict-p0.log）；原失败与补验均保留。
- `migration-app-2026-11-07T06-51-04.282Z/report.json`：真实旧/新/恢复旧 Electron；
  历史故障终态也完整保存，迁移不被解释为该科研任务成功。
- `dist-full-smoke/p4-gates/report.json`：62/62，默认播种 250 轮，累计 516 消息；
  审批、取消、提问、项目/组件恢复、强制崩溃后工具恰好一次。
- `mac-candidate/result.json` / `arm64-candidate/report.json`：中间候选包
  `release/s08/mac-arm64/Roc.app`，原生 smoke 通过，arm64 20/20。
- `layout-packaged-before-dependency-fix/layout-audit.json` 与
  `packaged-pdf-2026-11-07T06-57-20.415Z/report.json`：首包的 50 布局状态和真实编译
  PDF protocol/正文/图表。六结论最终包已重建到 release/mac-arm64/Roc.app；
  包含 schema/Skill/UI变化，首包证据不计入最终包覆盖。
- 最终源码：`six-verdict-unit-all.log` 1590/1590，`six-verdict-unit.log` 42/42，
  `six-verdict-renderer.log` 10/10，`six-verdict-p0.log` 19/19，harness 94，IPC/chunks 通过。
  `package-final.log` 包含 build/typecheck；11 份 Skill 为 1.3.0，输出 schema v4。
- 最终包：`packaged-final-full-smoke/` 基础 14/14、P4 62/62；
  `mac-final/`、`arm64-final/`、`layout-final/`、
  `packaged-pdf-2026-11-07T07-26-20.207Z/` 分别保留原生、架构、50 状态和 PDF 证据。
  用户逐次允许系统钥匙串访问后，真实 SIGKILL 恢复完成且工具恰好执行一次。
  布局首轮失败及显示器事件复现保留；最终审查用渲染视口模拟，原生最小宽度仍受检。
- `final-verification.json`：实际命令/退出码、当前源码和证据 hash、最终包内容摘要、
  失败与补验关联、未完成条件。状态为 `Verified passing (local engineering only)`。

## 后续条件

本地工程按已有授权提交，不推送、不发布。独立科学验收仍需 200 份独立样本、
双审/仲裁及锁定模型、费用和执行授权；真实外部互操作与正式发布需对应目标授权。
这些条件未补齐前，不将全部主线标记完成，不启动条件阶段 S09。
