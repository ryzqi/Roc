# UI 重构验证记录

2026-11-27 的固定文献列表、自动导入与状态动效重构见
[文献库界面优化验证](ui-library-refinement-2026-11-27.md)。

2026-11-25 的 UX 与动效阶段验证、当前生产帧对照及隔离候选包范围见
[P0–P6 验证记录](ux-motion/validation.md)。本文件保留此前 UI 重构的历史验收。

## 2026-11-24 P8.12：最终工程验收与本地打包

状态：**Verified passing**（工程重构、功能集成、布局与本地打包范围）。P8.8–P8.11记录的分页滚动、助手提交、阅读恢复和管理导航问题均已修正。最终完整Renderer、功能smoke、管理验收、浅深布局与macOS应用包通过；P1–P6主体工程及P8工程验收完成。性能按用户要求跳过，真人与外部服务验收仍单独保留。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`；macOS 27.2.1 arm64、Node 26.13.1、pnpm 12.21.0、Electron 45.3.4、React 19.3.1、TypeScript 7.0.2。以下为本轮最终证据，未把前序失败轮次计作成功：

| 检查命令 | 结果 |
| --- | --- |
| `pnpm test:unit` | 完整2775项：2774通过、0失败、1跳过。该轮在P8.11新增路由回归之前执行；没有重新运行新增后的2776项全量 |
| `node --test tests/unit/surfaces.test.mjs` | P8.11修改后的路由门禁17/17，含新增真实`runs`闭集回归 |
| `ROC_WORKSPACE_LATEX_TOOLCHAIN=/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64 ROC_DATA_ROOT=/tmp/roc-ui-complete-20261124.ngMhV0/latex-probe-data node --test --test-name-pattern='current workspace compiles with the installed offline toolchain' tests/unit/research-workspace-latex.test.mjs` | 上述唯一跳过项补跑1/1：真实离线编译生成有效PDF，作业快照清理通过 |
| `pnpm test:renderer` | 最终完整1021/1021，0失败、0跳过 |
| `ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/p8-complete-smoke pnpm smoke:electron` | 核心23/23、助手64/64，无Renderer错误 |
| `ROC_SMOKE_TARGET=dist pnpm verify:p9-management` | 90/90记录＝86/86断言＋4条说明，provider请求3次，无Renderer错误；任务仍running，本轮删除分支未执行 |
| `ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/p8-complete-layout pnpm audit:layout` | 783个状态、2097个控件/焦点检查通过，cut=0；浅深主题125%/200%/400%原生缩放12/12 |
| `pnpm build`、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design` | 最终生产修改后全部通过；打包再次执行build与分包门禁。278个组件通过已实现设计规则，eager为517980 bytes / 11 files，应用entry均≤500000 bytes |
| `pnpm package:mac` | 本地`--publish never`生成`release/mac-arm64/Roc.app`，自带隔离packaged smoke通过，深度严格签名检查通过 |
| `ROC_DATA_ROOT=/tmp/roc-ui-complete-20261124.ngMhV0/native-probe-data pnpm verify:native-packaging` | Electron实际加载SQLite成功，ripgrep校验及ONNX darwin/arm64校验通过 |
| `pnpm verify:arm64-only -- --strict` | 20/20，应用可执行文件仅arm64；Resources中扫描的6个原生库均为arm64，universal=0、pureX64=0 |

完整功能smoke验证提问恢复后的慢流、原生上滚保持、回到最新、取消、切项目、崩溃检查点续跑与工具去重。516条累计消息仅持有116条窗口消息，挂载19行。完整布局报告无文字重叠、字号违规、文本溢出、小热区、面板溢出或页面横滚；原生窗口最小尺寸1184×640，三个缩放等级的实际CSS视口分别为1152×720、720×450、360×225。已查看浅深宽画布及全部12张原生缩放截图。报告中432条`hidden`均为贴窗口边缘管理抽屉向上、右、下的外投影；已核对抽屉截图，朝画布一侧的边界完整，不将这些离窗投影算作可见裁切。

打包smoke实际验证包内SQLite、sqlite-vec、PTY、shell IPC、文件预览与BibTeX导入；10,000块受控语料的两次只读查询复用同一Worker，正常退出后一个Worker已停止。系统强调色通知、原生菜单、交通灯预留、模板托盘、关闭隐藏后恢复同一窗口、字体与资源加载均通过。该轮使用`.runtime/mac-smoke/run-*/data`和独立Chromium目录，资料根由smoke自动清理；没有用默认`~/.roc`执行Finder启动验收。

构建身份以生产修复已落地的`d03d4cf`工作树为准。打包重建的dist与完整Renderer、功能smoke及布局所用构建逐项一致：**348文件、19207642 bytes，SHA256 `4ca75fc5fe32d0d9d7a12726af1b70a0ad24695f0efd31771e29ab4407e70f09`**。摘要算法按相对路径排序，累计`path + NUL + sha256(content).hex + newline`，再对累计内容计算SHA256。按照现有打包配置排除`renderer/.vite/chunk-packages.json`与`renderer/.vite/manifest.json`后，通过`@electron/asar`逐项读取包内dist并核对路径、大小与内容摘要：**346文件、19026385 bytes，摘要 `478fdeaa5db0325a1d03853bc1fbe6070fc74ab82b915f8e06170c83506400c0`**。最终`app.asar`自身SHA256为`437db18e1a3fe2d4d5171324851885340ecece855bf12ec31d402c86c91aaeec`。

本轮临时日志、截图、原始审计报告、构建manifest、隔离资料根、诊断脚本、dist及新增打包缓存已清理；原本为空的`.runtime/tmp`目录仍保留为空。清理后重新核对最终`app.asar`与既有P0原始报告的摘要均未改变，`release/mac-arm64`仅保留`Roc.app`。正式计划与验证记录保留；只读复核未发现P8.11的语义错误、验证削弱或P8.12的成绩夸大，最终文档提交不改变生产构建。

仍缺少真人T1/T2/T3、真实外部服务、系统中文IME、VoiceOver、物理滚轮/触控板与实际刷新率的独立验收。剩余性能预检、benchmark、独立Profiler及启动/UI/PDF/长期性能采样均按要求跳过；受控功能夹具与packaged smoke不支持当前性能预算、改善比例或整体体验已验证的声明。

## 2026-11-24 P8.11：管理验收导航与路由门禁

状态：**Verified passing**（管理验收路径与静态路由门禁范围）。最终完整管理验收首次在62条已通过记录后等待`canvas-task-category-background`超时，整轮失败。此前脚本一直处于写作画布，任务检查没有显式进入运行画布。补齐导航后，按钮出现但仍被`inert`阻止；有界真窗诊断确认`canvas-column`为inert，唯一可见dialog为`assistant-drawer`，地址仍带`assistant=1`。正常画布导航会收起窄窗覆盖助手，脚本手工改URL则保留了它。

任务检查现在显式进入`view=runs&assistant=0`，继续通过真实控件创建、修改与立即运行后台任务。命令面板的记忆入口沿用当前管理抽屉，断言打开前后仍为同一画布，再切技能读取同一技能记录；关闭抽屉后继续检查命令检索。移除期待第二个管理画布的旧选择器，保留记忆草稿、调度事实、实际运行记录、MCP stdio子进程、重启与类型检查。

定向单元检查随后发现静态门禁只读取业务面分类，把已经登记在壳路由`APP_VIEWS`中的`runs`误报为未知。门禁现显式接收该闭集，同时保留业务面分类判据；没有给`tasks`增加业务画布或放宽未知路由。新回归读取实际路由解析结果，验证运行画布可以通过；撤除闭集中的`runs`后仍拒绝它，拼错、旧`latex`、停放能力和无画布的`tasks`均保持拒绝。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。以下检查通过：

- `ROC_SMOKE_TARGET=dist pnpm verify:p9-management`：完整**90/90记录**，其中**86/86断言、4条说明性记录**，实际provider请求3次，无Renderer错误，所有声明的闸门段落均执行。
- `node --test tests/unit/surfaces.test.mjs`：**17/17**，包含全仓库闸门脚本的路由字面量扫描及真实运行画布回归。
- `node --check scripts/verify-p9-management.mjs`、`node --check scripts/lib/gate-surfaces.mjs`、`node --check tests/unit/surfaces.test.mjs`、`git diff --check`通过。

立即运行产生真实调度记录；本轮后台任务仍为running，删除分支按原合同记作说明，不计作通过的删除断言。临时诊断脚本已删除，隔离资料根由脚本清理，日志与`.artifacts/p9-gates`在最终结果落档后清理。此次只修改验收脚本及门禁，生产dist仍为348文件、19207642 bytes，SHA256 `4ca75fc5fe32d0d9d7a12726af1b70a0ad24695f0efd31771e29ab4407e70f09`；已通过的完整Renderer与功能smoke仍对应这份构建。

## 2026-11-24 P8.10：阅读恢复与披露几何

状态：**Verified passing**（阅读恢复及受影响调用者定向范围）。前一次完整`pnpm test:renderer`为1020项、1019通过、1失败，唯一失败是迟到只读内容恢复后预期280px、实际300.5px。原用例独立复现；实际显示的600×400 Electron窗口也复现同样漂移。诊断确认恢复RAF已经执行，披露已开启、焦点仍在阅读区外，observer已归零；首次滚动位置是280px，随后`::details-content`展开，原生滚动锚定将位置推到300.5px。不能把这次失败归为RAF没有执行或仅隐藏窗口节流。

`ReadingViewBoundary`恢复已保存的披露时，短暂使用局部`data-reading-restoring`取消该披露的过渡，读取最终几何并立即清除标记，然后恢复祖先滚动位置。新身份恢复也先收拢披露再归零滚动。普通手动披露仍使用既有动效；1500ms释放期限、再次隐藏、身份隔离和用户输入接管保持原契约。

夹具现在使用可见真窗，先等待原生披露展开完成再保存280px，迟到内容到达后确认其闭合几何，并等待恢复后的披露落点再检查精确位置。保留阅读区外焦点、observer清理、二次隐藏、接管取消和新身份断言；新增真实点击折叠/展开及后续180px阅读位置检查。修复前，增强后的同一位置断言失败于300.5px；修复后通过，没有放宽位置误差或超时。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。以下检查通过：

