# 开发与检查

所有命令从仓库根目录执行。安装和启动见[根 README](../README.md)，Node 版本见 [.node-version](../.node-version)，pnpm、依赖及脚本以 [package.json](../package.json) 和锁文件为准。本页维护检查方法；通过结论必须来自对应代码版本的新运行。

## 按变更选择检查

| 变更 | 命令与范围 |
| --- | --- |
| 文档 | 核对源码、脚本参数、本地链接及锚点；执行 `git diff --check` |
| 类型与构建 | `pnpm typecheck`；`pnpm build` 同时检查阶段 Skill、类型并构建主进程、preload 和 renderer |
| 阶段 Skill | `pnpm check:skills`；正文、manifest 与 catalog 必须一致，见[内置技能](builtin-skills.md) |
| IPC | `pnpm check:ipc`；合同改变后执行 `pnpm generate:ipc` 并检查调用方 |
| 领域逻辑 | `pnpm test:unit`，或选择相关 `tests/unit/*.test.mjs` |
| Renderer | `pnpm test:renderer`；构建后执行 `pnpm check:renderer-chunks`，界面变更检查实际尺寸、键盘和主题 |
| 文献获取 | `pnpm test:literature-acquisition`；完整入库接缝见[文献自动入库](research-literature-acquisition.md) |
| 科研生产链 | `pnpm test:research-p0`，包含构建，要求真实[科研工具链](../resources/research-runtime/README.md) |
| 系统性综述 | `pnpm test:review-workflow`，配合相关 renderer 测试 |
| 计算资源与原生边界 | `pnpm test:research-resources`、`pnpm test:research-environment-boundaries`、`pnpm test:research-native-code` |
| 评测框架 | `pnpm evaluation:check`；各套件的准备、检查与运行见[评测指南](../evaluation/README.md) |
| 原生打包 | `pnpm verify:arm64-only`、`pnpm verify:native-packaging`；打包流程见[发布指南](github-releases.md) |
| 完整本地测试 | `pnpm test`：unit、renderer 与 Electron smoke |

壳层专项入口为 `pnpm verify:p3-workspace`、`pnpm verify:p4-assistant`、`pnpm verify:p5-literature`、`pnpm verify:p8-settings`、`pnpm verify:p9-management`；根据受影响表面选择。先完成构建，再执行依赖 `dist/` 的测试，避免构建替换文件造成读取失败。

`check:renderer-chunks` 检查首屏静态依赖及应用入口 chunk，包括懒加载画布和面板；预算由[脚本](../scripts/check-renderer-chunks.mjs)维护。编辑器按入口拆分，Mermaid 解析器和 ELK 的上游单模块仍可能产生 Vite 体积警告。升级依赖后须核对实际依赖图和产物。

## 测试替代行为

Electron smoke 用隔离 `ROC_DATA_ROOT` 启动，夹具入口是 [tests/smoke/lib/fixtures.mjs](../tests/smoke/lib/fixtures.mjs)。`ROC_SMOKE=1` 启用以下替代行为：

| 位置 | 行为 |
| --- | --- |
| [files-ipc.ts](../src/main/ipc/files-ipc.ts) | 文件选择返回测试工作区的 `assets/smoke-image.png` |
| [shell-ipc.ts](../src/main/ipc/shell-ipc.ts) | 原生确认框自动同意并记录请求 |
| [runtime-tools/index.ts](../src/main/plugins/runtime-tools/index.ts) | 拒绝 trusted-host 授权，返回 `trusted_host_approval_unavailable_in_smoke` |
| [chromium-runtime-flags.ts](../src/main/chromium-runtime-flags.ts) | 提供远程调试端口 |
| [macos-environment.ts](../src/main/macos-environment.ts) | 跳过登录 shell 的 PATH 采集 |
| [main-kernel-bootstrap.ts](../src/main/main-kernel-bootstrap.ts) | 标记 smoke 启动态 |

这类测试证明受控路径，真实原生对话框和外部客户端互操作需要单独运行。科研生产链的真实工具与模拟响应范围见[集成测试](../tests/integration/README.md)。

