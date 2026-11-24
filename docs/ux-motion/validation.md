# UX 与动效阶段验证

实施起点 `3eb8fd6ba1f6f5315ea7670f26c165994c2d34ef`。以下命令的工作目录均为
`/Users/Apple_501/Desktop/Roc/Roc`。阶段提交只包括正式源码、合同、可复跑工具、
必要回归与固定测量报告；临时资料根、逐轮诊断、原始 trace 与截图核验后清理。

## P0：基线与状态合同

状态：**Verified passing（自动化范围）**，2026-11-25。

建立 35 个 surface 合同、402 个 Renderer 源文件的 AST 索引（2126 个模板/路由）、
动效生命周期、风险优先级和普通生产采样。Renderer 外观未修改。采样器使用真实
Electron 输入与 CSS 命中核验；修复关闭后读取 Playwright process 的清理问题。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build` | 普通生产构建通过，含项目技能检查和 TypeScript 7.0.2 typecheck |
| `pnpm check:renderer-chunks` | 通过；eager JS 517980 bytes / 11 files |
| `node --test tests/unit/performance-electron-lifecycle.test.mjs` | 7/7 通过 |
| `node --check scripts/performance/bench-ui-motion.mjs` | 通过 |
| `node --check scripts/ui-audit/index-interactions.mjs` | 通过 |
| `node scripts/ui-audit/index-interactions.mjs --check` | 源码与 35 个合同快照一致 |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/baseline-2026-11-24.json --samples 5` | 八场景各五轮完成，0 blocked / 0 missing feedback |
| `git diff --check` | 通过 |

[正式报告](baseline-2026-11-24.json)固定 commit、lockfile、构建/仪器/夹具摘要与宿主。
M1 Pro / 32GiB / macOS 27.2.1；AC 供电、低功耗关闭；原生内容区 1440×900，
CSS 宽布局 1440×900、抽屉 720×450。Electron 显示元数据约 120Hz。

| 场景 | 五轮 RAF P95 最大（ms） | 五轮反馈 P95 最大（ms） | 拖动区间写入 |
| --- | ---: | ---: | ---: |
| 项目小列表置顶/取消 | 9.4 | 6.3 | 0 |
| 项目菜单反向 | 9.3 | 8.5 | 0 |
| 左抽屉反向 | 9.3 | 8.4 | 0 |
| 助手鼠标反向 | 9.3 | 8.3 | 0 |
| 助手键盘反向 | 9.3 | 8.2 | 0 |
| 分栏拖拽 | 9.3 | 9.0 | 20 |
| 分栏 Escape 回滚 | 9.3 | 8.2 | 21 |
| 500 历史 / 500 流式增量完成 | 9.4 | 5.5 | 0 |

全部动作窗口 ≥50ms 主线程任务及 RAF >50ms 间隔均为 0。流式每轮一个真实请求，
终态来自 `run_completed`，当前可见消息行有界。基线确认 F02 的每帧同步存储，
未测得当前窗口掉帧；不将风险推测写成性能故障。F17 是输入坐标校准问题，
没有证实助手按钮被搜索覆盖。

未完成：实际显示帧/合成帧、独立 60Hz 与低功耗采样、另一代 Mac、物理触控板、
中文 IME、VoiceOver、真人八旅程及外部服务。自动化 RAF 和受控 SSE 不能替代。
未重跑全业务 Renderer 套件；共享与全业务门禁集中到 P6。
