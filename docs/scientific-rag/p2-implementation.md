# P2：按需深读与批次恢复

保留既有六维 Paper Card，在阅读器、Paper Card 与原始对象检查器增加深读入口。
打开面板只读取已有结果；点击“生成深读”才创建任务。整篇阅读覆盖 11 个维度，
对象入口根据公式、表格、图片、算法选择维度。服务合同支持按章节（含子章节）或对象选取，
并记录 reading、writing、comparison 用途与用户问题。导入扫描仍只生成基础知识。

深读结果逐条保存 `author_stated`、`source_derived`、`model_inference` 或 `unknown`，
缺失维度与对象要素由程序补充明确的 unknown，所有生成内容保持 `unreviewed`。
来源校验只证明定位与原文一致，不代表蕴含关系、数学证明或科学结论通过审核。
界面展示来源状态、实际任务状态、取消/重试、unknown 缺口和来源跳转；解析变化后的旧结果
标记 stale，停用指向当前解析的错误跳转。深读模块沿用现有懒加载阅读器与源对象查看器。

原始 LaTeX、表格、图片与算法对象完整保留，不被解释文本替换。
公式解释覆盖变量、单位、输入输出、假设、引用定义/公式、推导步骤与复杂度；
表格解释覆盖数据集版本、划分、指标、基线、硬件、训练/推理预算、种子、次数与不确定度。
`raw_result` 必须逐字等于所引用原始单元格。
图片仅使用 caption 和正文引用，宿主校验拒绝未出现在引用文本中的数值/单位，
并拒绝带数值的图片 model_inference。此阶段不引入视觉测量或自动补值。
方法关系使用带来源的 contains_component、uses_formula、tests_component、ablates_component；
uses_formula 的目标必须是真实公式对象。

## 持久化与恢复

entities、facts、relations、deep 四种阶段均保存批次收据：jobId、inputHash、batchId、stage、
modelRevision、dependencyHash、outputHash、validationStatus，以及该批次候选增量。
收据存放在既有未发布代次的候选字段，不新增数据库或迁移；最终发布时原子替换为完整候选。
未发布收据不可通过知识读取接口暴露为正式知识，且仅存增量以避免累积候选重复存储。

重启和显式重试先核对原始来源、模型配置、批次依赖与输出摘要，再重新验证候选内容和证据。
有效批次被复用，缺失、失败或损坏批次重新执行；单个结构损坏的收据不丢弃其余有效收据。
伪造来源即使重新计算了摘要也不能跳过内容校验。全部阶段完成后统一校验、原子发布，
失败或取消保留上一有效代次。深读在来源和配置相同时复用已经完成的基础抽取；
模型/解析变化使旧结果失效，基础自动扫描不会偷偷重新生成全部深读。

## 本阶段文件

后端与共享合同：

- `src/shared/schemas/research-paper-deep-knowledge.ts`：请求、选择范围、维度、解释与来源合同。
- `src/shared/schemas/research-scientific-extraction.ts`：快照、候选、知识结果携带可选深读数据。
- `src/main/plugins/research/scientific-extraction-deep.ts`：范围选择、对象策略、来源与数值约束。
- `src/main/plugins/research/scientific-extraction-receipts.ts`：增量收据及规范化摘要。
- `src/main/plugins/research/scientific-extraction-pipeline.ts`：逐批恢复与最终统一验证。
- `src/main/plugins/research/scientific-extraction-repository.ts`：收据持久化、复用、发布与 stale 读取。
- `src/main/plugins/research/scientific-extraction-service.ts`：显式深读请求、读取、任务生命周期。

现有桌面界面：

- `src/renderer/literature/PaperDeepKnowledge.tsx`：深读操作、任务反馈、解释与来源导航。
- `src/renderer/literature/PaperReader.tsx`：阅读器深读标签与懒加载入口。
- `src/renderer/literature/ScientificPaperKnowledge.tsx`：Paper Card 入口及扩展实验条件展示。
- `src/renderer/literature/ScientificObjectView.tsx`：对象限定的深读入口。

验证与记录：

- `tests/unit/scientific-extraction-service.test.mjs`：批次恢复、篡改拒绝与按需深读回归。
- `tests/renderer/paper-deep-knowledge.test.mjs`：真实服务、SQLite 和 Electron 的深读交互回归。
- `docs/scientific-rag/p2-implementation.md`：本记录。

能力注册、IPC 生成合同与 Agent 工具已接入。生成仅主 Agent 可用，读取允许子 Agent；项目绑定与取消信号由宿主固定。
常用实验条件的科学事实合同与比较规则归入 P3；本阶段界面兼容其可选字段并显示 unknown。

## 验证

状态：`Verified passing`（上述后端、界面与恢复范围）。
所有命令工作目录：`/Users/Apple_501/Desktop/Roc/Roc`。

- `node --test tests/unit/scientific-extraction-pipeline.test.mjs tests/unit/scientific-extraction-service.test.mjs tests/unit/scientific-extraction-generations.test.mjs tests/unit/research-paper-card-knowledge.test.mjs`：46/46 通过，覆盖持久任务重启、显式重试、只补跑缺失对象、损坏/伪造收据拒绝、来源/模型变更、取消、基础知识复用和图片数值约束。
- `node --test tests/unit/scientific-extraction-generations.test.mjs tests/unit/scientific-knowledge-search.test.mjs`：17/17 通过，验证历史代次与既有检索兼容。
- `node --test tests/renderer/paper-deep-knowledge.test.mjs tests/renderer/scientific-wiki.test.mjs`：12/12 通过，覆盖只读打开、键盘操作、显式对象请求、来源身份、取消/重试、重新解析失效、380px 窄布局、主题与既有原始对象查看。
- `node --test tests/unit/paper-deep-tools.test.mjs`：1/1 通过，验证项目隔离、取消传播及生成权限。
- `node scripts/generate-ipc-schema.mjs --check`：通过。
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json`：通过。
- `git diff --check -- src/main/plugins/research/scientific-extraction-pipeline.ts src/main/plugins/research/scientific-extraction-repository.ts src/main/plugins/research/scientific-extraction-service.ts src/shared/schemas/research-scientific-extraction.ts src/renderer/literature/PaperReader.tsx src/renderer/literature/ScientificObjectView.tsx src/renderer/literature/ScientificPaperKnowledge.tsx tests/unit/scientific-extraction-service.test.mjs`：通过。

测试采用受控模型响应，验证真实服务、持久化与界面路径，不代表真实模型的科学抽取质量。
新增深读 UI 测试记录解析身份后主动结束源文件读取；同批次既有 scientific-wiki 测试覆盖实际 PDF、PNG
与完整原始对象查看。浅色/深色界面截图已检查并删除；测试夹具在清理钩子关闭数据库并删除目录，
本阶段临时截图目录不存在，仓库 `.runtime/tmp` 为空。未安装完整模型时仍可查看已有卡片和原始对象；
未配置抽取模型的请求按既有合同显式失败。
