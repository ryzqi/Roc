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

## P4：当前执行反馈、审批与清理状态

状态：**Verified passing（定向自动化与当前机器生产采样范围）**，2026-11-25。

Composer 发送、回复、纠正和追加共用受控按钮与状态反馈；捕获本次提交意图，
本地请求及父级 pending 都结束后才清理。停止仍可聚焦，等待真实运行确认。
工具、Hook 与子 Agent 的 busy 同时依据当前消息和本身/祖先活动；历史或完成后
停止旋转和 live 播报，原生披露、用户折叠选择与工具身份保持。审批共享
pending/error 展示，保留决定、版本、hash 和焦点规则，历史说明使用静态 note。

任务使用纯显示投影，不修改持久化状态：`cleanup_pending` 显示“正在取消”并归当前，
`cleanup_failed` 显示“资源清理未确认”并归失败；确认清理后的取消才归历史。
助手、任务摘要、总览和任务中心共用该口径；总览不会漏掉已取消但仍等待清理的任务，
未确认清理时不提供继续。刷新 pending/错误保留可读的既有任务，重试和回执合同不变。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build`、`pnpm check:renderer-chunks` | 普通生产构建/typecheck 通过；eager JS 530710 bytes / 31 files |
| `ROC_UI_CAPTURE_DIR=/tmp/roc-ux-p4-captures-20261125 node --test --test-concurrency=1 tests/renderer/assistant-activity-layout.test.mjs tests/renderer/assistant-panel-guards.test.mjs tests/renderer/research-tasks.test.mjs tests/renderer/task-center.test.mjs tests/renderer/project-overview.test.mjs` | 初次 57 项中 55 通过；两处 idle ARIA 编码断言修正后由下行验证 |
| `ROC_UI_CAPTURE_DIR=/tmp/roc-ux-p4-captures-20261125 node --test --test-concurrency=1 --test-name-pattern='^task and event cursor pages\|^source failure keeps' tests/renderer/research-tasks.test.mjs tests/renderer/task-center.test.mjs` | 2/2；pending=true/禁用、持久错误、重试、跨项目旧响应隔离及恢复可用通过 |
| `ROC_UI_CAPTURE_DIR=/tmp/roc-ux-p4-captures-20261125 node --test --test-name-pattern='^composer \|^IME confirmation \|^running offers \|^running rejects ' tests/renderer/desktop-interactions.test.mjs` | 12/12；即时重复请求、意图切换、拒绝保留草稿、附件读取/换 scope、合成 IME 守卫与运行纠正 |
| `pnpm audit:motion` | 405 files，0 violations / 0 input failures |
| `node scripts/ui-audit/index-interactions.mjs --write`、`--check` | 405 源文件、2174 模板/路由、35 合同，当前静态快照一致 |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p4-history-5000.json --samples 5 --history-messages 5000 --stream-chunks 500` | 八场景各五轮完成；0 blocked / 0 missing feedback；每轮流式一次真实请求 |
| `git diff --check` | 通过 |

两处失败要求 idle 按钮显式设置 `aria-busy="false"`，而原共享按钮省略该属性，
ARIA 默认即为空闲。修正为恢复 enabled 且无 busy=true，保留 pending 和重复派发断言，
没有修改共享按钮行为。真实助手回归同时通过三类审批 pending/焦点、用户上滚接管、
运行完成竞态与跨会话草稿/旧响应隔离。深浅任务和窄窗诊断截图读回，裁切为 0；
19 张任务截图/诊断 JSON 与本次构建、测试及采样日志核验后清理。

[P4 长历史报告](after-p4-history-5000.json)沿用同一普通生产构建、宿主和动作协议，
历史夹具增至 5000，流式增量仍为 500，不能与 P0 的 500 历史视为同一负载。
八场景五轮 RAF P95 最大 10.3ms、反馈代理 P95 最大 15.9ms；流式窗口
RAF P95 最大 10.2ms、P99 最大 16.3ms、反馈代理最大 5.5ms。全部 ≥50ms
主线程任务与 RAF >50ms 间隔均为 0，终态来自 `run_completed`；流式终点挂载
消息行每轮 1 行，总 DOM 点采样最多 2303。拖动内 0 写、释放 1 写、Escape 0 写。
heap/process 指标仅为点采样，不据此声称长期资源稳定或屏显 120Hz 达标。
P3 已覆盖 500 历史五轮，本阶段不重复相同负载；最终对照、完整 Renderer 和物理
触控板/IME/VoiceOver、另一台 Mac、真人旅程及外部服务范围在 P6 明确列出。

