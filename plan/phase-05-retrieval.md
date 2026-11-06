# S05：冻结多视角检索、来源身份与证据重排

优先级：P1。依赖：S01 评测协议、S02、S03。
来源：WP-04、RH-10/RH-11。实施状态：pending。建议时间：第 7～10 周。

## 目标与关口

用研究问题驱动可批准的检索视角，在固定范围内融合与重排 evidence。
查询不因 worker、重试或模型建议扩张，检索回执记录真实 partial coverage。
新检索合同整体切换；排序实验在隔离评价中选择，不保留旧检索系统。

## 当前起点

- [search plan schema](../src/shared/schemas/research-search-plan.ts)当前最多 3 个查询、
  总候选预算最多 60；多视角设计必须纳入这些真实限制。
- [literature fusion](../src/main/plugins/research/literature-fusion.ts)、
  [search ledger](../src/main/plugins/research/literature-search-ledger.ts)、
  [review search service](../src/main/plugins/research/review-search-service.ts)已有排序和执行回执。
- [retrieval evaluation](../src/main/plugins/research/literature-retrieval-evaluation.ts)
  与当前 benchmark 可作为确定性评价起点。

## 按顺序执行

- [ ] **RH-10.1 Perspective Plan**：明确 question/version、视角理由、query ID、
  具体 provider/filter/pagination/request cap、候选/费用上限和预期证据类型。
  视角可共用获批 query，不强制六个视角或擅自将 query cap 从 3 放大。
- [ ] **RH-10.2 人工冻结**：新目标 plan schema 给每个 query 稳定 ID，
  审批绑定 exact serialized plan/hash 和范围；如需改变上限，先定义新合同和
  用户可审查预算，再获批，不以视角功能默认扩张。
- [ ] **RH-10.3 唯一 dispatch**：retrieval worker 只执行审批版本内 query ID，
  query/provider/filter/page cap 不匹配就拒绝。新发现提交下一版 draft，
  不修改已批准计划；取消/恢复沿 S02 身份与 receipt。
- [ ] **RH-11.1 Canonical source identity**：DOI/arXiv/PMID 与别名合并沿已有 identity
  repository；标题相近但元数据冲突保留不同来源与冲突记录，不自动造相同版本。
- [ ] **RH-11.2 Ranking receipt**：保存原始 provider 排名、RRF 输入/版本与融合结果，
  evidence rerank 记录 input hash、ranker version、分数理由、locator 与来源版本。
  不改写原始 API 回执，不让 unknown/corrupt 来源静默排进可信 evidence。
- [ ] **RH-11.3 Evidence rerank**：在已有 chunk 上考虑相关性、方法匹配、信息增益、
  反证覆盖、定位和版本。只读 source、排序输出独立；写缓存/索引仍声明真实资源/effect。
- [ ] **RH-11.4 网络合同**：复用当前 cache/rate limit/resource/budget。
  429、provider 失败、分页提前终止、取消、receipt 缺失各有 partial coverage。
  `no results` 与 `not searched` 明确分开。
- [ ] **RH-11.5 公平采纳**：50 个独立问题比较 RRF、RRF+rerank、perspective+rerank，
  同语料、模型、查询数、provider 上限和费用。主指标 Recall@20、nDCG@20、
  Evidence Recall，另报相关作品数、wall time、费用和缺失源。
- [ ] **RH-10/11.6 切换与删除**：一次更新 schema、审批、stage/worker、IPC 和现有
  检索计划审核组件；删除旧 query 无身份执行入口与兼容 serializer。
  评价后只保留采纳策略；RRF 若仍是当前排序组成部分，不因来自旧仓库视为遗留代码。

## 交付物

计划新增 perspective schema、获批 query contract、versioned rank receipt、
evidence ranker 和 retrieval evaluation 用例；改写现有 plan/ledger/fusion 调用方。
数据、模型与论文判断集沿 S01 管理，不建另一份文献正文或 evidence 存储。
给 S06 的 task output contract 明确 query receipt、coverage、source/input versions 和预算引用。

## 删除范围

- 无审批 query ID 的检索执行、自动加查询或改 provider 的分支。
- 旧 plan/schema 双解析、query alias 和 rank receipt 静默改写。
- 泛化网络失败重试、partial coverage 返回“已完成全面检索”的逻辑。
- 无稳定收益的候选 ranker、生产旧/新检索 flag 和任务调试查询。

## 验证

```bash
node --test tests/unit/research-search-plan.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-review-owned-search.test.mjs
pnpm typecheck
pnpm check:ipc
pnpm research:retrieval-eval
pnpm research:local-retrieval-eval
pnpm research:network-bench
pnpm build
```

新增 frozen query/version/query cap、429/partial、同论文 alias 冲突、
来源变化后 rerank 失效和未批准视角真实 dispatch=0 检查。
现有 retrieval eval 若仅 fixture/固定 rubric，报告为 L1；独立科学指标走 S01 L2。
检索 UI 有变化运行现有 renderer search-plan 专项，完整布局在 S07 检查。

## 接受标准与下一步

AC-09 成立；所有排名可回查原始回执和当前源版本。
新策略只有在质量非退步和预算公平成立时采纳，无法证明收益时删除候选实现。
通过 G-C，S06 在获批 query/input/output 合同上构造有限依赖任务。
