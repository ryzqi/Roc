# 知识库优化 P3：分层 Wiki 与来源约束解释

来源页为 L1，概念、方法、公式、算法、数据集、指标和协议模板为 L2，研究综合为 L3。
模板存于既有页面 selection，搜索和列表可按层级、模板、页面种类过滤；不增加数据库或第二套实体图。

新合成固定经过引用计划、解释正文和独立语义建议三次有界调用。缺少计划目标、改写数值、引用越界、
比较条件不齐、宿主定位被伪造或来源/模型/Revision 改变均失败，旧 Revision 保持原样。
计划与后续阶段共享完整依赖闭包及去重后的原始来源，输入上限为 16k token，并受实际模型窗口限制。
原始公式、单元格和实验条件不裁剪；超限明确失败。

解释分别标记原文陈述、综合解释、条件对齐比较和模型推断。原文陈述须匹配原始引用，其他正文是待核验草稿。
宿主生成 SourceRef、validation 和 scientificApproval；语义建议不能提升为人工审核或写入正式 Evidence/Claim。
保存的旧引用式 Revision 继续可读，新合成缺少 goal 时不会静默回退旧流程。

实验条件增加 hardware、trainingBudget、inferenceBudget、randomSeeds、repeats、uncertainty。
字段可选且无默认值，旧 JSON 序列化不变；抽取 prompt 版本升级为 26，使旧配置批次不能作为新条件合同的当前知识复用；新已知条件只能选择原文 token，并接受既有原始表格行/合并单元格/关联上下文权限校验。
直接比较要求所有核心条件已知且一致。名字或人工别名不能抹去原始 Dataset/Metric/Baseline 属性差异。
新增 defines、extends、evaluates_on、compares_with、supports、contradicts、related_to 关系由原 Entity/Relation owner 保存。
新语义关系要求原文同时提及端点，强比较/矛盾关系还需完整且一致的实验 Facts；来源校验不代表语义确认。

`wiki.updateSources` 按指定章节加入或刷新论文来源，只使选定助手章节过期；保留无关章节、人工内容和历史字节。
`wiki.relations` 投影当前已验证来源。Wiki 检索也在返回正文前重新核对 PDF 字节，过期正文不能继续作为检索命中。

## 工程验证

工作目录为仓库根。以下为定向运行，不是科学质量评分：

```sh
node --test --test-concurrency=2 tests/unit/wiki-scientific-synthesis.test.mjs tests/unit/wiki-scientific-comparison.test.mjs tests/unit/wiki-search.test.mjs tests/unit/wiki-scientific-pages.test.mjs tests/unit/wiki-p3.test.mjs
node --test --test-concurrency=2 tests/unit/wiki-p3.test.mjs tests/unit/wiki-search.test.mjs tests/unit/scientific-fact-condition-tokens.test.mjs tests/unit/scientific-knowledge.test.mjs
```

第一组 23 项通过；补充 PDF 字节搜索失效检查后，第二组 25 项通过。
测试使用隔离仓库、原始 PDF 字节和受控模型响应，覆盖原文条件、字段缺失/差异、伪造来源、取消、版本竞争、人工章节和不可变历史。
这些检查不证明模型解释质量；完整 Fact Coverage、跨论文科学支持和实际模型资源表现仍需独立人工 gold 和真实运行。

接入回归：`node --test tests/unit/wiki-tools.test.mjs` 3/3 通过，覆盖层级/模板过滤、关系读取、项目隔离和计划模式拒绝增量写入。

扩大回归（81/81 通过）：
```sh
node --test --test-concurrency=2 tests/unit/wiki-pages.test.mjs tests/unit/wiki-paper-knowledge.test.mjs tests/unit/wiki-scientific-pages.test.mjs tests/unit/wiki-scientific-synthesis.test.mjs tests/unit/wiki-scientific-comparison.test.mjs tests/unit/wiki-search.test.mjs tests/unit/wiki-tools.test.mjs tests/unit/scientific-fact-condition-tokens.test.mjs tests/unit/scientific-fact-condition-selection.test.mjs tests/unit/scientific-fact-condition-sources.test.mjs tests/unit/scientific-knowledge.test.mjs tests/unit/scientific-knowledge-search.test.mjs
```