## P5：文献、阅读、创作与工件的真实反馈

状态：**Verified passing（定向自动化范围）**，2026-11-25。

发现搜索、候选、批量引用、导入/处理和 Zotero，PDF 工具/译文、RAG/Wiki，
编译、文件保存、Git、终端以及发布清单和技能管理接入共享受控反馈。
`ActionButton` 的 `unstyled` 变体保留调用者的几何与焦点样式，仍有原生
loading/disabled/aria-busy 合同。相邻按钮旋转时状态文字不重复 spinner，
终端 overlay 不重复顶部 live 播报；历史回执、错误和已保存来源不新增到期计时器。

入库回执不表示索引完成；翻译准备不表示译文完成；取消等待真实终态；另存框
返回 null 不报导出成功；文件保存依据实际 recoveryPoint；发布请求接受不表示
ZIP 已交付。复用现有 job/source/generation/revision、busyRef、请求和草稿守卫，
没有新增服务状态或锁。虚拟行、PDF 翻页/选区/阅读恢复、图谱、CodeMirror 和
终端正文保持原行为，不做整列、整图或字符动画。

以下命令均在仓库根执行。本次可选截图环境指向
`/tmp/roc-ux-p5-20261125-vS2WgA/captures`，普通性能采样留到 P6，
没有重跑 P0–P4 的相同定向门禁。

| 检查命令 | 结果 |
| --- | --- |
| `pnpm build`、`pnpm check:renderer-chunks` | 最终源码普通生产构建/typecheck 通过；eager JS 530736 bytes / 32 files |
| `ROC_UI_AUDIT_DIR=/tmp/roc-ux-p5-20261125-vS2WgA/captures node --test --test-concurrency=1 tests/renderer/discovery-search.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/literature-import-state.test.mjs tests/renderer/zotero-import.test.mjs` | 45/45；搜索、候选、导入引用键、拒绝/失效/取消和实际 Zotero 回执 |
| `node --test --test-concurrency=1 --test-name-pattern='^discovery \|^library citation\|^progress is \|^retry prevents\|^successful retry\|^manual PDF supplement\|^failed import\|^replacement retry\|^project switch\|^a cancellation race\|^unmount ignores\|^readonly project\|^light/dark and narrow canvas\|^empty and failed literature\|^narrow literature\|^large result sets' tests/renderer/literature-action-guards.test.mjs tests/renderer/literature-processing.test.mjs tests/renderer/literature-list-layout.test.mjs` | 19/19；复制失败重试、处理/取消竞争、旧项目响应隔离及列表布局 |
| `node --test --test-concurrency=1 tests/renderer/reading-tool-guards.test.mjs tests/renderer/retrieval-workspace.test.mjs tests/renderer/wiki-pages.test.mjs` | 27/27；PDF/译文草稿、停止、检索失败保留证据、Wiki 来源/版本/历史和换对象 |
| `node --test --test-concurrency=1 --test-name-pattern='^file reading \|^writing saves \|^Git gives \|^terminal \|^hidden terminal \|^truncated terminal \|^tool surfaces \|^skills \|^management content' tests/renderer/authoring-tools-layout.test.mjs tests/renderer/management-draft-guards.test.mjs` | 19/19；保存/编译/取消、Git 草稿、终端隐藏恢复/截断及管理布局 |
| `ROC_UI_AUDIT_DIR=/tmp/roc-ux-p5-20261125-vS2WgA/captures node --test --test-concurrency=1 tests/renderer/file-preview-dialog.test.mjs tests/renderer/export-publication.test.mjs tests/renderer/builtin-skills.test.mjs` | 15/15；文件保存失败和离开守卫、预览/许可/来源/重复回执、内置技能同版本安装及失败重试 |
| `pnpm audit:motion` | 405 files，0 violations / 0 input failures |
| `node scripts/ui-audit/index-interactions.mjs --write`、`--check` | 405 源文件、238 个含控件文件、2258 模板/路由、35 合同，静态快照一致 |
| `git diff --check` | 通过 |

