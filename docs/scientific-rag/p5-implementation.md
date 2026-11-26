# 知识库优化 P5：真实 PDF 工程验收

工程链路状态为 `Verified passing`，完整科研质量与发布状态仍为 `releaseAccepted: false`。
本阶段新增可复现的原始 PDF 验收入口和独立验证器，保留来源、源码快照、运行结果及清理记录。
不把受控模型响应测试、引用身份一致性或单篇 PDF 运行当作科研质量成绩。

## 运行范围

`benchmark-scientific-p5.mjs` 使用仓库内已下载、SHA-256 固定的原始 PDF，在独立子进程中创建内存 SQLite 和临时项目。
调用当前生产解析器，收集真实解析输出，构建 Paper IR，发布真实索引，再经统一检索协调层执行关键词查询、读取上下文和核验原文引用。
没有手写 IR，没有模型响应桩参与该链路；Embedding、Reranker、OCR 和生成模型均未配置，模型调用与模型 token 为 0。
独立子进程通过 IPC 在解析开始后取消，检查真实取消错误、正常退出和临时目录删除。

`verify-scientific-p5.mjs` 校验输入 PDF、源码、运行结果和产物哈希，再直接用 PDF.js 读取被引用的原始页。
验证器不调用生产解析器、IR 构建器或引用核验函数；它独立检查空白归一化后的完整引文确实出现于指定页。
这项检查验证原文存在性，不评分语义支持、阅读顺序或坐标精度。源码发生变化时验证器拒绝复用旧报告，需要重新运行。

输入为 *The 4+1 Model of Data Science*，28 页，424,938 bytes，SHA-256：
`2551035de153b3de967b7f2372802af4548408ee73dd2aa2910c43987c3b091f`。
该单篇 native-text PDF 不是数学密集型论文 gold，也不使 SciEGQA 本地缓存自动成为独立审核的正式评测集。

## 测量与限制

机器为 Apple M1 Pro，10 个逻辑 CPU，32 GiB 内存，macOS arm64，Node v26.13.1。
详细时间、来源、源码快照摘要及报告哈希见 [p5-engineering-results.json](p5-engineering-results.json)。
当前运行得到 1,131 个真实解析块和 IR 块、1,146 个索引块；两次查询均返回 10 个命中、9 个来源引用，命中内容哈希一致。
上下文恢复 4 个证据对象，原文引用通过，伪造引用被拒绝，查询开始前取消被拒绝。
解析中取消返回 `research_process_cancelled`，子进程退出，临时 PDF 副本、解析文件、IR、数据库和运行 bundle 均已清理。

最终源码基点为 `ff94f8aa534c7ff992497ced819a7eafa095c947`，精确工作树源码由报告的逐文件哈希固定。
解析 1,972.09 ms，索引 773.33 ms，首次/重复查询 4,160.21 / 3,913.39 ms；峰值 RSS 858,046,464 bytes。
解析取消子进程从启动到退出共 805.41 ms。独立验证器核对 1 个原始引用页并通过。
最终报告 SHA-256 为 `d8b4332c7e22d0666f84b8f3db957af453046f021ed249146d22a30e1b60ac8e`。

首次与重复查询共享同一个进程，没有清空操作系统缓存，因此不声明为冷启动/热启动基准。
RSS 为整个子进程峰值，包含服务与 SQLite；50 ms 采样只能描述运行过程，短峰值另由进程 maxRSS 记录。
P0 同源组件基线为 28 页、1,131 块、约 2.58 秒解析；P5 增加真实索引、统一查询和证据核验。
两次单样本的环境负载和流程不同，不推断性能提升，也不推断 Recall@K 不回退。

## 五个科研场景的验收状态

| 场景 | 已有工程证据 | 尚未满足的完整验收 |
| --- | --- | --- |
| 单论文深入阅读 | 本次真实 PDF 解析、索引、检索、稳定来源、上下文与独立原文验证；P2 原始对象/公式/实验契约测试 | 数学密集论文上真实模型的方法解释、公式与消融问答及人工 gold |
| 20 篇多论文综述 | P3 三论文比较与解释流程的隔离仓库、受控模型响应测试 | 20 篇真实论文、真实生成模型、Fact Coverage 与跨论文语义支持评审 |
| 新论文持续加入 | P3 指定章节来源增量、PDF 字节失效、人工章节保护和不可变历史回归 | 连续真实模型运行的增量成本与知识质量 |
| Agent 完整论文写作 | P4 真实 SQLite/检索与受控响应测试：持久来源、跨会话收据、人工审核闸门和无效候选拒绝 | 完整 Agent 生成四个正文章节并经人工评审的端到端运行 |
| 知识变化后的修订 | P4 来源变化传播至 Evidence、Claim 和保存段落的只读检查；权限/模型/来源竞争零写入 | 真实多轮 Agent 的修订建议质量、完整正文及导出回归 |