追加单位绑定修复验证：`node --test tests/unit/wiki-p3.test.mjs tests/unit/wiki-scientific-synthesis.test.mjs tests/unit/wiki-scientific-comparison.test.mjs` 20/20 通过。数字与紧邻单位必须在同一原文位置绑定，不能将同值的 FLOPs、kg、复合单位、中文单位或不同数字之间的单位互换。此追加测试使早期23/25两组重跑时各增加1项。

## 桌面界面与运行验证

`WikiPages.tsx` 在既有目录加入 L1/L2/L3、模板筛选，并在创建表单提供七种 L2 模板和 L3 研究综合。
筛选进入真实搜索合同；改变范围重置分页，创建成功清除旧筛选以显示新页。模板选择纳入未保存草稿保护。
新增 `WikiScientificExplanation.tsx` 逐条展示四种解释来源、来源状态、模型审核建议和“未人工审核”，
原始事实/对象仍通过原有检查器读取，完整章节及实验条件保留为可展开记录。
不改正文的人工保存保留解释；人工改写正文后清除生成解释标记，保留来源依赖。

非人工科学章节的“用新论文更新此节”将项目、页面、章节、当前修订、依据摘要和已有论文代次交给助手。
提示要求读取新论文当前知识，再调用增量来源更新和指定章节重建；点击入口自身不写入来源。
此界面交接已验证，后续工具执行由能力与工具测试覆盖。

界面文件范围：

- `src/renderer/literature/WikiPages.tsx`
- `src/renderer/literature/WikiScientificExplanation.tsx`
- `tests/renderer/wiki-pages.test.mjs`
- `tests/renderer/scientific-wiki.test.mjs`

状态：`Verified passing`。所有命令工作目录为 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm exec electron-vite build
pnpm check:renderer-chunks
ROC_UI_CAPTURE_DIR=/tmp/roc-p3-wiki-ui-evidence node --test --test-concurrency=1 tests/renderer/wiki-pages.test.mjs tests/renderer/scientific-wiki.test.mjs
ROC_UI_CAPTURE_DIR=/tmp/roc-p3-wiki-ui-evidence node --test --test-concurrency=1 --test-name-pattern='layer and template|persisted explanations' tests/renderer/wiki-pages.test.mjs tests/renderer/scientific-wiki.test.mjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
git diff --check -- src/renderer/literature/WikiPages.tsx src/renderer/literature/WikiScientificExplanation.tsx tests/renderer/wiki-pages.test.mjs tests/renderer/scientific-wiki.test.mjs
```

构建、分块检查、类型检查和 diff 检查通过。完整 Electron 回归 26/26 通过；窄窗口标签不换行、
截图等待主题稳定的最后调整后，新增两个场景 2/2 通过。覆盖真实 IPC/SQLite、模板落库、组合筛选、
四种来源类型、四种模型建议、精确原始知识代次、完整条件、人工编辑、回滚、失效、键盘和导航保护。
旧回归调整为：回滚过期来源后搜索不能再次命中旧依据，但清空搜索后的目录仍能打开历史页面。

真实 Electron 中检查浅色/深色截图与 380px 窄窗口；既有回归同时检查 560/800/1100px。
`clip-audit` 均为 `cut: 0`，页面无横向溢出。测试夹具清理隔离目录，截图已在本阶段人工抽查后删除；
`.runtime/tmp` 为空。忽略的 `dist` 构建目录保留供后续 smoke 使用。

最终提交快照单独运行 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 与 `node scripts/generate-ipc-schema.mjs --check` 均通过。
`node --test tests/unit/scientific-extraction-wire.test.mjs tests/unit/provider-tool-json-schema.test.mjs` 38/38 通过。