- `node --test --test-concurrency=1 tests/renderer/reading-view-boundary.test.mjs`：严格串行连续五轮，每轮**5/5**，累计**25/25**。
- `node --test --test-concurrency=1 --test-name-pattern='readonly content|restored disclosures|second hide|reader interaction|new result identity|hidden discovery|hidden notes|wide and narrow light/dark monitor' tests/renderer/reading-view-boundary.test.mjs tests/renderer/discovery-search.test.mjs tests/renderer/reading-note-guards.test.mjs tests/renderer/research-monitors.test.mjs`：**8/8**，包含真实发现、笔记和浅深宽窄监控调用者。
- `pnpm build`（含typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design`（278个组件）及`git diff --check`通过；eager为517980 bytes / 11 files，应用entry均未超500000 bytes。

诊断夹具不进入正式测试或产物；隔离资料根由测试自动清理。修改后的完整Renderer、最终功能smoke、布局与macOS打包另验，性能按用户要求跳过。

## 2026-11-24 P8.9：助手提交与布局交接

状态：**Verified passing**（助手提交、转录与完整功能smoke范围）。提问恢复后的下一次提交已被后端接收，400条输出也已生成，但新回复行没有进入可见窗口；点击现有“滚动到最新”后立即可见。当前提交接收与转录插入分属不同提交，消息数从8到10再到11，输入区同时改变转录视口高度。立即对旧窗口执行LAST仍会复现首次慢流超时；开启虚拟器日志会扰动时序，因此该诊断通过不计入修复成绩。

当前作用域的发送、回答提问或补充指令成功返回后，助手增加一次最新定位请求。转录在两帧布局测量后复用已有LAST/最新窗口加载路径，待执行期间消息数变化重新安排；会话或历史epoch变化取消旧请求。真实wheel、指针与滚动导航键可取消待执行定位，保留原生事件。定位结束后仍由Virtuoso的`followOutput="auto"`决定流式跟随，用户可以继续上滚阅读。

正式回归使用自包含消息夹具，覆盖后台数据更新保留历史、接收提交早于新输出、成功提交回最新、拒绝提交及迟到响应保留阅读位置、等待布局时原生wheel接管、后续增长保留位置以及Enter操作最新按钮。暂时撤回wheel取消处理后，新接管断言失败于最新按钮无法出现；恢复后通过。原始事件回放测试、绝对临时文件依赖、生产诊断与库日志均已移除。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/assistant-panel-guards.test.mjs` **124/124**；`pnpm build`（含typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design`（278个组件）及`git diff --check`通过，eager为517980 bytes / 11 files。

`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/p8-settled-submission-smoke pnpm smoke:electron` 无诊断完整运行，核心 **23/23**、助手 **64/64**。真实提问恢复后的慢流可见、原生上滚、回最新、取消、切项目、崩溃检查点恢复和工具不重复均通过，无Renderer错误；516条累计消息持有116条窗口消息、挂载19行。全量Renderer与最终macOS包另验，性能按用户要求跳过；隔离资料根自动清理，诊断、回放与日志在最终结果落档后清理。

## 2026-11-24 P8.8：文献分页滚动夹具

状态：**Verified passing**（分页回归范围）。`pnpm test:renderer`完成1017项，1016通过、1失败；唯一失败在选中首条并直接调用DOM `scrollTo()`后，首条仍挂载，尚未进入下一页加载。单项原夹具循环第4轮复现；有界位置诊断第1轮复现10000px→0px，容器始终连接、选择始终为首条，scrollHeight从17227px变为16897px，clientHeight为538px。直接DOM滚动没有用户输入接管事件，未结束的选择定位在行高刷新后重试。

分页测试的滚动步骤现通过Playwright `mouse.wheel()`发出真实wheel，让已有用户接管路径处理定位；首条卸载、真实总数、单次请求、原地重试、追加视口、跨页选择、437条去重和DOM有界断言均保留。诊断监听与日志已移除。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test --test-name-pattern='manual pages keep' tests/renderer/literature-pagination.test.mjs`严格串行连续20轮 **20/20**；`node --test --test-concurrency=1 tests/renderer/literature-pagination.test.mjs tests/renderer/literature-list-layout.test.mjs` **12/12**；`node --check tests/renderer/literature-pagination.test.mjs`与`git diff --check`通过。测试资料根自动清理，失败诊断和循环日志在结果落档后清理。完整Renderer复验、功能smoke及打包另记；性能采样按用户要求跳过。

## 2026-11-24 P7.5：按要求跳过性能采样

用户明确要求“跳过性能测试”。剩余生产长流预检、普通启动、UI大规模交互、PDF连续翻页、长期空闲/流式及独立React Profiler正式采样均取消；本轮尚未启动这些运行，也没有生成新的正式性能报告。既有P0原始报告保留，先前定向回归和预检仅支持各自已经记录的范围，不据此声明当前性能预算通过。

全量单元/Renderer功能回归、完整Electron smoke、布局/原生缩放、IPC/分包/设计门禁和macOS打包继续完成。该范围调整不代替真人T1/T2/T3、系统中文IME、VoiceOver或物理设备验收；这些证据缺口继续保留。

## 2026-11-24 P8.7：文献定位中断与原生滚动

状态：**Verified passing**（文献列表滚动与键盘范围）。外部选中第120条后，用户已经滚回顶部，Virtuoso仍因可变行高测量重试旧定位，将列表拖回约9900px；去掉焦点步骤和改用可见Electron真窗的wheel仍可复现。安装版本为react-virtuoso 4.18.23，定位在150ms无刷新后才结束，`scrollIntoView.done`可能在首次测量重试时提前通知，不能据此判定静稳。

包装层仅暴露父级需要的`scrollIntoView`。手动wheel、指针或PageUp/PageDown接管后，下一次真实scroll通过公开`scrollToIndex`替换旧请求，使用无页头、无分组列表的零索引固定原点加当前scrollTop，避免远端未测量行锚点漂移。接管持续至scroll、已渲染条目和列表总高均静稳200ms；新键盘定位重新取得控制，items/查询/项目/归档/排序/分类与选择变化或卸载废弃旧回调及待聚焦目标。只有原定位拥有待恢复焦点且当前焦点已落到body时，才以preventScroll把键盘控制交回列表。

真实滚动条进一步复现一次pointerdown后的连续移动被旧请求撤销：曾到约6053px，随后回到8619px。保持手动接管至静稳尾段修复此路径；同位置的公开定位不会再调用原生scrollTo，分数像素取整小于1px。最终拖动回归反向验证在撤回这一行时失败，恢复后通过。取样等待原生输入交付并冻结最终位置，不把拖动中曾到达的最小值或按下前几何当作最终期望；后续上移必须超出第一步，防止旧回跳污染期望值。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/renderer/literature-list-layout.test.mjs` 严格串行连续 **20轮，每轮10/10，累计200/200**。包含首次可见后立即wheel、连续四包wheel、一次按下四步原生滚动条拖动、199条结果替换并移除旧选择、End定位被wheel中断后Home继续导航；最终与已交付原生位置之差小于1px。保留真实行卸载、Tab复制按钮、Arrow/Home/End/Enter、多选、隐藏查询/项目失效和DOM有界断言，200条只挂载13行。

`node --check tests/renderer/literature-list-layout.test.mjs`、`pnpm build`（含typecheck）、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design`（278个组件）及`git diff --check`通过。eager为517980 bytes / 11 files，应用entry均未超500000 bytes。测试资料根自动清理；诊断和循环日志在正式结果落档后清理。上述为Playwright在真实Electron中驱动原生事件，不代替物理设备、系统IME或VoiceOver验收；最终全量、完整smoke、打包和性能另记。

## 2026-11-24 P8.6：阅读失败披露与可见恢复

状态：**Verified passing**（阅读处理与布局范围）。常规处理阶段保持折叠；首次回执读取失败、处理失败或重试提交失败自动展开，不调用focus。同次失败的loading、错误文案更新和文档hydration保留手动收起；成功恢复或新代次失败可再次披露。新失败仅初始化尚未选择的阶段，保留用户正在使用的详情动作。

真实几何检查复现：原阶段列表排在错误与重试之前，展开后错误原因及重试被32%高度的标题滚动区挡住。反馈现位于阶段列表前，原因与唯一重试同排，正文采用8px间距与内边距，原生披露和正常阅读正文预算保留。静态审查另发现强行切换阶段会卸载聚焦的“查看知识页”；新真实回归先失败于该按钮消失，修复后其选择、焦点和Enter动作均保留。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`ROC_UI_CAPTURE_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/reader-failure node --test --test-concurrency=1 tests/renderer/literature-processing.test.mjs tests/renderer/reading-layout.test.mjs` **33/33**；`node --test --test-name-pattern='reader pipeline keyboard' tests/renderer/paper-reader.test.mjs` **1/1**。覆盖420px浅深、820px浅、1100px深的回执读取失败与处理失败，共八个布局状态；原因及按钮完整矩形位于标题区内，五点命中、键盘焦点与阴影审计通过，cut=0、无页面横滚，处理重试的hover审计亦通过。正常长标题阅读区仍至少占640px列高的75%。五点取样避开按钮透明圆角，同时保留完整矩形边界检查。

`pnpm build`、`pnpm audit:design`（278个组件）及`git diff --check`通过。已查看420px浅色回执失败和深色处理失败截图；诊断截图与测试资料根在结果落档后清理。最终全量Renderer、完整smoke、打包和性能另验。

## 2026-11-24 P8.5：阅读阶段的真实键盘焦点

状态：**Verified passing**（阶段键盘回归范围）。原路径连续失败于元数据目标聚焦；在发送Enter前加入即时诊断，确认元数据阶段按钮尚未可见、`focus()`未使它成为活动元素。只增加按钮可见性等待后原路径通过。最终夹具明确等待原生披露打开、各阶段可见并确认真实焦点，再发送Enter/Space；保留目标summary聚焦、details打开、结构化阅读模式和数据库零写入断言。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test --test-name-pattern='reader pipeline keyboard' tests/renderer/paper-reader.test.mjs` 严格串行连续五轮 **5/5**；`node --check tests/renderer/paper-reader.test.mjs`、`git diff --check`通过。没有修改生产焦点策略或加入固定延时。失败原因披露和全量Renderer复验另记。

## 2026-11-24 P8.4：原生退出夹具契约

状态：**Verified passing**（原生退出回归范围）。全量Renderer为1003/1008，退出测试停在内核关闭前；隔离运行再次失败。生产窗口销毁路径已经通过`kernel.runtime.publishEvent`通知终端所有者结束，旧内核替身缺少此异步契约，导致销毁回调抛错。仅补齐测试替身，并记录实际事件与关闭顺序。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/renderer/native-quit-guards.test.mjs` **3/3**。拒绝退出和关闭隐藏均保持零次销毁事件；接受退出时，保存的真实WebContents ID恰好收到一次`terminal.owner.closed`，来源为`@roc/main`，发布早于`shutdown-start`；所有窗口先关闭、tray释放一次，内核关闭完成前进程保持存活，最后正常退出。测试资料根自动清理。全量Renderer其余四项失败及最终整轮复验另记。

## 2026-11-24 P8.2：完整布局矩阵与原生缩放

状态：**Verified passing**（布局范围）。同一CDP会话负责设置和清除CSS视口模拟，原生缩放前从该会话解除模拟；画布截图等待真实CodeMirror正文可见，退出时释放会话，避免将模拟尺寸误记为原生缩放。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/layout pnpm audit:layout` **783个状态通过、2097个控件/焦点检查、cut=0**。原生最小窗口保持1184×640；浅深主题下画布与设置的125%/200%/400%缩放共 **12/12** 状态通过，实际CSS视口分别为1152×720、720×450、360×225。已查看浅色宽画布和深色400%设置截图，正文与输入焦点完整。

`node --check scripts/ui-layout-audit.mjs`、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design`和`git diff --check`通过；eager为517717 bytes / 11 files，278个组件通过已实现设计规则。截图与原始布局报告仅作本轮现场复核，正式结果落档后清理。此结果不替代系统IME、VoiceOver、实际滚轮或外部服务任务验收。

## 2026-11-24 P7.7：提问恢复与活动披露收尾