P3/P4 的受控模型响应只验证宿主边界，不能证明模型具备科研理解或写作能力。
正式冻结语料目前仍未达到就绪状态，质量指标保持 `null`，不会生成虚假的 Recall、Coverage 或语义支持率。
OvisOCR3/MLX、Embedding、Reranker、生成模型的加载/卸载、持续资源增长、完整 GUI 长文滚动和正式发布验收仍待实际配置与运行。

## 发布门槛逐项核对

| 门槛 | 本阶段证据与边界 |
| --- | --- |
| 来源完整性 | 本次真实原文引用的身份、代次、页码与文字存在性已验证；没有独立坐标精度评分 |
| 原始值保护 | P2/P3 定向回归覆盖原始对象与数值/单位拒绝；尚无公式/表格 gold 识别质量成绩 |
| 检索质量 | 单篇关键词路径运行成功；冻结评测集 Recall@K 前后对照未执行 |
| Wiki 质量 | 宿主计划/解释/建议边界通过受控响应测试；Fact Coverage、语义支持和 20 篇综合未评分 |
| 写作安全 | 持久 Evidence、人工审核与竞争零写入经过定向测试；完整真实模型 Agent 写作尚未验收 |
| 增量正确性 | 指定章节更新、旧来源失效、人工内容和历史保护经过回归；真实模型连续增量运行未执行 |
| 恢复能力 | 本次 native 解析取消退出/清理已验证，任务恢复另有 P2 回归；真实模型进程崩溃与重启场景未执行 |
| 资源表现 | 记录一次真实链路 RSS 和取消耗时；尚无持续负载、无界队列/调用证明或重型模型释放验收 |

正式 corpus readiness 报告仍为 `blocked`，合格独立论文和查询均为 0；解析、检索、抽取、Wiki、写作的正式质量评测均为 `not_run`。
单篇工程运行不改变该状态。本入口未执行数据库升级、打包应用启动、安装包分发或部署，也未读取默认用户数据目录。

## 可复现命令

工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`。输出目录必须不存在；重跑时使用新的目录，并将同一路径传给验证器。

```sh
node scripts/benchmark-scientific-p5.mjs evaluation/local/corpora/sciegqa-bench-v1/pdfs/cs/2311.07631.pdf 2551035de153b3de967b7f2372802af4548408ee73dd2aa2910c43987c3b091f .artifacts/p5-original-pdf-e2e-final
node scripts/verify-scientific-p5.mjs .artifacts/p5-original-pdf-e2e-final
node --check scripts/benchmark-scientific-p5.mjs
node --check scripts/verify-scientific-p5.mjs
git diff --check
```

最终构建与桌面 smoke（同一仓库根目录）：

```sh
pnpm build
pnpm check:ipc
ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=.artifacts/p5-shell-smoke node scripts/smoke-electron.mjs
```

`pnpm build` 通过，包含 skills、TypeScript、electron-vite 和 renderer chunks 检查；IPC 检查通过。
桌面 smoke 退出 0，23/23 通过且无 renderer error，收据为 `.artifacts/p5-shell-smoke/result.json`。
其实际 target 为 `dist-main-fallback`，`full: false`，使用受控 provider；这不是安装包 Finder 启动或真实模型科研验收。

各阶段定向回归与最终结果见 [P1](p1-implementation.md)、[P2](p2-implementation.md)、
[P3](p3-implementation.md)、[P4](p4-implementation.md)，不在此复制可能变动的测试计数。

最终原始 PDF 验收证据保留于 `.artifacts/p5-original-pdf-e2e-final`（10 个 JSON），桌面 smoke 保留 JSON 收据及日志。
smoke 的 canvas/assistant 截图已目视检查，六张临时 PNG 已删除；四个隔离目录由脚本 finally 清理。
三个中间试跑目录 `p5-original-pdf-e2e`、`p5-original-pdf-e2e-v2`、`p5-original-pdf-e2e-v3` 已删除。
运行 bundle、PDF 临时副本、解析/IR scratch 均已清理，`.runtime/tmp` 和 `.runtime/test-bundles` 为空。
构建产物 `dist` 保留供使用；原始 PDF 缓存和 P0 证据保持不变。
