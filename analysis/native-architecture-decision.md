# Roc 原生感长期架构决策

日期：2026-06-04

## 背景

本决策执行 `analysis/optimization-plan.md` 的阶段 3：评估是否引入 Rust 核心层，以及是否从 Electron 迁移到原生外壳 + 系统 WebView。

已完成的 P1 事实：

- `ecc6332`：终端输出按 16ms 批量合并，减少高频 IPC 边界穿越。
- `5ccec29`：renderer 手动 chunk + Workbench 工具懒加载；构建输出中入口 JS 从约 1.85 MB 降到约 1.11 MB，并拆出 `renderer-terminal`、`renderer-diff`、`renderer-markdown`。
- `9c36909`：窗口材质按 `mica -> acrylic -> static background` 降级。
- `efcf5df`：IPC channel 从 `src/shared/ipc-schema.json` 生成，`pnpm check:ipc` 防止 drift。

对应原则：

- T1：渲染表面以下的窗口、材质、托盘、热键仍受 Electron 抽象限制。
- T2：IPC channel 已开始单 schema 化，但 preload API 类型仍是手写。
- T4：继续以可感知启动、窗口显示、IPC 延迟为优化目标。
- T5：React + Vite 的短迭代循环是当前产品速度优势。
- T8：Electron/Chromium 是基线成本，当前工作优先处理 margin cost。

## 决策 1：暂不引入 Rust 核心层

结论：不启动 P2.1。

理由：

- 当前没有已验证的 CPU 密集瓶颈。主要链路仍是 AI、文件 I/O、SQLite、Git、终端和 renderer 交互。
- 已发现的 margin cost 可以在 TypeScript/Electron 内解决：IPC 批处理、renderer chunk、schema 生成、窗口材质 fallback。
- 引入 Rust 会新增构建、打包、ABI、签名、测试矩阵和跨语言调试成本；没有性能证据支撑这笔成本。

触发条件：

- `pnpm smoke:performance` 或 packaged smoke 显示某个 CPU 绑定本地算法 p95 超过 200ms，且 JS 优化后仍不可接受。
- 文件索引、模糊搜索、压缩、加密、语法分析成为主要耗时。
- 需要把同一算法共享到移动端或服务端。
- Node private bytes 或 GC 暂停成为可复现的交互卡顿来源。

下一步：

- 保留 Node-API/Rust 原型选项，但只在上述触发条件成立后启动。
- Rust 原型必须先做单模块 A/B：同一输入、同一业务结果、同一 smoke 证据。

## 决策 2：暂不迁移到原生外壳 + 系统 WebView

结论：未来 3 个月继续执行 Electron 渐进优化，不启动 P3 迁移。

理由：

- 当前 P1 已降低 renderer 初始负载，并把 IPC/channel drift 风险收窄；还没有证据说明 Electron 抽象已经成为产品阻塞。
- 迁移需要 Swift/AppKit + C#/WPF 或 WinUI 双外壳，预计至少 2 人 6-12 个月；当前计划没有资源承诺。
- T5 的短迭代循环是 Roc 主要优势。迁移必须证明 HMR、renderer 复用、packaged smoke 和开发速度不退化。

触发条件：

- 产品定位明确转为“原生优先的专业桌面工具”，且用户反馈持续指出网页感不可接受。
- packaged 性能目标连续不达标：热键响应 > 100ms、窗口显示 > 400ms、非 I/O IPC > 50ms，且 Electron 内优化无法解决。
- 需要 Electron 无法稳定提供的系统级能力，例如更强窗口材质控制、原生辅助功能桥、系统 WebView 生命周期控制。
- 团队明确投入至少 2 名工程师 6 个月，并接受双轨维护和功能冻结窗口。

下一步：

- 继续方案 C：保留 Electron，完成 P0/P1 后收集用户反馈和 packaged 性能数据。
- 重新评估日期：2026-09-04。
- 若触发迁移评估，先做 1 个月原型，不直接全量迁移。原型必须验证 React bundle 加载、HMR、基础 IPC、窗口材质、托盘/热键、packaged smoke。

## 当前架构方向

短期方向：Electron + React + TypeScript，继续优化 margin cost。

长期方向：把 schema、性能预算、packaged smoke 和 native-feel scorecard 作为决策门槛。只有当数据证明 Electron 内优化不足时，才进入 Rust 或原生外壳迁移。