状态：**Verified passing**（本部分）。提问卡移除后，虚拟列表重挂历史工具时丢失手动展开态，连续高度收缩中断下一轮慢流跟随。披露现随当前消息窗口保留，消息/块裁剪或thread/epoch变更时释放；保留值仅含状态和截止时间，不复制正文。裸推理、子代理离屏完成后按原截止时间收起；同ID离屏重试的新失败重新披露，同一次失败更新尊重手动收起。流式完成不重新分组，工具组与真实块有独立键域，嵌套块按完整父路径隔离。

真实回归又复现快速滚出前原生toggle尚未通知，导致手动选择未被保留；summary点击现同步更新受控披露，保留原生Enter/Space激活，空内容披露有禁用语义。此前P4等待超时返回最后文本的夹具也改为显式失败，失败几何诊断限制5秒，不在常驻路径逐帧采样。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/assistant-panel-guards.test.mjs` **127/127**，包含14项新增真实Virtuoso卸载/重挂回归。补充Space展开/收起后快速滚出：`node --test --test-concurrency=1 --test-name-pattern='virtual completed|completed tool history|streaming, errors|finishing a streamed|live tool failure|live Hook|compact header' tests/renderer/lifecycles.test.mjs tests/renderer/assistant-activity-layout.test.mjs` **7/7**；浅深320/400px裁切为零。`pnpm build`和`git diff --check`通过。

`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-complete-20261124.ngMhV0/p77-smoke pnpm smoke:electron` 核心 **23/23**、助手 **64/64**，提问恢复后的慢流初始跟随、主动上滚保持位置、回到最新、取消、切项目、崩溃检查点续跑和工具不重复均通过，无Renderer错误。516条累计消息只持有116条窗口消息、挂载20行。完整布局、打包和正式五轮性能另记；该本地受控provider结果不代表外部模型或真人任务通过。合同见[性能测量](research-performance.md)。

## 2026-11-24 P8：完整集成中的滚动失败

状态：**Changed, unverified**（最终集成范围）。工作目录 `/Users/Apple_501/Desktop/Roc/Roc`；`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-final-smoke4-20261124 pnpm smoke:electron` 核心 **23/23**，深度助手完成35个断言后，在提问恢复后的慢流首次底部跟随检查超时，不能记为完整smoke通过。失败时没有Renderer异常；后续定向跟踪确认问题卡移除后的连续高度收缩使视口离底。当前补回归和修复，最终复验另记。

原 `waitForTranscript` 超时会返回最后文本；部分调用未断言返回内容。因此此前仅凭等待返回推断“已出现G4S-0005”无效，后续必须使未匹配文本显式失败。本次失败现场用于定位，临时轨迹及截图在正式验证结果落档后清理。

## 2026-11-24 P7.5：测量进程超时与失败保留

状态：**Verified passing**（工具回归范围）。启动至界面就绪限制30秒，正常关闭限制15秒；发生原生模态卡住时仅终止本轮持有的进程并等待退出，再清理隔离资料根。长流/空闲测量窗口不受这些时限影响。诊断读取和取消订阅也有界，失败JSON/Markdown保留阶段、已有样本和清理异常，避免挂住或误写成功。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/unit/performance-electron-lifecycle.test.mjs tests/unit/performance-repeated-workloads.test.mjs tests/unit/performance-child-report.test.mjs tests/unit/performance-ui-runs.test.mjs tests/unit/performance-profiling.test.mjs tests/unit/performance-report.test.mjs` **34/34**；真实Node子进程验证挂住、退出等待、仅清理所属进程及旁路进程存活。相关脚本 `node --check` 和 `git diff --check` 通过；真实Electron预检另记。

## 2026-11-24 P8.3：文件校验取消的主进程异常

状态：**Verified passing**（取消边界与定向单元范围）。preflight7在第三次应用启动前出现原生未捕获异常弹窗；目标进程采样及可访问性文本确定为 `FileHandle.createReadStream` 的AbortError，来源是原生代码校验。真实子进程复现：异步元数据读取期间取消，已取消信号进入读取流后，迭代虽拒绝仍另发未处理错误。原生代码和同模式视觉模型扫描在异步读取/打开后、创建流前同步检查取消；保留读取中的取消、原始I/O失败及文件描述符关闭。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/unit/research-native-code.test.mjs tests/unit/visual-retrieval.test.mjs` **27/27**；新回归验证元数据时取消、读取中取消、EIO透传和视觉模型打开时取消，子进程无未捕获错误且fd已关闭。运行时为Node 26.13.1，修复后的完整Electron启动和打包另验；`pnpm build`通过。原生异常进程被定向终止，隔离资料根由finally清理，没有访问真实用户资料。

最新UI组合 `node --test --test-concurrency=1 tests/renderer/radix-settings-dialog.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/artifact-dock.test.mjs tests/renderer/literature-list-layout.test.mjs` **69/69**，包含原生400%缩放、保存/取消/放弃、浮层及侧栏状态；该结果不代替完整布局矩阵。

## 2026-11-24 P7.7：长回复交接与虚拟列表跟随

状态：**Verified passing**（消息生命周期定向范围）。生产长流预检曾在下一轮收流时停留旧长回复，先复现上一轮实时终态被替换后、持久历史稍后重新插入的高度突变；有界保留一条终态回答至持久投影接管。进一步用5,000条增量、100条分页和400条保留窗口复现测高期间短暂离底，外部状态反向关闭Virtuoso跟随。现由 `followOutput="auto"` 使用虚拟器自身的底部/滚动判断，保留主动上滚阅读，不逐增量强制滚动。

缓存随client/项目/目录/thread隔离，在头尾裁剪或重窗时释放；最终持久正文接管保留历史独有活动，取消/失败部分回答及无正文的新失败运行不会提前丢失旧回答。工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test tests/unit/renderer-transcript-cache.test.mjs tests/unit/persisted-thread-history.test.mjs tests/unit/performance-sustained-stream.test.mjs` **18/18**；`node --test tests/renderer/lifecycles.test.mjs` **91/91**，覆盖真实hook、Virtuoso、分页、上滚与同thread作用域切换。`pnpm build`、`pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm audit:design`及`git diff --check`通过，eager 517717 bytes / 11 files，277个组件通过已实现规则。

后续preflight7在10,000历史启动时遭遇独立主进程文件校验取消异常，未进入UI场景；不作为此修复或正式性能通过证据。原生弹窗已读取精确AbortError来源，隔离进程及资料根已清理，该问题另行修复记录。之前preflight6的失败仍保留；完整生产流与正式五轮另记。

## 2026-11-23 P7.6：文献侧栏派生计算

状态：**Verified passing**（侧栏行为定向范围）。Profiler短预检发现隐藏文献侧栏仍随store状态更新渲染；分类/Zotero统计、多选条目和键盘索引现按实际数据依赖缓存。保留搜索、排序、分类、多选和虚拟列表状态，隐藏期间继续处理查询和项目变化，不冻结权限与动作状态；此改动不等于释放全部隐藏列表DOM，正式性能收益另验。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/renderer/literature-list-layout.test.mjs` **5/5**，覆盖统计随新条目更新、状态更新不重扫分类、隐藏后筛选与滚动保留、外部焦点保留，以及隐藏期间查询往返和项目切换清空失效多选。取样等待虚拟行测高稳定，设两秒超时；追加超时后 `node --check tests/renderer/literature-list-layout.test.mjs` 与 `git diff --check` 通过，统一构建另记。临时夹具自动清理。

## 2026-11-23 P7.5：性能工具与短预检

启动对照补充：普通启动夹具保持P0原始事件与无append cursor数据，仅真实流式UI夹具显式初始化追加游标。`node --test tests/unit/performance-profile-seed.test.mjs tests/unit/performance-report.test.mjs` **9/9**。P0实际harness内容对应后续 `e57ec6c`，当前普通启动计时逻辑相同；新增构建模式/路径元数据导致fixture摘要不同，最终只按[明确口径](research-performance.md)人工对照，保留通用比较器严格拒绝，不能把静态核对记作性能通过。

状态：**Verified passing**（测量工具与短预检；正式五轮另记）。普通UI、PDF、长流/空闲和独立React profiling入口均使用隔离资料根，按独立进程轮次汇总并校验源码、构建、fixture和主机身份。专用profiling构建保护普通dist，计数器不保留正文；失败状态、完成轮数和损坏子报告证据进入最终报告。子进程清除继承的测量参数与开发Renderer URL，避免测到不同应用。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/unit/performance-profile-seed.test.mjs tests/unit/performance-profiling.test.mjs tests/unit/performance-repeated-workloads.test.mjs tests/unit/performance-sustained-stream.test.mjs tests/unit/performance-ui-runs.test.mjs tests/unit/renderer-workload-metrics.test.mjs tests/unit/performance-child-environment.test.mjs tests/unit/performance-child-report.test.mjs tests/unit/performance-report.test.mjs` **37/37**。

`ROC_PERF_UI_WORKLOADS=1 ROC_PERF_STREAM_MINUTES=1 node scripts/performance/bench-macos-app.mjs /tmp/roc-ui-p7-preflight5-20261123.json --samples 1 --idle-minutes 0`七个短场景及一分钟长流通过：210个delta、实际首尾75.48秒、正常完成、终帧已渲染。此前同场景偶发旧长回复遮住新运行，已另建真实hook/Virtuoso回归稳定复现，生产交接修复另记；本次通过不能撤销此前失败证据。

`node scripts/performance/bench-repeated-workloads.mjs /tmp/roc-ui-pdf-preflight3-20261123.json --workload pdf --samples 1`通过：400页PDF连续200次翻页，每次验证页码、新canvas分配及可见栅格，页内P50/P95为39.69/45.38ms，并完成后台解析。首次旧脚本匹配到重复刷新按钮、随后点击未解析PDF的禁用对照控件；现限定画布并使用真实原文模式。`node scripts/performance/bench-react-profiler.mjs /tmp/roc-ui-profile-preflight-20261123.json --samples 1`七场景与IPC计数通过，专用临时构建已清理。上述数字仅为预检，不是正式五轮成绩；RAF、输入代理和React包含式render耗时的限制见[性能测量](research-performance.md)。

## 2026-11-23 P8.2：高缩放短视口与确认操作

状态：**Verified passing**（短视口与原生缩放定向范围）。真实400%缩放留下360×225 CSS视口，活动栏原固定高度溢出，设置表单可用区过低；共用ConfirmDialog的取消按钮另复现垂直裁切和遮挡。活动栏改为独立滚动，短视口模态壳收减外留白并由面板承接滚动，设置的分区/表单/保存栏共享滚动区域。保留字号、目标尺寸、取消初焦点与草稿守卫。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`pnpm build`通过；`node --test --test-name-pattern='short viewport|short settings|native 400|short shared confirmation' tests/renderer/radix-settings-dialog.test.mjs` **4/4**。覆盖浅/深主题、七个活动栏动作、设置导航/输入/文本区、保存取消后草稿仍在、确认后实际写入、关闭取消后保留修改、放弃确认关闭且不写入；正文及各确认按钮的焦点环、五点命中与阴影裁切通过。原生测试使用无CSS仿真历史的新BrowserWindow，核对1440×900窗口、zoom4和360×225实际视口，避免把CSS视口模拟当作原生缩放。

布局审计增加真实webContents 125%/200%/400%缩放，逐路由重新应用并核对倍率与实际CSS尺寸，以原生capturePage保留完整窗口截图。仅跳过普通矩阵的临时定向入口检查 **12/12** 缩放状态通过；完整矩阵另记，不合并宣称同轮通过。已检查400%深色设置截图，输入焦点完整可见。临时入口和截图在最终清理时移除；长期合同见[设计系统](design-system.md)。

