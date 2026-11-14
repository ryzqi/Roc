# 开发验证入口与验收边界

在仓库根目录运行以下命令。工具版本、完整脚本及依赖以 [package.json](../package.json)、[pnpm-lock.yaml](../pnpm-lock.yaml) 为准；启动准备见根 [README](../README.md)。本页列出验证方法，不表示这些检查已在当前工作区执行。

## 按变更选择检查

| 变更 | 入口与目的 |
| --- | --- |
| 文档 | 核对源码/命令、相对链接与归档引用，执行 `git diff --check`；文档校验不证明运行行为 |
| 类型与构建 | `pnpm typecheck`；`pnpm build` 同时检查随包技能与类型并构建 Electron |
| IPC 合同 | `pnpm check:ipc`；修改生成源后用 `pnpm generate:ipc` 并核对消费者 |
| Renderer | `pnpm test:renderer`；构建后 `pnpm check:renderer-chunks`；界面变更再执行相关壳层闸门 |
| 领域逻辑 | `pnpm test:unit`，或 `node --test tests/unit/<专题>.test.mjs` 选择实际存在的测试文件 |
| 真实科研生产链 | `pnpm test:research-p0`（包含构建）；使用实际工具链验证解析、生产、审批与导出 |
| 系统性综述 | `pnpm test:review-workflow`；配合 [renderer 测试](../tests/renderer/) 验证用户决定与来源变化 |
| 计算资源与原生边界 | `pnpm test:research-resources`、`pnpm test:research-environment-boundaries`、`pnpm test:research-native-code` |
| 助手工程评估 | [Native](../evaluation/adapters/native/run.mjs)：`pnpm evaluation:native:check`（94 项确定性合同）；[S01](../evaluation/adapters/s01/check.mjs)：`pnpm evaluation:s01:check`（离线数据审计）；统一工作流、真实模型与独立 benchmark 的配置见 [evaluation](../evaluation/README.md) |
| 冻结向量检索回归 | [Frozen retrieval](../evaluation/adapters/frozen-retrieval/check.mjs)：`pnpm evaluation:frozen-retrieval:check <frozen-corpus.json> <report.json>`；指标 API 见 [index.mjs](../evaluation/adapters/frozen-retrieval/index.mjs)，覆盖冻结输入的生产排序与工程回归 |
| 完整本地测试 | `pnpm test`；包含 unit、renderer 与 Electron smoke，不能替代外部服务互操作 |

壳层闸门：`pnpm verify:p3-workspace`、`pnpm verify:p4-assistant`、`pnpm verify:p5-literature`、`pnpm verify:p8-settings`、`pnpm verify:p9-management`。根据受影响表面选择；旧阶段页的 P6/P7 闸门已删除。

性能和检索回归使用不同入口：`research:*bench` 测量耗时与资源，`research:retrieval-eval` 评估文献融合冻结协议，`evaluation:frozen-retrieval:check` 使用预先捕获的向量验证生产检索排序。后者属于 `frozen-embedding` 工程回归，不测量真实线上 ingestion、embedding 生成或建索引质量。完整命令和保存产物见[性能基线](research-performance.md)与[文献融合](research-literature-fusion.md)。不能用通过工程 fixture 的成绩代替独立人工审核的真实科研质量。

## Smoke 的确定性边界

测试以 `ROC_DATA_ROOT=<临时目录>` 启动，夹具管理见 [tests/smoke/lib/fixtures.mjs](../tests/smoke/lib/fixtures.mjs)。产品中 `ROC_SMOKE` 的替代行为须与实际使用它的脚本一同维护。

| 位置 | 替代行为 |
| --- | --- |
| [files-ipc.ts](../src/main/ipc/files-ipc.ts) | 文件选择返回测试工作区的 `assets/smoke-image.png` |
| [shell-ipc.ts](../src/main/ipc/shell-ipc.ts) | 原生确认框自动同意并记录请求 |
| [chromium-runtime-flags.ts](../src/main/chromium-runtime-flags.ts) | 打开远程调试端口 |
| [macos-environment.ts](../src/main/macos-environment.ts) | 跳过登录 shell 的 PATH 采集 |
| [main-kernel-bootstrap.ts](../src/main/main-kernel-bootstrap.ts) | 启动态标记为 smoke |

因此 smoke 可以证明受控路径，却不能证明真实原生对话框或外部客户端已验收。

## 尚需独立验收的范围

这些缺口从旧实施记录保留；文档整理没有补做验收。实际进度须由对应运行的协议、环境与产物确认。

| 范围 | 所需证据或条件 |
| --- | --- |
| ROC-PR-03 完整数据 | 满足任务族配额的 200 项冻结数据、独立来源簇、split、许可与独立审核；工程 fixture 不充当独立科学样本 |
| L2 pilot / 完整真实模型 / L3 | 隔离凭证、可信计价或硬费用上限、固定模型/环境/目标与费用授权；L3 另需独立操作与放量授权 |
| 检索、长期上下文、注入/反证、综述与论证质量 | 独立人工标注、原始资料与领域盲审 |
| R / Julia | 对应真实解释器、项目锁文件与包环境；C 边界探针不能替代科学执行验收 |
| Zotero | 真实客户端、原生选择框与附件互操作记录 |
| Provider / Hub / OpenReview | 有界真实环境集成记录与具体资源的访问/许可决定；官方合同探测不等于全面互操作 |
| Zenodo | 官方 sandbox 隔离账号与目标授权、真实 safeStorage 集成；公开发布另需针对具体交付包和远端目标批准 |
| 外部 Trace | 接收目标、字段范围与传输授权；本地导出不证明远端链路 |
| 更广性能与科学代表性 | 代表性扫描 OCR、真实用户库/模型缓存、真实 Provider 延迟和科学 PDF 标注；历史 P3 外部文件刷新曾测得 474 ms，高于 ≤200 ms 目标；本次未复验，其余基线见性能文档 |
