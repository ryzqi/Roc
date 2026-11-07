# S07 执行报告

状态：`Verified passing`（本地工程）。起点 `3647317946ba1a964039f6a72bbda15a3e3a37b4`。
工作目录均为 `/Users/Apple_501/Desktop/Roc/Roc`，macOS arm64 / Node v26.13.0。
证据根 `.artifacts/research-harness/S07/`；`final-verification.json` 固定最终源码与日志/截图 hash。
这是多轮验证，首轮安全源码快照早于新增注入及 UI 修复，不合并伪称同一次全量。

## 改动与复现

- grant 领取后至 shell spawn 前重新同步检查持久 run/fence/input/grant/approval/expiry。
  6 个 host 文件 sentinel 修前全部被改写，修后拒绝且字节不变。
- 版本化攻击目录和 runner 逐项记录实际到达层、效果断言、日志与源码 hash，拒绝 missing/skipped。
  原 153 项含 123 攻击/30 控制，新增网页/MCP description/result 3 攻击，总 156。
  policy/schema/SQLite/transport/native 分开报告；不从 pass 总数推算总体未授权 effect 数。
- modal/drawer 按主题 token 留足阴影余量，窄设置面板改为纵向导航和完整表单。
  720px modal、380px drawer 阴影及 380px 表单挤压修前证据分别保留在
  `layout-before/`、`layout-before-drawer/`、`layout-before-settings-content/`。
- P0 fixture 对齐冻结 queryId 与精确结果 receipt hash；真实拒绝规则不变。

## 验证

以下成功命令均 exit 0。原失败日志保留，不纳入成功计数。

| 命令 | 结果 / 证据 |
| --- | --- |
| `node --test tests/unit/execution-grant-broker.test.mjs tests/unit/ipc-execution-boundary.test.mjs` | 21/21；grant-after.log；修前 grant-before-v2.log 为 6 次真实越权，grant-before.log 为无效早拒绝夹具 |
| `node --test --test-concurrency=1 tests/integration/research-process-resources.test.mjs tests/integration/research-native-environment-boundaries.test.mjs tests/integration/research-julia-environment-boundaries.test.mjs tests/integration/research-native-code-integrity.test.mjs` | 36/36；native-boundaries.log |
| `node scripts/security-boundary-audit.mjs` | 153/153；security-2026-11-07T05-27-29.065Z/report.json |
| `node scripts/security-boundary-audit.mjs S07-154 S07-155 S07-156` | 3/3；security-2026-11-07T05-33-59.214Z/report.json |
| `node --test tests/unit/run-capability-manifest.test.mjs` | 20/20；injection.log |
| `node --test --test-concurrency=1 tests/renderer/research-tasks.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/response-matrix.test.mjs tests/renderer/async-resource-identity.test.mjs tests/renderer/lifecycles.test.mjs tests/renderer/run-diagnostics.test.mjs tests/renderer/radix-settings-dialog.test.mjs` | 94/94；renderer.log；任务、批准、反证、unknown、gap、source changed、迟到响应与只读状态 |
| `node --test --test-concurrency=1 tests/renderer/radix-settings-dialog.test.mjs` | 最终布局修复后 1/1；settings-content-renderer.log |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | ipc.log / chunks.log；无 IPC 或 import 变化后续无需重复 |
| `pnpm build` | 最终 build-settings-content.log；包含 typecheck |
| `node scripts/ui-layout-audit.mjs` | layout-settings-content.log；layout-verified/layout-audit.json；50 状态，cut=0、无 viewport overflow |
| `node scripts/smoke-electron.mjs` | 14/14；smoke.log；真实助手 stub run、PTY、设置与合成 IME |
| `node scripts/run-research-p0.mjs --test-name-pattern='hostile PDF\|MCP timeout'` | 2/2；hostile-pdf-mcp-after.log；首轮旧 fixture 失败在 hostile-pdf-mcp.log |

布局矩阵含 light/dark、1440/1100/1099/720/380、portal/canvas/assistant/tasks/settings、
reduced-motion、任务抽屉 24 次 Tab/Shift+Tab、Escape 和焦点返回。
380px 最终截图已人工目视复核，表单可读且可滚动；drawer 贴边阴影完全隐藏为预期。
生产最小窗为 1184×640，窄档是一次性测试窗口 override，不能宣称原生产品支持 380px。

## 边界与下一步

真实 shell、PDF 和 native sandbox 使用隔离 fixture/synthetic secret。
网页/MCP 注入用确定性伪造调用验证权限边界，不是实际模型防注入成功率。
R/Julia 原生测试使用受控 C launcher 探针；CPU/RSS 为采样治理。
IME 为 DOM 合成事件，系统输入法手工验收仍未运行。
独立科学样本、盲审、付费模型与外部真实账号未运行；无远端发布。
D10 工程收尾；S08 继续导出闭包、全链路、迁移与本地 arm64 打包。
