# S08 执行报告

状态：`Verified passing`（S08 本地工程；科学、外部互操作与发布未完成）。
起点 `0734156e5f50726a66c2dccc68ecc1f3f263d9ed`；本报告随 S08 工程提交。
工作目录 `/Users/Apple_501/Desktop/Roc/Roc`，macOS arm64、Node 26.13.0、pnpm 12.5.1、
Electron 45.0.0。原生检查 PATH 前缀 `/tmp/roc-s02-python.QTIAVb` 提供 Python 3.14.7。
证据根 `.artifacts/research-harness/S08/`；最终汇总见 `final-verification.json`。

## 实现与闭包

- `research-export-validation.ts` / `export-validation.ts` 定义 validation v1。
  导出 manifest v4 收录 `provenance/validation.json`，绑定精确人工审核文件、
  source/artifact/claim/PDF hash、语义报告当前性、人工关系及执行时 Skill/model/Task 来源。
- 批准、完成、交付边界统一 `assertCurrentExportReviews`。语义或人工审核变化后，
  旧导出不能继续获批；v3 缺清单时提示重新生成，保留历史 ZIP 字节。
- 实验材料明确随包或需外部取得，重放 `not_run`、科学复现 `not_verified`。
  参考文献/期刊补充资料 metadata-only，本地 prepare/export 不触发外部发布。
- 生产 P0 打开真实交付 ZIP，逐成员比对 sealed 文件清单、size/hash、重复和越界路径，
  回读 validation、人工审核、manifest、RO-Crate；不是只检查生成对象。
- 更新迁移目标标签、三份 ADR、迁移/删除台账和 [操作手册](s08-release-handbook.md)。
- smoke 尊重显式 dist/packaged 目标，P4 夹具配置真实项目预算、采用当前 wire 请求。
  mac smoke 去掉 renderer 不得提供的 `source` 权限字段。`lowlight` 只由 renderer
  使用，移至 devDependencies，避免包内多带其 highlight.js 依赖。
- 补齐 unrelated/unable_to_verify，使核验支持统一合同中的六种结论；同步共享
  output schema v4、11 份 Skill 1.3.0 和 catalog。规则 v1及人工权威不变。

## 最终源码与候选包

以下命令均已退出 0。原生命令使用上述 Python PATH 前缀；源码/产物及日志 hash
见 final-verification.json。最终应用为 `release/mac-arm64/Roc.app`，ad-hoc 签名。

| 实际命令 | 结果 / 日志 |
| --- | --- |
| `pnpm test:unit` | 1590/1590；six-verdict-unit-all.log |
| `node --test tests/unit/research-scientific-review.test.mjs tests/unit/research-export-validation.test.mjs tests/unit/research-semantic-publication.test.mjs tests/unit/research-skill-registry.test.mjs` | 42/42；six-verdict-unit.log |
| `node --test tests/renderer/response-matrix.test.mjs` | 10/10；six-verdict-renderer.log；六结论界面/键盘实测 |
| `pnpm check:ipc`、`pnpm check:renderer-chunks`、`pnpm harness:eval` | exit 0；six-verdict-ipc/chunks/harness.log；harness 94 |
| `pnpm package:dir` | build/typecheck 与 arm64 包通过；package-final.log |
| `node scripts/verify-native-packaging.mjs --require-base release/mac-arm64/Roc.app/Contents/Resources/app.asar/package.json --label s08-final` | exit 0；native-final.log |
| `node scripts/verify-arm64-only.mjs --strict` | 20/20；arm64-final.log 与 arm64-final/report.json |
| `node scripts/run-research-p0.mjs` | 19/19；six-verdict-p0.log；真实 ZIP、PDF 编译、故障与攻击 |
| `P4_KEEP_DATA_ON_FAILURE=1 ROC_SMOKE_TARGET=packaged node scripts/smoke-electron.mjs --full` | 基础 14/14、P4 62/62；packaged-final-full.log 与 packaged-final-full-smoke/ |
| `node scripts/smoke-mac.mjs release/mac-arm64/Roc.app` | exit 0；smoke-mac-final.log 与 mac-final/result.json |
| `node .artifacts/research-harness/S08/packaged-pdf.mjs` | exit 0；packaged-pdf-final.log；protocol 字节、正文/图表及 Enter 关闭 |
| `ROC_SMOKE_TARGET=packaged node scripts/ui-layout-audit.mjs` | 修复测试驱动后 50 状态，cut=0、viewport overflow=0；layout-final.log 与 layout-final/ |

最后仅变更布局审查脚本及文档，没有修改最终包对应的产品源码。
完整 renderer/native/quality/workflow 基线及失败补验按下节限定范围使用，未把局部
新回归冒充全量重跑。最初原生 500ms marker 未出现的用例原样补验通过。

## 分轮验证