合计 125 项定向业务回归通过。深浅/宽窄布局与裁切沿用业务审计；读回文献 320px、
RAG 420px、Wiki 560px、发布 650px、文件 820px、Git 440px 和技能 480px 的代表截图。
写作/管理夹具使用 `MotionConfig reducedMotion="always"`，发布窄窗显式模拟
reduce；局部共享反馈的减少动态效果合同沿用 P2，不据此声称每个业务状态全组合
或系统设置切换已经验收。

五个本次涉及的测试将默认截图/审计目录放入已有临时目录，保留显式输出环境变量，
原业务断言未改。核验后清理本次截图、日志和临时目录；正式业务文档和状态证据保留。
PaperReader/PaperPdfView、LibraryVirtualizedRows、KnowledgeGraphView、
其它工件/设置/管理入口沿用已有反馈，没有为数量覆盖而重写。完整回归、长时资源、
最终帧对照及物理输入/真实服务缺口由 P6 汇总。

<a id="p6"></a>

## P6：当前构建质量门禁、性能与隔离打包

状态：**Verified passing（功能、布局、包一致性与启动的自动化范围）**，2026-11-25。
长流的 20ms 参考目标和完整实机验收尚未达到，具体范围见下文。

P6 没有改动 Renderer 产品源码。普通生产构建复用 P0–P5 的最终实现，
完整回归、布局、Electron 路径和性能采样串行执行。打包与 macOS smoke 增加显式
临时根参数，候选包不覆盖现有 `release/`；源科研工具链继续读取
`.runtime/research-toolchain/darwin-arm64`。命令与环境见[开发指南](../development.md)。

| 检查命令 | 当次结果 |
| --- | --- |
| `pnpm build` | 通过，含 typecheck；普通 production dist |
| `pnpm test:unit` | 初次 2782 项：2776 通过、5 失败、1 跳过；五项失败均为语料物化器拒绝仓库内临时输出，见下文定向补跑 |
| `pnpm test:renderer` | 初次 1036 项：1035 通过、1 失败；唯一失败为 Wiki 布局旧选择器，见下行 |
| `node --test tests/renderer/wiki.test.mjs` | 修正后 9/9；保留时间原值、换行、独立几何与默认折叠诊断的键盘披露 |
| `pnpm audit:design` | 280 个目标文件，已实现规则 0 违规 |
| `pnpm audit:motion` | 405 files，0 violations / 0 input failures |
| `node scripts/ui-audit/index-interactions.mjs --check` | 405 源文件、1 registry，238 含控件文件、2258 模板/路由、35 合同；快照一致 |
| `ROC_SMOKE_TARGET=dist pnpm audit:layout` | 783 状态、2097 控件/焦点检查；全部 cut=0，包含浅深、8 尺寸、减少动态效果及 125%/200%/400% 原生缩放 |
| `pnpm check:renderer-chunks` | eager JS 530736 bytes / 32 files；每个应用入口 ≤500000 bytes，预算通过 |
| `ROC_SMOKE_TARGET=dist node scripts/verify-p4-assistant.mjs` | 64/64；默认 250 次追加运行，累计 516 消息、持有窗口 116 消息、挂载 19 行；0 Renderer errors |
| `ROC_SMOKE_TARGET=dist pnpm smoke:electron` | 核心 23/23、附带完整助手 64/64；0 Renderer errors |

改动的 `scripts/lib/native-packaging.mjs`、`scripts/smoke-mac.mjs`、
`scripts/smoke-electron.mjs`、`scripts/verify-p4-assistant.mjs` 和
`tests/renderer/wiki.test.mjs` 分别以 `node --check <文件路径>` 检查，全部通过。
提交前 `git diff --check` 通过；本阶段修改的 8 份 Markdown 文档共 94 个本地文件链接
读回无缺失，六份正式 JSON 均为 complete / 5 轮，交互矩阵的静态列保持原值。

