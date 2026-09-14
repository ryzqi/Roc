# Phase 4：验证与交付记录

状态：Verified passing，附已知限制。基点：`058f44f`。

## 已运行

- `pnpm typecheck` 通过。
- `pnpm check:ipc` 通过。
- `pnpm build` 通过（含 typecheck 与 electron-vite）。
- 科研相关回归：`tests/main/plugins/research`、`tests/renderer/research-view.test.tsx`、`tests/main/native-packaging.test.ts`、IPC/数据库探测共 38 文件 / 276 项通过，34 项按环境跳过。
- Renderer 5a–5e 与 Packaging 增量均有独立 review 记录。

## 已知限制

- 全量 `pnpm test` 仍有既有 chat/agent/backup/code-quality 失败，不属于本计划科研增量回归，未在本阶段修复。
- `package:dir` / `package:mac` / `smoke:mac` / `smoke:electron` 未在本机完整重跑；打包合同已由 native-packaging 20/20 覆盖，安装包实机验证仍待发布前执行。
- Intel 实机验证仍未做。

## Spec

计划要求的科研工作台主路径已交付：项目流程、文献库/阅读、Idea Canvas、LaTeX 编辑预览、图稿导出、随包工具链与许可证校验。Phase 5 交付给用户即本记录。