冻结采集 `2026-11-07T06-12-06.038Z/verification.json` 的 `changedSources=[]`。
该轮整体状态 failed，原因与补验分别保留，不能宣称一次全量全部通过。

| 实际命令 | 结果 / 日志 |
| --- | --- |
| `pnpm check:ipc`、`pnpm build` | exit 0，build 含 typecheck；冻结 ipc.log/build.log |
| `pnpm test:unit` | 1588/1588；冻结 unit.log |
| `node --test --test-concurrency=1 tests/renderer/` | 452/452；冻结 renderer.log |
| `pnpm harness:eval` | 94，通过；冻结 harness.log |
| `pnpm harness:quality:check`、`pnpm test:review-workflow`、`pnpm check:renderer-chunks` | exit 0；quality/workflow/renderer-chunks.log |
| 四个原生 integration 文件，串行 | 35/36；冻结 native.log；500ms timeout 场景缺 marker |
| 原样 focused cancellation/timeout 用例 | 1/1；native-cancellation-recheck.log；未弱化时间或断言 |
| `node scripts/run-research-p0.mjs` | Electron 恢复后 17/19；p0-recheck.log；两个冷重开夹具缺 SQLite 函数 |
| `node scripts/run-research-p0.mjs --test-name-pattern='restart during'` | 修复夹具后 2/2；p0-restart-fixed.log |
| `node .artifacts/research-harness/S08/migration-app-rehearsal.mjs` | exit 0；migration-app-seventh.log；真实旧/新/恢复旧应用 |
| `pnpm package:dir` | exit 0；package-dir.log；首包后续被 mac smoke 发现多带 highlight.js |
| `pnpm verify:native-packaging`、`node scripts/verify-arm64-only.mjs --strict`、`pnpm verify:paths` | exit 0；native-packaging/arm64-only/paths.log；arm64 20/20 |
| `node --test tests/unit/renderer-assistant.test.mjs` | 11/11；lowlight-regression.log |
| `node .artifacts/research-harness/S08/package-candidate.mjs` | exit 0；package-candidate.log；中间候选 build/typecheck/chunks 与独立目录打包 |
| `node scripts/smoke-mac.mjs release/s08/mac-arm64/Roc.app` | exit 0；smoke-mac-candidate.log、mac-candidate/result.json |
| `node scripts/verify-native-packaging.mjs --require-base release/s08/mac-arm64/Roc.app/Contents/Resources/app.asar/package.json --label s08-candidate` | exit 0；native-candidate.log |
| `node .artifacts/research-harness/S08/arm64-candidate.mjs --strict` | exit 0；20/20；arm64-candidate.log 与 arm64-candidate/report.json |
| `ROC_SMOKE_TARGET=packaged node scripts/ui-layout-audit.mjs` | 50 状态通过，cut=0；layout-packaged.log 与 layout-packaged-before-dependency-fix/ |
| `node .artifacts/research-harness/S08/packaged-pdf.mjs` | 第二轮 exit 0；packaged-pdf-second.log 与 packaged-pdf-2026-11-07T06-57-20.415Z/ |
| `ROC_SMOKE_TARGET=packaged node scripts/smoke-electron.mjs --full` | 首包 exit 1；用户允许后通过基础路径，但 checkpoint dispatch 未进入 running；packaged-full-smoke.log / first-package-full-smoke/ |
| `ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs --full` | exit 0；基础 14/14、P4 62/62；dist-full-smoke.log 与 dist-full-smoke/p4-gates/report.json |

上述四个原生文件为 research-process-resources、research-native-environment-boundaries、
research-julia-environment-boundaries、research-native-code-integrity，路径均在 tests/integration/。
确切完整命令、分轮来源 hash、退出码及日志 hash 由机器汇总保留。

冻结全量测试之后补齐六种科研 verdict，并更新共享输出合同 v4、11份 Skill
manifest 1.3.0及 catalog；相应 schema、UI与回归测试均变化。另有 P0连接夹具、
smoke请求/预算和lowlight依赖分类修正。确切漂移清单在 final-verification.json，
不能把冻结测试视为覆盖最终源码；最终源另跑 unit/P0/harness与相关界面回归。
首包现保存在 release/s08-first/mac-arm64；中间候选在 release/s08/mac-arm64；
六结论最终候选是 release/mac-arm64/Roc.app。旧布局/PDF记录仍指向首包；本节表格是历史分轮记录，上节是最终包证据。

## 失败与修复证据

1. 冻结 P0/smoke 因 Electron `dist/path.txt` 缺失未启动。恢复本地 ZIP，SHA256 为
   `896c3a50b148e89a158dca08a6996a022ddf39b23aac871e107f5b4087f8caa9`，与安装包
   checksums.json 匹配。缺失原因未确定，不归因于产品；失败日志保留。
