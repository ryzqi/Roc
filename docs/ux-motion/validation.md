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

## P1：误触、派生输入与诊断分层

状态：**Verified passing（定向自动化范围）**，2026-11-25。

取消整个科研任务先确认当前对象和影响，暂停保持一键；任务身份或状态变化清除旧确认，
清理等待/失败阻止恢复。新建项目明确选目录后为空标题建议目录名，研究目标仍必填。
文献引用键保留人工改写（包括空值），可以恢复自动派生。超过 12 项的项目菜单提供
本地搜索、清空和当前标记；设置只记录最近合法导航分区，拒绝草稿切换不写偏好。
RAG、Wiki、监控和 Zotero 的底层字段收进原生诊断，业务状态、错误、来源和回执保留。

新确认回归复现了开发 StrictMode 的真实焦点缺口：取消优先聚焦后，模拟
`disconnectPassiveEffect` 清理又还焦点到背景。共享恢复组件现在保留首次打开者，
依据实际 panel DOM 脱离文档判断卸载，不增加计时器；父级直接卸载仍正常恢复。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build` | 最终源码普通生产构建通过，包含 typecheck |
| `pnpm check:renderer-chunks` | 通过；eager JS 519156 bytes / 10 files |
| `node --test --test-concurrency=1 tests/renderer/research-tasks.test.mjs tests/renderer/literature-import-state.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/retrieval-workspace.test.mjs tests/renderer/wiki-pages.test.mjs tests/renderer/research-monitors.test.mjs tests/renderer/zotero-import.test.mjs` | 141 项中初次 137 通过；四项失败完成修正并定向重跑，见下行 |
| `node --test --test-concurrency=1 --test-name-pattern='project menu searches\|DOI target selection\|source-state UI displays truthful' tests/renderer/project-session-layout.test.mjs tests/renderer/research-monitors.test.mjs tests/renderer/zotero-import.test.mjs` | 项目和监控 2/2；Zotero 的缺失 expect 导入补齐后由下一命令验证 |
| `node --test --test-name-pattern='source-state UI displays truthful' tests/renderer/zotero-import.test.mjs` | 1/1，通过原值披露、缺失/版本/集合状态及宽窄深浅布局 |
| `node --test --test-concurrency=1 tests/renderer/project-session-layout.test.mjs tests/renderer/radix-settings-dialog.test.mjs` | 设置 29/29；项目搜索在最终原生焦点/关闭同步修正后由上面定向命令验证 |
| `node --test --test-name-pattern='task cancellation requires a deliberate confirmation for the current task' tests/renderer/research-tasks.test.mjs` | 1/1；打开、Escape、保留、任务切换零取消；确认一次；真正卸载仍还焦点 |
| `node --test --test-name-pattern='Escape closes the model popover\|remote model dialog above settings\|^modal ' tests/renderer/desktop-interactions.test.mjs` | 5/5；模型/嵌套弹层、初焦点与滚动恢复 |
| `node --test --test-name-pattern='^short shared confirmation\|^settings dialog layers focus\|^nested settings Escape\|^reset confirmation\|^discard requires confirmation' tests/renderer/radix-settings-dialog.test.mjs` | 5/5；共享确认、设置嵌套与焦点 |
| `node scripts/ui-audit/index-interactions.mjs --check`、`git diff --check` | 通过；当前 2146 个静态模板/路由，35 个合同 |

原生披露断言先通过键盘或点击打开，再等待对应原值可见；没有弱化版本、回执或操作断言。
项目菜单回归等待原生关闭及再次打开聚焦，不用固定 sleep。查看了窄窗监控和 Zotero
来源状态截图，现有裁切检查通过；任务生成的截图、夹具目录和诊断日志随后清理。
RAG 设置的低影响文字分层完成源码审阅，沿用设置回归；没有另造只重复展示实现的测试，
其后端计数诊断的独立运行场景仍保留待验证。
完整合同仍包含未测的物理输入、VoiceOver、真人任务和外部服务；不由本阶段成绩推导全量通过。
