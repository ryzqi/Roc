# Agent harness：工具、提示词与证据恢复

Roc 的 harness 已有冻结能力清单、主代理/子代理执行范围、工具准入与资源协调、效果幂等、持久恢复和上下文压缩。工具优化应让模型看到的指引与这些运行时合同一致。权限、审批、幂等和验收由运行时执行，提示词只负责帮助模型选择正确的动作。

主要入口是 [run-harness.ts](../src/main/plugins/agent/run-harness.ts)、[context-assembler.ts](../src/main/services/deep-agent/context/context-assembler.ts)、[middleware-stack.ts](../src/main/services/deep-agent/middleware-stack.ts) 和 [agent-builder.ts](../src/main/services/deep-agent/agent-builder.ts)。最终响应格式另见[响应合同](agent-response-contract.md)。

## 工具与提示词合同

| 问题 | 当前合同与落点 |
| --- | --- |
| 通用 coding agent 身份无法准确描述科研工作台 | 身份为科研与工作区助手；行动请求执行到验证，问题直接回答，事实答案保留最小充分证据。 |
| 系统提示重复完整工具描述 | 系统块只列排序去重的工具名与跨工具行为规则；完整描述及参数仍在模型的工具声明中。 |
| 研究提示无条件提到未绑定工具 | 研究、记忆、规划、委派、澄清和工件恢复指引按可见工具名生成；Plan Mode 不注入研究执行块。 |
| 后台工作流可能引导调用缺失工具 | 创建任务必须具备解析时间、提案、提交三个能力；修改/取消指引各自检查工具是否存在。缺少能力时说明限制，不声称执行成功。 |
| 默认文件说明与 Roc 后端不一致 | 文件工具说明明确虚拟路由、搜索语义、分页单位、精确替换与失败恢复，不引导访问框架私有落盘路径。 |
| resolution 失败被标记为 success | 返回 `ToolMessage.status = error`，保留调用标识和 Forge 消息标签，让用量与恢复路径看到真实失败。 |
| 模型接收到未经脱敏的异常文本 | 错误输出复用 Roc 脱敏器；识别到参数解析异常时给出字段修正指引，不附加包装异常中的原始调用参数和栈。 |

提示块由 [prompt-blocks.ts](../src/main/services/deep-agent/context/prompt-blocks.ts) 生成，按静态、能力、工作区、请求排列。工具顺序变化不应改变稳定块；项目绑定的研究指导由工具集合决定。文件、工具结果和旧会话是参考数据，不能扩大权限或覆盖当前任务及运行时政策。

跨工具指导包括：独立只读调用可以并行；依赖前序结果的动作和同一资源的写入应串行；错误后修正输入或方法；结果截断后缩小查询或继续分页。有副作用的动作在超时、取消或响应丢失后，先查实际状态/回执；工具支持请求标识时复用原标识。并行规则是模型指导，运行时资源协调和幂等边界仍负责实际执行。

工具声明由 [framework-capability-middleware.ts](../src/main/services/deep-agent/framework-capability-middleware.ts) 和 [context-artifact-tool.ts](../src/main/services/deep-agent/context/context-artifact-tool.ts) 维护：

| 工具 | 输入与恢复语义 |
| --- | --- |
| `ls` / `glob` | 显式传入 `/workspace/`、`/memory/` 或 `/skills/` 下的 `path`。已知准确文件路径可直接读取。搜索输出过大时缩小范围。 |
| `read_file` | `file_path` 使用虚拟路径。文本 `offset` 为零起始行偏移，默认 0；`limit` 为行数，默认 100。按返回的 `@@` 头部继续读取；头部是元数据，不能复制进编辑内容。 |
| `grep` | `pattern` 是字面子串；`foo\|bar` 不表示二选一。显式指定 `path`，用 `glob` 缩小文件集合，以 `output_mode` 选择路径、行内容或计数。匹配/长行被截断后不能据此声称完整。 |
| `write_file` / `edit_file` | 前者创建或整体替换，后者精确字符串替换。指导模型先检查现有内容、保留无关改动；匹配缺失或歧义时重新读取，不盲目重复编辑。这里的先读要求是指导，不是新增的执行前置锁。 |
| `read_context_artifact` | 使用同一引用中的 `artifactId` 和 `sha256`。`offset`/`limit` 是 UTF-16 字符单位，非行/字节；默认 0/4000，上限 12000。原样传回 `nextOffset`，直到所需证据已读取；`complete=true`、`nextOffset=null` 表示结尾。 |

