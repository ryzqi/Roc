# Agent 记忆

Roc 将会话 checkpoint、上下文 artifact 和长期记忆分开保存。长期记忆位于本地 SQLite store，以全局 USER/AGENTS/MEMORY、项目 AGENTS/MEMORY 和按需读取的 topic 文档呈现；会话历史用于回查，不等同于已经确认的长期事实。

## 运行作用域与刷新

`memory_search` 的项目路径由运行快照注入，模型只能提供查询和条数。搜索过程从固定文件到 topic 扫描复用同一个项目上下文。运行期间切换界面项目，不改变该运行的读取范围；无项目运行只读取全局记忆。

每次新调用在 `beforeAgent` 重新加载固定记忆源，替换前一轮 checkpoint 中的 `memoryContents`。同一轮模型/工具循环沿用该轮快照；中断与 checkpoint 恢复不重新执行入口加载。编辑或撤销在下一次新运行生效，运行中的显式 `memory_search` 读取当前存储。该策略保留框架的提示词缓存标记，不在每次模型调用重复读取。

## 全文编辑

模型编辑记忆时，基于存储原文完成字面替换，默认要求唯一匹配，`replaceAll` 替换全部匹配。完整结果通过结构、安全和容量校验后，写入同一份已校验文本。校验失败不改原文；不再受展示分页的 500 行边界影响，也不会把过滤后的生效视图误写回存储。

回归命令：`node --test tests/unit/memory-backend-edit.test.mjs`。

## 生命周期与检索

`workspace_fact` 和 `decision` 是稳定事实，以作用域、类型和 key 判定覆盖，不因模型或工具配置 hash 变化而失效。`pitfall`、`verification` 是环境经验，额外按 applicability 隔离；一个环境的撤销不会删除另一个环境的经验。

固定文件和 topic 归档共同决定每个 key 的最新状态。撤销、待复验、过期或结构损坏的最新条目仍保留覆盖效力，防止旧归档重新生效。损坏的 `counterexamples` JSON 只隔离该条目，其他条目继续读取。修复后可重新生效。

同一运行重复提交相同条目会去重；过期事实允许有证据的新运行重新确认并续期。去重会检查 topic 中保留的历史；历史被清理后不承诺无限期重放幂等。配额检查仍优先于去重，达到上限的重试返回 `quota_exceeded`。

`memory_search` 同时检索自动偏好和人工编辑的 USER Markdown。排序先比较查询词覆盖数，再比较 key、摘要和正文的字段权重；重复堆叠单词不会增加词频分数。当前使用词法检索，没有向量数据库或语义召回保证。

## 写入协调与来源

`remember`、运行结束维护、模型文件编辑和管理界面写入使用同一数据库连接的串行队列。队列覆盖读取、去重、配额和主题上限检查、归档、写入及审计调用；嵌套写入可重入，失败后后续操作仍可执行。不同 store 实例复用同一连接时共享队列。这是主进程内的协调，不是跨进程锁，也不是多文件与审计的原子事务；审计仍沿用失败记录日志的策略。

自动记忆开关在写入执行时检查，同时约束 `remember` 与模型的 `write_file` / `edit_file` 记忆路径。关闭后仍可读取长期记忆及通过管理界面手工保存。

生产 `remember` 工具从运行快照取得 run、thread、项目和本轮真实用户输入，模型不能指定这些来源。`user_preference` 必须提供 `user stated: "本轮原文"` 形式的引用，也接受中文用户引用前缀；引用在归一化空白后必须能在本轮输入中找到。识别到的用户声明均做此检查，失败不会调用写入端。核对后的证据附带运行定位和输入 SHA-256；结构化条目保存证据，精简 USER 偏好通过审计的 sourceRunId 回查来源。

引用匹配只证明原文存在，不证明摘要与原文语义一致。其他工具观察尚未自动与执行记录核对，人工 Markdown 及模型直接文件编辑也不经过引用校验；这部分不能视为已验证事实。需要严格来源保证的候选应走 `remember`，并保留原始记录以复查。

回归命令：`node --test tests/unit/memory-mutations.test.mjs tests/unit/memory-evidence.test.mjs`，包含并发候选、重复提交、配额、并行编辑、主题上限、失败恢复、写入开关和伪造引用。

## 管理预览

预览复用运行读取的生命周期投影，按全局与当前项目分别处理。topic 参与最新状态判定以抑制已撤销的旧值，但正文仍按需读取，不进入固定记忆预览。预览开始时固定项目，避免读取途中切换项目混入其他内容。

管理界面尚未绑定一次运行的模型和工具配置，因此仅展示稳定事实及普通 Markdown，明确说明环境经验暂未解析；这不是完整的下一轮提示词。底层方法接受可选的有效 applicability，供具备运行上下文的调用方精确过滤经验；现有管理 IPC 不传入该值。

回归命令：`node --test tests/unit/memory-preview.test.mjs tests/unit/renderer-management.test.mjs`。

## 验证

从仓库根目录运行 `node --test tests/unit/memory-runtime.test.mjs tests/unit/framework-capability-middleware.test.mjs`，覆盖同 thread 更新、删除、新 agent、恢复快照与项目切换。测试使用隔离存储和固定模型响应，不表示真实模型的记忆质量。

生命周期和检索回归：`node --test tests/unit/memory-lifecycle.test.mjs tests/unit/memory-retrieval.test.mjs`，覆盖跨环境、归档覆盖、坏条目、过期续期、重试、USER 混合 Markdown 和重复词排序。

跨会话评测同时验证存储、工具结果与最终回答，要求 key 和 `rememberedText` 等于原始记忆；即使搜索成功，回答遗漏、替换或否定记忆也不通过。该任务要求返回原文，不接受语义改写。

S01 长记忆校验针对固定英文样例，增加数字边界、有限的英文数字形式和否定检查，并保留精确引用集合要求。它不是通用语义判断器，也不验证事实与 DOI 的逐项对应。

评测回归：`node --test tests/unit/memory-evaluation.test.mjs tests/unit/quality-evaluation.test.mjs evaluation/tests/memory-answer-grader.test.mjs evaluation/tests/capability-session-grader.test.mjs evaluation/tests/application-session.test.mjs`。跨会话用例运行隔离的真实 Roc worker，并使用受控模型响应；通过这些检查不代表真实模型质量提升。
