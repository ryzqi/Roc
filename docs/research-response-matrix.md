# Review Response Matrix

审稿矩阵属于当前项目的论文工件。原始审稿意见、人工回复与处理状态按完整矩阵追加版本；保存不会修改正文、证据、科学支持审核或人工闸门。

## 合同

`research.responseMatrix.save` 需要主进程根据实际 IPC sender 绑定的人工身份。renderer、模型和请求参数不能自授身份。输入必须给出项目、论文工件、幂等 requestId、当前工件快照版本、精确上一版 ID/hash、修订理由和完整意见集合。

每项包含稳定 commentId、审稿人和原始意见。既有意见不能被删除或改写；新的处理结果保留原意见并追加版本。状态由人工明确选择：

| 状态 | 要求 |
| --- | --- |
| `open` | 保持未处理；可保存调查中的回复、位置和证据 |
| `addressed` | 非空回复，至少一个修改稿中的精确位置 |
| `declined` | 非空回复，记录人工未采纳理由 |

位置绑定当前保存的主张 ID/hash、UTF-16 字符范围和完整原文；小节、主张版本、修改稿 LaTeX/contentHash/claimsHash 与所选项目 Evidence 一起冻结。位置只能来自该修改稿。所选 Evidence 必须处于 `recorded` 状态；关联本身不构成语义支持确认。文字或结构修改可以只绑定修改稿位置，科学证据需要人工明确选择。

同一请求和 sender 的精确重试返回原回执且零写入。请求内容、sender、parent 或工件版本冲突明确拒绝。已批准/非当前阶段工件及归档项目不能追加新版本。

## 当前核验与历史

`research.responseMatrix.inspect` 读取当前保存修改稿和最新矩阵，返回报告 hash、当前工件版本、原人工处理状态及 `reviewCurrent`。修改稿或所选 Evidence 的内容变化使原绑定失效；原状态保留供重新核对，不能被当成新修改稿已经处理完毕。过期正文必须先重新保存，不读取成功式缓存回退。

`research.responseMatrix.history` 按 limit/offset 读取最多 100 条，标记 `stored_receipt`。它验证保存字节、索引、父版本和内在位置/稿件/hash 合同，不要求恢复当前来源。历史不能证明当前来源或意见已经重新核查。没有审核时当前 review 为 null、各状态 ID 集合为空，不能推断没有外部审稿意见。

Research DB50 仅新增 `research_response_matrices`；旧迁移账本、用户工件与来源原样保留，不创建或推断审稿意见。没有旧 API、旧 schema 或默认字段兼容层。

## 实施边界

A5A 交付主进程合同、存储、读取、人工 IPC 和生成 preload。A5B 接入现有工件抽屉中的惰性编辑；A5C 接入审批与导出消费者。论文/LaTeX/语义支持审核继续决定主张是否可发布。

A5B 已在现有论文工件抽屉提供“检查审稿回复”惰性入口。打开前零矩阵请求；人工编辑完整矩阵，单条意见表单保留桌面信息密度。已保存原始意见/审稿人只读，处理状态、回复、精确修改位置和证据显式编辑。可选择完整段落或 UTF-16 字符范围，保留选区空白。待关联位置不能被整份保存静默丢弃。新意见只有保存前可移除，旧意见需要保留并记录处理结果。

未保存和请求中状态锁住关闭/Escape、父工件刷新/重核对/审核、其他编辑和来源决定。回执丢失时保持相同 requestId/内容，精确重试零重复写入；修改内容才换 requestId。修改稿变化后的旧“已处理”标记为历史判断。当前核验失败隐藏旧成功数据，独立分页历史仍能读取完整保存回执。不同项目/快照的表单和迟到响应隔离。归档、已批准、非当前阶段和客户端只读状态不发保存请求。

A5C 在工件快照中提供必填、可为 null 的 `responseMatrix` head（ID/hash/version/时间），所选独立 Evidence 也进入快照，因此追加矩阵、修改稿件或来源变化都会撤销旧工件审批版本。共享科学核验覆盖阶段完成、人工审批、任务验收与导出；存在矩阵时必须提供核验服务。该服务读取所选实验指标的真实结果、输入代码和执行回执，普通来源不推断实验指标。所有异步读取结束后，整个工件集合再同步核对来源和版本。

导出科学快照使用 schema 5，必填 `responseMatrices` 固定最新回执及全部分页 `stored_receipt` 历史，矩阵独立 Evidence 进入来源闭包和导出源 hash。保存新人工回复即撤销旧科学导出 seal；过期稿件或来源不能通过当前审批/导出，保存历史仍独立可读。旧 schema 及缺少必填字段的数据直接拒绝，没有迁移回退。