## 2026-11-23 P8：终端数据库边界与完整助手路径

状态：**Verified passing**（本段终端与助手范围）。完整smoke首次终端回显失败，实际原因是项目权限查询误用了workspace/core数据库，后者没有research_projects表。权限由ResearchProjectWorkspaceContract从科研数据库读取并注入工作区插件；归档、删除或目录变化继续拒绝连接/输入/调整尺寸，清理仍可执行。新增真正分离的双SQLite回归先复现失败再验证修复。smoke改为等待真实ready并核对shell生成的独立输出行，输入回显不能通过；打包smoke同步连接令牌合同。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test tests/unit/workspace-terminal-project.test.mjs tests/unit/terminal-session-lifecycle.test.mjs tests/unit/terminal-ipc-owner.test.mjs tests/integration/terminal-session-reattach.test.mjs` **21/21**；`node --test tests/unit/main-kernel-startup.test.mjs` **1/1**；`pnpm typecheck`及`pnpm build`通过。`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-final-smoke3-20261123 pnpm smoke:electron` 主体 **23/23**，真实终端、助手、设置和125%缩放通过；1184px助手覆盖右侧，画布开关前/中/后均为900px宽且边界不变。深度路径首次因旧夹具假设助手默认展开而失败，已改为先进入会话上下文再显式打开助手，背景导航前先关闭覆盖层。

随后 `ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-final-p4-20261123 node scripts/verify-p4-assistant.mjs` **64/64**，包括真实工具/批准/拒绝/提问/取消、切项目恢复、SIGKILL崩溃后检查点续跑且工具不重复。516条消息只挂载17行、回放窗口115条，输入与滚动通过。结果来自本地受控HTTP provider，未宣称远端模型质量。最终CSS修复后的完整一轮验收另记。

## 2026-11-23 P5.3：真实选区润色与编辑器状态保留

状态：**Verified passing**（写作交互和运行合同范围）。学术润色通过原chat.startRun发起plan只读运行，接受实际JSON合同已校验的终轮响应，显示差异并由用户确认修改可撤销草稿。订阅早于启动、补读终态回放，项目/路径/磁盘/完整草稿/选区身份全程核对；编辑后撤销、移动选区和旧运行结果均不能误应用。已校验响应随终态/outbox/快照持久化，有整体容量保护，不从混合会话文本猜测JSON。plan仍有只读工具及自动记忆，文档明确此权限边界。

隐藏文稿时释放CodeMirror EditorView和Markdown/公式预览，保留EditorState、撤销历史、选区、滚动、草稿和预览开关。组合输入结束后等待编辑器自身微任务提交才释放；再次显示应用最新只读和值，替换前重新核对完整文档与选区。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，完整组合命令见P4.5/P7.4：写作 **17/17**、润色作用域 **6/6**、编辑器生命周期 **4/4**。包含实际组件启动/接收/确认路径、80段预览滚动恢复、隐藏KaTeX释放和组合输入DOM变更；组合事件不等于系统中文输入法验收。`pnpm test:unit` 最新 **2736通过、0失败、1既有跳过**，包含润色解析、冷恢复、终态事件与容量边界；`pnpm build`通过。

`node --test tests/integration/research-scientific-writing-runtime.test.mjs` **11/11**，使用真实离线Tectonic、Typst、Pandoc和Vale。此结果证明相应编译/导出通路，不替代外部模型质量与真人T3任务。合同见[工作台](research-workbench.md)及[响应合同](agent-response-contract.md)。

## 2026-11-23 P4.5 / P7.4：发现分页、处理轨迹与隐藏阅读视图

状态：**Verified passing**（文献界面与生命周期范围）。发现页订阅真实来源事件，按可信请求/项目隔离；合并前记录只读，最终候选可分页与加入。后页追加保持选择，每次导入最多30篇。五阶段轨迹进入已有信息、PDF、解析、索引和知识页，重试只提交真实任务版本；异步文档就绪不重建已展开的轨迹，旧文档重试回执不跨身份发布。

隐藏检索、笔记预览、问答证据、雷达和监控时释放只读重DOM，保留查询/草稿/选择/未决保存。ReadingViewBoundary在隐藏前记录滚动和details，返回同一内容时有界恢复；新内容重置位置，用户操作立即接管，不抢焦点。PDF原文高度保持既有预算，处理阶段收进标题披露。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。`node --test --test-concurrency=1 tests/renderer/source-editor-lifecycle.test.mjs tests/renderer/authoring-tools-layout.test.mjs tests/renderer/inline-polish-scope.test.mjs tests/renderer/discovery-search.test.mjs tests/renderer/reading-view-boundary.test.mjs tests/renderer/reading-note-guards.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-processing.test.mjs tests/renderer/paper-reader.test.mjs` 为 **126/128**，两项失败定位到处理轨迹在文档异步就绪时重挂载。修复组件身份并保留确定性回归后，`node --test --test-concurrency=1 tests/renderer/literature-processing.test.mjs tests/renderer/paper-reader.test.mjs` **28/28**。发现7/7、阅读边界4/4通过。此前文献组合134项中127通过，包括action-guards、retrieval-workspace、research-monitors；另7项失败及对应PDF高度、隐藏身份/滚动和夹具修正由本次定向检查覆盖，未记为单轮全绿。

`pnpm test:unit` **2736通过、0失败、1既有跳过**（2737项，434.7秒）；`pnpm build`、`pnpm check:renderer-chunks`通过，eager JS 517554 bytes / 11 files。外部学术源质量与真人阅读体验另验。

## 2026-11-23 P7.3：工件只读资源释放

状态：**Verified passing**（工件生命周期范围）。隐藏检视器释放只读Markdown、JSON、来源图像、综述报告/记录与生产文件字节；编辑器、草稿、协议版本、未决保存和关闭守卫继续存活。返回按同一版本恢复展开、分页、文件选择及阅读位置，不抢当前焦点；异步文件重新按原SHA读取。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` **52/53**。唯一失败为夹具在原生宽度变化尚未显示助手覆盖层时提前发Escape；改为等待真实覆盖层可见再关闭，`node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/authoring-tools-layout.test.mjs` **21/21**，其中Dock **5/5**。未放宽编辑器身份、保存锁、阅读位置或资源释放断言。此前全量renderer **944/944**，新变更以本段定向复验为准。文档见[工件检查器](research-artifact-inspector.md)。

## 2026-11-23 P4.4：检索快照分页与来源进度合同

状态：**Verified passing**（主进程与IPC合同）。发现页可显式请求每页30条，后续页读取同一可信owner/project和7天有效期快照；最多保留本次实际获取的900条融合候选，普通Agent工具仍受原limit限制。每个来源真实完成后只向发起窗口发送只读原始记录；候选身份仅在最终融合后生成，完成顺序不改变融合排序。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test tests/unit/literature-import.test.mjs tests/unit/literature-query-planner.test.mjs tests/unit/literature-domain-sources.test.mjs tests/unit/literature-search-progress-ipc.test.mjs` **103/103**；`pnpm check:ipc`通过。覆盖65条分30/30/5页、后页真实导入、旧limit、窗口/项目/过期隔离、先完成来源事件、相同requestId的不同窗口不串流。前端交互和真实外部服务另验；快照total不代表来源全部命中。合同见[文献融合](research-literature-fusion.md)。

## 2026-11-23 P6.4：设置布局与首个 Escape

状态：**Verified passing**。设置分类宽度统一 208px，表单上限 680px；即时主题、密度和字号附影响说明及可访问描述。设置、模型表单与粘底保存继续共享原浮层和草稿守卫。

此前两次设置 Escape 偶发已定位为 Radix 最高层监听器更新落后于新确认框 autofocus：父层旧监听器先消费 Escape，确认框没有关闭。新增确定性回归在首次 focusin 同步发键，修复前稳定失败。Roc 浮层归属改在 layout 阶段登记，仅纯确认框启用 window capture 按当前栈处理 Escape；设置主窗、远端模型选择器的焦点、Tab 与 Escape 仍由 Radix 管理，原生 select 先关闭自身选择层。没有增加固定等待或放宽断言。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`、`node --check tests/renderer/radix-settings-dialog.test.mjs`、`git diff --check` 通过；overlay stack 单元 4/4；`node --test --test-concurrency=1 tests/renderer/radix-settings-dialog.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/artifact-dock.test.mjs` **58/58**，54.7 秒。包含首聚焦 Escape、原生选择层两次 Escape、放弃/重置/删除、模型及密钥、背景抽屉、内联/覆盖 Dock、输入与导航，浅深两密度及 1440/1280/1184/800/640px 无横溢出且裁切为零。系统输入法和 VoiceOver 不由这些浏览器键盘事件代替。

## 2026-11-23 P7.2：终端隐藏、恢复与进程归属

