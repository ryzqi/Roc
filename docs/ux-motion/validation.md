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
| 100 项集合筛至约 11 项置顶/取消 | 9.4 | 6.3 | 0 |
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

## P2：事件刻度、受控反馈与 AST 审查

状态：**Verified passing（定向自动化范围）**，2026-11-25。

七个事件预设与 CSS 刻度建立可检查映射，已有 modal、drawer、popover、scrim 和
selection 导出保留原节奏。13 个局部 duration utility 显式迁移到 `ui-motion-*`，
分隔条两处 `transition-all` 缩为 opacity/transform；附件使用的 standard 曲线补齐。
AST 审查复用现有 Babel 解析器，不增加依赖、运行时 CSS 解析或自动生成报告。

`ActionStatus` 统一文字、图标和可访问语义；`TransientStatus` 只按真实完成身份收起成功。
ErrorBar、DelayedFallback、设置保存栏三个入口接入，保留原恢复动作、反闪烁延迟与保存锁。
外层已拥有 live region 时内层不重复播报。错误和脏内容常驻，成功换对象或到期后清理，
没有对流式文字或每次计数更新播放动画。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build` | 普通生产构建通过，包含 typecheck |
| `pnpm check:renderer-chunks` | 通过；eager JS 521590 bytes / 14 files |
| `node --test tests/unit/motion-contract.test.mjs tests/unit/ui-audit.test.mjs` | 7/7；刻度与旧别名、AST 静态表达式和失败输入 |
| `pnpm audit:motion` | 403 files，0 violations，0 input failures |
| `ROC_UI_AUDIT_DIR=/tmp/roc-ux-p2-gallery-20261125 node --test --test-concurrency=1 tests/renderer/page-ui.test.mjs tests/renderer/action-button.test.mjs` | 7/7；原生按钮/表单、单一 live region、真实成功到期/再次完成/换对象、持久错误与减少动态效果 |
| `node --test --test-name-pattern='^validation jumps\|^transient settings writes\|^discard requires' tests/renderer/radix-settings-dialog.test.mjs` | 3/3；失败保存保留草稿后重试、写入锁与放弃确认 |
| `node scripts/ui-audit/index-interactions.mjs --write`、`--check` | 403 源文件、2152 模板/路由、35 合同，快照与当前源码一致 |
| `git diff --check` | 通过 |

读回浅深主题 1440 宽画廊截图；桌面尺寸与 320px 长内容容器裁切检查通过。
24 张任务截图与画廊临时构建核验后清理，正式夹具和必要回归保留。P2 不重复五轮
性能采样或全业务回归；P3 的反向面板、P4/P5 调用点和 P6 汇总门禁继续执行。
AST 只覆盖静态 class 表达式及本文件初值，不将 CSS/动态运行路径或物理读屏声称为已验收。

## P3：壳体反向、一次持久化与轻量导航

状态：**Verified passing（定向自动化与当前机器生产采样范围）**，2026-11-25。
所有命令在仓库根 `/Users/Apple_501/Desktop/Roc/Roc` 执行。

浮动左右栏和遮罩用 CSS 离散显示过渡保留退出视觉，关闭立即隔离交互，重开保持节点与草稿；
workspace 边界裁切避免进入位移临时扩大页面横向滚动范围。共享模态框读取实时 presence，
逻辑关闭立即还焦点，管理抽屉与放弃确认同时退出后重开不会被旧恢复抢焦点。
原生 popover 同步 beforetoggle 交互状态，设置 Radix FocusScope 保留原退出生命周期。

分栏每帧只更新视觉，释放一次持久化；Escape、pointercancel、换项目和分隔条卸载
回滚尺寸且不写中间值。拖动时收起左栏单独保存折叠基线，取消尺寸不会重新展开。
导航共用实例隔离指示条，画布冷加载保留旧宿主和目标提示，ready 后只淡出轻量遮层。
设置分区淡入新表单。项目置顶仅完整集合 ≤20、显示 ID 不变且前后位置可见时局部过渡，
大集合直接更新，快速反向、滚动和减少动态效果取消旧动画，焦点按项目 ID 保留。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build`、`pnpm check:renderer-chunks` | 最终普通生产构建/typecheck 通过；eager JS 529804 bytes / 31 files，单入口预算通过 |
| `node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/canvas-view-loading.test.mjs tests/renderer/project-session-layout.test.mjs` | 画布 11/11、项目 10/10；初次 workspace 的两个失败已修正并由下行最终构建验证 |
| `ROC_UI_AUDIT_DIR=/tmp/roc-ux-p3-workspace-20261125 node --test tests/renderer/workspace-frame.test.mjs` | 6/6；深浅、宽窄/断点、零横向溢出/裁切、draft 保活、0/1 写入、取消/收起/换项目、退出中反向及 reduced motion |
| `node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/artifact-dock.test.mjs` | 工件 5/5；workspace 初次最后一项的夹具时序失败由上一行修正后验证 |
| `node --test --test-name-pattern='^resize \|^Escape closes the model\|^remote model dialog\|^modal ' tests/renderer/desktop-interactions.test.mjs` | 8/8；原生编辑/披露、模态退出隔离、50ms 重开后焦点不被旧退出抢走 |
| `node --test --test-concurrency=1 --test-name-pattern='^management \|^activity \|^selection \|^settings restores \|^short shared confirmation\|^settings dialog layers focus\|^nested settings Escape\|^reset confirmation\|^discard requires confirmation' tests/renderer/shell-management-guards.test.mjs tests/renderer/radix-settings-dialog.test.mjs` | 7/7；设置快速双分区、单表单、guard、共享确认/嵌套焦点，活动与任务入口 |
| `node --test --test-name-pattern='^reopening management\|^actual shell assistant\|^actual shell management' tests/renderer/shell-management-guards.test.mjs` | 3/3；真实管理抽屉/确认同时退出、50ms 父层重开、旧确认卸载后保留新编辑器焦点 |
| `pnpm audit:motion`、`node scripts/ui-audit/index-interactions.mjs --write`、`--check` | 404 源文件；0 motion violations / 0 input failures；2152 模板/路由、35 合同，静态快照一致 |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p3.json --samples 5` | 8 场景 ×5 轮全部完成；0 blocked / 0 missing feedback；每轮流式一次真实请求 |
| `git diff --check` | 通过 |

初次新增 workspace 用例在断点的 resize effect 安装前操作抽屉，并依赖上一用例草稿，
已改为自包含且等待实际 drawer 模式与焦点。重开首焦点沿用原 close button 合同，
没有改弱隔离或草稿断言。深浅 1440/1184 截图读回后，4 张任务截图与临时构建日志清理。

[正式 P3 对照](after-p3.json)使用 P0 同一普通构建模式、M1 Pro/32GiB、AC/低功耗关闭，
记录实际 Electron 45.3.4 / Chromium 156.0.8078.100。全部动作窗口 ≥50ms 主线程任务
与 RAF >50ms 间隔均为 0，流式终态来自 `run_completed`，挂载行数有界。

| 场景 | P0 → P3 五轮 RAF P95 最大（ms） | P3 反馈 P95 最大（ms） | P3 拖动内 / 总写入 |
| --- | ---: | ---: | ---: |
| 大项目集合过滤后置顶/取消 | 9.4 → 9.6 | 7.8 | 0 / 0 |
| 项目菜单反向 | 9.3 → 10.0 | 15.9 | 0 / 0 |
| 左抽屉反向 | 9.3 → 10.1 | 8.9 | 0 / 0 |
| 助手鼠标反向 | 9.3 → 10.1 | 8.5 | 0 / 0 |
| 助手键盘反向 | 9.3 → 10.1 | 7.6 | 0 / 0 |
| 分栏拖拽 | 9.3 → 9.4 | 9.3 | 0 / 1 |
| 分栏 Escape | 9.3 → 10.0 | 10.0 | 0 / 0 |
| 500 历史 / 500 流式完成 | 9.4 → 10.0 | 5.8 | 0 / 0 |

RAF P95 最大增加 0.8ms，菜单反馈代理从 8.5ms 增至 15.9ms；没有隐藏该变化，
当前仍在 20ms RAF / 100ms 反馈起始预算内。P3 消除了每帧同步偏好写入，
不由此声称物理 120Hz 达标或全量“无性能回退”。小集合动画由 Renderer 回归单独验证，
生产 `project-reorder` 仍是 100 项完整集合的过滤场景。5000 历史、长时资源、
物理触控板/IME/VoiceOver、另一台 Mac 和真人八旅程继续在后续阶段或实机范围验收。