当前矩阵的 `open`、`declined` 及未建立矩阵不会自动批准或拒绝论文。存在 `open` 项时核验其真实状态并保留在导出中；科学支持、审稿处理状态与接受论文的人工决定分别表达。

## 验证

以下命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行，最终 A5A 源码检查均 exit 0：

- `node --test tests/unit/research-response-matrix.test.mjs tests/unit/research-consistency.test.mjs tests/unit/research-citation-reviews.test.mjs tests/unit/research-semantic-publication.test.mjs`：35/35，包括 9 个矩阵合同、真实 sender、重试、事务失败、来源失效、磁盘重开、DB49→50 与 UTF-16 精确空白选区检查。
- `pnpm build`：TypeScript 与 main/preload/renderer 构建通过。
- `node scripts/smoke-electron.mjs`：13/13，无 renderer error。
- `pnpm check:ipc`：生成文件一致；`pnpm check:renderer-chunks`：eager JS 1,134,228 bytes / 6 files。

前一验证快照的 `node scripts/run-research-p0.mjs` 13/13，以及 `node --test tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/citation-coverage.test.mjs tests/renderer/scientific-consistency.test.mjs` 51/51。该快照后只修改精确选区合同、明确来源错误及相应 unit 检查，最终重新构建并启动验证。

日志保留于 `.artifacts/research-optimization/xwrite-a5a-final-*.log`，前一快照保留于 `xwrite-a5a-{p0,renderer,startup,ipc,chunks}.log`。C2C 消费者修正后的补充完整 unit 为 1249/1249；它不代表最终 A5A 的完整 suite 已运行。后续 UI 与审批/导出验证分别记录在各交付部分；独立科学验收尚未运行。

A5B 最终命令均在相同工作目录 exit 0：

- `node --test tests/renderer/response-matrix.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/citation-coverage.test.mjs tests/renderer/scientific-consistency.test.mjs`：59/59，包括 8 个真实 Electron 矩阵场景。
- `pnpm build`：TypeScript 与全应用构建通过。
- `node scripts/smoke-electron.mjs`：13/13，无 renderer error。
- `pnpm check:ipc` 一致；`pnpm check:renderer-chunks`：eager JS 1,134,228 bytes / 6 files，矩阵模块留在惰性图中。

650px 明暗主题、减弱动效、展开、hover、长正文/选区和保存状态共 4 份审计均 cut 0；hidden 3 精确对应原有整高抽屉在窗口 top/right/bottom 物理边界的投影，无水平溢出。实际截图已查看，字符范围控件、证据、回复、修订理由、保存/放弃和焦点可见，保留于 `.artifacts/research-optimization/response-matrix-ui/`。初次 5/7 的两处 fixture 失败分别为论文不存在生产文件按钮、来源变化先由工件版本拒绝；修正测试消费者后最终 8/8，未放宽产品校验。日志为 `xwrite-a5b-{renderer,build,startup,ipc,chunks}.log`。

A5C 最终命令在同一工作目录均 exit 0：

- `node --test tests/unit/research-response-matrix.test.mjs tests/unit/research-figure-consistency.test.mjs tests/unit/research-semantic-publication.test.mjs tests/unit/research-consistency.test.mjs tests/unit/research-citation-reviews.test.mjs`：52/52，覆盖独立 Evidence、response-only 核验、稿件/来源/项目在 await 期间变化、多工件异步窗口、102 条完整历史和严格 schema 4/seal。
- `pnpm build`：TypeScript 与构建通过。
- `node --test --test-name-pattern='actual result metric evidence' tests/integration/research-python-experiments.test.mjs`：1/1，真实 CPython 指标、写作 complete/approve 和含 open 意见的导出通过。
- `node scripts/run-research-p0.mjs`：13/13；上述 A5B 五个 renderer 文件：59/59；`node scripts/smoke-electron.mjs`：13/13，无 renderer error。
- `pnpm check:ipc` 一致；`pnpm check:renderer-chunks`：eager JS 1,134,272 bytes / 6 files。

补充 `node --test tests/unit/` 为 1264/1264；该进程早于最终多工件异步修正及新增回归，最终产品由 52 项专项验证覆盖，不能称为最终源码全单元验收。日志保留于 `.artifacts/research-optimization/xwrite-a5c-{verified-focused,verified-build,final-python,final-p0,final-renderer,final-startup,final-ipc,final-chunks,unit}.log`。初次合成 fixture 的 unsupported 主张、写作实际进入 review 及自动创建 review cycle 均按真实合同修正，未放宽产品检查。独立科学审稿验收仍未运行。