## 输出完整性、运行中输入与效果恢复

[输出完整性中间件](../src/main/services/forge-guardrails/middleware/model-output-integrity.ts) 覆盖主代理和子代理。它读取 OpenAI/Anthropic 的终止元数据，确知输出截断时先隐藏整批工具提案，避免进入审批或执行，再保留调用 ID 并生成配对错误反馈。文本 rescue 也拒绝截断响应。纠正使用 LangChain 原生模型循环，次数保存在 LangGraph checkpoint；每个执行图在当前 run 最多纠正一次，连续截断终止。缺失元数据保留兼容行为，不能据此宣称响应完整。

助手运行时可发送“纠正当前任务”或“完成后追加”，同时保留停止按钮。纠正进入下一次安全的模型边界；追加等当前图结束后，以新消息继续相同 thread/run，重新经过完整压缩流程。附件与技能选择不属于运行中输入合同。审批与问题回复仍走原有接口。

输入复用 `agent_run_inbox`，类型记录在既有用户消息事件的 `runInput` 字段，不改变数据库 schema。`submissionId` 支持重复 IPC 和失败重试；同一标识的正文或类型漂移会拒绝。inbox、用户事件、会话消息在同一事务提交，完成事务检查未消费输入，封住 final 与入队竞态。`chat.runInputs` 校验 run/thread 身份；UI 的“已送入上下文”仅指已交给模型调用边界，不代表模型已成功处理。

重启后未知文件效果可从运行诊断中“核对文件结果”，再继续原 checkpoint。[核对服务](../src/main/services/deep-agent/effect-reconciliation-service.ts) 当前只支持内置 `write_file`：原子写入预先保存工作区、父目录、暂存文件和目标原像的身份与摘要。发布后的目标 inode/hash 可证明已执行；原暂存文件仍在且目标原像未变才可证明未发布。前者恢复可信结果，后者允许原调用安全重试。旧记录缺证明、路径或内容漂移、其他工具无法核实时保持阻断。UI 和模型均不能自行提交 applied/not_applied。

该路径复用现有效果账本、路径锁、handoff、验收和 checkpoint，不新增执行器、队列或恢复数据库。核对只允许停止的重启中断 run；待审批、身份漂移和未知效果继续阻止恢复。

## 长输出只交给 Roc 保留

Deep Agents 1.17.0 的默认 filesystem middleware 会把超过约 80,000 字符的普通工具结果写到 `/large_tool_results/`。Roc 后端拒绝这个路径；框架随后把原结果替换成落盘失败提示，Roc 的压缩器因而收不到原始证据。这是运行时数据丢失，不能仅靠提示词修复。

能力包装器将框架的 `toolTokenLimitBeforeEvict` 和 `humanMessageTokenLimitBeforeEvict` 设为 `null`，关闭不兼容的工具/用户消息落盘，保持 [ADR 0027](adr/0027-retain-roc-context-compaction.md) 的单一压缩所有权。原始消息进入 Roc 管线，再由 [context-compaction-pipeline.ts](../src/main/services/deep-agent/context/context-compaction-pipeline.ts) 保留大结果、生成带 SHA-256 的线程/工作区引用。禁用恢复工具时，保留步骤不替换大结果；后续摘要和硬预算仍按既有策略处理。

```mermaid
flowchart LR
    T[工具返回原始结果] --> F[文件中间件保留消息]
    F --> C[Roc 上下文压缩]
    C --> S[线程与工作区工件存储]
    C --> M[模型收到预览与恢复引用]
    M --> R[read_context_artifact]
    S --> R
    R --> M
```

关闭框架工具落盘也会关闭其文件页的字符裁切；按行分页仍保留，超长单行交给 Roc 工件恢复，避免截掉无法通过行偏移重新取回的尾部。消息进入压缩前仍占用内存，本次没有新增流式落盘或改变原有硬预算。`grep`/`glob` 等工具自身的输出裁切不变。

模型上下文保留与 UI 事件投影是两条不同路径：[tool-output-projection.ts](../src/main/services/deep-agent/tool-output-projection.ts) 的预览/工件输出不能代替模型的上下文恢复。取消和审批中断继续传播；网络重试仍由既有中间件负责。脱敏沿用已有模式，不代表任意文本中的所有敏感信息都能被识别。

## Codex / pi 对照依据