状态：**Verified passing**。终端隐藏时释放 xterm DOM、尺寸观察和 IPC 订阅，主进程继续运行 PTY；按真实窗口、项目和目录恢复同一会话。输出使用有界 256 Ki UTF-16 缓冲和连接令牌，裁掉重播/实时重复区间并拒绝旧连接输入；超过容量明确提示截断。输出只发回所属窗口。显式结束需确认，窗口销毁和应用退出清理进程，项目归档/工作区变化重新校验权限。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`、`pnpm check:ipc`、`git diff --check` 通过；`node --test tests/unit/terminal-session-lifecycle.test.mjs tests/unit/terminal-ipc-owner.test.mjs tests/integration/terminal-session-reattach.test.mjs` **20/20**；`node --test --test-concurrency=1 tests/renderer/authoring-tools-layout.test.mjs` **13/13**。真实 node-pty 验证隐藏前后 shell PID 不变、隐藏期间输出恢复、结束/owner销毁/shutdown 后 PID 消失；界面验证 DOM 释放、重新连接、截断提示和结束回调先于 IPC 返回时确认框仍能正确关闭。完整窗口/打包路径另在 P8 验收，不能据此宣称所有子进程树或备用屏幕程序均可完整恢复。合同见[终端会话](terminal-sessions.md)；测试临时资料根自动清理。

## 2026-11-23 P8准备：原子写入并发夹具

状态：**Verified passing**（修正后的单文件范围）。仓库根 `pnpm test:unit` 首轮共2697项，2695通过、1失败、1跳过，446.1秒；失败为既有 `tests/unit/agent-filesystem-path-invalidation.test.mjs` 对同路径两次相互依赖编辑错误要求调用先后FIFO。路径规范化在入锁之前异步执行，第二次可先入锁；一次性门控探针证明入锁顺序反转但最大临界区并发仍为1，未发现生产互斥故障。

现两次并发编辑分别更新同文件的独立原文，仍要求两次成功、最终两处更新和prepared/published/durable真实回执。`node --test tests/unit/agent-filesystem-path-invalidation.test.mjs` 连续20轮 **80/80**；移除锁的一次性探针确认相同检查会发现版本冲突/丢更新。生产写入合同未修改，所有探针已清理。定向结果不写成全量一次通过，最终全量另记。

## 2026-11-23 P6.3：隐藏窗口的审批与继续状态

状态：**Verified passing**。原逻辑暂停隐藏窗口RAF，也延迟了run_interrupted/resumed/continued状态；现在三类控制事件同步冲刷同一顺序队列，先提交之前的文字再更新控制状态。文字增量仍按帧合批，原始序号事件先记录后投影，主进程权限、回执持久化及输入回执路径未改变。

工作目录及完整串行命令见P5.2，`tests/renderer/lifecycles.test.mjs` **86/86**。新增真实hook用例在隐藏状态立即读取权威状态，覆盖双审批逐个消费、前序文字、failed→continued、重复序号拒绝、显示恢复与卸载清理；共享assistant/目录/workspace单元组合43/43通过。界面及时投影不替代后端实际批准结果，最终smoke另验证副作用。

## 2026-11-23 P5.2：知识证据与隐藏资源

状态：**Verified passing**。RAG宽容器采用70:30原文/证据导航，窄窗折叠目录；支持关系明确标为待核验，唯一回答仍在实际助手中。打开来源沿用parse/source/locator身份，返回保留问题并恢复源按钮焦点；检索失败保留上次结果与对应原查询。Wiki/关系图模块首次进入才加载，隐藏时清理只读派生和重DOM，保留筛选、分页、选中及Wiki草稿；科学源预览隐藏后释放PDF资源。已有关系图为有界SVG，无新增无用Worker。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。P2.3记录的组合65/67，其中RAG7/7、图谱7/7、科学知识10/10通过。知识宿主探针位于Vite类型擦除之后，计数注入未命中；改成pre转换并检查正计数，下一阅读测试显式恢复自己的活动视图。随后 `node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/lifecycles.test.mjs` **113/114**，知识宿主完整 **6/6**，唯一失败为设置新增断言缺少expect导入，另记P6.4。知识范围累计30/30；静态类型、设计审计、derive单测15/15通过。图谱和科学知识截图现放自动清理的夹具目录。

## 2026-11-23 P2.3：壳控制层与右侧对象检视

状态：**Verified passing**（以下壳与对象回归范围）。AppShellContent只组合启动、主题、布局与快捷键；共享资源、对象动作及运行关注分别由workspace/panel/run-attention控制层持有，use-app-route保持唯一URL写入点。对象动作沿用同一导航、脏草稿和待保存守卫，未创建任务状态副本。

工件在默认344px右栏显示，与助手互斥；宽窗内联，窄窗复用已有覆盖策略。嵌入检查器复用ModalShell标题与滚动正文，不增加portal/模态焦点圈。切助手仅隐藏检查器、保留编辑器草稿与待完成写入；关闭/替换仍走原工件守卫。内联与覆盖互换保留输入焦点，阅读位置捕获涵盖已接受的卸载。已查看1440px浅色内联与620px深色覆盖截图。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm typecheck`通过；路由/守卫单测21/21（命令见P5.1）。P2.2记录的Electron组合 **107/108**，Dock3/3、工作区4/4、桌面31/31、综述9/9、壳14/14、冷加载10/10通过。唯一旧迁移测试切回后无条件Enter，关闭了现在正确恢复的details；修正为先确认恢复展开再用幂等展开helper，完整 `tests/renderer/artifact-inspector.test.mjs` **37/37**，随 `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/retrieval-workspace.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/knowledge-graph.test.mjs tests/renderer/scientific-wiki.test.mjs` 执行。后组65/67，2项知识夹具失败见P5.2；未把跨阶段组合记作一次全绿。

## 2026-11-23 P7.1：画布宿主保留预算

状态：**Verified passing**（宿主生命周期范围）。成功切换后卸载只读总览，后台只读预算为0；文献、写作、运行三个草稿/会话宿主明确固定保留。发现/知识/文献仍为同一宿主，冷加载失败不移除当前画布，切项目释放旧宿主。此策略没有把全部重DOM独立于状态，也不宣称已经实现PTY重连；终端cleanup仍会终止PTY，故不能直接卸载写作。

工作目录及单测命令见P5.1（保留预算3/3）；Electron完整组合命令见P2.2，其中 `tests/renderer/canvas-view-loading.test.mjs` **10/10**，覆盖20次切换、草稿/选区/导航监听、共享身份、导入失败和项目重建。此前新增测试在只读宿主外层出现时立即读取leaf数量，遇到React.lazy尚未提交而得到0；改为等待同一严格数量断言，复跑全部10项通过。实际内存/CPU和trace另由P7正式基准记录，不能以生命周期计数替代。

## 2026-11-23 P5.1：共享目录与写作问题面板

状态：**Verified passing**。文件树与写作复用同一目录索引、待完成请求及watcher，200ms合并后续文件变化，隔离不同工作区的迟到响应。隐藏写作暂停目录扫描与全局保存快捷键，保留正文草稿和导航/卸载保护，重新显示时读取最新元数据。编译问题移入160–240px可折叠底部区域，保留真实文件/行号、草稿保护、取消和导出；编辑/预览按55:45分配。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p5-captures-20261123 node --test --test-concurrency=1 tests/renderer/authoring-tools-layout.test.mjs tests/renderer/manuscript-sync.test.mjs tests/renderer/file-tree-virtualization.test.mjs` **13/13**，包括两个消费者合并读取、隐藏停止子目录扫描、恢复新增文件且脏草稿保留、真实组件错误行定位和取消/导出。`node --test tests/unit/renderer-directory-index.test.mjs tests/unit/renderer-view-retention.test.mjs tests/unit/renderer-routes.test.mjs tests/unit/renderer-navigation-guard.test.mjs` **30/30**，其中目录索引6/6。此次编译服务为受控返回，实际离线编译另由最终smoke验证。

## 2026-11-23 P2.2：按项目和模式恢复布局

状态：**Verified passing**。探索/专注/运行保留兼容URL标识，宽度与左栏折叠分别按项目/模式保存，最多60组；首次沿用旧全局宽度，新模式独立修改。当前模式重置恢复232/344px，侧栏200–340px、Dock280–520px；缩放覆盖状态不持久化，助手开关继续来自URL。ADR0023和工作台合同已同步。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test tests/unit/renderer-layout-preferences.test.mjs` **3/3**，覆盖损坏/不可用存储、旧宽度兼容、独立重置和60组保留；`pnpm typecheck`通过。串行组合 `node --test --test-concurrency=1 tests/renderer/artifact-dock.test.mjs tests/renderer/workspace-frame.test.mjs tests/renderer/desktop-interactions.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/review-protocol-inspector.test.mjs tests/renderer/shell-management-guards.test.mjs tests/renderer/canvas-view-loading.test.mjs` 为107/108，其中工作区 **4/4**，拖拽取消、左右分隔条、断点草稿和项目/模式隔离通过；唯一失败是旧工件迁移用例在阅读位置恢复期间选择目标超时，P2.3继续定位。没有把该组合记作全绿。

## 2026-11-23 P6.2：运行任务列表与详情

状态：**Verified passing**。运行画布以260px任务列表配合既有TaskDetail，700px以下堆叠；管理抽屉保留原选择器。任务每页25条并去重，未加载的深链目标仍可打开独立详情，列表失败显式重试。任务事实、审批、恢复、回执与诊断沿用同一权威数据和草稿守卫；高级诊断按需展开。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p6-captures-20261123 node --test --test-concurrency=1 tests/renderer/research-tasks.test.mjs tests/renderer/shell-management-guards.test.mjs` **40/40**。已查看深色宽窗任务主从截图，另覆盖浅深窄窗、长目标、键盘焦点、分页/失败/深链、项目切换与编辑保护。

此前跨阶段组合70/75：4项壳夹具仍等待已移除的任务下拉框，1项焦点断言在鼠标模式下仅调用focus。现改用真实任务行aria-pressed与Tab/Shift+Tab后确认焦点和outline，未放宽运行或编辑守卫。截图审阅后清理。P2对象Dock接线与最终全量回归另行验证。

## 2026-11-23 P6.1：工具失败与执行反馈

状态：**Verified passing**。工具、Hook与子代理失败状态首次出现时展开真实原因；用户随后手动折叠不会被重复事件强制展开，新的失败边沿可再次提示。成功历史继续按需挂载，保留原始参数、输出、顺序与回执，自动披露不移动输入焦点。

工作目录及完整组合命令见本日P3记录；`tests/renderer/assistant-activity-layout.test.mjs` **6/6**，覆盖连续流式完成、真实失败、手动披露、焦点保留及浅深320/400px，裁切为零。停止、批准与运行投影权威没有改写，实际副作用由最终smoke验证。

## 2026-11-23 P4.3：阅读检视器

状态：**Verified passing**。阅读检视器提供笔记、引用、证据三个原生键盘标签；笔记切换后保留草稿，引用复用BibTeX复制/导出与命名动作。证据来自wikiSnapshot，明确失效历史摘录，按实际parseId/rawLocator定位；PDF选中文字仍写入私人笔记，不伪造支持证据。窄窗检视器展开与原文回跳沿用已有阅读位置保护。

工作目录及完整组合命令见本日P3记录；其中 `tests/renderer/reading-layout.test.mjs`、`tests/renderer/reading-note-guards.test.mjs`、`tests/renderer/reading-tool-guards.test.mjs` **21/21**。覆盖笔记跨标签保留、引用输出、历史解析定位、翻译取消、删除/冲突保护、IME公式、晚到保存与重复提交。截图改放夹具临时目录并自动清理。真实PDF长翻页及完整外部服务T2另在P7/P8验收。

## 2026-11-23 P4.2：发现列表与候选预览

状态：**Verified passing**。900px容器起结果与预览按65:35排列，预览展示真实摘要、来源冲突、DOI和原入库动作；窄容器改为内联详情，返回/Escape恢复原候选焦点、筛选与滚动。部分来源失败保留有效结果；批量导入仍使用真实回执。

工作目录及完整组合命令见本日P3记录；其中 `tests/renderer/discovery-search.test.mjs` 与 `tests/renderer/literature-review.test.mjs` **6/6**，覆盖重复提交、部分来源、已入库排除、键盘披露、未知/归档权限和浅深窄宽布局。全应用布局快照另见P2.1记录；外部学术源T1尚未被受控夹具验证。

## 2026-11-23 P3：项目门户与研究总览

状态：**Verified passing**。门户每次挂载40项，搜索、计数与键盘Home/End仍遍历完整项目集合；总览按当前任务、最多3项待处理与真实类型成果组织，长目标可展开。继续研究的文案来自实际诊断，按钮只导航；不存在项目归属的会话不会被伪造。技术原因保留在可展开的错误标识中。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`。串行执行 `node --test --test-concurrency=1 tests/renderer/project-overview.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/discovery-search.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/reading-layout.test.mjs tests/renderer/reading-note-guards.test.mjs tests/renderer/reading-tool-guards.test.mjs tests/renderer/authoring-tools-layout.test.mjs tests/renderer/manuscript-sync.test.mjs tests/renderer/file-tree-virtualization.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/canvas-view-loading.test.mjs`：总计66/67，P3两文件11/11及阅读文件的任务原因测试通过；唯一失败为P7新增切页生命周期夹具，另行修复记录。组合设置 `ROC_UI_AUDIT_DIR=/tmp/roc-ui-p3-captures-20261123` 与 `ROC_UI_CAPTURE_DIR=/tmp/roc-ui-p6-captures-20261123`，截图审阅后清理。已查看1184px浅色紧凑与1440px深色舒适总览，长目标、焦点与内容边界正常。