单元补跑使用仓库外临时根，实际命令如下；五项全部通过。完整单元的已验证并集为
**2781 通过、1 原有跳过**，不是把初次完整命令记作 exit 0。跳过项为
`tests/unit/research-workspace-latex.test.mjs:82`，本轮未设置 `ROC_WORKSPACE_LATEX_TOOLCHAIN`。
完整 Renderer 与最终 Wiki 文件补跑的已验证并集为 **1036/1036**；没有重跑其余 1027 项。

```sh
TMPDIR=/tmp/roc-ux-p6-os-20261125-qaZ4E3 node --test --test-concurrency=1 \
  --test-name-pattern='architecture repair corpus materializes|template import verifies CRC|research TIFF parser rejects invalid dimensions|architecture repair corpus refuses|template ZIP reader rejects the attack' \
  tests/unit/architecture-repair-corpus.test.mjs tests/unit/research-archive-libraries.test.mjs
```

Wiki 的 P1 诊断分层已将 `gen` 从常规内容移入默认折叠区域；原布局用例仍查找可见
`gen` span，独立重现后改为核验可见 `<time>` 与原代次披露，没有放宽裁切或来源断言。
Electron smoke 初次等待把保存 pending 当完成、在助手进入中测最终几何；
现等待真实保存完成与实际对齐。助手深度脚本则将退出中的保留节点当作已打开，
4 秒定向诊断确认 `data-open=false`、`inert=true`、输入未 disabled。现在按
`aria-pressed` 打开并等待交互恢复，关闭检查核验实际隐藏及 inert，而不是旧 `hidden`
属性。临时诊断已移除；完整场景保持审批、拒绝、提问、取消、强制终止及检查点工具去重。

### 最终构建与五轮性能

以下命令同样在仓库根执行，使用已有普通 production `dist`；采样期间不运行其它
Electron 检查或构建。每份报告均为 **complete / 5 轮**，全部原始子报告保留在正式 JSON。
报告路径不用于下一次重跑，复测须选新路径。

| 检查命令 | 报告与范围 |
| --- | --- |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p6.json --samples 5` | [动作](after-p6.json)：八场景，各五轮，500 历史 / 500 增量 |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p6-history-5000.json --samples 5 --history-messages 5000 --stream-chunks 500` | [长历史](after-p6-history-5000.json)：八场景，各五轮 |
| `node scripts/performance/bench-ui-motion.mjs docs/ux-motion/reduced-motion.json --samples 5 --reduced-motion` | [减少动态效果](reduced-motion.json)：八场景，各五轮 |
| `node scripts/performance/bench-ui-workloads.mjs docs/ux-motion/after-p6-workloads.json --samples 5 --idle-minutes 0` | [业务负载](after-p6-workloads.json)：文献、20 次切换、500/5000 历史与对应增量、0/1000/10000 事件启动 |
| `node scripts/performance/bench-repeated-workloads.mjs docs/ux-motion/after-p6-pdf.json --samples 5 --workload pdf` | [PDF](after-p6-pdf.json)：每轮 400 页、200 次连续翻页，含打开/关闭、后台解析与隐藏解析 IPC |

源码身份为 `5bbe60d735179e69fe340fee29b65cbacd233dc1`，`trackedDirty=true` 的未提交
范围为 P6 验证脚本、打包目录参数、Wiki 回归和文档，Renderer 产品源码没有未提交修改。
依赖锁 SHA256 为 `6130ac618350445948f63929d2fbeeefa06b7980e6034791603db6b32eaf1ccc`；
完整 dist SHA256 为 `f460ecaac39e2df76e8fd205fda1727c04cd8c047c57927b55449985ffa8c5e9`。
业务与 PDF 报告中的 main/preload/Renderer manifest 摘要对应这份构建。
宿主为 M1 Pro / 32GiB、macOS 27.2.1、Electron 45.3.4 / Chromium 156.0.8078.100；
动作报告记录 AC、低功耗关闭，原生内容区 1440×900，抽屉 CSS 视口 720×450。
约 120Hz 的 Electron 显示元数据不构成实际显示帧验收。