源码快照于 2026-11-20 固定：Codex `10ca17496f5c934b9cf4baacda95c4a785f95630`；pi-mono `edfe6b2ef32283d31efc9e26db86fe48be19d3b2`。以下为源码观察，未运行上游测试。

| 观察 | 一手来源 | Roc 的取舍 |
| --- | --- | --- |
| 指引随启用工具生成；pi 分开管理 snippet、guidelines、schema | [pi system-prompt](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/coding-agent/src/core/system-prompt.ts#L88-L180)、[Codex spec_plan](https://github.com/openai/codex/blob/10ca17496f5c934b9cf4baacda95c4a785f95630/codex-rs/core/src/tools/spec_plan.rs#L1027-L1074) | 按能力生成指导；名称索引是 Roc 的压缩选择，pi 自身仍使用 snippet。 |
| 执行模式改变时同步改变工具描述和参数 | [Codex exec_command](https://github.com/openai/codex/blob/10ca17496f5c934b9cf4baacda95c4a785f95630/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L275-L303) | 工具声明承担具体操作契约，使用已安装框架的实际字段和默认值。 |
| 分页输出提供明确续读位置；输出预算为元数据保留空间 | [pi read](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/coding-agent/src/core/tools/read.ts#L318-L338)、[Codex context](https://github.com/openai/codex/blob/10ca17496f5c934b9cf4baacda95c4a785f95630/codex-rs/core/src/tools/context.rs#L549-L618) | 明确行与字符偏移；保留 Roc 的作用域、哈希和恢复协议，不复制上游分页起点。 |
| 编辑失败说明需要补充上下文或合并重叠编辑 | [pi edit-diff](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/coding-agent/src/core/tools/edit-diff.ts#L292-L393) | 精确替换前先读，匹配失败后重读；已识别 schema 错误给出输入修正方向。 |
| 并行调度与同资源写入协调分开 | [pi agent-loop](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/agent/src/agent-loop.ts#L518-L532)、[pi mutation queue](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L28-L60)、[Codex parallel](https://github.com/openai/codex/blob/10ca17496f5c934b9cf4baacda95c4a785f95630/codex-rs/core/src/tools/parallel.rs#L332-L359) | 保留现有准入与资源协调，提示模型显式处理语义依赖。 |
| 可反馈给模型的错误与致命控制流有区别；取消不证明写入回滚 | [Codex errors](https://github.com/openai/codex/blob/10ca17496f5c934b9cf4baacda95c4a785f95630/codex-rs/tools/src/function_call_error.rs#L3-L10)、[pi write](https://github.com/badlogic/pi-mono/blob/edfe6b2ef32283d31efc9e26db86fe48be19d3b2/packages/coding-agent/src/core/tools/write.ts#L64-L87) | 返回真实错误状态，保留取消/审批语义；不确定效果先查询回执再决定重试。 |

## 验证与后续测量

在仓库根目录执行：

```sh
node --test tests/unit/context-prompt-policy.test.mjs tests/unit/framework-capability-middleware.test.mjs tests/unit/context-compaction-pipeline.test.mjs tests/unit/harness-tool-errors.test.mjs tests/unit/run-capability-manifest.test.mjs tests/unit/context-contract-audit.test.mjs tests/unit/context-capacity.test.mjs
pnpm typecheck
git diff --check
```

回归覆盖部分能力、Plan Mode、稳定前缀、后台任务链、实际文件工具调用、超长结果分页恢复、错误后的 schema 修正、用量/幂等、取消和网络重试。超长结果测试使用真实中间件与恢复工具，工件存储和 token 计数为夹具；QASPER 检查经过生产 worker，但模型响应为固定传输。

这些检查证明工程合同，不证明真实模型任务成功率、费用或延迟改善。下一步按[评测指南](../evaluation/README.md)固定模型和任务，对照检查三类轨迹：部分能力下的工具误选与无效重试、长文献结果后的证据恢复、导入响应丢失后的状态核对。同步记录输入 token、工具调用数、错误恢复次数、任务验收结果；有数据后再决定按任务裁剪科研工具集合或引入渐进工具发现。

## 2026-11-26 工具与提示词一致性审计

本轮沿 `run-capability-manifest → run-harness → context-assembler → agent-builder` 检查能力冻结、模型可见工具、系统提示词、模型工具说明和后台副作用回执。按实际代码合同修复以下问题，而不是替换 deepagents/LangGraph 或放松 Roc 的审批与效果恢复规则。

| 风险 | 审计发现 | 本轮处理与验证 |
| --- | --- | --- |
| 高：工具名碰撞 | MCP 禁用名列表手工复制科研工具名，遗漏 `research_review_read`、`research_review_execute_query` 等。工具卡内部去重不覆盖后续追加的框架/科研工具。 | 直接从 `RESEARCH_TOOL_DESCRIPTORS` 派生科研保留名，并在完整冻结 manifest 上再次检验唯一性。单测遍历全部科研工具，验证不能用 MCP 名称覆盖。 |
| 高：文献任务状态误报 | `research_add_literature` 的模型描述和 schema 已默认 `fulltext_auto`，系统研究提示却写着“只完成元数据”。 | 提示词区分元数据提交、后台排队、单篇 `ready` 与故障状态；把状态查询/重试/取消指引分别绑定到本轮实际工具可见性。 |
| 中：检索路线相似 | 通用正文 chunk 检索、科学对象检索、Wiki 派生导航和外部文献搜索的使用边界不够醒目。 | 以「外部发现 → 原文段落 / 科学对象 → 证据核验 → 写作检查」区分入口；在相关模型工具描述和项目提示中写明何时使用及不能证明什么。 |
| 中：用户引用伪装指令 | 用户指定技能名、技能路径及 `@` 文件路径被直接插入 XML 风格标签；包含闭合标签会破坏结构。能力 ID 以逗号拼接，可能混入换行。 | 对参考标签作 XML 文本转义；能力列表使用确定性的 JSON 字符串，避免换行和分隔符逃逸。参考数据仍不能扩大授权。 |
| 低：证据/写作措辞 | 静态问答提示中的“先固定答案再找证据”容易鼓励倒推依据；写作源文件被不必要地限定为 LaTeX。 | 改为先核对来源再形成结论，以当前工作区真实源文件为准；保留精确 JSON、简短答案与直接证据要求。 |

### 工具选择与返回状态

| 用户意图 | 首选工具路线 | 必须保留的边界 |
| --- | --- | --- |
| 搜索未入库的新论文 | `research_search_literature` →（获授权后）`research_add_literature` | 搜索候选不是 paper ID；不能因搜索就默认导入 |
| 问已入库论文正文 | `research_search_knowledge` → `research_read_knowledge_context` → `research_capture_evidence` | 命中片段不是完整实验条件；evidenceId 只来自捕获结果 |
| 核实表格数值、公式、图、引文 | `research_search_scientific_knowledge` → `research_read_scientific_context` → `research_validate_scientific_evidence` | `searchId` 属于本次运行；需按原始对象验证具体主张 |
| 查找综述页面 | `research_wiki_search` / `research_wiki_read` | Wiki 是派生导航，不得回灌成原始证据 |
| 撰写或修订章节 | `research_prepare_writing_context` → 编辑工作区源文件 → `research_check_draft_grounding` | `incomplete`、自动核验与人工科学批准是三种不同状态 |
| 查看文献导入进度 | `research_get_literature_import` → `research_get_literature_processing` | 前者 `completed` 仅指元数据，后者逐篇 `ready` 才是全文处理完成 |

对于部分能力清单，只注入存在的具名工具指引；计划模式继续只读，不获得研究副作用工具。上述表格是完整能力下的参考路径，不表示每次运行都拥有所有工具。

### 一手设计依据与剩余工作

- [OpenAI Function Calling 最佳实践](https://developers.openai.com/api/docs/guides/function-calling)：工具名/描述和参数应明确目的、格式、输出含义；系统提示词声明使用时机。工具数增加可能降低选择准确性，建议以可测量的按需暴露优化为后续独立改造。
- [Deep Agents 概览](https://docs.langchain.com/oss/javascript/deepagents/overview)：保留默认工具、文件上下文、子代理与权限中间件等框架约定；Roc 通过自身 manifest 将可见性与执行权限收口。
- [MCP server instructions 设计说明](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)：跨工具通则放在系统提示词，具体调用说明留在工具描述；提示词不能承担安全执行门禁。

后续用固定模型、任务集与运行轨迹比较修改前后 **有效工具选择率、无权限/无效工具调用次数、工具输入错误率、证据核验率、文献后台状态误报率、输入 token、延迟及人工验收通过率**。当前单测只验证代码契约与工具清单不泄漏，尚无真实模型对照数据；不应据此声明任务成功率已提升。
