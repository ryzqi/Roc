# P1：统一科研检索

新增 `research.knowledge.scientificQuery`，RAG Studio 与 Scientific Agent 共用协调器。
既有普通资料与六通道科学检索仍保留；明确论文范围或未解析的 DOI 不回退为全项目检索。
每轮返回原封不动的搜索收据，后续上下文和证据校验仍重建原对象、核对当前源文件及项目授权。
合并结果附带稳定 ScientificSourceRef、轮次、停止原因与降级原因。

简单问题使用确定性规划。复杂问题最多一次模型补充、两轮默认检索（合同硬上限三轮），
按候选总预算、查询去重、零增益与 20 秒协调预算停止。中文检索使用 ICU 分词与有界双字词。
候选按论文、对象和意图保留覆盖；精排超限只跳过该对象，不截断公式、表格或原始条件。
配置在精排期间改变会拒绝结果。上下文扩展保留实验条件、变量定义及局限的原始定位。

界面保留既有桌面布局与键盘/输入法保护，科学对象可打开对应解析版本。
科学候选 ID 不进入旧 chunk 捕获接口；应在阅读器核验来源后捕获稳定 Evidence。
Agent 单次搜索句柄只能在本次运行使用，跨会话需使用来源身份及正式 Evidence。

## 验证

工作目录：仓库根。工程回归使用隔离 SQLite、真实 PDF 字节与受控解析对象/模型响应，
不属于独立人工科学 gold。

- `node --test --test-concurrency=2 tests/unit/scientific-query-planner.test.mjs tests/unit/scientific-query-planner-stream.test.mjs tests/unit/scientific-fusion.test.mjs tests/unit/scientific-reranker.test.mjs tests/unit/scientific-retrieval.test.mjs tests/unit/scientific-context.test.mjs`：36 项通过；新增计划预算上限后 context 9 项通过。
- `node --test --test-concurrency=2 tests/unit/scientific-query-orchestrator.test.mjs tests/unit/scientific-evidence.test.mjs`：14 项通过，覆盖范围隔离、过期拒绝、截止预算及真实 Agent 调用。
- `node --test --test-concurrency=1 tests/renderer/retrieval-workspace.test.mjs tests/renderer/desktop-action-guards.test.mjs tests/renderer/literature-workspace-layout.test.mjs`：23 项通过；增加科学对象身份回归后检索界面 9 项通过。
- 预算修复后的 `node --test tests/unit/scientific-evidence.test.mjs tests/unit/scientific-query-planner.test.mjs`：20 项通过。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 与 `node scripts/generate-ipc-schema.mjs --check`。

尚无独立金标或真实模型对照，不能宣称 Recall、精排准确率或问答质量提升。
原有 P0 全量测试的三项已确认历史失败保持记录；本阶段不将其改写为通过。
