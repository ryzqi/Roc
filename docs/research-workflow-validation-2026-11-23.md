# 科研工作流实施验收

验收日期：2026-11-23。对应[2026-11-21 调研](research-workflow-gap-analysis-2026-11-21.md)的八项优化。状态：**Verified passing**，功能已经逐项提交，最终顺序原生回归通过。本文记录固定工作区的工程验收，当前功能合同由下列专题文档维护。

## 实施范围

| 项目 | 提交 | 当前合同 |
| --- | --- | --- |
| P0-1 科研提案与下一步查询 | `18b6e79` | [工件检查器与提案](research-artifact-inspector.md) |
| P0-2 工作稿与受控正文同步 | `d35612d` | [稿件同步](research-manuscript-sync.md) |
| P0-3 真实结果进入图稿、正文和 Methods | `c82e10c` | [实验结果](research-experiment-results.md) |
| P0-4 技能参考依赖闭包与运行准备检查 | `c802a38` | [内置技能](builtin-skills.md)、[阶段技能](research-skills.md) |
| P1-1 已记录关系的影响与定向修复 | `8ba7a63` | [变更影响](research-impact.md) |
| P1-2 证据矩阵、大纲与提取试查 | `24ce68b` | [论证大纲](research-argument-outline.md)、[系统综述](research-systematic-review.md) |
| P1-3 投稿配置、署名与匿名包 | `4d4a459` | [投稿](research-submissions.md) |
| P1-4 外部意见与实验报告回流 | `e57d188` | [协作](research-collaboration.md) |

这些功能复用现有工件、证据、执行图、人工审核和导出服务。影响查询覆盖已记录关系；提取试查覆盖选定的一至五篇全文；外部实验报告保留“未经独立核验”的身份。它们不构成任意学科的自主科研保证。

## 最终验收修正

- 投稿所选 `paper.docx` 实际复制到 `extras/paper.docx` 后，原逻辑路径曾被错误判为缺失。现在期刊检查和材料预检都使用成功复制建立的映射，并核对实际字节、大小和逻辑路径哈希。缺文件、无映射和不匹配映射仍失败。单测与真实 DOCX 投稿覆盖此路径。
- 原生流程夹具更新到现行 Idea Canvas 字段与 UTF-16 证据定位合同；元数据导入显式选择 `metadata_only`，另行实际导入和解析 PDF；只读查询断言先等待后台任务完成。
- 缺失模型 usage 的旧测试误要求非零 token 上限。现行[观测合同](research-task-observability.md)没有累计额度；未提供估算时预留为零。修正测试核对唯一 `unknown` 调用、`actual_tokens=null`、公开调用诊断和事件，不改生产记账逻辑。

## 命令与结果

以下命令均在 `/Users/Apple_501/Desktop/Roc/Roc` 执行。环境为 macOS arm64，Node `v26.13.1`、pnpm `12.21.0`、TypeScript `7.0.2`、Electron `45.3.4`；离线工具链位于 `.runtime/research-toolchain/darwin-arm64`。验证包含工作区已有的 UI 改动；本任务提交只包含科研工作流相关文件。

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过，含技能构建与类型检查 |
| `pnpm test:unit` | 2678 项：2677 通过，1 项工具链条件跳过，0 失败 |
| `ROC_WORKSPACE_LATEX_TOOLCHAIN=.runtime/research-toolchain/darwin-arm64 node --test tests/unit/research-workspace-latex.test.mjs` | 4/4 通过，补验上述跳过项，实际编译 LaTeX |
| `pnpm test:renderer` | 892/892 通过，0 跳过 |
| `node --test tests/unit/research-submission-preflight.test.mjs` | 4/4 通过 |
| `node scripts/run-research-p0.mjs --test-name-pattern='missing model usage'` | 1/1 通过 |
| `node scripts/run-research-p0.mjs --test-name-pattern='native experiment rerun'` | 1/1 通过 |
| `node scripts/run-research-p0.mjs` | 最终顺序运行 19/19 通过，0 跳过，约 63 秒 |
| `node scripts/smoke-electron.mjs` | 23/23 通过，无 renderer error |
| `pnpm check:ipc` | 通过，生成接口为当前版本 |
| `pnpm check:renderer-chunks` | 通过，单入口块未超过限制 |
| `git diff --check` | 通过 |

一次与 Electron smoke 同时运行的原生套件在导出阶段出现 `research_process_supervision_failed`，触发进程协调器的保护性隔离，后续用例报 `research_process_cleanup_unresolved`。首个失败用例单独运行通过，随后全套顺序运行 19 项全部通过。并发干扰尚未证实，根因未定位；没有绕过隔离、增加自动重试或放宽断言。最终验收采用两个套件分别运行，不能据此声称已排除并发时的偶发监管问题。

## 运行证据与边界

原生集成使用 Electron 的 Node 运行环境、真实 SQLite、TypeScript 执行、PDF 解析、Vega/Skia 图稿、LaTeX/Typst 编译和 ZIP 文件。垂直用例实际修改输入并重跑，核对新结果证据、正文同步、回复矩阵、图稿和本地交付，再生成署名与匿名投稿包、核对 DOCX 哈希并重开 SQLite。另有标准离线任务覆盖文献导入、阅读、方法计划、实验、写作、审稿与导出，以及取消、重启、来源变更、恶意 PDF 和外部写入回执等故障路径。

模型输出、部分远端来源响应和科学数据由受控夹具提供。人工闸门使用显式测试人工上下文；垂直交付用例直接设置已接受的外审状态以聚焦交付。它们证明工程行为，不证明真实研究者已完成科学审核，也不证明在线模型的科研质量或成功率。外部反馈/实验回流另由各功能提交中的专项与 Electron 界面回归覆盖。

Electron smoke 使用隔离数据根及本地 stub provider，启动的是本地构建；不验证默认用户资料、Finder 打包启动、签名或发布。IME 检查为合成 DOM 事件，未操作系统输入法。本次没有对外投稿、发布数据或部署应用。

## 交付与清理

保留上述功能合同、调研出处、测试源文件和提交历史。完成验证后删除本任务临时计划、原始调研资料和可明确归属的测试中间产物；保留无关计划、既有运行产物和共享工具链。收尾前以 SHA-256 核对 38 个已有无关修改文件，确认未被本任务改变，也不纳入本任务提交。