下表是**每轮分位数的五轮最大值**，不是合并全部 RAF 或输入事件的分位数。

| 动作协议 | RAF P95（ms） | RAF P99（ms） | 输入→反馈代理 P95（ms） | ≥50ms 长任务 / RAF >50ms / 缺失反馈 |
| --- | ---: | ---: | ---: | --- |
| P0，500 历史 / 500 增量 | 9.4 | 24.8 | 9.0 | 0 / 0 / 0 |
| P3，同负载 | 10.1 | 10.4 | 15.9 | 0 / 0 / 0 |
| P6，同负载 | 10.2 | 15.9 | 15.9 | 0 / 0 / 0 |
| P4，5000 历史 / 500 增量 | 10.3 | 16.3 | 15.9 | 0 / 0 / 0 |
| P6，同长历史负载 | 10.2 | 10.4 | 16.1 | 0 / 0 / 0 |
| P6，reduce，500 历史 / 500 增量 | 10.1 | 10.4 | 17.7 | 0 / 0 / 0 |

P6 普通动作逐场景 RAF P95 最大依次为：项目集合 9.9ms、菜单 10.1ms、
左抽屉 10.2ms、助手鼠标 10.0ms、助手键盘 10.1ms、拖拽 9.4ms、Escape 10.0ms、
流式完成 10.1ms。拖动内每轮 0 写、释放 1 写、Escape 0 写；三份最终动作报告均一致。
P0 拖动/Escape 曾写 20/21 次，现在消除了中间写入。菜单反馈从 8.5ms 到 15.9ms，
P95 帧间隔也有小幅增加，不能称所有性能指标都改善。

| 最终业务场景 | RAF P95 最大（ms） | 最大 RAF 间隔（ms） | 输入→第二次 RAF P95 最大（ms） | 最长主任务（ms） |
| --- | ---: | ---: | ---: | ---: |
| 100 项目搜索 | 10.0 | 10.0 | 22.7 | 11.109 |
| 100 文献 | 9.6 | 10.4 | 15.8 | 8.068 |
| 2000 文献 | 9.8 | 10.4 | 15.5 | 7.420 |
| 10000 文献 | 9.8 | 10.4 | 16.0 | 12.896 |
| 20 次画布切换 | 16.5 | 42.7 | 53.2 | 48.215 |
| 500 历史 / 500 增量 | 10.0 | 17.5 | 17.2 | 15.047 |
| 5000 历史 / 5000 增量 | **25.2** | 34.6 | 15.8 | 27.595 |
| 400 页 PDF / 200 次连续翻页 | 10.0 | 10.4 | 15.2 | 5.114 |

以上动作窗口的 ≥50ms 主线程长任务均为 0。文献的 1/10/50 页由真实“加载更多”
全部取回，再 End/连续滚动；每轮最终挂载 12 行，10000 文献全部分页加载耗时
五轮 P95 为 3663.0ms。历史长流每轮一次真实本地 SSE 请求，终态为 `run_completed`，
终点挂载 1 行。Provider 增量数与 IPC 事件数不同，不能把 5000 增量称为 5000 次运行。
PDF 每轮验证 200 个目标页与 200 次新栅格分配，单页栅格就绪 P95 的五轮最大值
为 45.7ms，最多 1 Worker；打开/关闭场景首次栅格 P95 245.6ms、分配 1 次。
后台解析 1823.3ms、隐藏解析 IPC 1.783ms。输入→第二次 RAF 和动作反馈是两个指标，
都只是绘制机会代理，不能写成屏显 FPS。

业务报告中的启动样本各五次，0/1000/10000 事件的主窗就绪 P95 分别为
1174.6/1174.5/1183.0ms，首次内容绘制 188/180/184ms，助手输入区就绪
543.5/548.7/544.3ms，挂载消息行 0/13/13。它们属于 UI workload fixture，
不与更早的独立启动 fixture 合并或直接宣称提升。

### 长流与画布切换的起点对照