2. P0 冷重开直接 `new Database` 绕过 `configureRocDatabaseConnection`，触发器报
   `no such function: roc_payload_hash`。应用入口已正确注册；夹具采用生产初始化后
   两例通过，完整性触发器和恢复断言未移除。
3. mac smoke 首轮传入已禁止的 `source:'terminal'`；修正后通过 shell。第二轮发现
   lowlight 的生产依赖带入 highlight.js；依赖分类修正后最终原生 smoke 通过。
4. PDF 首轮 renderer 直接 fetch 失败；实际产品 iframe 使用 protocol。第二轮从
   Electron net.fetch 检查 protocol 返回的 16547 字节，SHA256 与真实编译 PDF 一致，
   并已目视核对正文/图表、PDF extension/embed 状态和 Enter 关闭。未放宽 protocol。
5. 完整 packaged smoke 保存合成测试 secret 时等待系统钥匙串；sample 停在
   SecItemCopyMatching/SecKeychainItemCopyContent，SecurityAgent 运行。没有修改安全
   设置、使用明文存储或自动批准。用户已允许首包本次访问，随后崩溃恢复失败。
   六结论新包由用户逐次允许系统请求后，完整 14/14 + 62/62 通过；未更改安全设置。
   首包 failure 的运行 DB 未保留，具体原因未确认；不将最终包通过写成已证明首包根因。
6. 原 schema 只有四种 verdict，与统一合同六种不符。新增两例先红（保存前
   ZodError），补齐枚举/标签后又被共享 Skill hash 拒绝，故同步输出 v4与11份
   manifest 1.3.0/catalog。定向42/42与界面10/10通过，旧pin拒绝和人工权威仍受检。
7. 最终包布局首轮在 dark drawers-edge 得到 1184 而非 1099px。隔离 probe 证实
   display-metrics-changed 会通过真实窗口纠正恢复产品最小宽度；原生 minimum
   仍为测试覆盖的 380，排除其被系统重设。审查改为渲染视口模拟，保留原生约束，
   每个状态主动触发该事件，并断言精确渲染宽度和原生最小宽度。50 状态完整通过；
   没有禁用纠正处理器、放宽断言或修改产品窗口代码。首轮日志、probe 与报告均保留。

## 迁移、恢复与桌面证据

真实演练目录 `migration-app-2026-11-07T06-51-04.282Z/`。
旧 S05 `9d16212d` 独立构建，agent20/research63 → agent21/research64 → 恢复匹配旧版。
先停机，再对 `plugin-data` 转换，并完整保留外层配置/索引。七库完整性通过。
原事件 envelope 逐字节保留；转换追加一条明确的历史不可续跑事件，其 hash 也通过
`parseExecutionEvent`；新应用启动不再追加事件。1 条 effect receipt 与 6 条预算调用
非空且前后 count/hash 相同。旧版恢复 Task/event/evidence/execution 与停机状态相同。
workspace sentinel SHA256 为 `4cf922f05c2063523feec5058f1690f51f9e687074d7963fcda4d3a3c50258bf`，未改变。

演练的 chat 成功，旧研究阶段到达故障终态并被完整保存。因此该证据证明迁移和恢复，
不能当作科研工作流成功；成功导出及故障路径由 P0 另行覆盖。

打包布局覆盖浅/深主题、门户/画布/助手/任务/设置、键盘焦点与 reduced-motion。
生产最小窗 1184×640；最终 380px 是测试渲染视口模拟，原生 minimum 保持不变，
不是产品支持声明。首包旧记录使用 minWidth override，已明确区分。
原生 OS IME 未手工验收，已有 IME 用例仅为合成事件。已目视复核最终包浅色
columns-edge 任务抽屉和深色 380px 设置截图，焦点可见、表单可滚动。最终包 PDF
标题/正文/A、B 图表可见，protocol 内容 16549 字节、SHA256 与编译原文件相同，Enter 关闭通过。

源码 full smoke 的 P4 默认播种 250 轮，累计 258 轮、516 条消息、2439 事件，
13 页回放；窗口保留 116 条消息而只渲染 16 行。审批/拒绝、提问、取消后再发、
面板卸载与项目切换恢复、强制杀进程后检查点续跑均通过，ls 仅执行一次。
该证据目标为 dist-main-fallback；最终包另跑完整同一流程通过：258 轮、516 消息、
2439 事件/13 页、窗口116条/DOM15行，SIGKILL 后恢复且 ls 只执行一次。

## 剩余条件

本地工程完成，候选包 `release/mac-arm64/Roc.app` 已通过实际 smoke，未 notarize 或发布。
独立样本 0/200、双人审查/仲裁、live 模型 A/B、真实账号互操作与原生 OS IME 手工验收未运行。
S09 未独立立项。工程提交不代表总体科学验收或发布批准，最终分项结论见
[final-acceptance.md](final-acceptance.md)。