此前44/45组合中TaskSummary夹具仍要求主层显示原始错误码；现改为检查可读原因与键盘展开原始标识，未删除诊断信息。真实外部服务恢复不在此夹具的证明范围。

## 2026-11-23 P4.1：文献游标分页

状态：**Verified passing**（分页接口和界面回归范围）。新 `research.library.listPage` 保留旧数组接口，按(updatedAt DESC,id ASC)稳定排序，单页事务返回真实total/hasMore/nextCursor；项目、归档和搜索由后端完整集合过滤，特殊LIKE字符按字面处理。前端每页200条，显式加载更多/重试；查询、刷新与项目切换隔离迟到响应，追加去重并保留选择与阅读详情，不跳回先前选中行。标题/年份排序和类型分类仍仅作用于已加载条目，界面已明确标记；不是全库排序。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm check:ipc`、`pnpm typecheck`；`node --test tests/unit/research-plugin-lazy.test.mjs tests/unit/research-library-pagination.test.mjs` **15/15**。`ROC_UI_AUDIT_DIR=/tmp/roc-ui-p3-captures-20261123 node --test --test-concurrency=1 tests/renderer/project-overview.test.mjs tests/renderer/project-session-layout.test.mjs tests/renderer/literature-pagination.test.mjs tests/renderer/literature-retention.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-processing.test.mjs tests/renderer/literature-action-guards.test.mjs tests/renderer/wiki.test.mjs tests/renderer/lifecycles.test.mjs` **146/147**。唯一失败为旧夹具仍查找“当前结果排序”，已更新为真实“已加载结果排序”；完整`node --test tests/renderer/literature-workspace-layout.test.mjs`随后 **5/5**。

数据库覆盖437条跨页、时间戳相同、总数、引用键、归档、游标行删除及新前置记录；Electron覆盖400条追加、多选保留、页失败重试、查询/项目隔离与独立详情。2k/10k资源测量在P7记录，不以小夹具替代。临时测试数据库由夹具清理。

## 2026-11-23 P2.1：画布优先与右侧助手

状态：**Verified passing**（几何、导航和以下回归范围）。栏序改为左栏、画布、右侧助手，默认232/344px；1440px起且画布保留760px才内联助手，1100–1439px保留左栏、助手覆盖，1099px以下双抽屉。分隔条向左扩大右侧助手，Home重置，Escape撤销；断点变化不卸载输入草稿。打开文件、文献、任务或引导会关闭覆盖助手，原导航与草稿守卫决定实际跳转。WorkspaceScope新增仅打开输入区的openAssistant命令。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm build`、`pnpm check:renderer-chunks`、`pnpm audit:design` 通过；`node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/page-ui.test.mjs tests/renderer/shell-management-guards.test.mjs` **19/19**。`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-p2-layout-20261123 pnpm audit:layout` **771状态、2079焦点检查**通过，裁切为零，包含浅深、1184/1280/1440px及缩放对应窄窗、hover/展开/动效落点。已查看宽窗写作与右侧助手、原生最小宽暗色助手、阅读页面截图。运行使用隔离profile，截图、日志和审计临时目录已清理。

首次组合16/19揭示覆盖助手阻挡画布与旧测试假设；修正对象导航后第二轮10/14，原因是旧openTask夹具再次点击助手开关，将已关闭的助手重新打开。改为断言导航后已关闭，未放宽草稿/审批/副作用断言；最终19/19通过。完整布局另包含并行开发中P3/P4的当时快照，各阶段行为验证仍单独记录。AGENTS.md在本机被忽略，其栏序说明已同步但不强制加入仓库。

## 2026-11-23 P1.3：页头、信息区与标准条目

状态：**Verified passing**。`shared/page-ui.tsx` 提供 PageHeader、PageSection、原生 PageListRow，复用 EmptyState/ErrorBar；导航、选择与异步状态仍归业务所有。永久夹具覆盖正常、空、加载、错误、受限状态。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`pnpm build`、`pnpm check:renderer-chunks`、`pnpm audit:design` 通过；`ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-p2-captures-20261123 node --test --test-concurrency=1 tests/renderer/workspace-frame.test.mjs tests/renderer/page-ui.test.mjs tests/renderer/shell-management-guards.test.mjs` 最终 **19/19**，其中页面组件 **2/2**。浅深主题、紧凑/舒适、1184/1280/1440px、320px 长标题无横溢出，裁切为零；原生 Enter/Space、禁用与焦点检查通过。已查看浅色紧凑1184px、深色舒适1440px截图，截图审阅后清理。壳体部分见独立 P2.1 记录。

## 2026-11-23 重构计划 P0.1：可复现审计

本轮执行当时的 2026-11-23 重构计划，代码基线为 `85e92a4bf0bfccda1a4d77a65373067139da13ce`。下方 11 月 20–21 日记录属于历史轮次，与本计划 P0–P8 分开。

状态：**Verified passing**（审计依赖和测试准备范围）。两套本机 Skill 审计脚本原先被 Git 忽略，布局与 renderer 测试无法在干净检出中找到它们。现统一读取 `scripts/ui-audit/`，包含 MIT 许可、原始/当前 SHA256 与修改说明；`pnpm audit:design` 为固定入口。

新增阳性测试复现纯黑阴影漏报：原 `rgba?` 正则把 `rgb(0, 0, 0)` 的蓝通道零视为 alpha 零。修复只改变透明度识别，不改变裁切几何与容差；回归覆盖纯黑、零蓝通道、hover、足够留白、整边隐藏及显式透明。公共 Vite 夹具也在创建随机目录前建立 `.runtime/tmp/`，消除首次运行的 `ENOENT`。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/ui-clip-audit.test.mjs tests/unit/ui-audit.test.mjs
pnpm audit:design
node --test tests/renderer/literature-list-layout.test.mjs
git diff --check
```

结果：审计行为与来源校验 **3/3**；设计扫描 **270 文件**；文献列表完整回归 **3/3**；差异检查通过。首次 103 项基线因缺少临时目录在准备阶段失败；修复后 102/103，一项虚拟列表滚动断言失败，单项及完整文件随后通过。保留这次偶发记录，不把定向重跑写成整套一次通过。

本部分不改变生产 UI。当前构建、全布局与性能数字在 P0.2 记录；T1/T2/T3 外部服务、人工输入法和 VoiceOver 仍需各自验证。临时日志与截图在本轮审阅后清理。

## 2026-11-23 P0 基线修复：导入请求只消费一次

状态：**Verified passing**（导入请求生命周期）。全布局检查发现：从侧栏打开并关闭导入弹窗，返回项目入口，再进入同一项目，已关闭弹窗会重开并遮住发现页。原因是请求存在共享 store，而已消费标记仅存在 Hub 的局部 ref，卸载后丢失。消费确认现保存在共享 store，按请求 ID 确认，保留冷挂载前和非活动期间的新请求。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：`node --test --test-name-pattern='sidebar import requests' tests/renderer/literature-workspace-layout.test.mjs` 修复前复现失败；修复后 `node --test tests/renderer/literature-workspace-layout.test.mjs` **5/5**，`pnpm typecheck`、`git diff --check` 通过。完整应用的返回项目路径将在 P0.2 重新构建后复跑，不以组件回归代替全布局结果。

## 2026-11-23 P0.2：当前工程基线

状态：**Verified passing**（以下工程基线范围）。应用基线为 `42c3a78`（包含 P0.1 和导入请求修复）。本次布局驱动按当前可见列表选择唯一导入入口，仍校验恰有一个入口；完整 smoke 的 P4 子闸门也支持把诊断放入指定临时目录。没有放宽几何、业务或分包门槛。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，以下命令通过：

```sh
pnpm build
pnpm check:ipc
pnpm check:renderer-chunks
pnpm audit:design
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-p0-layout-complete-20261123 pnpm audit:layout
node scripts/performance/bench-macos-app.mjs /tmp/roc-ui-p0-performance-final-20261123.json --samples 5 --idle-minutes 0
ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-ui-p0-smoke-final-20261123 pnpm smoke:electron
```

- 构建含类型检查通过；eager JS **503389 bytes / 10 files**，各应用 chunk 低于 500000 bytes。保留上游 Mermaid/ELK 提示，未改预算。
- 布局 **771 状态 / 2079 次焦点与无遮挡检查**通过，阴影裁切最大 `cut=0`。浅/深各覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及普通/减弱动效。原生最小宽度保持 1184px，较窄尺寸是测试窗口内的 CSS 视口模拟。已查看浅色工作台、深色文献阅读、380px 模型设置截图。夹具为空/少量受控内容，不能当海量真实文献或 PDF 证据。
- 前次矩阵在浅色 1099px 的截图步骤出现 `Target page, context or browser has been closed`，无足够诊断确定原因；完整同参数重跑通过，保留中断记录，不声明已修复其根因。此前导入入口和请求重放两处阻塞已分别修正。
- **15 次**同机启动/历史加载量测完成，结果与逐样本证据见[性能方法及基线](research-performance.md#2026-11-23-ui-工程基线)。0/1,000/10,000 合成消息的主窗就绪 P95 分别 1289.8/1347.2/1276.6ms；后两组采样均挂载 13 条消息。测量期间没有并行运行 Electron 测试或构建。
- 完整 smoke：核心 **23/23**，助手深度路径 **64/64**。涵盖隔离工作区真实文件/Git/PTY、本地受控 provider、批准/拒绝的实际文件结果、停止与恢复、检查点进程重启、516 条消息下有界回放与滚动、125% 缩放。首轮深度路径打开侧栏后未关闭覆盖抽屉，助手正确处于 inert；修复脚本操作顺序后完整重跑通过。运行应用仍是上述 P0 构建，末尾类型检查同时覆盖工作区中正在实现的 P1.1 源码。真实外部模型和人工输入法未由这些结果验证。

P0 尚有独立验收缺口：100 个项目，100/2,000/10,000 篇文献，500/5,000 条流式消息，200 页 PDF 连续翻页，20 次面板切换，30 分钟空闲 CPU/RSS、输入到绘制/FPS/Profiler，以及真实服务 T1/T2/T3、系统输入法与 VoiceOver。P1 可在已固定的工程基线上按切片推进，这些缺口不记为已完成。

## 2026-11-23 P1.1：共享按钮六态

状态：**Verified passing**（按钮及设置接入范围；全量 renderer 有下述失败）。

`ActionButton` 在既有 `shared/form-ui.tsx` 中复用按钮类；默认/悬停/按下/禁用/加载/可见焦点使用同一契约。加载由调用方控制，显示图标与真实操作文案，设置 `aria-busy` 并禁用。模型设置的保存密钥、测试连通和设置保存栏已接入，原有密钥保存同步防重、失败重试、草稿和供应商身份隔离保持在业务层。保存栏按下位移现在尊重减弱动效。

永久组件画廊属于测试，不增加产品入口。真实 CSS 下检查浅/暗、两种密度和 1184/1280/1440px，驱动 hover/按下/Tab，校验最小字号 12px、点击目标 28px、无横溢出及 `clip.cut=0`。已查看浅色紧凑 1184px 和深色舒适 1440px 截图。回归还覆盖外部表单提交、原生 name/value/ref、disabled fieldset、加载防点击、恢复后键盘可达，以及 busy 与 saving 的区别。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-gallery-20261123 node --test --test-concurrency=1 tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
pnpm test:renderer
node --test --test-name-pattern='rendered transcript keeps|intentional scroll away' tests/renderer/lifecycles.test.mjs
node --test tests/renderer/literature-list-layout.test.mjs
```