## 性能、科学质量与外部服务

日常回归保留行为和资源计数断言，性能重复采样按需开启：`config-snapshot` 与 `embedding-batch` 默认各跑两轮，`paper-reader` 的同页选区默认执行十次。分别设置 `ROC_PERF_CONFIG_REPORT`、`ROC_PERF_EMBEDDING_REPORT`、`ROC_PERF_PDF_REPORT` 为新的 JSON 输出路径，再运行对应测试文件，即恢复二十轮采样（PDF 共一百次选区）并生成报告。Embedding 的纯归一化计时也仅在报告模式执行。

性能方法集中在[性能测量](research-performance.md)。文献抓取和离线相关性评估见[检索融合](research-literature-fusion.md)；Scientific RAG 的数据资格和对照方法见[专题索引](scientific-rag/README.md)。工程 fixture、执行成功和来源校验分别提供不同证据，不能代替独立科学评价。

| 范围 | 额外准备与证据 |
| --- | --- |
| 真实模型及完整科研质量 | 冻结资料、问题、模型、工具、预算和评分合同，独立人工参考与原始运行证据；要求见[评测指南](../evaluation/README.md) |
| R / Julia / Python | 对应真实解释器、环境与锁文件；受控探针只证明其覆盖的执行边界 |
| Zotero | 真实客户端、原生文件选择和附件互操作 |
| Provider / Hugging Face / OpenReview | 目标服务与具体资源的访问条件、真实请求/响应；服务合同 fixture 不证明公网可用性 |
| Zenodo | 官方 sandbox 的隔离账号及目标授权；公开发布需要具体包和远端目标的独立批准 |
| 外部 Trace | 接收目标、允许字段与传输授权；本地导出不能证明远端接收 |
| 性能代表性 | 扫描 OCR、真实用户库、缓存状态与真实服务负载；小样本工程测量不能外推全部工作负载 |

## 运行产物

生成目录按需创建，不要求保留空目录；`pnpm verify:paths` 只检查仓库必需输入。清理前先退出占用目标的开发、测试、打包进程，逐项核对路径和用途。

| 路径 | 用途与清理边界 |
| --- | --- |
| `dist/`、`release/` | 编译和打包输出；无需保留该构建时可删除。分别用 `pnpm build`、`pnpm package:mac` 重建，依赖产物的检查须先构建。 |
| `.artifacts/` | 测试截图、日志与专项输出；可删除已结束且不再用于验收、对照或独立重评分的批次，测试会重建各自输出。 |
| `.runtime/pnpm-cache/`、`.runtime/pnpm-store/` | 包元数据缓存与依赖内容存储；缓存可重新获取，store 优先用 `pnpm store prune` 回收。清理后再次安装可能需要网络；`node_modules/` 是当前开发依赖。 |
| `.runtime/research-toolchain/`、`.runtime/research-models/` | 构建、解析与原生 smoke 的实际输入，不能当临时文件整目录清空；准备方法见[科研运行时](../resources/research-runtime/README.md)。 |
| `.runtime/` 下其他子目录 | 按所属命令判断；已结束的临时工作区、废弃工具副本和空目录可清理。数据库迁移目录若含快照或备份，按[数据库维护合同](database-storage.md)保留。 |
| `evaluation/` | 定义与源码保留；下载来源、语料、审核材料、有效运行证据分别按[评测保留规则](../evaluation/README.md#保留与验证)处理，不能整目录删除。 |
| 根目录 | 保留源码入口、构建配置、锁文件、维护文档和本机工具配置；`.DS_Store` 与本次工作产生的临时文件可清理。 |

`scripts/` 保留构建、测试、维护和可重跑的评测入口。仅绑定已丢失历史输入或不存在 Git 基线、且无当前调用方的专项脚本已移除；不要仅凭未列入 `package.json` 判断脚本无用。

重跑使用新的输出路径，并检查参数及全部输入。固定结果 JSON 不能代替原始输入或当次执行；缺少原始资料时不能续跑、比较或独立重评分。清理输出后不再据旧报告声明当前验收通过。
