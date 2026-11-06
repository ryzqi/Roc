# S01：统一评测系统、独立数据与受控模型合同

优先级：P0。依赖：S00。来源：WP-02、RH-04/RH-05。
实施状态：`Verified passing（工程 L0/L1）`；S01 总体 in_progress，
科学数据/双审/L2/盲审未运行、`insufficient`。工程建议时间：第 1～4 周；数据工作贯穿 S08。

## 目标与关口

将现有 pilot-only 合同重构为可运行 fixture/pilot/full 的单一评测系统。
建立真实独立样本和盲审，后续算法以同一评价器采纳。
工程合同完成可解锁本地开发；科学验收另需真实数据和费用授权。

## S00 固定起点

S00 基线的 Task 合同仅 16 个 L1 pilot，所有任务 `split: pilot`，没有 live adapter。
当前 [Task.md](../scripts/harness-eval/quality-evaluation/Task.md)已记录 S01 新合同及限制。
[protocol.ts](../scripts/harness-eval/quality-evaluation/protocol.ts)已有协议锁，
[runner.ts](../scripts/harness-eval/quality-evaluation/runner.ts)已有 journal/预算调用边界，
[statistics.ts](../scripts/harness-eval/quality-evaluation/statistics.ts)已有配对统计。
不能把这套基础再列作全新 Runner。

## 按顺序执行

- [x] **RH-04.1 数据合同切换**：将 `data.ts` 的硬编码 pilot 数据依赖替换为显式版本化 dataset
  输入；schema 包含 task family、难度、source cluster、许可/归属、输入 hash、split、
  reviewer/review status、隐藏期望 ref。缺字段直接拒绝，无默认 16 项数据兜底。
- [x] **RH-04.2 单一 Runner**：重构现有 runner/protocol/validator/statistics 接收同一
  frozen dataset；明确 fixture、L2 pilot、L2 full 的证据等级和数量条件。
  删除 `fullDatasetReady: false` 和 pilot-only dispatch 的硬编码分支。
  不新建另一套 journal 或统计器。
- [x] **RH-04.3 隐藏评估边界**：Agent 仅收到 AgentTaskView，不能读 expected facts、
  validator、cluster、split 和 reviewer。
  全量模式需要实际进程/文件/工具访问隔离；只从 JS 对象删字段不算防泄漏。
- [x] **RH-04.4 留存 fixture**：原 16 项移到测试/离线 fixture dataset，沿同一新合同运行，
  明示 synthetic/contract-only；不计入独立 200 项完成数，不保留旧 production runner。
- [ ] **RH-05.1 标注规范**：按[验收矩阵](acceptance.md)八族配额收集 200 项，
  每族至少五个独立来源簇。来源簇先确定再划 split，标注前预注册具体分配。
- [ ] **RH-05.2 科学双审**：科学主张支持、条件、矛盾、无关和无法核验由两位独立审核者
  标注，保留原文 locator、分歧及仲裁；不让 writer 模型自评成为 gold。
  首批 30～50 条 claim 可供 S04 pilot，完整样本持续补齐。
- [x] **RH-05.3 真实 Harness adapter（本地合同）**：连接当前 application Harness 和隔离配置，
  同时约束模型、summary、child、verifier、tool、retry 费用。
  运行前 host 锁定报价/硬上限与实际 provider 标识，journal 落盘后 dispatch。
  无费用 transport 已验，真实 provider 强制和八族 effect 环境尚待独立验收。
- [x] **RH-05.4 公平实验（工程协议）**：冻结 baseline/candidate SHA、输入、模型、工具、权限、环境、
  temperature、次数、价格版本；配对随机化顺序。失败留分母，成本未知保留占用。
- [ ] **RH-05.5 科学报告**：生成配对区间、任务族回退、失败分类、人类盲审和未知费用报告，
  加入 claim/retrieval/context/DAG 专项实验索引，不重复计独立来源数。

RH-05.1/2/5 的标注手册、manifest/双审/仲裁/报告及专项索引模板已交付，
机器统计实现已完成；真实样本、人工审查和科学实验仍未运行，不勾选完成。

## 已交付

在现有 `scripts/harness-eval/quality-evaluation/` 增加 dataset schema/loader、
application adapter 和 dataset audit，改写现有 protocol/runner/validator/statistics。
评估期望存储与 agent 可见输入分离，真实私有数据放受控本地数据目录，不直接提交仓库。
合规可分发小样本可以版本化；大 corpus 用 manifest/hash/许可与审核记录定位。

已交付 `plan/evaluation-protocol.md`、待填写 manifest、标注手册、盲审/仲裁、
pilot/full 报告模板和授权需求清单；机器结果存 `.artifacts/research-harness/S01/`。
没有将模板或 contract doubles 标成真实 corpus/科学报告。

## 删除范围

- 硬编码 pilot-only 数据、输入和状态判断。
- 为旧 runner/protocol API 保留的 overload、adapter、alias 与默认 fixture 回退。
- 把 fixture 结果当科学质量或 provider 费用的报告字段。
- 临时模型调用脚本、可从 agent 读取隐藏期望的测试入口。

统计原则和有效 fixture 回归继续沿新合同运行。

## 验证

现有命令：

```bash
pnpm typecheck
pnpm harness:quality:check
node --test tests/unit/quality-evaluation.test.mjs
pnpm harness:eval
```

新增有意义的回归覆盖：来源簇跨 split 泄漏、许可/审核不足、dataset hash 变化、
agent 读取隐藏期望、同协议重复 journal、真实 dispatch 前预算不足、取消未确认、
报价超限、失败分母与未知费用。实际 adapter 使用无费用的本地测试 transport 先验收。
L2 有明确目标和授权后再用真实 provider；没有授权不试探用户现有凭证。

## 接受标准与下一步

AC-15/16 分两栏报告：

- 工程：数据 schema、唯一 runner、隔离、journal、预算与统计通过 L0/L1。
- 科学：200 独立样本、完整审核、受控 L2 和盲审报告，不足标 `insufficient` 或未运行。

S03/S05 可使用工程协议；S04 语义 pilot 需最小独立 claim 集。
没有完整科学证据，S08 不能宣称默认科研质量已验收。

## 本轮工程结果（2026-11-06）

- 显式 loader/schema/hash、split/来源/许可/双审元数据及隐藏路径 containment 成立；
  原 16 项 prompt、期望、来源记录和文章归属完整保留，全为 fixture。
- 同一 runner/protocol/statistics 已覆盖 fixture/pilot/full，旧生产 API 零引用。
- 无费用真实 application Harness、文件/进程/网络拒绝、持久 journal、请求上限、
  费用异常、取消与清理回归通过。统计补测保留完整 holdout 身份和任务族非劣关口。
- `pnpm typecheck`、`pnpm harness:quality:check`、`pnpm test:unit`（1481 pass）、
  `pnpm harness:eval`（94/94）、`pnpm build` 全 exit 0。
  最新专项 30 pass；之后新增统计断言的 dataset 专项 6 pass。
- 精确命令/cwd/时间/SHA/log hash 见
  [engineering-verification.json](evaluation/engineering-verification.json)；
  原始证据在 `.artifacts/research-harness/S01/2026-11-06T11-24-16.346Z/`。

限制：真实终态会带 context 前缀而失败 JSON 校验，本轮保留失败且未改生产输出。
空 MCP/Skill/外部 workspace 配置不能验真实 effect 或跨会话恢复；
实际 provider 强制、200 独立样本和人类科学双审/盲审未运行。
S02～S09 未启动。本轮仅提交已验证的 S01 工程合同。