5000 历史加 5000 增量五轮 RAF P95 为 **25.0/25.0/25.1/24.9/25.2ms**，
稳定超过方案 20ms 参考目标。额外一次普通构建 raw trace 复现 P95 25.0ms；
Renderer 主线程 RunTask 总计 4885ms，FunctionCall 3168.6ms，Layout 1224.5ms / 367 次，
Paint 244.9ms；Minor/Major GC 分别 28.25/9.65ms。嵌套耗时不相加，trace 只用于定位。

随后在仓库外独立 worktree 固定 `3eb8fd6ba1f6f5315ea7670f26c165994c2d34ef`，
复用同一依赖、执行 `pnpm build` 和
`node scripts/performance/bench-ui-workloads.mjs /Users/Apple_501/Desktop/Roc/Roc/docs/ux-motion/baseline-workloads-3eb8fd6.json --samples 5 --idle-minutes 0`，
取得[起点完整业务报告](baseline-workloads-3eb8fd6.json)，complete / 5 轮。
实际工作目录为 `/tmp/roc-ux-p6-os-20261125-qaZ4E3/baseline-worktree`。
该 worktree 的唯一 tracked 差异是复用 P0 的 `electron-lifecycle.mjs` 正常退出修复；
它在测量后捕获本次 ChildProcess，不改变 Renderer、RAF 或场景。
因此基线报告也保留 `trackedDirty=true`。两个业务报告的协议、fixture、lockfile、
9 个上层仪器/夹具文件摘要全部相同；基线完整 dist SHA256 为
`89123bb07b6474d8c351e724af6b969d1e481b31fd9d43dca286b0678bb52a17`。

| 同负载指标 | 起点五轮最大 | P6 五轮最大 |
| --- | ---: | ---: |
| 5000 增量 RAF P95（ms） | 25.1 | 25.2 |
| 5000 增量最大 RAF 间隔（ms） | 34.0 | 34.6 |
| 5000 增量输入→第二次 RAF P95（ms） | 18.7 | 15.8 |
| 5000 增量最长主任务（ms） | 25.148 | 27.595 |
| 5000 增量 Layout 总计（ms） | 1241.495 | 1231.206 |
| 5000 增量顶层 busy 总计（ms） | 4935.039 | 4932.434 |
| 20 次切换 RAF P95（ms） | 10.4 | 16.5 |
| 20 次切换最大 RAF 间隔（ms） | 43.4 | 42.7 |
| 20 次切换输入→第二次 RAF P95（ms） | 51.1 | 53.2 |
| 20 次切换最长主任务（ms） | 46.798 | 48.215 |

起点长流五轮 P95 为 25.1/25.0/24.9/25.1/24.9ms，也没有 ≥50ms 长任务。
长流限制在方案起点已经存在；正文仍沿用完整累积文本的流式渲染，相关解析器未改变。
该负载继续标为 **20ms 目标未达**，不修改仪器、阈值或删除样本。
画布切换的 P95 增加 6.1ms，当前仍在 20ms 参考预算内，输入代理在 100ms 内；
保留这项代价，不用常规动作成绩声称全部负载无性能回退。

### 布局、资源与覆盖范围

布局审计包含浅深、8 种尺寸、reduce/no-preference 与原生 125%/200%/400% 缩放，
783 状态 / 2097 控件与焦点检查全部 cut=0。读回了深色 640px 设置、浅色 800px PDF
批注、深色 380px RAG、宽窗写作、深色 400% 设置以及原生包门户和设置代表截图。
这证明所列状态的几何与自动化焦点，物理输入和系统读屏仍需独立验收。

eager JS 从 P0 的 517980 bytes / 11 files 到最终 530736 bytes / 32 files，
各应用入口仍 ≤500000 bytes，Renderer chunk 预算通过。
业务 workload 的 after heap 最大点采样为 83307260 bytes（约 79.4MiB），
after DOM 最大 78225；起点分别为 74213828 bytes、65656。
这些计数包含缓存与未 GC 节点，各轮点采样不能证明峰值、泄漏或持续增长。
长流终点消息行与文献虚拟行仍有界。未运行 30 分钟可见/隐藏空闲与持续流式，
不作长期内存稳定结论。