构建、分包、设计门禁和按钮定向检查通过：定向 **14/14**；eager JS **503800 bytes / 10 files**，比 P0 增加 411 bytes，分包预算未改变；设计扫描 270 文件。

完整 renderer **895/898 通过**，耗时 1875 秒，3 个失败均为滚动断言：`lifecycles.test.mjs` 历史裁剪后原消息锚点不可见（当时 1376 行），下一会话未到初始底部（当时 1447 行）；`literature-list-layout.test.mjs` 滚到顶部后第 120 行仍挂载（135 行）。未修改测试的定向复跑中，文献完整文件 **3/3**，两项消息流测试 **1/2**（初始底部失败仍复现）。文献同类失败在 P0 已出现；消息流后续诊断与修复见下节，不把重跑结果写成全量通过，不改动断言容差或延长超时。

本子项不代表 P1 的 tokens、输入/菜单、状态、列表与检视器全部完成。临时日志和截图在审阅、提取必要诊断后清理，正式组件夹具和验证记录保留。

## 2026-11-23 P0.3：消息流回归夹具校正

状态：**Verified passing**（夹具校正及以下组合验证范围）。

全量失败的两个消息流用例已定位到夹具问题。旧夹具没有应用 CSS，默认段落外边距使测量行高约 22.5px、实际行距 38.5px；80 条消息的初始滚动停在 1520px，而实际内容高度为 2244px、视口 320px。几何相交检查还把 Virtuoso `visibility:hidden` 的初始化行当作可见锚点，历史更新会与尚未结束的初始化定位重叠。探针确认 `checkVisibility()` 默认不检查 CSS visibility，必须显式传入 `visibilityProperty: true`。

夹具现与其他 renderer 测试一致读取本轮 `pnpm build` 生成的 CSS，等待真实可见的初始化列表，并按 Virtuoso `data-index` 确认 prepend/trim 已应用。保锚场景明确先上滚阅读历史；位于底部时继续追随新尾部仍由独立用例验证。原 2px 断言和超时保留，未新增固定等待或改动生产消息流。仅保留失败时的几何诊断，临时滚动钩子、轨迹及探针均已删除。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
node --test tests/renderer/lifecycles.test.mjs
node --test --test-concurrency=1 tests/renderer/lifecycles.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/action-button.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/lifecycles.test.mjs
git diff --check
```

最终生命周期完整文件连续 **5 轮 85/85**；消息流、文献列表、按钮和设置组合 **102/102**；语法与差异检查通过。先前 898 项全量运行仍按原成绩保留；文献列表偶发失败的根因尚未证实，不标为已修复。

## 2026-11-23 P1.2：共享表单反馈、只读与模型字段校验

状态：**Verified passing**（本子项和最终 70 项组合范围；首次 Escape 偶发仍记录如下）。

共享 `TextField`、`NumberField`、`SelectField` 统一独立标签、说明和错误关联，`CheckboxField` 将说明从名称中分离。文本/数值使用原生只读并显示标记；数值提交检查只读、自身及祖先 fieldset 的禁用状态，复用 IME 守卫，保留空值、零及失焦/Enter 提交契约。沿用现有 tokens，不新增校验规则。

模型设置接入当前 `validateDraft`：名称、类型、接入地址、模型标识/显示名及高级数值的错误显示在对应字段，供应商重排后按 ID 重新定位校验路径；错误首次出现时展开高级参数，修正后保持展开。既有嵌入配置 ID 改为可聚焦、可选择复制的只读字段；新配置 ID 可编辑，保存期间仍由整个 fieldset 禁用。全局校验汇总与既有写入、草稿、密钥保护继续保留。

工作目录 `/Users/Apple_501/Desktop/Roc/Roc`：

```sh
pnpm build
pnpm check:renderer-chunks
pnpm audit:design
ROC_UI_AUDIT_DIR=/tmp/roc-ui-p1-form-fields-captures node --test tests/renderer/form-fields.test.mjs
node --test --test-concurrency=1 tests/renderer/form-fields.test.mjs tests/renderer/model-provider-settings.test.mjs tests/renderer/settings-write-guards.test.mjs tests/renderer/action-button.test.mjs tests/renderer/radix-settings-dialog.test.mjs tests/renderer/management-draft-guards.test.mjs
node --test --test-name-pattern='settings dialog layers|reset confirmation accepts' tests/renderer/radix-settings-dialog.test.mjs
node --test tests/renderer/radix-settings-dialog.test.mjs
node --test --test-name-pattern='reduced motion preserves' tests/renderer/action-button.test.mjs
node --check tests/renderer/form-fields.test.mjs
node --check tests/renderer/model-provider-settings.test.mjs
node --check tests/renderer/settings-write-guards.test.mjs
node --check tests/renderer/action-button.test.mjs
git diff --check
```

表单语义回归先复现缺少 NumberField 描述、只读属性及 IME Enter 误提交，再修正实现。最终表单 **4/4**；画廊检查浅/深 × 紧凑/舒适 × 1184/1280/1440px，以及 320px 容器，无横溢出、`clip.cut=0`、焦点可见；已人工查看浅色紧凑 1184px、深色舒适 1440px 与模型设置高级参数截图。构建（含类型检查）、分包及设计扫描 270 文件通过；eager JS **505042 bytes / 10 files**，应用 entry chunk 预算未改变。

首轮设置集成 **12/14**，两项新增断言错误分别为 Zod 实际提示 `>0` 与 macOS 全选键；修正后该组全部通过。首次扩大组合 **68/70**：设置放弃确认的 Escape 未关闭，导致下一用例被残留弹窗阻挡；未修改弹窗，原失败对 **2/2**、完整文件 **22/22** 均通过，偶发根因尚未确认。第二次组合 **69/70**，失败为既有 ActionButton 的减弱动效即时取样。单项复现和探针确认 `:active=true`，CSS 过渡为 0.01ms，同帧 opacity 为 1、下一帧为 0.9；改用既有超时内轮询视觉生效，保留无位移断言，未改生产样式或增加固定等待。最终结果见本节末尾。

最终六文件组合 **70/70**，耗时 58.5 秒；语法和差异检查通过。合成 composition 事件与复制事件只验证浏览器交互，不代表系统中文输入法、系统剪贴板服务或 VoiceOver 已人工验收。本次未重跑 898 项全量 renderer；P0.3 中的历史成绩和文献列表偶发问题仍保留。截图、日志与临时运行目录审阅后删除；只保留正式代码、回归夹具和文档。模型设置独立测试改为仅在指定 `ROC_UI_AUDIT_DIR` 时导出截图。

## P0 工程基线（2026-11-20）

macOS 27.2.1 arm64，Electron 45，基线提交 `dd7511a`。隔离数据根启动当天既有 dist，窗口 1320×860，原生最小 1184×640。门户、默认写作、文献、发现（雷达）、知识（RAG）五面均成功加载，无 pageerror、无页面横向溢出，阴影审计均 `cut=0`。截图检查确认默认空写作页、重复文件列表，以及文献七标签带来的多层导航。

仓库根执行：

- `pnpm check:renderer-chunks`：通过，eager JS 481730 bytes / 10 files。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：239 文件通过。
- `pnpm typecheck`：通过。

导航诊断仅在当前窗口内存保留最近 500 个事件，记录页面类别和相对耗时，不含项目标识、查询、文件路径或凭据，不自动上传。任务事件继续使用实际运行事件；本地诊断不构成第二套任务状态。

用户访谈、T1–T3 真实外部服务任务、SUS 与灰度发布尚无证据；工程检查不能代替这些验收。临时截图和隔离运行数据在检查后清理，不进入版本库。

## P1 信息架构与设计契约

[设计契约](design-system.md)固定五目的地、对象与动作归属、十个关键状态的文字线框、集中旧深链迁移、抽屉与原生窗口边界及组件 Do/Don't。复用现有 token、组件和单壳，草稿与业务事实保持原有权威来源。文档与本地引用已检查；这些线框未冒充真人可用性测试结论。

## P2 壳体与系统

五目的地、工作台、集中旧深链迁移、写作内终端、共享文献宿主与 1200px 抽屉阈值已接入。仓库根 `pnpm build`、`pnpm check:renderer-chunks`、设计规则审计通过；eager JS 482999 bytes / 10 files。

`node --test tests/unit/renderer-routes.test.mjs tests/unit/surfaces.test.mjs`：29/29，通过 1920 路由组合。`node --test --test-concurrency=1 tests/renderer/canvas-view-loading.test.mjs tests/renderer/literature-workspace-layout.test.mjs`：10/10，覆盖共享宿主与草稿保留。

隔离 Electron 实窗完成默认工作台、冷入口导入、五目的地、终端、管理深链、1280px 列布局及 1184px 抽屉检查；浅/深主题无 pageerror、无横溢出，`clip.cut=0`。

## P3 文献与发现

发现页默认搜索，来源部分失败保留结果，批量收录展示后端原始分项回执。导入四入口、六能力；阅读器与后台处理展示五阶段，解析不推断索引，缺记录明确待核验。列表增加当前结果排序与批量引用导出。

仓库根 `pnpm typecheck`、设计规则审计通过。`node --test tests/unit/literature-pipeline-state.test.mjs` 5/5；发现 Electron 回归 1/1；导入状态与编辑保护 12/12；阅读与后台处理 20 项均通过（修正旧文案断言后单独复跑失败项）；文献列表与复制动作测试通过。外部搜索和下载未以 fixture 冒充验收。

## P4 知识与写作

提问先检索真实证据，再通过现有助手通路生成答案；知识画布保留检索上下文。问答与知识页是二级入口，关系图从知识页进入。文献/概念跳转携带稳定对象与定位信息，阅读及路由守卫放行后才提交选择。

写作新增工作区编译、取消与原生导出，复用离线 Tectonic、工作区路径校验和资源预算。编译先保存草稿，PDF 使用既有预览协议；只保留 PDF 成果，任务快照与日志在结束后清理。

仓库根 `pnpm build`、`pnpm check:ipc`、设计规则审计通过；`pnpm check:renderer-chunks` 为 486244 bytes / 10 eager files。`node --test tests/renderer/retrieval-workspace.test.mjs` 5/5；`node --test --test-name-pattern='RAG' tests/renderer/desktop-action-guards.test.mjs` 2/2。问答 1100/420px、索引 1100/380px 浅深主题均 `clip.cut=0`，截图检查后删除。

`ROC_WORKSPACE_LATEX_TOOLCHAIN=.runtime/research-toolchain/darwin-arm64 node --test tests/unit/research-workspace-latex.test.mjs` 4/4：含本机真实离线编译，验证有效 PDF、保存内容快照、失败/取消清理及越界/归档/符号链接拒绝。知识问答的模型回答仍需真实模型配置后的 T2 任务验收，不将受控 IPC 测试计为模型质量结果。

`node --test tests/renderer/authoring-tools-layout.test.mjs` 6/6，含保存→编译、构建问题行定位、PDF 预览、导出取消和取消等待回执；浅深色 440/820/1200px 均 `clip.cut=0`。原生另存对话框未手工操作，受控 IPC 只证明界面正确处理成功/取消回执。`node --test --test-concurrency=1 tests/renderer/literature-workspace-layout.test.mjs tests/renderer/literature-retention.test.mjs` 相关 4 项通过（旧 fixture 补齐 `updatedAt` 后复跑）：覆盖双守卫、笔记页跳阅读器、重复概念/证据定位、查询保留。

## P5 助手与任务中心

顶栏和管理抽屉共享一次读取的任务投影；研究任务、后台任务、文献处理各自保留权威来源与错误。分页结果明确标为近期，项目后台任务按工作区筛选。总览提供当前、待处理、最近结束及失败分组，打开原有详情与恢复操作。助手优先展示任务阶段、最近完成与真实成果，完整参数、用量和诊断按需展开。批准/拒绝保持同等视觉权重；停止请求保留等待清理回执，失败不冒充已停止。

仓库根 `pnpm build`、`pnpm typecheck`、设计规则审计、`git diff --check` 通过。`pnpm check:renderer-chunks` 为 491998 bytes / 10 eager files。

- `node --test tests/renderer/task-center.test.mjs`：2/2，覆盖三来源、作用域、分页口径、失败与晚回包、键盘打开；440/720px 浅深主题与 hover 均 `clip.cut=0`。
- `node --test tests/renderer/shell-management-guards.test.mjs`：8/8，顶栏与工作区进入同一任务中心，保留管理草稿、导航、工件与 Git 保护。
- `node --test --test-name-pattern='task categories' tests/renderer/management-draft-guards.test.mjs`：1/1。
- `node --test tests/renderer/native-state-guards.test.mjs`：7/7，原生窗口与项目绑定保护。已删除被任务中心替代的顶栏轮询 hook。
- `node --test tests/renderer/assistant-panel-guards.test.mjs`：15/15，IME、草稿隔离、停止、检查点恢复和三类审批。
- `node --test tests/renderer/research-tasks.test.mjs`：23 项均通过；首次 20/23，更新阶段文案断言和原生折叠展开等待后定向 3/3。覆盖真实成果、停止清理、恢复能力、诊断与草稿保护。

## P6 引导、可读性与交付检查

工作台加入三步内联引导，可跳过并从帮助重开，沿用导航守卫。只保存版本化关闭偏好，不保存业务进度。设置提供本次窗口匿名诊断的显式复制出口；复制失败可重试，提交中锁定按钮。界面中点分隔文案已移除。

弱化文字使用同一语义 token 修正。按 sRGB 相对亮度计算：暗色 `#909099` 在最弱的已检查面板 `#27272a` 上为 4.71:1；浅色 muted `#596579`、subtle `#606774` 在 `#e2e8f0` 上分别为 4.78:1、4.62:1。该结果限定这些文字/背景组合，不等同整应用 WCAG 认证。