35 个合同的当前证据映射已同步到[交互矩阵](interaction-matrix.csv)和
[界面清单](surface-inventory.md)。全量回归覆盖的是现有测试的指定路径，
没有把 2258 个静态模板算作已验收状态，也没有将每个合同全组合标为通过。
S30 的独立后端 RAG 计数/诊断运行仍待验证。

### 隔离 macOS 候选包

实际打包命令如下，工作目录为仓库根。执行器先调用
`createPackagingEnvironment()`，使缓存和 TMPDIR 实际进入本次临时根；
源工具链预检通过，打包 19.0 秒，原生 smoke 7.7 秒，均 exit 0。

```sh
ROC_PACKAGING_RUNTIME_DIR=/Users/Apple_501/Desktop/Roc/Roc/.runtime/roc-ux-p6-20261125-837IGC/packaging-runtime \
  pnpm exec electron-builder --mac --dir --arm64 --publish never \
  --config electron-builder.yml \
  --config.directories.output=/Users/Apple_501/Desktop/Roc/Roc/.runtime/roc-ux-p6-20261125-837IGC/package
ROC_SMOKE_ARTIFACT_DIR=/Users/Apple_501/Desktop/Roc/Roc/.runtime/roc-ux-p6-20261125-837IGC/mac-smoke \
ROC_SMOKE_RUNTIME_DIR=/Users/Apple_501/Desktop/Roc/Roc/.runtime/roc-ux-p6-20261125-837IGC/mac-runtime \
  node scripts/smoke-mac.mjs \
  /Users/Apple_501/Desktop/Roc/Roc/.runtime/roc-ux-p6-20261125-837IGC/package/mac-arm64/Roc.app
codesign --verify --deep --strict --verbose=2 \
  .runtime/roc-ux-p6-20261125-837IGC/package/mac-arm64/Roc.app
```

第一条是实际 builder 参数；单独重跑须按[开发指南](../development.md)把
`createPackagingEnvironment()` 的完整返回值传给 child，设置变量本身不会配置第三方 builder。
候选包 366 个 dist 运行文件逐字节等于被测 dist，文件集合也一致；
`electron-builder.yml` 显式排除的两份 `.vite` 构建元数据独立列出。
运行文件集合 SHA256 为
`140e80032e293341d37d1b3e44bf8aeb019f5a033e9713d65503281f9e108c89`，
没有额外 dist 文件。严格签名检查通过。

macOS smoke 通过真实 packaged SQLite/sqlite-vec、PTY/shell、RTK、科研工具链、
文件 preview 和 BibTeX parser；10k chunk 检索两次共用一个 Worker，10 hits，
shutdown 确认 Worker 已停止。主窗口 2916ms 就绪，关闭隐藏后原生 activate 恢复同一窗口，
系统外观事件到达，字体就绪，3 份 stylesheet，0 missing images / 0 Renderer errors。
原生控件留白、模板 tray 与主行动可见。该 smoke 使用隔离资料根，
没有测试默认 `~/.roc` 的 Finder 启动路径。

### 清理与剩余实机验收

本次 `.artifacts`、`.runtime/tmp` 曾临时映射到任务目录，结束后已恢复原目录；
清理前后核对原 device/inode，`release/` 始终使用原目录，候选包输出另置。
只保留本次六份正式 JSON、可复跑工具、必要回归和合同；派生 Markdown、逐轮报告、
原始 trace、截图、日志、候选包与原版本临时 worktree 已在核验后删除，worktree 注册已移除。
本次任务根和仓库外临时根也已删除，共享 `node_modules` 保留，仓库外 UI 临时根无新增；
真实 `~/.roc`、预存缓存和研究资料未修改。

未完成的实机范围：独立实际 60Hz/120Hz 显示帧与 GPU 合成帧、低功耗、第二代 Mac、
物理触控板、中文 IME、VoiceOver、系统减少动态效果切换、真人八旅程、真实外部服务、
默认资料根的 Finder 启动，以及长期资源稳定性。自动化的合成 IME、CSS 缩放、
受控 SSE、reduced-motion 模拟和 isolated native smoke 分别保留其证据边界。