以下命令均在仓库根 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

- `pnpm build`、`pnpm typecheck`、`pnpm check:ipc`：通过。
- `pnpm check:renderer-chunks`：493155 bytes / 10 eager files，低于 500000 bytes 预算；相对 P0 增加约 2.4%。大型编辑器、PDF、终端和图谱仍按需加载。
- `python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer`：247 个组件通过脚本已实现的规则。
- `node --test --test-name-pattern='first steps' tests/renderer/shell-management-guards.test.mjs`：1/1，覆盖关闭偏好、重新挂载、导航拒绝、重开后的焦点及匿名事件字段。
- `node --test --test-name-pattern='application session diagnostics' tests/renderer/settings-write-guards.test.mjs`：1/1，覆盖 500 条上限、字段白名单、复制 pending/失败/重试；480px 浅深主题无横溢出、`clip.cut=0`。

`ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-p6-layout-XC81zK/retry pnpm audit:layout`：762 个状态通过，2063 次控件焦点与无遮挡检查通过；浅/深主题各覆盖 1440×900、1280×820、1200×820、1199×820、1184×820、720×760、380×760、1200×540，并检查减弱动效与普通动效的最终落点。原生最小窗口保持 1184×640；窄尺寸通过可丢弃 Electron 窗口的 renderer viewport 模拟，不宣称原生窗口可缩至 380px。无页面横溢出、低于 12px 字体、低于 24px 点击目标，阴影审计最大 `cut=0`。浅深引导、1184 抽屉、1280 任务中心与发现页截图已人工检查。

首轮布局在知识页面发现搜索输入框仅高 19px；为共享知识搜索框设置 24px 最小高度，运行 `pnpm exec electron-vite build` 后再完成上述全矩阵。没有降低审计门槛或跳过该控件。

`ROC_SMOKE_TARGET=dist ROC_SMOKE_ARTIFACT_DIR=/tmp/roc-p6-smoke-xyadu1 node scripts/smoke-electron.mjs` 的核心 16 项通过，包括首次引导、统一任务入口、真实工作区文件/Git/PTY、本地受控 provider 的运行和设置保存。新增缩放段最初因自动化在响应式抽屉落地前检查侧栏而失败；修复脚本等待布局与引导焦点的时机，未改应用代码。修复后未重复整轮 smoke，不能将本轮记作整套脚本全绿。

随后在仓库根通过 `ROC_SMOKE_TARGET=dist node --input-type=module` 的隔离 harness，直接读取并执行 `scripts/smoke-electron.mjs` 中 `// One real zoom pass` 开始的最新缩放段，工作台/设置 2/2 通过。真实窗口 1280×820、倍率 1.25、CSS 视口 1024×656；关键控件获得键盘焦点且 `elementFromPoint` 命中，字号、目标尺寸、溢出和裁切均通过。脚本等待响应式布局完成后关闭导航抽屉，最终恢复倍率和窗口尺寸。该倍率的实际鼠标点击尚未验证。Playwright 缩放截图存在导出裁切，改用 Electron `capturePage()` 获取完整 2560×1640 原生截图，人工检查通过后删除。

最终 `node --check scripts/smoke-electron.mjs`、`node --check scripts/ui-layout-audit.mjs`、`git diff --check` 通过。检查脚本在结束时清理自己创建的隔离数据根，截图目录可通过环境变量指定。

## 验收边界与回滚

本轮完成本地工程实施和已记录的工程检查，不声明用户研究或发布门槛全部达成。5–8 名真实目标用户的 T1–T3 测试、SUS、真实外部搜索/下载与模型质量、人工 VoiceOver、操作系统输入法和滚轮体验、长期 CPU/内存及崩溃恢复、安装包分发和灰度发布尚未完成。受控 IPC 与本地 smoke provider 的通过只证明相应工程通路，不代替外部服务和用户体验结果。

每阶段使用独立本地提交：P0 `243720b`、P1 `39d940b`、P2 `cec5f23`、P3 `cb8644b`、P4 `e13e0e9`、P5 `320766b`，P6 为本节及最终收尾所在提交。需要回滚时，从目标阶段的后续提交开始逆序 `git revert`，再构建并运行受影响的检查；不使用 reset 清除历史。本轮未执行回滚或远端发布。回滚代码不会删除已有文献、项目文件、编译 PDF 或用户数据，也不应为回滚界面而重置数据库。

工程截图、隔离 smoke 数据和临时计划在检查后清理；保留本记录、设计契约、回归检查及用户原始方案。


## 2026-11-21 页面密度与组件复用

本轮以 `1d6865c` 为起点，核对 Apple HIG、Microsoft Fluent、IBM Carbon 的布局与组件指导，参考成熟 Sidebar、Radix Dialog 和 Virtuoso，沿用既有 token、单壳与依赖。来源和应用位置见[设计契约](design-system.md#官方参考与组件复用)。没有新增组件库，也没有新增临时方案文档。

完成项目门户固定查询区、工作台成果/文献自适应并列、文献两层工具栏与虚拟列表、助手分层输入与历史成功工具披露、后台任务平面列表和筛选。补齐虚拟行卸载后的键盘焦点、流式结束后的工具 DOM/展开态保留、高缩放短视口门户滚动。现有文档的栏序、断点、四目的地与设置分组同步到当前代码。

本地提交：`3de1ce0` 项目布局、`5cc2603` 后台任务、`38ef779` 文献列表、`0a14048` 虚拟焦点、`3d33800` 助手、`75405a3` 高缩放与对齐；文档收尾使用后续独立提交。

环境：macOS 27.2.1 arm64，Electron 45.3.4。以下命令在 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

```sh
pnpm build
pnpm check:renderer-chunks
python3 .agents/skills/b-end-design-system/scripts/audit-design-rules.py src/renderer
node --test --test-concurrency=1 tests/renderer/project-session-layout.test.mjs tests/renderer/literature-list-layout.test.mjs tests/renderer/literature-action-guards.test.mjs tests/renderer/management-draft-guards.test.mjs tests/renderer/task-center.test.mjs tests/renderer/assistant-activity-layout.test.mjs tests/renderer/assistant-panel-guards.test.mjs tests/renderer/desktop-interactions.test.mjs
ROC_SMOKE_TARGET=dist ROC_UI_AUDIT_DIR=/tmp/roc-ui-refactor-MS2nxb/final-layout pnpm audit:layout
git diff 1d6865c --check
```

- 构建、内含类型检查、chunk 门禁、差异检查通过；258 个组件通过脚本已实现的设计规则。
- 合并 Electron 回归 **101/101**，无跳过。覆盖项目筛选/编辑、文献虚拟列表/批选/复制、后台刷新失败与草稿、助手输入/停止/审批、CJK 事件守卫、浮层焦点与缩放对应短视口。
- 全应用布局 **771 状态**、**2079 次控件焦点与无遮挡检查**通过，所有阴影审计 `cut=0`。浅/深主题覆盖 1440×900、1280×820、1100×820、1099×820、1184×820、720×760、380×760、1200×540，以及减弱动效、hover、展开和普通动效落点。门户、工作台并列、助手模型浮层、窄设置等截图已查看。原生最小窗口仍为 1184×640；低于此尺寸使用隔离 Electron 窗口内的 renderer viewport 模拟。
- 审查在真实 Electron 1184×640、400% 缩放复现门户列表归零后，新增不超过 400px 高度的整页滚动规则；随后上述最终 101 项回归在 296×160 CSS 视口及 244×122 壳内内容空间验证入口与搜索均可聚焦。此追加规则只影响全矩阵未覆盖的极短视口，未重复整套矩阵。
- 文献 200 条实测只挂载 13 行；按需加载虚拟组件，首末跳转、排序、外部选择、手动滚动卸载和复制动作均有行为回归。
- 历史 500 次成功工具调用折叠时组内 DOM 少于 20 个节点；展开可查看全部回执。当前流式消息完成后保留同一焦点节点与输出节点，错误、审批、推理和可导航综述回执不被聚合隐藏。
- 最终 eager JS **502830 bytes / 10 files**，对比本轮既有构建基线 **501716 bytes** 增加 1114 bytes（约 0.22%）。应用入口与各应用懒模块均低于 500000 bytes 门禁；总 eager 预算由脚本维护。编辑器、PDF、终端与图谱继续懒加载。构建保留 Mermaid/ELK 上游大模块提示，未调整门槛。
- 更新的 Markdown 本地链接已核验。所有本轮临时截图、日志、隔离运行目录已清理；未创建中间计划或报告文件。

状态为 **Verified passing**，范围是本轮代码与上述工程检查。未重新打包或发布应用；人工系统输入法、VoiceOver、真实滚轮、长期 CPU/内存和真实外部服务任务不属于这些自动化结果。README 保留注明日期的既有真实业务截图，不把受控测试截图替换成真实业务证据。
